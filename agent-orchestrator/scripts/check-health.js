#!/usr/bin/env node
/**
 * check-health.js — supervise an orchestrated agent session by reading
 * its PID, the manifest's timeout, an optional heartbeat log, and the
 * phase directory's most recent artifact.
 *
 * Unit 8 per docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md
 * (Unit 8 section, line 567) and the Unit 8 dispatch handoff.
 *
 * Detection precedence is explicit:
 *
 *   PRIMARY (load-bearing):
 *     - PID liveness: process.kill(pid, 0) on the orchestrator's recorded
 *       PID (manifest-status.phases[phaseId].pid). Falls back to a
 *       session-name lookup via spawn-session's getSessionPid when the
 *       status file has no pid.
 *     - Timeout: now - started_at > timeout_minutes ⇒ stuck/dead.
 *
 *   SECONDARY (advisory):
 *     - Heartbeat staleness: ${phase_dir}/heartbeat.jsonl tail age >
 *       5 minutes. Stale heartbeat alone does NOT flip `alive` to false
 *       — agents drop heartbeats during atomic operations on purpose
 *       (protocol-header.md §"Heartbeat"). Stale heartbeat AND PID gone
 *       is a strong "dead" signal and the caller can render that combo;
 *       this module only reports the raw signals.
 *
 * The orchestrator (Unit 11, future) calls checkHealth() in a polling
 * loop. The call must be cheap and exception-free — a thrown error per
 * call would tank the loop. Therefore:
 *   - Programmer errors (invalid phaseId / role) throw.
 *   - Run-time resource errors (missing manifest / phase dir / phase id
 *     not in manifest) return `{ alive: false, error: "..." }`.
 *   - Subprocess and PID-lookup failures downgrade to `pidAlive: null`
 *     so downstream consumers can distinguish "definitely dead" from
 *     "couldn't tell"; they do not abort the call.
 *
 * Public API:
 *
 *   checkHealth({
 *     phaseId,            // required, matches VALID_ID_RE
 *     role,               // required, one of impl | qa | coord
 *     manifestPath,       // required, file must exist
 *     phaseDir,           // optional override; default <manifestDir>/docs/orchestration/phases/<phaseId>
 *                         //   (matches scaffold-protocol.js — protocol artifacts always live
 *                         //    under the manifest's directory, NOT manifest.workdir, per
 *                         //    docs/manifest-reference.md §workdir)
 *     sessionName,        // optional override; default orch-<phaseId>-<role>
 *     heartbeatStaleMs,   // optional, default 5 * 60_000
 *     startupGraceMs,     // optional, default 60_000 — pidAlive: null instead of false
 *                         //   when WMI lookup misses but started_at is within this window
 *     // injection seams for tests:
 *     _now, _killer, _pidLookup,
 *     _readFileSync, _existsSync, _statSync, _readdirSync,
 *   }) -> {
 *     alive: bool,           // pidAlive === true && !timedOut && no error
 *     pidAlive: bool|null,   // null = couldn't determine
 *     timedOut: bool,
 *     heartbeatAge: number|null,    // seconds since last heartbeat ts, or null
 *     heartbeatStale: bool,         // age > heartbeatStaleMs
 *     lastCheckpoint: string|null,  // basename of most recent phase artifact
 *     error?: string,        // present when something prevented a full check
 *   }
 *
 * Helpers (also exported, primarily for tests):
 *   isPidAlive(pid, _killer?) -> bool|null
 *   parseHeartbeatTail(content) -> { tsMs, pid } | null
 *   findLastCheckpoint(phaseDir, _readdirSync?, _statSync?) -> string|null
 *   readPhaseStatus(manifestPath, phaseId, _readFileSync?, _existsSync?) -> object|null
 *   defaultPhaseDir(manifestDir, phaseId) -> string
 *   defaultSessionName(phaseId, role) -> string
 *
 * CLI:
 *   check-health.js --phase <id> --role <role> --manifest <path>
 *
 * Exit codes: 0 on a successful check (regardless of alive/dead verdict),
 * 1 on input validation error.
 *
 * Plan deviation: the plan (line 580) directs `tasklist /FI "PID eq X"`
 * for PID liveness. PR #15 uses process.kill(pid, 0) instead. Two reasons:
 * (1) it avoids per-poll subprocess overhead Unit 11 would otherwise
 * pay every tick (the institutional memory in todos/044 measured ~140ms
 * per spawnSync on Windows); (2) Node's signal-0 probe works on Win32
 * via the same kernel ACL check tasklist uses. PID *lookup* (the WMI
 * Get-CimInstance path) is delegated to spawn-session.js's getSessionPid
 * per the dispatch's no-reimplementation rule; this module only does PID
 * *liveness* on a known PID.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  VALID_ID_RE,
  VALID_ROLES,
  loadManifest,
  loadStatus,
} = require('./parse-manifest');
const { getSessionPid } = require('./spawn-session');

// -------------------- Constants --------------------

// VALID_ROLES is canonical in parse-manifest (todo 077, PR #17). Imported
// rather than redeclared so the V1.5 recovery-role addition is a one-file
// edit in parse-manifest plus per-consumer include/exclude updates.

const DEFAULT_TIMEOUT_MINUTES = 60;
const HEARTBEAT_STALE_MS = 5 * 60_000;
// Startup grace window: when the WMI lookup returns no Claude child but
// the manifest-status `started_at` is within this window, treat the
// state as `pidAlive: null` ("still starting up") instead of `false`
// ("crashed"). Prevents Unit 11 from triggering recovery on a session
// that's still spawning — wt → cmd /k → claude takes a few seconds on
// cold launches and longer when the binary needs to JIT or auth.
// Codex round 7 [P2].
const DEFAULT_STARTUP_GRACE_MS = 60_000;

// Files whose mtime is not informative as a "checkpoint" — either the
// agent rewrites them continuously (heartbeat.jsonl) or they're
// transient OS artifacts. Excluded from the last-checkpoint scan so the
// recovery anchor names a real deliverable.
const CHECKPOINT_EXCLUDE_NAMES = new Set(['heartbeat.jsonl']);
const CHECKPOINT_EXCLUDE_SUFFIXES = ['.lock', '.tmp', '.swp', '.swo', '.crdownload'];

// Tail-read windows for heartbeat.jsonl (todo 067, PR #17). The file is
// append-only and never truncated by the orchestrator, so its size is
// bounded only by agent discipline. Reading the whole file per poll
// tick would let a misbehaving (or prompt-injected) agent stall the
// orchestrator. Open + seek to size-window + read a fixed tail; expand
// the window if no role match is found in the smaller window.
//   64 KiB ≈ 500 typical heartbeat lines @ ~120 bytes
//   256 KiB ≈ 2000 lines
//   1 MiB ≈ 8000 lines
// Beyond 1 MiB we give up: heartbeatAge: null + heartbeatCorrupt
// reflects whatever was seen during the walk. That degraded reading
// IS the right policy — at >1 MiB without a role-matching record, the
// agent has clearly stopped emitting and Unit 11 should treat that as
// a freshness signal of its own.
const HEARTBEAT_TAIL_WINDOW_BYTES = Object.freeze([
  64 * 1024,
  256 * 1024,
  1024 * 1024,
]);

// Hard cap on phase-directory entries scanned per `findLastCheckpoint`
// call (todo 068, PR #17). Beyond this threshold the phase has clearly
// gone off the rails (a runaway loop or a build-artifact dump) and
// "newest by mtime" is no longer a meaningful recovery anchor — pick-
// best-from-N>cap is unsafe by name-sort (timestamp-prefixed naming
// sorts ascending so take-first discards the NEWEST entries) and still
// O(N) statSyncs by mtime-sort, defeating the cap. Above the cap we
// skip the stat phase entirely and return `null` plus an advisory.
const MAX_CHECKPOINT_ENTRIES = 256;

// -------------------- PID liveness --------------------

/**
 * Probe whether a PID is currently running on this OS. Uses
 * process.kill(pid, 0), which is portable: on POSIX it sends a no-op
 * signal that performs only the ACL/existence check, and on Windows
 * Node translates signal 0 to the same kernel existence probe tasklist
 * makes. No subprocess is spawned, so this is safe in a tight poll
 * loop.
 *
 * Returns:
 *   true  — process is alive (or kernel returned EPERM, which means it
 *           exists but we lack permission — still alive)
 *   false — kernel returned ESRCH (no such process)
 *   null  — invalid PID, or unknown error code (caller may surface)
 */
