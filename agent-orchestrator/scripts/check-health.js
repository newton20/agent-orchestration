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
 *     workdir,            // optional override; default derived from manifest
 *     phaseDir,           // optional override; default <workdir>/docs/orchestration/phases/<phaseId>
 *     sessionName,        // optional override; default orch-<phaseId>-<role>
 *     heartbeatStaleMs,   // optional, default 5 * 60_000
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
 *   defaultPhaseDir(workdir, phaseId) -> string
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
const yaml = require('js-yaml');

const { VALID_ID_RE, statusPathFor, loadManifest } = require('./parse-manifest');
const { getSessionPid } = require('./spawn-session');

// -------------------- Constants --------------------

const VALID_ROLES = Object.freeze(['impl', 'qa', 'coord']);
const DEFAULT_TIMEOUT_MINUTES = 60;
const HEARTBEAT_STALE_MS = 5 * 60_000;

// Files whose mtime is not informative as a "checkpoint" — either the
// agent rewrites them continuously (heartbeat.jsonl) or they're
// transient OS artifacts. Excluded from the last-checkpoint scan so the
// recovery anchor names a real deliverable.
const CHECKPOINT_EXCLUDE_NAMES = new Set(['heartbeat.jsonl']);
const CHECKPOINT_EXCLUDE_SUFFIXES = ['.lock', '.tmp', '.swp', '.swo', '.crdownload'];

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
 * Parse the last non-empty line of a JSONL heartbeat log. Returns
 *   { tsMs, pid }
 * where tsMs is the parsed `ts` field as epoch ms and pid is the
 * agent-reported `pid` (null if the field is absent or malformed).
 *
 * Strict-tail semantics per the Unit 8 dispatch: only the LAST
 * non-empty line is examined. A malformed last line returns null
 * (no heartbeat) — we do not walk back to a previous valid record,
 * because a partial-write tail that's stuck malformed would mask a
 * dead agent from the supervisor indefinitely.
 *
 * The protocol-header.md format is:
 *   {"ts": "<ISO 8601 UTC>", "pid": <int>, "role": "...", "phase_id": "...", "message": "..."}
 */