function isPidAlive(pid, _killer) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const killer = _killer || ((p, sig) => process.kill(p, sig));
  try {
    killer(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return null;
  }
}

// -------------------- Heartbeat parsing --------------------

/**
 * Parse a JSONL heartbeat log and return the freshest valid record
 * matching `opts.role` (when supplied), or the file's most recent
 * record when no role filter is given. Returns
 *   { tsMs, pid }
 * where tsMs is the parsed `ts` field as epoch ms and pid is the
 * agent-reported `pid` (null if the field is absent or malformed).
 *
 * Two operating modes:
 *
 * - **No role filter (V1 default):** Strict-tail. Examines only the
 *   LAST non-empty line. A malformed last line returns null — we do
 *   not walk back to an earlier valid record, because a partial-
 *   write tail stuck malformed would otherwise mask a dead agent
 *   from the supervisor indefinitely. (Dispatch contract.)
 *
 * - **Role filter (`{ role: 'impl' | 'qa' | 'coord' }`):** Walks lines
 *   from end to start, skipping malformed lines and entries for other
 *   roles, returning the most recent valid record for the requested
 *   role. Required for multi-role phases where impl and qa share the
 *   same `heartbeat.jsonl` and would otherwise see each other's
 *   activity as their own — codex round 6 [P2]. The strict-tail rule
 *   doesn't translate to multi-role: a fresh `impl` write would
 *   otherwise mask a dead `qa` regardless of how careful `qa` was.
 *
 *   In role-filter mode the return shape carries an additional
 *   `corrupt: boolean` field (todo 083, PR #17). It is `true` whenever
 *   ANY non-parseable line was encountered during the walk, regardless
 *   of whether a valid record was eventually found further back. The
 *   advisory rides alongside a recovered freshness reading so an
 *   operator can see "newest line is garbage; we recovered an older
 *   record" — distinguishing it from "no records at all." When no
 *   valid record AND no corruption is seen, the function still returns
 *   `null` (back-compat).
 *
 * The protocol-header.md format is:
 *   {"ts": "<ISO 8601 UTC>", "pid": <int>, "role": "...", "phase_id": "...", "message": "..."}
 */
function parseHeartbeatTail(content, { role } = {}) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const lines = content.split(/\r?\n/);

  if (role === undefined) {
    // V1 default — strict-tail. Last non-empty line, or null if it's malformed.
    let lastLine = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed !== '') {
        lastLine = trimmed;
        break;
      }
    }
    if (lastLine === null) return null;
    return parseHeartbeatLine(lastLine);
  }

  // Role filter — walk back, skipping malformed / wrong-role lines.
  // Track corruption: any non-empty line that fails JSON parse OR parses
  // to a non-object/array shape sets `corrupt = true`. Per todo 083, the
  // signal fires on ANY malformed line, even when an older valid record
  // is found later in the walk. Wrong-role lines (validly parsed JSON
  // with the wrong role) are NOT corruption — they're legitimate
  // entries belonging to another consumer.
  let corrupt = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    const obj = tryParseJson(trimmed);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      corrupt = true;
      continue;
    }
    if (obj.role !== role) continue;
    const tsMs = coerceTimestampMs(obj.ts);
    if (tsMs === null) {
      // Object parses but `ts` is unusable — treat as corruption (the
      // file shape promised a `ts` and didn't deliver).
      corrupt = true;
      continue;
    }
    const pid = Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : null;
    return { tsMs, pid, corrupt };
  }
  // No valid record found. If corruption was seen, surface that so the
  // caller can set heartbeatCorrupt — return a record with null tsMs/pid.
  if (corrupt) return { tsMs: null, pid: null, corrupt: true };
  return null;
}

function parseHeartbeatLine(line) {
  const obj = tryParseJson(line);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const tsMs = coerceTimestampMs(obj.ts);
  if (tsMs === null) return null;
  const pid = Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : null;
  return { tsMs, pid };
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

/**
 * Read the tail of `heartbeat.jsonl` and return the parsed
 * role-matching record (or null) using a fixed-window seek-and-read
 * — bounded memory and CPU regardless of file size (todo 067).
 *
 * Strategy:
 *   - Open + fstat. If size === 0, return null.
 *   - For each window in HEARTBEAT_TAIL_WINDOW_BYTES (64 KiB → 256 KiB
 *     → 1 MiB), read the trailing `min(size, window)` bytes. If the
 *     read started mid-file (startOffset > 0), drop the leading
 *     partial line (everything up to and including the first newline)
 *     so parseHeartbeatTail sees only complete records.
 *   - parseHeartbeatTail with role filter on the window. If a
 *     role-matching record is found, return it. Otherwise expand to
 *     the next window. If we already read the whole file in one
 *     pass (startOffset === 0), there's nothing more to expand to —
 *     return whatever the parse yielded (null OR a corrupt-only
 *     diagnostic record).
 *   - Beyond the largest window: return the last non-finite-tsMs
 *     diagnostic so heartbeatCorrupt still surfaces if any window
 *     saw corruption.
 *
 * Return shape mirrors parseHeartbeatTail's role-filter return:
 *   - { tsMs, pid, corrupt } when a record is found
 *   - { tsMs: null, pid: null, corrupt: true } when only corruption
 *     was seen across all windows tried
 *   - null when no records and no corruption
 *
 * Test seams (`_openSync`, `_fstatSync`, `_readSync`, `_closeSync`)
 * mirror the fs primitives so tests can simulate large files without
 * actually allocating MiB-scale buffers when not needed.
 */
function readHeartbeatRecord(filePath, role, opts = {}) {
  const openSync = opts._openSync || fs.openSync;
  const fstatSync = opts._fstatSync || fs.fstatSync;
  const readSync = opts._readSync || fs.readSync;
  const closeSync = opts._closeSync || fs.closeSync;

  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (_) {
    return null;
  }
  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch (_) {
      return null;
    }
    const size = typeof stat.size === 'number' ? stat.size : 0;
    if (size === 0) return null;
    let lastDiagnostic = null;
    for (const window of HEARTBEAT_TAIL_WINDOW_BYTES) {
      const startOffset = Math.max(0, size - window);
      const length = size - startOffset;
      const buffer = Buffer.alloc(length);
      let bytesRead;
      try {
        bytesRead = readSync(fd, buffer, 0, length, startOffset);
      } catch (_) {
        return lastDiagnostic;
      }
      let text = buffer.slice(0, bytesRead).toString('utf8');
      if (startOffset > 0) {
        // We started mid-file. Usually the first line is partial — but
        // not always: when the byte just before `startOffset` is `\n`,
        // the read aligns exactly with a record boundary and the
        // first line is complete. Peek that byte before unconditionally
        // dropping (codex round 1 of PR #17 — without this peek, a
        // matching record at the largest window's exact tail boundary
        // would be silently discarded).
        let alignedAtBoundary = false;
        try {
          const peek = Buffer.alloc(1);
          const peekN = readSync(fd, peek, 0, 1, startOffset - 1);
          if (peekN === 1 && peek[0] === 0x0a /* \n */) {
            alignedAtBoundary = true;
          }
        } catch (_) {
          // Couldn't peek — fall through to the safe (drop) branch.
        }
        if (!alignedAtBoundary) {
          const nl = text.indexOf('\n');
          if (nl < 0) {
            // No newline at all in this window — every byte is a
            // single (possibly partial) line that we can't trust.
            // Re-expand.
            continue;
          }
          text = text.slice(nl + 1);
        }
      }
      const parsed = parseHeartbeatTail(text, { role });
      if (parsed && Number.isFinite(parsed.tsMs)) {
        return parsed;
      }
      // No record yet — keep the most informative diagnostic so the
      // corrupt flag survives if no later window finds a match.
      if (parsed) lastDiagnostic = parsed;
      // Whole file fit in this window: nothing more to expand to.
      if (startOffset === 0) return parsed || null;
    }
    // We walked through every window (largest = HEARTBEAT_TAIL_WINDOW_BYTES
    // last entry, currently 1 MiB) without finding a role-matching
    // record AND without ever hitting startOffset === 0 (which would
    // have returned earlier). The file is therefore larger than the
    // largest window. Surface a `truncated: true` diagnostic so
    // checkHealth can mark heartbeatStale + heartbeatTruncated — pre-
    // PR #17, the full-file scan would have surfaced an old role
    // record as `heartbeatStale: true`; without this signal, a role
    // that stopped emitting before >1 MiB of other-role activity
    // would silently lose its stale advisory (ce:review round 2 — P2
    // functional regression).
    if (lastDiagnostic === null) {
      lastDiagnostic = { tsMs: null, pid: null, corrupt: false, truncated: true };
    } else {
      lastDiagnostic.truncated = true;
    }
    return lastDiagnostic;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

// -------------------- Last-checkpoint scan --------------------

/**
 * Return the basename of the most-recently-modified non-transient file
 * in `phaseDir`, or null if the directory is missing or has no eligible
 * files. Used by the orchestrator (Unit 11) to anchor recovery prompts
 * at the last visible artifact.
 *
 * Excludes:
 *   - heartbeat.jsonl (rewritten on every agent heartbeat — its mtime
 *     would always win and tell us nothing about progress)
 *   - common transient suffixes (.lock, .tmp, .swp, .swo, .crdownload)
 *
 * Subdirectories are not descended. The phase directory is intentionally
 * shallow per scaffold-protocol.js's contract.
 */
function findLastCheckpoint(phaseDir, _readdirSync, _statSync, _logger) {
  const readdirSync = _readdirSync || fs.readdirSync;
  const statSync = _statSync || fs.statSync;
  // Optional logger seam — production warns to stderr; tests can
  // capture the advisory by passing a sink. Either choice satisfies
  // todo 068's "log line or returned in result" AC.
  const logger = _logger || ((msg) => console.warn(msg));
  let entries;
  try {
    entries = readdirSync(phaseDir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  if (entries.length > MAX_CHECKPOINT_ENTRIES) {
    // Per todo 068 (PR #17): past the cap, skip the stat phase
    // entirely (zero per-entry statSyncs) and return null. Picking
    // any "newest" candidate from N > cap entries is unsafe — name-
    // sort + take-first would discard the newest with timestamp-
    // prefixed naming, and mtime-sort still requires the per-entry
    // stats we were trying to bound.
    logger(
      `check-health: phase dir overflowed (${entries.length} entries > ${MAX_CHECKPOINT_ENTRIES} cap); ` +
        `lastCheckpoint untrustworthy — skipping mtime scan: ${phaseDir}`
    );
    return null;
  }
  let bestName = null;
  let bestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    const name = entry.name;
    if (CHECKPOINT_EXCLUDE_NAMES.has(name)) continue;
    if (CHECKPOINT_EXCLUDE_SUFFIXES.some((s) => name.endsWith(s))) continue;
    let st;
    try {
      st = statSync(path.join(phaseDir, name));
    } catch (_) {
      continue;
    }
    const mtime = typeof st.mtimeMs === 'number' ? st.mtimeMs : st.mtime?.getTime?.();
    if (!Number.isFinite(mtime)) continue;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestName = name;
    }
  }
  return bestName;
}

// -------------------- Manifest-status helpers --------------------

/**
 * Read manifest-status.yaml's record for `phaseId`. Thin wrapper over
 * `parse-manifest.loadStatus(manifestPath)` — that loader is canonical
 * for the manifest-status YAML shape and applies the `__proto__` /
 * `prototype` / `constructor` filter (see todo 069 for the reuse-
 * discipline rationale). Returns null when the file is missing, the
 * loader fails, or the phase has no entry. Never throws.
 */
function readPhaseStatus(manifestPath, phaseId, _readFileSync, _existsSync) {
  const result = loadStatus(manifestPath, { _readFileSync, _existsSync });
  if (!result.ok || result.status === null) return null;
  const entry = result.status.phases[phaseId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return entry;
}

/**
 * Coerce a YAML / JSON timestamp shape into epoch milliseconds, or null
 * if unparseable. Accepts:
 *   - JS Date (yaml.DEFAULT_SCHEMA produces these for ISO timestamps)
 *   - string (ISO 8601 — Date.parse handles it)
 *   - finite number (already epoch ms)
 *
 * Empty strings are treated as missing (return null), NOT zero-epoch —
 * the empty-string-as-explicit-override class of bugs (see PR #13
 * codex round) is the reason for this specific guard.
 */
function coerceTimestampMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Coerce a value to a positive integer, mirroring parse-manifest's
 * `expectPositiveInt` semantics. Returns null when the value cannot
 * sensibly be a positive int (null/undefined/empty string/non-finite/
 * non-integer/zero/negative). Strings that parse cleanly to positive
 * integers ("5", "30") return their numeric form — parse-manifest
 * accepts those, so the health checker must accept them too.
 *
 * Empty string is treated as missing (returns null), NOT zero — the
 * empty-string-as-explicit-override class of bugs (PR #13 codex finding).
 */
function asPositiveInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// -------------------- Path helpers --------------------

/**
 * Compose the conventional phase directory for a phase id.
 *
 * @param {string} manifestDir — the manifest's containing directory
 *   (i.e., `path.dirname(path.resolve(manifestPath))`). This is the
 *   PROTOCOL ROOT per `docs/manifest-reference.md` §workdir and the
 *   scaffold-protocol convention — protocol artifacts always live
 *   under the manifest's directory.
 *
 *   It is **not** `manifest.workdir`. The workdir field is the spawned
 *   session's `wt --startingDirectory` (the agent's git/tooling cwd);
 *   it has nothing to do with where the protocol scaffold lives.
 *   Passing `manifest.workdir` here will silently produce a wrong
 *   path. The parameter name `manifestDir` (renamed from `workdir` in
 *   todo 070, PR #17) exists to keep that distinction crisp.
 *
 * @param {string} phaseId — must match `VALID_ID_RE`.
 * @returns {string} `<manifestDir>/docs/orchestration/phases/<phaseId>`
 */
function defaultPhaseDir(manifestDir, phaseId) {
  return path.join(manifestDir, 'docs', 'orchestration', 'phases', phaseId);
}

// `role` should be one of parse-manifest.VALID_ROLES — checkHealth
// validates against that set before composing the session name.
function defaultSessionName(phaseId, role) {
  return `orch-${phaseId}-${role}`;
}

// -------------------- Main --------------------

function checkHealth(opts = {}) {
  const {
    phaseId,
    role,
    manifestPath,
    phaseDir,
    sessionName,
    // No destructure default for heartbeatStaleMs — `undefined` means
    // "let manifest defaults take precedence over HEARTBEAT_STALE_MS".
    heartbeatStaleMs,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
    _now,
    _killer,
    _pidLookup,
    _readFileSync,
    _existsSync,
    _statSync,
    _readdirSync,
    // Heartbeat tail-read seams (todo 067, PR #17). Mirror fs.openSync /
    // fstatSync / readSync / closeSync so tests can simulate large
    // files without allocating MiB-scale buffers.
    _openSync,
    _fstatSync,
    _readSync,
    _closeSync,
    // Unit 11 batching seams (todo 086, PR #17). Underscore prefix
    // signals "advanced caller opt-in; not part of the everyday API."
    // When set, the corresponding internal load is skipped — the caller
    // (Unit 11's `pollAllPhases`) loads each artifact ONCE per tick and
    // hands the cached value to every per-phase checkHealth call.
    //
    //   _loadedManifest — already-loaded manifest object (the shape
    //     `loadManifest(...).manifest` produces). When set, skips the
    //     existsSync + loadManifest path; the manifest is trusted
    //     verbatim. Validation is the caller's responsibility.
    //   _loadedStatus — already-loaded manifest-status (the shape
    //     `loadStatus(...).status` produces, OR `null` to declare
    //     "no status file"). When set, skips the readPhaseStatus
    //     load; the status root is indexed by phaseId.
    //   _pidSnapshot — already-fetched PID snapshot. Either a
    //     Map<sessionName, { pid, ... }> or a plain object keyed by
    //     sessionName. When set, skips the getSessionPid call; the
    //     snapshot is authoritative for this tick (a missing entry
    //     means "definitely not running" rather than "transient
    //     lookup failure").
    _loadedManifest,
    _loadedStatus,
    _pidSnapshot,
  } = opts;

  // --- Programmer-error validation. Throws so the CLI exits 1 and so
  // tests catch typos early. Unit 11's poll loop never passes garbage
  // by the time it calls checkHealth(); these guards exist for the
  // direct CLI surface and for diagnostic clarity.
  if (typeof phaseId !== 'string' || phaseId === '' || !VALID_ID_RE.test(phaseId))
    throw new Error(
      `checkHealth: phaseId ${JSON.stringify(phaseId)} is not safe — use [A-Za-z0-9._-]+`
    );
  if (typeof role !== 'string' || !VALID_ROLES.includes(role))
    throw new Error(
      `checkHealth: role must be one of ${VALID_ROLES.join(' | ')}, got ${JSON.stringify(role)}`
    );
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '')
    throw new Error('checkHealth: manifestPath is required (non-empty string)');
  // Library + CLI must agree on the type contract (PR #17 ce:review
  // round 1: pre-fix the lib accepted any non-negative finite number
  // while the CLI required a non-negative integer — agent consumers
  // hitting the lib path could pass 30000.5 silently). Both knobs are
  // documented as "non-negative integer milliseconds" in --help; pin
  // Number.isInteger here so the contracts match.
  if (
    heartbeatStaleMs !== undefined &&
    (!Number.isFinite(heartbeatStaleMs) ||
      !Number.isInteger(heartbeatStaleMs) ||
      heartbeatStaleMs < 0)
  )
    throw new Error(
      `checkHealth: heartbeatStaleMs must be a non-negative integer, got ${JSON.stringify(heartbeatStaleMs)}`
    );
  if (
    !Number.isFinite(startupGraceMs) ||
    !Number.isInteger(startupGraceMs) ||
    startupGraceMs < 0
  )
    throw new Error(
      `checkHealth: startupGraceMs must be a non-negative integer, got ${JSON.stringify(startupGraceMs)}`
    );

  const now = typeof _now === 'function' ? _now() : Date.now();
  const existsSync = _existsSync || fs.existsSync;

  // Default-shape result. Every field is populated even on the error
  // path so callers can destructure without conditional guards.
  //
  // `schema_version: 1` (todo 075, PR #17) is the first key. Bump on
  // any breaking field rename or removal so consumers (Unit 11, future
  // operator pipelines) can refuse mismatched majors. The full V1
  // shape — including `pidAliveReason`, `errorKind`, and
  // `heartbeatCorrupt` — is documented in `printHelp`'s OUTPUT
  // section (todo 076) and pinned by a snapshot test.
  const baseResult = {
    schema_version: 1,
    alive: false,
    pidAlive: null,
    // pidAliveReason (todo 071, PR #17): disambiguates the three causes
    // of pidAlive: null. One of 'startup_grace' | 'lookup_failed' |
    // 'session_not_found' when pidAlive === null; null otherwise.
    pidAliveReason: null,
    timedOut: false,
    heartbeatAge: null,
    heartbeatStale: false,
    // heartbeatCorrupt (todo 083, PR #17): true when role-filter walk
    // encountered any non-parseable line, regardless of whether a
    // valid record was eventually found. Advisory only — orthogonal
    // to the freshness verdict; Unit 11 renders it as "possibly hung
    // agent producing garbage" rather than as a recovery trigger.
    heartbeatCorrupt: false,
    // heartbeatTruncated (PR #17 ce:review round 2): true when the
    // tail-read exhausted its largest window without finding a
    // role-matching record on a non-trivial file. Combined with
    // heartbeatStale: true, it tells Unit 11 "this role hasn't
    // emitted in at least the size of the tail window — count as
    // stale, but don't expect an exact age." Without this signal, a
    // role that stopped emitting before >1 MiB of other-role
    // activity in a shared heartbeat file would silently lose its
    // stale advisory.
    heartbeatTruncated: false,
    lastCheckpoint: null,
  };

  // --- Manifest must load. Without timeout_minutes we can't compute
  // the deadline; without phases we can't find the role's PID. A missing
  // manifest is a run-time issue (operator deleted it, wrong path passed)
  // — return `error` rather than throwing so Unit 11's poll loop survives.
  //
  // `errorKind: 'config'` (todo 072, PR #17) marks pre-flight config
  // failures (manifest not found / invalid / phase id absent). Unit 11
  // policy: pause polling and surface to the operator. Distinct from
  // `errorKind: 'runtime'` (set when phase dir is missing), where the
  // poll loop should keep ticking and treat as recovery candidate.
  //
  // Batching seam (todo 086): when the caller passes `_loadedManifest`,
  // skip both the existsSync probe and the disk load. Trust the caller
  // to have validated the shape upstream (Unit 11's pollAllPhases loads
  // once per tick).
  let loaded;
  if (_loadedManifest !== undefined) {
    loaded = { ok: true, manifest: _loadedManifest };
  } else {
    if (!existsSync(path.resolve(manifestPath)))
      return {
        ...baseResult,
        error: `manifest not found: ${manifestPath}`,
        errorKind: 'config',
      };
    loaded = loadManifest(manifestPath);
    if (!loaded.ok)
      return { ...baseResult, error: loaded.error, errorKind: 'config' };
  }

  const phaseEntry = (Array.isArray(loaded.manifest.phases) ? loaded.manifest.phases : []).find(
    (p) => p && typeof p === 'object' && p.id === phaseId
  );
  if (!phaseEntry)
    return {
      ...baseResult,
      error: `phase "${phaseId}" not found in ${manifestPath}`,
      errorKind: 'config',
    };

  // --- Resolve the phase directory.
  // Per agent-orchestrator's convention (scaffold-protocol.js line 113-116
  // and docs/manifest-reference.md §workdir), protocol artifacts always
  // live under the manifest's directory. `manifest.workdir` is the spawned
  // tab's starting directory (`wt --startingDirectory`), NOT the protocol
  // root — `prompt_file` and `completion_signal` paths "always resolve
  // against the manifest's directory, regardless of workdir." We mirror
  // that exactly: manifestDir is the protocol root, full stop. The
  // `phaseDir` opt is the only escape hatch (tests + Unit 11 layouts that
  // diverge from the convention).
  const manifestAbs = path.resolve(manifestPath);
  const manifestDir = path.dirname(manifestAbs);
  const resolvedPhaseDir =
    typeof phaseDir === 'string' && phaseDir.trim() !== ''
      ? path.resolve(phaseDir)
      : defaultPhaseDir(manifestDir, phaseId);

  // --- Resolve timeouts. parse-manifest's `expectPositiveInt` validates
  // via Number(v) so values like the YAML-quoted `"5"` pass validation.
  // We coerce the same way before checking, otherwise an accepted
  // manifest with quoted-numeric timeout silently fell through to
  // DEFAULT_TIMEOUT_MINUTES (codex round 4 [P2]).
  const D = loaded.manifest.defaults || {};
  const timeoutMinutes =
    asPositiveInt(phaseEntry.timeout_minutes) ??
    asPositiveInt(D.phase_timeout_minutes) ??
    DEFAULT_TIMEOUT_MINUTES;
  // Heartbeat staleness threshold precedence:
  //   1. opts.heartbeatStaleMs (explicit override — tests + Unit 11 advanced use)
  //   2. defaults.heartbeat_timeout_minutes from manifest (× 60_000)
  //   3. HEARTBEAT_STALE_MS (5 minutes — last-resort default)
  // Production callers (Unit 11) and the CLI rely on the manifest field
  // so a manifest configured for faster/slower heartbeat warnings
  // produces correct `heartbeatStale` results.
  const effectiveStaleMs = (() => {
    if (heartbeatStaleMs !== undefined) return heartbeatStaleMs;
    const def = asPositiveInt(D.heartbeat_timeout_minutes);
    if (def !== null) return def * 60_000;
    return HEARTBEAT_STALE_MS;
  })();

  // --- Read manifest-status for started_at. The PID field there is
  // phase-scoped, NOT role-scoped (Unit 4's manifest-status shape only
  // tracks one PID per phase), so for multi-role phases the last
  // written role's PID would mask the others. PID resolution goes
  // through getSessionPid(orch-<phase>-<role>) instead — the session
  // name carries the role and the WMI lookup is naturally scoped.
  //
  // Batching seam (todo 086): when the caller passes `_loadedStatus`,
  // skip the disk load. Both `null` (no status file) and an object
  // (status root with `phases` map) are valid pre-loaded values.
  let statusEntry;
  if (_loadedStatus !== undefined) {
    if (_loadedStatus === null) {
      statusEntry = null;
    } else {
      const phases = _loadedStatus.phases;
      const entry =
        phases && typeof phases === 'object' && !Array.isArray(phases)
          ? phases[phaseId]
          : undefined;
      statusEntry =
        entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    }
  } else {
    statusEntry = readPhaseStatus(manifestPath, phaseId, _readFileSync, existsSync);
  }

  // --- PID resolution. Always call getSessionPid(name) — the session
  // name is `orch-<phase>-<role>`, so the lookup naturally scopes by
  // role. Per the dispatch: do NOT reimplement PID lookup — getSessionPid
  // owns the WMI contract.
  //
  // `excludeWrappers: true` is critical: cmd /k and powershell -NoExit
  // intentionally keep the tab open after Claude exits (post-mortem
  // visibility), and the wrapper's CommandLine still contains `--name`.
  // Without this flag, getSessionPid's wrapper-fallback would mask a
  // crashed agent as alive until the phase timeout fires (codex round 3
  // [P1]).
  // `throwOnError: true` is critical: getSessionPid otherwise swallows
  // PowerShell/Get-CimInstance failures into `null`, making the
  // production CLI conflate transient WMI hiccups with a confirmed
  // missing process — Unit 11 would enter recovery on a one-off
  // PowerShell crash. With throwOnError, the runner failure propagates,
  // the surrounding try/catch sets pidLookupFailed, and pidAlive
  // resolves to null ("couldn't tell"). Codex round 5 [P1].
  const expectedSessionName = sessionName || defaultSessionName(phaseId, role);
  let pid = null;
  let pidLookupFailed = false;
  if (_pidSnapshot !== undefined) {
    // Batching seam (todo 086): the orchestrator handed us a Map (or
    // plain object) with the WMI snapshot for the whole tick. The
    // snapshot is authoritative for "did we observe this session in
    // the snapshot?" — no transient-failure case applies because the
    // whole tick's snapshot succeeded as a single PowerShell call
    // upstream. Note: this only resolves `pid` from the snapshot;
    // the startup-grace overlay below still fires when `started_at`
    // is fresh, so a snapshot taken mid-spawn still surfaces as
    // pidAlive: null + 'startup_grace' rather than 'session_not_found'.
    const entry =
      _pidSnapshot instanceof Map
        ? _pidSnapshot.get(expectedSessionName)
        : _pidSnapshot[expectedSessionName];
    if (entry && Number.isInteger(entry.pid) && entry.pid > 0) {
      pid = entry.pid;
    } else {
      pid = null;
    }
  } else {
    const lookup =
      _pidLookup ||
      ((name) =>
        getSessionPid(name, { excludeWrappers: true, throwOnError: true }));
    try {
      const found = lookup(expectedSessionName);
      pid = Number.isInteger(found) && found > 0 ? found : null;
    } catch (_) {
      // Distinct from "lookup returned null": the lookup itself errored
      // (transient WMI failure, blocked PowerShell, network share
      // hiccup). Per the public contract, that is "couldn't decide" —
      // pidAlive: null — not a confirmed missing process. Otherwise the
      // orchestrator would enter recovery on a transient hiccup.
      pidLookupFailed = true;
      pid = null;
    }
  }

  // --- PID liveness. The verdict is tri-state (true | false | null) so
  // Unit 11 can render the cases differently. The `pidAliveReason`
  // field (todo 071, PR #17) disambiguates the three sources of
  // `null`:
  //   - lookup threw → pidAlive: null, reason 'lookup_failed' (re-poll)
  //   - lookup returned null + within startup grace → null, 'startup_grace' (re-poll, deterministic resolve)
  //   - lookup returned null + past startup grace → null, 'session_not_found' (post-grace = treat as crash)
  //   - lookup returned null + no status entry → null, 'session_not_found' (no started_at to ground a grace window)
  //   - lookup returned PID, kill ESRCH → pidAlive: false (kernel said gone — strongest dead signal)
  //   - lookup returned PID, kill ok/EPERM → pidAlive: true
  //   - lookup returned PID, kill unknown errno → null, 'lookup_failed'
  //
  // BEHAVIOR CHANGE vs PR #15: WMI lookup returning null PAST the grace
  // window used to surface as `pidAlive: false`. PR #17 makes that
  // case `pidAlive: null + reason 'session_not_found'` so Unit 11's
  // tri-state convergence ("two consecutive nulls past grace = crash")
  // applies uniformly. ESRCH from `kill(pid, 0)` STAYS `pidAlive: false`
  // — we had a PID and the kernel said it's gone.
  let pidAlive;
  let pidAliveReason = null;
  if (pidLookupFailed) {
    pidAlive = null;
    pidAliveReason = 'lookup_failed';
  } else if (pid === null) {
    if (statusEntry) {
      // Canonical name is `started_at` (snake_case parity with
      // parse-manifest.KNOWN_UPDATE_FIELDS). The pre-PR-#17 fallback
      // to `spawned_at` was dropped in todo 078 — see spawnSession's
      // docstring for the writer-side rename rule.
      const startedMs = coerceTimestampMs(statusEntry.started_at);
      if (startedMs !== null && now - startedMs < startupGraceMs) {
        pidAlive = null;
        pidAliveReason = 'startup_grace';
      } else {
        pidAlive = null;
        pidAliveReason = 'session_not_found';
      }
    } else {
      pidAlive = null;
      pidAliveReason = 'session_not_found';
    }
  } else {
    pidAlive = isPidAlive(pid, _killer);
    if (pidAlive === null) {
      // kill returned an unknown errno — same wire value as a runner
      // failure (Unit 11 treats them identically: re-poll).
      pidAliveReason = 'lookup_failed';
    }
  }

  // --- Timeout check. Field name is `started_at` per parse-manifest's
  // KNOWN_UPDATE_FIELDS (snake_case canonical). The PR-#15 fallback to
  // `spawned_at` was dropped in todo 078 — preserving it codified the
  // ambiguity rather than enforcing the choice. Writers persisting
  // spawn-session's camelCase `spawnedAt` return must rename to
  // `started_at` at the manifest-status boundary.
  let timedOut = false;
  if (statusEntry) {
    const startedMs = coerceTimestampMs(statusEntry.started_at);
    if (startedMs !== null) {
      const deadlineMs = startedMs + timeoutMinutes * 60_000;
      if (now > deadlineMs) timedOut = true;
    }
  }

  // --- Heartbeat scan. The protocol-header.md convention places
  // heartbeat at <phase_dir>/heartbeat.jsonl. Empty / missing /
  // malformed-tail file = no usable heartbeat (heartbeatAge: null,
  // heartbeatStale: false — nothing to compare against).
  const heartbeatPath = path.join(resolvedPhaseDir, 'heartbeat.jsonl');
  let heartbeatAge = null;
  let heartbeatStale = false;
  let heartbeatCorrupt = false;
  let heartbeatTruncated = false;
  if (existsSync(heartbeatPath)) {
    // Filter by role: in multi-role phases the heartbeat file is
    // shared (impl + qa append to the same file), and each entry
    // carries its `role`. Without a filter, a fresh impl write would
    // mask a dead qa. Codex round 6 [P2].
    //
    // Tail-read fixed window (todo 067, PR #17): bounded memory and
    // CPU regardless of file size. See readHeartbeatRecord for the
    // expansion strategy and the > 1 MiB give-up policy.
    const parsed = readHeartbeatRecord(heartbeatPath, role, {
      _openSync,
      _fstatSync,
      _readSync,
      _closeSync,
    });
    if (parsed) {
      // Todo 083 (PR #17): the `corrupt` flag rides alongside the
      // freshness reading. It's set when ANY non-parseable line was
      // encountered during the walk, even if an older valid record
      // was eventually found.
      if (parsed.corrupt === true) heartbeatCorrupt = true;
      // ce:review round 2 (PR #17): tail-exhausted on a >1 MiB file.
      // Combined with heartbeatStale: true, this is the coarse
      // "we know the role is stale but couldn't compute exact age"
      // signal. Always implies stale — pre-PR-#17 the full-file
      // scan surfaced this case as `heartbeatStale: true` directly.
      if (parsed.truncated === true) {
        heartbeatTruncated = true;
        heartbeatStale = true;
      }
      if (Number.isFinite(parsed.tsMs)) {
        const ageMs = Math.max(0, now - parsed.tsMs);
        heartbeatAge = Math.floor(ageMs / 1000);
        heartbeatStale = ageMs > effectiveStaleMs;
      }
    }
  }

  // --- Last checkpoint. Phase directory missing is surfaced as a
  // dominant error per the dispatch: alive flips to false, error is set.
  // PID + heartbeat fields are still populated so a debugger can see
  // the partial signals.
  let lastCheckpoint = null;
  let phaseDirMissing = false;
  if (existsSync(resolvedPhaseDir)) {
    lastCheckpoint = findLastCheckpoint(resolvedPhaseDir, _readdirSync, _statSync);
  } else {
    phaseDirMissing = true;
  }

  const computedAlive = pidAlive === true && !timedOut;
  const result = {
    schema_version: 1,
    alive: phaseDirMissing ? false : computedAlive,
    pidAlive,
    pidAliveReason,
    timedOut,
    heartbeatAge,
    heartbeatStale,
    heartbeatCorrupt,
    heartbeatTruncated,
    lastCheckpoint,
  };
  if (phaseDirMissing) {
    result.error = `phase directory not found: ${resolvedPhaseDir}`;
    // Mid-flight diagnostic, not a config failure (todo 072): the
    // manifest validated, the phase id is real — the directory is
    // just gone (crashed mid-run, scaffold lost, transient FS race).
    // Unit 11 policy: count toward recovery heuristic but keep
    // polling. The other diagnostic fields (`pidAlive`, `timedOut`,
    // `heartbeatAge`) remain meaningful in this state.
    result.errorKind = 'runtime';
  }
  return result;
}

// -------------------- CLI --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  check-health.js --phase <id> --role <role> --manifest <path>',
      '                  [--startup-grace-ms <n>] [--heartbeat-stale-ms <n>]',
      '',
      '  --phase     Required. Phase id (matches [A-Za-z0-9._-]+).',
      '  --role      Required. One of impl, qa, coord.',
      '  --manifest  Required. Path to manifest YAML.',
      '',
      '  --startup-grace-ms <n>',
      '              Optional. Non-negative integer milliseconds. Treats',
      '              `pidAlive: null` instead of false when the WMI lookup',
      '              misses but `started_at` is within this window. No',
      '              manifest fallback exists for this knob; the CLI flag',
      '              is the only override. Default: 60000 (60s).',
      '',
      '  --heartbeat-stale-ms <n>',
      '              Optional. Non-negative integer milliseconds. Threshold',
      '              for `heartbeatStale`. Precedence: this flag >',
      '              manifest defaults.heartbeat_timeout_minutes (× 60000) >',
      '              built-in default 300000 (5m).',
      '',
      'OUTPUT (schema_version: 1):',
      '  Single JSON object on stdout. Field order, names, and types:',
      '',
      '  schema_version (number | string)',
      '      The output-schema version. V1 emits the integer 1.',
      '      Consumers (e.g. orchestrate.js) accept MAJOR or',
      '      MAJOR.MINOR forms (todo 101). Major bumps are',
      '      breaking — consumers refuse to parse unfamiliar majors.',
      '      Minor bumps are forward-compat — consumers warn but',
      '      proceed (existing field semantics unchanged; new',
      '      fields are ignored).',
      '',
      '  alive (boolean)',
      '      Aggregate verdict — true iff pidAlive === true AND not',
      '      timedOut AND no error.',
      '',
      '  pidAlive (true | false | null)',
      '      Tri-state. true: process is running. false: process is',
      '      DEFINITIVELY gone (we held a PID and the kernel said',
      '      ESRCH). null: COULDN\'T DECIDE — Unit 11 must NOT trigger',
      '      recovery on a single null; require a tri-state convergence',
      '      ("two consecutive nulls past startup grace = treat as',
      '      crash"). See pidAliveReason for which null this is.',
      '',
      '  pidAliveReason (string | null)',
      '      Set only when pidAlive === null. One of:',
      '        - "startup_grace": within startup grace window; PID',
      '          lookup not yet meaningful — re-poll, deterministic',
      '          resolve as the agent registers with WMI.',
      '        - "lookup_failed": runner error or transient WMI/',
      '          process.kill failure — re-poll up to N times.',
      '        - "session_not_found": WMI lookup returned no match',
      '          past startup grace; treat as crash on convergence.',
      '      null when pidAlive is true or false (no ambiguity to',
      '      disambiguate). A single null reading is NEVER',
      '      sufficient to trigger recovery — see pidAlive\'s',
      '      tri-state convergence rule.',
      '',
      '  timedOut (boolean)',
      '      true when now - started_at > timeout_minutes. Independent',
      '      of pidAlive — a still-running process past its deadline',
      '      times out.',
      '',
      '  heartbeatAge (number | null)',
      '      Seconds since the most recent role-matching heartbeat.',
      '      null when no usable heartbeat record exists.',
      '',
      '  heartbeatStale (boolean)',
      '      heartbeatAge > effective stale threshold. Stale alone is',
      '      ADVISORY (agents drop heartbeats during atomic ops);',
      '      stale-AND-pidAlive-false is a strong "dead" signal that',
      '      Unit 11 may compose itself.',
      '',
      '  heartbeatCorrupt (boolean)',
      '      true when the role-filter walk encountered any',
      '      non-parseable line — even when an older valid record was',
      '      eventually salvaged. Advisory; Unit 11 reads as "possibly',
      '      hung agent producing garbage" (orthogonal to the',
      '      freshness verdict).',
      '',
      '  heartbeatTruncated (boolean)',
      '      true when the heartbeat tail-read exhausted its largest',
      '      window (1 MiB) without finding a role-matching record on',
      '      a non-trivial file. Always implies heartbeatStale: true —',
      '      the role hasn\'t emitted in at least the size of the tail',
      '      window, but exact heartbeatAge cannot be computed from a',
      '      bounded read. Pre-PR-#17 the full-file scan surfaced this',
      '      case as heartbeatStale: true directly; the new field lets',
      '      Unit 11 distinguish "stale with known age" from "stale,',
      '      age unknown."',
      '',
      '  lastCheckpoint (string | null)',
      '      basename of the most-recently-modified non-transient file',
      '      in the phase directory, or null if absent. The recovery',
      '      anchor — Unit 11 names this in retry prompts.',
      '',
      '  error (string, optional)',
      '      Human-readable detail. Present only on error paths',
      '      (config / runtime — see errorKind).',
      '',
      '  errorKind ("config" | "runtime", optional)',
      '      Set in tandem with `error`. "config" = pre-flight failure',
      '      (manifest missing/invalid/phase absent) — Unit 11 should',
      '      pause and surface to operator. "runtime" = mid-flight',
      '      diagnostic (phase directory missing) — Unit 11 keeps',
      '      polling and treats as recovery candidate. Distinguish',
      '      via this field; do NOT regex against `error` strings.',
      '',
      'Worked example (success path):',
      '  {',
      '    "schema_version": 1,',
      '    "alive": true,',
      '    "pidAlive": true,',
      '    "pidAliveReason": null,',
      '    "timedOut": false,',
      '    "heartbeatAge": 12,',
      '    "heartbeatStale": false,',
      '    "heartbeatCorrupt": false,',
      '    "heartbeatTruncated": false,',
      '    "lastCheckpoint": "impl-prompt.md"',
      '  }',
      '',
      'Exit codes:',
      '  0 — check completed (regardless of alive/dead verdict)',
      '  1 — input validation error',
    ].join('\n')
  );
}