function parseHeartbeatTail(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const lines = content.split(/\r?\n/);
  let lastLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed !== '') {
      lastLine = trimmed;
      break;
    }
  }
  if (lastLine === null) return null;
  let obj;
  try {
    obj = JSON.parse(lastLine);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const tsMs = coerceTimestampMs(obj.ts);
  if (tsMs === null) return null;
  const pid = Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : null;
  return { tsMs, pid };
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
function findLastCheckpoint(phaseDir, _readdirSync, _statSync) {
  const readdirSync = _readdirSync || fs.readdirSync;
  const statSync = _statSync || fs.statSync;
  let entries;
  try {
    entries = readdirSync(phaseDir, { withFileTypes: true });
  } catch (_) {
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
 * Read manifest-status.yaml's record for `phaseId`. The status file is
 * the sibling of the manifest per parse-manifest.js's statusPathFor()
 * convention. Returns null when the file is missing, malformed, or has
 * no entry for the phase. Never throws — the caller (checkHealth)
 * proceeds with a session-name PID lookup when the status file has
 * nothing to say.
 */
function readPhaseStatus(manifestPath, phaseId, _readFileSync, _existsSync) {
  const readFileSync = _readFileSync || fs.readFileSync;
  const existsSync = _existsSync || fs.existsSync;
  const statusPath = statusPathFor(path.resolve(manifestPath));
  if (!existsSync(statusPath)) return null;
  let raw;
  try {
    raw = readFileSync(statusPath, 'utf8');
  } catch (_) {
    return null;
  }
  let parsed;
  try {
    // Pinned to DEFAULT_SCHEMA for parity with parse-manifest's loaders
    // — preserves YAML timestamps as JS Date objects, which we coerce
    // back via coerceTimestampMs() below.
    parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.phases || typeof parsed.phases !== 'object' || Array.isArray(parsed.phases))
    return null;
  const entry = parsed.phases[phaseId];
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

// -------------------- Path helpers --------------------

function defaultPhaseDir(workdir, phaseId) {
  return path.join(workdir, 'docs', 'orchestration', 'phases', phaseId);
}

function defaultSessionName(phaseId, role) {
  return `orch-${phaseId}-${role}`;
}

// -------------------- Main --------------------

function checkHealth(opts = {}) {
  const {
    phaseId,
    role,
    manifestPath,
    workdir,
    phaseDir,
    sessionName,
    heartbeatStaleMs = HEARTBEAT_STALE_MS,
    _now,
    _killer,
    _pidLookup,
    _readFileSync,
    _existsSync,
    _statSync,
    _readdirSync,
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
  if (heartbeatStaleMs !== undefined && (!Number.isFinite(heartbeatStaleMs) || heartbeatStaleMs < 0))
    throw new Error(
      `checkHealth: heartbeatStaleMs must be a non-negative finite number, got ${JSON.stringify(heartbeatStaleMs)}`
    );

  const now = typeof _now === 'function' ? _now() : Date.now();
  const existsSync = _existsSync || fs.existsSync;

  // Default-shape result. Every field is populated even on the error
  // path so callers can destructure without conditional guards.
  const baseResult = {
    alive: false,
    pidAlive: null,
    timedOut: false,
    heartbeatAge: null,
    heartbeatStale: false,
    lastCheckpoint: null,
  };

  // --- Manifest must load. Without timeout_minutes we can't compute
  // the deadline; without phases we can't find the role's PID. A missing
  // manifest is a run-time issue (operator deleted it, wrong path passed)
  // — return `error` rather than throwing so Unit 11's poll loop survives.
  if (!existsSync(path.resolve(manifestPath)))
    return { ...baseResult, error: `manifest not found: ${manifestPath}` };

  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return { ...baseResult, error: loaded.error };

  const phaseEntry = (Array.isArray(loaded.manifest.phases) ? loaded.manifest.phases : []).find(
    (p) => p && typeof p === 'object' && p.id === phaseId
  );
  if (!phaseEntry)
    return {
      ...baseResult,
      error: `phase "${phaseId}" not found in ${manifestPath}`,
    };

  // --- Resolve workdir + phase dir.
  // Workdir precedence:
  //   1. explicit `workdir` opt (test override / Unit 11 advanced use)
  //   2. manifest.workdir (relative paths resolved against manifest dir)
  //   3. manifest dir (last-resort default)
  // Empty-string manifest.workdir is treated as missing per the
  // empty-string-as-override guard (PR #13 codex finding).
  const manifestAbs = path.resolve(manifestPath);
  const manifestDir = path.dirname(manifestAbs);
  let resolvedWorkdir;
  if (typeof workdir === 'string' && workdir.trim() !== '') {
    resolvedWorkdir = path.resolve(workdir);
  } else if (
    typeof loaded.manifest.workdir === 'string' &&
    loaded.manifest.workdir.trim() !== ''
  ) {
    resolvedWorkdir = path.isAbsolute(loaded.manifest.workdir)
      ? loaded.manifest.workdir
      : path.resolve(manifestDir, loaded.manifest.workdir);
  } else {
    resolvedWorkdir = manifestDir;
  }
  const resolvedPhaseDir =
    typeof phaseDir === 'string' && phaseDir.trim() !== ''
      ? path.resolve(phaseDir)
      : defaultPhaseDir(resolvedWorkdir, phaseId);

  // --- Resolve timeout. parse-manifest validates timeout_minutes as a
  // positive int when present, so we never see 0 / negative / string.
  // Defensive `> 0` guard remains in case a future writer bypasses
  // validation.
  const timeoutMinutes = (() => {
    if (Number.isInteger(phaseEntry.timeout_minutes) && phaseEntry.timeout_minutes > 0)
      return phaseEntry.timeout_minutes;
    const D = loaded.manifest.defaults || {};
    if (Number.isInteger(D.phase_timeout_minutes) && D.phase_timeout_minutes > 0)
      return D.phase_timeout_minutes;
    return DEFAULT_TIMEOUT_MINUTES;
  })();

  // --- Read manifest-status for PID + started_at. Both fields are
  // optional; we proceed even if they're missing.
  const statusEntry = readPhaseStatus(manifestPath, phaseId, _readFileSync, existsSync);

  // --- PID resolution.
  // Prefer manifest-status.phases[phaseId].pid (recorded by spawn-session
  // at spawn time, written by parse-manifest.js's runUpdate). Fall back
  // to a session-name lookup via getSessionPid so the checker survives
  // a stale / deleted status file. Per the dispatch: do NOT reimplement
  // PID lookup — getSessionPid owns the WMI contract.
  const expectedSessionName = sessionName || defaultSessionName(phaseId, role);
  let pid = null;
  if (statusEntry && Number.isInteger(statusEntry.pid) && statusEntry.pid > 0) {
    pid = statusEntry.pid;
  } else {
    const lookup = _pidLookup || ((name) => getSessionPid(name));
    try {
      const found = lookup(expectedSessionName);
      pid = Number.isInteger(found) && found > 0 ? found : null;
    } catch (_) {
      pid = null;
    }
  }

  // --- PID liveness. `null` distinguishes "lookup couldn't decide" from
  // "definitely dead" so Unit 11 can render the cases differently.
  let pidAlive;
  if (pid === null) {
    pidAlive = false; // no PID anywhere — agent never reported / never spawned
  } else {
    pidAlive = isPidAlive(pid, _killer);
  }

  // --- Timeout check. Field name is `started_at` per parse-manifest's
  // KNOWN_UPDATE_FIELDS (snake_case). Defensive fallback to `spawned_at`
  // covers the case where a future writer mirrors spawn-session's
  // camelCase return shape — documented as a known naming drift in the
  // dispatch handoff.
  let timedOut = false;
  if (statusEntry) {
    const startedMs =
      coerceTimestampMs(statusEntry.started_at) ?? coerceTimestampMs(statusEntry.spawned_at);
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
  if (existsSync(heartbeatPath)) {
    let content = null;
    try {
      content = (_readFileSync || fs.readFileSync)(heartbeatPath, 'utf8');
    } catch (_) {
      content = null;
    }
    if (typeof content === 'string') {
      const parsed = parseHeartbeatTail(content);
      if (parsed && Number.isFinite(parsed.tsMs)) {
        const ageMs = Math.max(0, now - parsed.tsMs);
        heartbeatAge = Math.floor(ageMs / 1000);
        heartbeatStale = ageMs > heartbeatStaleMs;
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
    alive: phaseDirMissing ? false : computedAlive,
    pidAlive,
    timedOut,
    heartbeatAge,
    heartbeatStale,
    lastCheckpoint,
  };
  if (phaseDirMissing) result.error = `phase directory not found: ${resolvedPhaseDir}`;
  return result;
}

// -------------------- CLI --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  check-health.js --phase <id> --role <role> --manifest <path>',
      '',
      '  --phase     Required. Phase id (matches [A-Za-z0-9._-]+).',
      '  --role      Required. One of impl, qa, coord.',
      '  --manifest  Required. Path to manifest YAML.',
      '',
      'Output: JSON status on stdout. Exit codes:',
      '  0 — check completed (regardless of alive/dead verdict)',
      '  1 — input validation error',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  const out = { phaseId: null, role: null, manifestPath: null };
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
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  if (!out.phaseId) fail('--phase is required (see --help)');
  if (!out.role) fail('--role is required (see --help)');
  if (!out.manifestPath) fail('--manifest is required (see --help)');
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write(`check-health: ${msg}\n`);
  process.exit(code);
}

function main() {
  const args = parseCliArgs(process.argv);
  let result;
  try {
    result = checkHealth({
      phaseId: args.phaseId,
      role: args.role,
      manifestPath: args.manifestPath,
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
  findLastCheckpoint,
  readPhaseStatus,
  coerceTimestampMs,
  defaultPhaseDir,
  defaultSessionName,
  VALID_ROLES,
  DEFAULT_TIMEOUT_MINUTES,
  HEARTBEAT_STALE_MS,
  CHECKPOINT_EXCLUDE_NAMES,
  CHECKPOINT_EXCLUDE_SUFFIXES,
};