// Parse a non-negative integer CLI argument. Empty string and undefined
// (missing arg) are explicit errors — the empty-string-as-explicit-
// override class of bug bit PR #13 codex round, and the dispatch's
// institutional memory called it out for these specific flags. Returns
// the parsed integer; throws Error on invalid input.
function parseNonNegativeIntFlag(flag, raw) {
  if (raw === undefined || raw === '')
    throw new Error(`${flag} requires a non-negative integer (got ${JSON.stringify(raw)})`);
  // Number('   ') === 0, which would silently accept whitespace-only
  // input. Trim explicitly first so the error message matches what the
  // operator typed.
  const trimmed = String(raw).trim();
  if (trimmed === '')
    throw new Error(`${flag} requires a non-negative integer (got ${JSON.stringify(raw)})`);
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0)
    throw new Error(`${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

// Throws Error on invalid argv (caller — main() — catches and calls
// fail() to convert to a non-zero exit). `--help` short-circuits via
// process.exit(0) directly because help-then-exit is the desired
// flow for the user, not an error.
function parseCliArgs(argv) {
  const out = {
    phaseId: null,
    role: null,
    manifestPath: null,
    startupGraceMs: undefined,
    heartbeatStaleMs: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--phase':
        out.phaseId = argv[++i];
        break;
      case '--role':
        out.role = argv[++i];
        break;
      case '--manifest':
        out.manifestPath = argv[++i];
        break;
      case '--startup-grace-ms':
        out.startupGraceMs = parseNonNegativeIntFlag('--startup-grace-ms', argv[++i]);
        break;
      case '--heartbeat-stale-ms':
        out.heartbeatStaleMs = parseNonNegativeIntFlag('--heartbeat-stale-ms', argv[++i]);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!out.phaseId) throw new Error('--phase is required (see --help)');
  if (!out.role) throw new Error('--role is required (see --help)');
  if (!out.manifestPath) throw new Error('--manifest is required (see --help)');
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write(`check-health: ${msg}\n`);
  process.exit(code);
}

function main() {
  let args;
  try {
    args = parseCliArgs(process.argv);
  } catch (e) {
    fail(e.message);
  }
  let result;
  try {
    result = checkHealth({
      phaseId: args.phaseId,
      role: args.role,
      manifestPath: args.manifestPath,
      startupGraceMs: args.startupGraceMs,
      heartbeatStaleMs: args.heartbeatStaleMs,
    });
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  checkHealth,
  isPidAlive,
  parseHeartbeatTail,
  readHeartbeatRecord,
  findLastCheckpoint,
  readPhaseStatus,
  coerceTimestampMs,
  asPositiveInt,
  defaultPhaseDir,
  defaultSessionName,
  parseCliArgs,
  parseNonNegativeIntFlag,
  VALID_ROLES,
  DEFAULT_TIMEOUT_MINUTES,
  HEARTBEAT_STALE_MS,
  DEFAULT_STARTUP_GRACE_MS,
  HEARTBEAT_TAIL_WINDOW_BYTES,
  MAX_CHECKPOINT_ENTRIES,
  CHECKPOINT_EXCLUDE_NAMES,
  CHECKPOINT_EXCLUDE_SUFFIXES,
};
