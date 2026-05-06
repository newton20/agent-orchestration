#!/usr/bin/env node
/**
 * orchestrate.js — Unit 11. Stateless event loop that wires every prior
 * unit (manifest parse, scaffold, spawn, prompt generation, health check)
 * into a single Node.js process the `/orchestrate` skill spawns.
 *
 * The orchestrator owns three responsibilities:
 *
 *   1. Advance phases. For each `pending` phase whose `depends_on` are
 *      `completed`: render prompts, write `.pending-<sessionName>`
 *      flag files (Unit 4.5 hook protocol), spawn sessions, persist
 *      `started_at` + `pid` to manifest-status, transition to `running`.
 *
 *   2. Monitor running phases. For each `running` phase: call checkHealth
 *      per role; detect completion signals; convert tri-state pidAlive
 *      readings into recovery decisions via N-tick convergence; respawn
 *      crashed agents with the recovery template up to `max_recovery_retries`;
 *      escalate past the budget.
 *
 *   3. Run review loops. When an `impl` completion signal lands on a
 *      phase with `review_loop.enabled`, spawn QA. When QA's verdict
 *      passes, mark the phase `completed`. When QA's verdict fails and
 *      iterations < `review_loop.max_iterations`, respawn impl with a
 *      fresh prompt that includes the prior verdict's failures. Past
 *      max iterations, escalate to the operator.
 *
 * **Stateless invariant.** The manifest + manifest-status files ARE the
 * state. Every tick re-reads both. The only in-memory state that
 * survives across ticks is *transient diagnostic state* — the
 * convergence-counter map (consecutive `pidAlive: null` readings before
 * recovery fires). Loss of that map on process restart simply delays a
 * recovery decision by N ticks; correctness is preserved because the
 * file protocol is the source of truth. Documented as design decision
 * #10 below.
 *
 * **Stateless does NOT mean "no caching within a tick."** Per
 * architecture-strategist's todo 086 recommendation (PR #17 ce:review),
 * the per-tick `pollAllPhases` loads the manifest, the status, and a
 * PID snapshot ONCE and threads them through every per-phase
 * `checkHealth` call via the `_loadedManifest` / `_loadedStatus` /
 * `_pidSnapshot` injection seams. This trades an in-tick cache for
 * O(1) PowerShell calls per tick instead of O(N×roles).
 *
 * **No `claude -p` calls.** V1 is template-only. The recovery template
 * renders with the original role (`impl` / `qa` / `coord`); the V1.5
 * recovery-analyst LLM step is deferred (plan §V1.5 Deferred Units,
 * Unit 9). Adding LLM calls here exhausts the orchestrator's context
 * window — the whole point of a Node.js process is to avoid that.
 *
 * Public API (programmatic, exported for tests + future MCP/web callers):
 *
 *   runOrchestrator(opts) -> Promise<{ ok, summary, history }>
 *     Main loop. Returns when all phases reach a terminal status
 *     (`completed` / `failed`), the `signal` aborts, or `maxTicks`
 *     elapses. Caller is responsible for releasing the lockfile via the
 *     returned `lockPath` if the loop exits non-normally.
 *
 *   pollAllPhases(opts) -> { ok, manifest, phases, status, pidSnapshot, error?, errorKind? }
 *     Single-tick state load. Useful for tests + future operator
 *     dashboards.
 *
 *   decideTickActions(tickState, runState, opts) -> Action[]
 *     Pure function: given a tick's loaded state, return the list of
 *     actions the orchestrator should take. Tests assert on actions
 *     without executing side effects.
 *
 *   executeActions(actions, tickState, runState, opts) -> { warnings, completed, failed }
 *     Side-effect path. Tests inject fake `_spawnSession` / `_runUpdate`
 *     / `_generatePrompt` to verify writes without touching real disk.
 *
 *   acquireLock(orchDir, opts) -> string  // path
 *   releaseLock(lockPath)
 *
 * CLI:
 *   orchestrate.js <manifest.yaml>
 *   orchestrate.js --resume <manifest.yaml>
 *   orchestrate.js --once <manifest.yaml>           # single tick, then exit
 *   orchestrate.js --active-interval-ms <n>         # default 30000
 *   orchestrate.js --idle-interval-ms <n>           # default 120000
 *   orchestrate.js --max-recovery-retries <n>       # default 3
 *   orchestrate.js --converge-n <n>                 # default 3
 *   orchestrate.js --startup-grace-ms <n>           # default 60000
 *   orchestrate.js --plugin-dir <path>              # for templates copy
 *   orchestrate.js --project-name <s>               # rendered into prompts
 *   orchestrate.js --dry-run                        # no spawns, no writes
 *
 * Exit codes:
 *   0 — all phases reached `completed`
 *   1 — one or more phases reached `failed`, or fatal error
 *   2 — refused to start (lockfile contention)
 *
 * ============================================================
 * Unit-11-design-responsibility decisions (per dispatch).
 * Each cite is documented in code at the call site.
 * ============================================================
 *
 * 1. **Polling cadence: 30s active / 120s idle.**
 *    `DEFAULT_ACTIVE_INTERVAL_MS` and `DEFAULT_IDLE_INTERVAL_MS` below.
 *    Adaptive switch: `isActiveTick` returns true iff at least one
 *    phase is `running` this tick, false iff every phase is in a
 *    terminal status or `pending` with unmet deps.
 *
 * 2. **`pidAliveReason` convergence: 3 consecutive nulls past grace.**
 *    `DEFAULT_LOOKUP_FAILED_CONVERGE_N = 3`. Tri-state convergence
 *    fires recovery only after the heuristic threshold is met; a
 *    single null is never enough. Counters reset on the first non-null
 *    reading. `startup_grace` reasons do NOT count toward the heuristic.
 *
 * 3. **`errorKind: 'config'` vs `'runtime'` policy.**
 *    `config` (manifest invalid / phase id absent) → mark phase
 *    `blocked` + log structured terminal block + halt orchestrator
 *    polling on that phase until the config issue resolves. The
 *    operator must edit the manifest for the orchestrator to advance.
 *    `runtime` (phase dir missing) → keep polling, log advisory,
 *    treat the next non-runtime tick as the recovery candidate.
 *
 * 4. **`schema_version: 1` consumption.**
 *    `expectSchemaVersion` checks every checkHealth result. Mismatch
 *    is a fatal error (refuse to silently process newer majors). See
 *    `assertSchemaVersion`.
 *
 * 5. **`heartbeatTruncated` advisory: log + continue.**
 *    Non-blocking. We log at debug level and do NOT trigger recovery
 *    on truncation alone — the role hasn't emitted in >1 MiB of
 *    heartbeat-file activity, but PID + completion-signal remain the
 *    primary signals.
 *
 * 6. **Recovery role addition path (V1.5).**
 *    `VALID_ROLES` from parse-manifest is the single source of truth.
 *    Adding a recovery-analyst role (V1.5) requires:
 *      a. Append `'recovery-analyst'` to parse-manifest.VALID_ROLES.
 *      b. Add a template (`recovery-analyst-prompt.md`) under
 *         templates/ + register it in generate-prompt.ROLE_TEMPLATES.
 *      c. Update orchestrate.js's recovery branch to invoke `claude -p`
 *         with the recovery-analyst prompt for prompt-generation
 *         decisions. The retry counter / original-prompt-preservation
 *         contracts stay unchanged.
 *
 * 7. **Writer-side `started_at` rename (todo 087).**
 *    `persistSpawnMetadata` translates spawn-session's camelCase
 *    `spawnedAt` → snake_case `started_at` AT THE SEAM. This is
 *    Option A from todo 087's body — the sole translation lives in
 *    Unit 11 between spawn-session output and parse-manifest's
 *    runUpdate. spawn-session's docstring already directs callers to
 *    rename; check-health.js reads only `started_at` (the
 *    `spawned_at` fallback was dropped in todo 078).
 *
 * 8. **`pollAllPhases` batch-API surface.**
 *    Public function. Loads manifest + status + PID snapshot once per
 *    tick. Threaded into every per-phase `checkHealth` via the
 *    underscore-prefixed batching seams from todo 086.
 *
 * 9. **`_pidSnapshot` shape: `Map<sessionName, { pid }>`.**
 *    `buildPidSnapshot` builds a Map. The shape is the documented
 *    contract for any future caller that wants to pre-fetch PIDs
 *    (e.g., a web dashboard).
 *
 * 10. **`_loadedManifest` staleness policy.**
 *    Each tick re-reads the manifest. Cached values are valid for
 *    one tick only; the next call to `pollAllPhases` invalidates
 *    them. Downstream callers (today: `decideTickActions`,
 *    `executeActions`) MUST NOT cache across ticks.
 *
 * Convergence counters note: the tri-state heuristic counts ARE
 * in-memory across ticks (per phase/role). On orchestrator restart the
 * counters reset to zero — recovery is delayed by at most N ticks,
 * never silently skipped, because a confirmed `pidAlive: false`
 * (kernel ESRCH) escalates immediately regardless of counter state.
 *
 * V1.5 deferred — concurrent multi-manifest runs:
 *   - Session names are `orch-<phase>-<role>` (no manifest identity).
 *     Two orchestrators running DIFFERENT manifests with overlapping
 *     phase ids would both spawn `orch-phase-1-impl`; PID lookup is
 *     global and would conflate the two. V1 contract: one
 *     orchestrator instance per machine OR ensure phase ids are
 *     unique across all simultaneous manifests. V1.5 will namespace
 *     session names by a manifest-derived hash. Codex round 22 P2.
 *   - The shared-workdir secondary lockfile (codex round 22 P2)
 *     prevents two manifests from racing on the SAME workdir's
 *     `.pending-*` directory — refuse-to-start if the workdir lock
 *     is held by another manifest. Concurrent runs across DIFFERENT
 *     workdirs remain unrestricted.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

const {
  loadManifest,
  loadStatus,
  runUpdate,
  validate,
  findDanglingDeps,
  normalizePhases,
  statusPathFor,
  VALID_ID_RE,
  VALID_ROLES,
} = require('./parse-manifest');
const { scaffoldProtocol } = require('./scaffold-protocol');
const {
  spawnSession,
  buildPidLookupArgs,
  parsePidLookupOutput,
} = require('./spawn-session');
const { generatePrompt } = require('./generate-prompt');
const { checkHealth } = require('./check-health');

// -------------------- Constants --------------------

// Polling cadence (design decision #1). Active = at least one phase
// running this tick; idle = no phases running. The adaptive switch
// keeps disk + WMI pressure low when nothing is happening, and tightens
// to 30s when the orchestrator is actively driving phases. Operator
// override via --active-interval-ms / --idle-interval-ms.
const DEFAULT_ACTIVE_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_INTERVAL_MS = 120_000;

// Recovery budget (design decision per dispatch — same for QA review
// loop and crash retries; the dispatch's "max 3" applies to both, with
// distinct counters).
const DEFAULT_MAX_RECOVERY_RETRIES = 3;
const DEFAULT_REVIEW_LOOP_MAX_ITERATIONS = 3;

// Tri-state convergence (design decision #2). N consecutive `pidAlive:
// null` readings (with reason `lookup_failed` OR `session_not_found`)
// past startup grace before recovery fires. `startup_grace` reasons do
// NOT count toward the heuristic — the agent is still spawning.
const DEFAULT_LOOKUP_FAILED_CONVERGE_N = 3;

// Startup grace (forwarded to checkHealth as `startupGraceMs`). Default
// matches check-health's DEFAULT_STARTUP_GRACE_MS so behavior is
// consistent unless the operator overrides.
const DEFAULT_STARTUP_GRACE_MS = 60_000;

// Schema version we accept from checkHealth. Bumping check-health's
// schema_version is a breaking change — we refuse to silently process a
// newer major (design decision #4).
const SCHEMA_VERSION_EXPECTED = 1;

/**
 * Todo 101: parse a checkHealth-output `schema_version` value into
 * `{ major, minor }`. Accepts:
 *   - integer N             → { major: N, minor: 0 }
 *   - string "N"            → { major: N, minor: 0 }
 *   - string "N.M"          → { major: N, minor: M } (N, M ∈ ℕ₀)
 * Rejects (returns null):
 *   - null / undefined / NaN
 *   - non-integer numbers (1.5)
 *   - strings with more than one dot ("1.0.x")
 *   - non-numeric strings ("abc")
 *   - empty string
 *
 * Pre-fix the orchestrator hard-failed on ANY mismatch — a V1.5
 * minor bump from `1` to `1.1` would have broken every consumer.
 * The MAJOR / MAJOR.MINOR soft-band lets minor versions advance
 * compatibly while still fast-failing major bumps that are by
 * definition breaking.
 */
function parseSchemaVersion(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return null;
    return { major: v, minor: 0 };
  }
  if (typeof v !== 'string' || v === '') return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const parts = v.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parts.length === 2 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (major < 0 || minor < 0) return null;
  return { major, minor };
}

// Maximum bytes a flag file may carry. Mirrors session-start.js's
// MAX_FLAG_BYTES so the writer + reader agree on the cap. Required so a
// runaway prompt generator can't write a flag larger than the hook will
// accept (the hook would reject the file and the agent would never
// receive its prompt).
const MAX_FLAG_BYTES = 256 * 1024;

// Lockfile basename. Lives at <manifestDir>/docs/orchestration/<this>.
const LOCKFILE_NAME = '.orchestrator.lock';

// -------------------- Path helpers --------------------

function defaultSessionName(phaseId, role) {
  return `orch-${phaseId}-${role}`;
}

function flagFilePath(orchDir, sessionName) {
  return path.join(orchDir, `.pending-${sessionName}`);
}

function phaseDirFor(manifestDir, phaseId) {
  return path.join(manifestDir, 'docs', 'orchestration', 'phases', phaseId);
}

function orchDirFor(manifestDir) {
  return path.join(manifestDir, 'docs', 'orchestration');
}

function templatesDirFor(manifestDir) {
  // Match scaffold-protocol's destination — templates are copied under
  // the protocol root, so prompt generation reads them from the live
  // operator-visible location (any local edits to a copied template
  // ship to the next dispatched agent).
  return path.join(manifestDir, 'docs', 'orchestration', 'templates');
}

function completionSignalFor(phaseDir, role) {
  return path.join(phaseDir, `${role}-complete.md`);
}

/**
 * Resolve the actual completion-signal path for a (manifest, phase,
 * role) tuple, honoring the manifest's `completion_signal` field when
 * appropriate (codex round 5 P2).
 *
 * Per docs/manifest-reference.md, each phase's `completion_signal` is
 * a path relative to the manifest's directory pointing at the
 * phase-level completion artifact. For single-role phases it's
 * unambiguous: that path IS the role's completion signal. For multi-
 * role phases the manifest's single field can describe at most one
 * role's signal — V1 convention assigns it to `impl` (the role
 * named in the default `<phaseDir>/impl-complete.md`); other roles
 * fall back to per-role naming.
 *
 * Returns an absolute path. The fallback (when `manifest.phase
 * .completion_signal` is absent / non-default for this role) is the
 * conventional `<phaseDir>/<role>-complete.md`.
 */
function resolveCompletionSignal(manifest, manifestDir, phaseId, role) {
  const phaseEntry = findRawPhase(manifest, phaseId);
  if (
    phaseEntry &&
    typeof phaseEntry.completion_signal === 'string' &&
    phaseEntry.completion_signal !== ''
  ) {
    const declared = path.isAbsolute(phaseEntry.completion_signal)
      ? phaseEntry.completion_signal
      : path.resolve(manifestDir, phaseEntry.completion_signal);
    // Codex round 6 P2: arbitrary path acceptance. The manifest's
    // completion_signal is the operator's authoritative declaration —
    // we should NOT silently fall back to convention because the
    // basename doesn't match `<role>-complete.md`. Two cases:
    //   1. Single-role phase OR phase with this role's impl-style
    //      basename — use the declared path verbatim. Includes
    //      arbitrary names like `signals/phase-0-done.md` for the
    //      role declared in `agents[]`.
    //   2. Multi-role phase whose declared path's basename matches a
    //      DIFFERENT role's default — use convention for the OTHER
    //      roles so each gets a distinct signal file.
    const phaseAgents = Array.isArray(phaseEntry.agents)
      ? phaseEntry.agents
      : phaseEntry.agent
        ? [phaseEntry.agent]
        : [];
    const declaredRoles = phaseAgents
      .map((a) => (a && typeof a.role === 'string' ? a.role : null))
      .filter(Boolean);
    const baseName = path.basename(declared);
    // Case 1a: phase declares only one role.
    if (declaredRoles.length <= 1) {
      // Single-role phase OR shorthand `agent` form — the declared
      // path is unambiguously this role's signal.
      if (declaredRoles.length === 0 || declaredRoles[0] === role) {
        return declared;
      }
    }
    // Multi-role phase. Two acceptance rules:
    //   a. Basename matches `<role>-complete.md` → declared path is
    //      this role's signal.
    //   b. Basename does NOT match any declared role's default →
    //      assume the path is the IMPL role's signal (the
    //      conventional "phase-level signal" the manifest reference
    //      assigns to impl). Other roles fall back to convention so
    //      each gets its own file.
    // (Codex round 8 P2: arbitrary names like
    // `signals/phase-0-impl-complete.md` were previously ignored in
    // multi-role phases because the basename check is exact.)
    if (baseName === `${role}-complete.md`) return declared;
    const declaredMatchesAnyRoleDefault = declaredRoles.some(
      (r) => baseName === `${r}-complete.md`
    );
    if (!declaredMatchesAnyRoleDefault && role === 'impl') {
      return declared;
    }
    // Otherwise: convention default (every other role).
  }
  return completionSignalFor(
    phaseDirFor(manifestDir, phaseId),
    role
  );
}

function qaVerdictFor(phaseDir) {
  return path.join(phaseDir, 'qa-verdict.json');
}

// -------------------- Lockfile --------------------

/**
 * Acquire the orchestrator lockfile under `<orchDir>/.orchestrator.lock`.
 *
 * Refuses if a lockfile exists AND its `pid` is still alive. A stale
 * lockfile (pid dead per `process.kill(pid, 0)`) is overwritten — the
 * prior orchestrator crashed without cleanup, the operator wants to
 * restart, no human review needed.
 *
 * Returns the lockfile path on success. Throws on contention so the
 * caller can `process.exit(2)` with a meaningful message.
 *
 * Test seams: `_now`, `_pid`, `_existsSync`, `_readFileSync`,
 * `_writeFileSync`, `_renameSync`, `_killer`, `_unlinkSync`, `_hostname`.
 */
/**
 * Probe the OS for the start time of a running process. Returns
 * epoch ms, or null if the process is gone / probe failed / platform
 * not supported.
 *
 * Used by acquireLock's PID-recycling tiebreaker (todo 089). The
 * recorded `prev.startedAt` in the lockfile is the orchestrator's
 * OWN Date.now() at acquire time; this function asks the kernel
 * "what's the start time of the process currently holding this
 * PID?" Comparing the two distinguishes "same orchestrator still
 * running" from "PID recycled by an unrelated process".
 *
 * Windows: `Get-CimInstance Win32_Process -Filter "ProcessId=N"` →
 *   `CreationDate` field is a CIM datetime string (e.g.
 *   `20260503094530.123456-420`). PowerShell's CIM cmdlet returns
 *   it as a parseable JS Date when piped through `Get-Date`.
 * POSIX: `/proc/<pid>/stat` field 22 (starttime) is the process's
 *   start time in jiffies since system boot. Combined with `/proc/
 *   stat`'s `btime` (boot epoch) and `/proc/<pid>/stat`'s clock
 *   tick rate, we can compute epoch ms. V1 only Windows is the
 *   target shell; the POSIX branch is a best-effort future-proof.
 *
 * Probe overhead: ~140ms on Windows for the PowerShell spawn.
 * acquireLock is called once per orchestrator instance startup (not
 * per-tick), so this cost is acceptable.
 */
function probeProcessStartTime(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const runner =
      opts._runner ||
      ((program, argv) =>
        execFileSync(program, argv, {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
          timeout: 5000,
        }));
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" ` +
      `-ErrorAction SilentlyContinue; ` +
      `if ($p -and $p.CreationDate) { ` +
      `$d = $p.CreationDate; ` +
      `if ($d -is [datetime]) { Write-Output ($d.ToUniversalTime().ToString("o")) } ` +
      `else { Write-Output ([Management.ManagementDateTimeConverter]::ToDateTime($d).ToUniversalTime().ToString("o")) } }`;
    let stdout;
    try {
      stdout = runner('powershell', [
        '-NoProfile',
        '-NoLogo',
        '-Command',
        script,
      ]);
    } catch (_) {
      return null;
    }
    if (typeof stdout !== 'string' || stdout.trim() === '') return null;
    const ts = Date.parse(stdout.trim());
    return Number.isFinite(ts) ? ts : null;
  }
  // POSIX best-effort. /proc/<pid>/stat field 22 is starttime in
  // jiffies; convert via /proc/stat btime + /proc/<pid>/stat _SC_CLK_TCK.
  // For V1 we don't need this path (Windows is the target); return
  // null so acquireLock's tiebreaker treats the probe as inconclusive
  // and falls back to the existing alive-or-not logic.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.split(/\s+/);
    if (fields.length < 22) return null;
    const starttimeJiffies = Number(fields[21]);
    if (!Number.isFinite(starttimeJiffies)) return null;
    const btimeMatch = fs
      .readFileSync('/proc/stat', 'utf8')
      .match(/^btime\s+(\d+)/m);
    if (!btimeMatch) return null;
    const btimeMs = parseInt(btimeMatch[1], 10) * 1000;
    // Assume 100 Hz (linux default _SC_CLK_TCK). For V1 that's
    // close enough; the ±1s tolerance in acquireLock absorbs drift.
    return btimeMs + starttimeJiffies * 10;
  } catch (_) {
    return null;
  }
}

function acquireLock(orchDir, opts = {}) {
  const ourPid = opts._pid || process.pid;
  const now = opts._now ? opts._now() : new Date().toISOString();
  const hostname = opts._hostname ? opts._hostname() : os.hostname();
  const existsSync = opts._existsSync || fs.existsSync;
  const readFileSync = opts._readFileSync || fs.readFileSync;
  const writeFileSync = opts._writeFileSync || fs.writeFileSync;
  const mkdirSync = opts._mkdirSync || fs.mkdirSync;
  const unlinkSync = opts._unlinkSync || fs.unlinkSync;
  const openSync = opts._openSync || fs.openSync;
  const closeSync = opts._closeSync || fs.closeSync;
  const writeSync = opts._writeSync || fs.writeSync;
  const killer = opts._killer || ((p, sig) => process.kill(p, sig));

  mkdirSync(orchDir, { recursive: true });
  const lockPath = path.join(orchDir, LOCKFILE_NAME);

  if (existsSync(lockPath)) {
    let prev;
    try {
      prev = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch (_) {
      throw new Error(
        `corrupt lockfile at ${lockPath}; inspect and remove the file ` +
          `before restarting the orchestrator`
      );
    }
    if (prev && Number.isInteger(prev.pid) && prev.pid > 0) {
      let alive;
      try {
        killer(prev.pid, 0);
        alive = true;
      } catch (e) {
        if (e && e.code === 'ESRCH') alive = false;
        else if (e && e.code === 'EPERM') alive = true; // process exists, ACL'd
        else alive = false; // unknown errno — treat as dead, overwrite
      }
      // Todo 089: PID-recycling tiebreaker. `kill(pid, 0)` returns
      // success if ANY process owns that PID — including a process
      // that recycled the PID after the prior orchestrator died.
      // Cross-check against the OS-reported start time stored in
      // the lockfile. If the OS reports a different start time than
      // we recorded, the PID was recycled and the lock is stale.
      // PID space is small on Windows (~32K) and recycling within
      // 30 minutes after an orchestrator OOM/crash is common; this
      // closes the case where an unrelated process now holds the
      // recorded PID.
      if (alive && typeof prev.startedAt === 'string' && prev.startedAt !== '') {
        const startTimeProbe = opts._startTimeProbe || probeProcessStartTime;
        let osStartedAtMs;
        try {
          osStartedAtMs = startTimeProbe(prev.pid);
        } catch (_) {
          osStartedAtMs = null; // probe failure: be conservative, treat as alive
        }
        if (typeof osStartedAtMs === 'number' && Number.isFinite(osStartedAtMs)) {
          const recordedMs = Date.parse(prev.startedAt);
          if (Number.isFinite(recordedMs)) {
            // Tolerate ±1s clock drift between Node's Date and the
            // OS's CIM-reported CreationDate. Anything beyond that
            // is a recycled PID.
            const diffMs = Math.abs(osStartedAtMs - recordedMs);
            if (diffMs > 1000) {
              alive = false; // PID recycled — recorded process is dead
            }
          }
        }
      }
      if (alive) {
        const err = new Error(
          `another orchestrator (pid ${prev.pid}, started ${prev.startedAt}) ` +
            `holds ${lockPath}; refusing to start a second instance. ` +
            `If the prior process actually died, delete the file manually.`
        );
        err.code = 'ELOCKED';
        throw err;
      }
    }
    // Stale lock detected. Race-safe reclaim (codex round 12 P2):
    // unlinkSync alone has a TOCTOU window — two orchestrators both
    // see the stale lock, both unlink, the second unlink could
    // remove the first's just-acquired-exclusive-lock. Use rename
    // with a unique target instead. renameSync on POSIX errors with
    // ENOENT when the source has already been renamed away by
    // another process; on Windows likewise. Only ONE rename
    // succeeds, deterministically resolving the reclaim race.
    const staleSidecar = path.join(
      orchDir,
      `${LOCKFILE_NAME}.stale-${ourPid}-${Date.now()}`
    );
    try {
      const renameSync = opts._renameSync || fs.renameSync;
      renameSync(lockPath, staleSidecar);
      // Best-effort cleanup of the sidecar; failure is harmless
      // (orphaned `.stale-*` files are easy to spot + remove
      // manually, and bestEffortUnlink avoids throwing).
      bestEffortUnlink(unlinkSync, staleSidecar);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // Another orchestrator just won the rename race. Fall
        // through to the exclusive create below — we'll get EEXIST
        // and surface contention cleanly.
      } else {
        // Any other rename error (EACCES, ENOSPC, etc.) — surface
        // as a hard refusal rather than risk overwriting the
        // contender's lock.
        throw new Error(
          `cannot reclaim stale lock at ${lockPath}: ${e.message}`
        );
      }
    }
  }

  // Codex re-round P1: record the OS-reported process start time
  // (not Date.now) so the recycling tiebreaker compares apples-to-
  // apples on resume. Pre-fix the recorded value was Date.now() at
  // ACQUIRE time; if the orchestrator spent >1s in scaffold/preflight
  // before acquiring the lock, Date.now != OS-creation-time and the
  // tiebreaker falsely concluded "recycled PID" against ITSELF — a
  // second orchestrator could overwrite a live lock and run
  // concurrently.
  const startTimeProbe = opts._startTimeProbe || probeProcessStartTime;
  let osStartedAtMs = null;
  try {
    osStartedAtMs = startTimeProbe(ourPid);
  } catch (_) {
    osStartedAtMs = null;
  }
  // Persist the OS-reported start time as ISO when available; fall
  // back to the wall-clock `now` when the probe is inconclusive
  // (recycling detection becomes best-effort in that case but the
  // lockfile still functions for the alive-or-not check).
  const startedAtIso =
    typeof osStartedAtMs === 'number' && Number.isFinite(osStartedAtMs)
      ? new Date(osStartedAtMs).toISOString()
      : now;
  const content = JSON.stringify(
    { pid: ourPid, startedAt: startedAtIso, hostname },
    null,
    2
  );

  // Codex round 4 P2: exclusive-create acquire. `wx` flag = O_CREAT |
  // O_EXCL | O_WRONLY — fails with EEXIST if the file already
  // exists. Two orchestrators racing to acquire the lock will
  // deterministically resolve: the first openSync('wx') succeeds,
  // every later openSync('wx') gets EEXIST and we throw ELOCKED.
  // The prior `existsSync` + `rename` shape had a TOCTOU window
  // between the check and the rename where two orchestrators could
  // both see "no lock" and both rename successfully (rename does
  // NOT fail on existing file — it overwrites).
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // Race lost — another orchestrator just claimed the lock.
      // Re-read it and surface contention vs corruption.
      let other;
      try {
        other = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch (_) {
        const err = new Error(
          `lockfile race: another orchestrator just took ${lockPath} ` +
            `(file is unparseable; inspect manually).`
        );
        err.code = 'ELOCKED';
        throw err;
      }
      const err = new Error(
        `lockfile race: another orchestrator (pid ${other.pid || '?'}, ` +
          `started ${other.startedAt || '?'}) just claimed ${lockPath}.`
      );
      err.code = 'ELOCKED';
      throw err;
    }
    throw e;
  }
  // We hold the fd. Write content + close.
  try {
    if (typeof writeFileSync === 'function' && writeFileSync !== fs.writeFileSync) {
      // Test path passed a custom writer. Close the exclusive fd and
      // use the injected writeFileSync (matches prior test seam shape).
      closeSync(fd);
      writeFileSync(lockPath, content, { encoding: 'utf8' });
    } else {
      const buf = Buffer.from(content, 'utf8');
      writeSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
    }
  } catch (e) {
    try { closeSync(fd); } catch (_) { /* ignore */ }
    try { unlinkSync(lockPath); } catch (_) { /* ignore */ }
    throw e;
  }
  return lockPath;
}

function releaseLock(lockPath, opts = {}) {
  const unlinkSync = opts._unlinkSync || fs.unlinkSync;
  try {
    unlinkSync(lockPath);
  } catch (_) {
    /* best-effort; the next orchestrator start will detect + overwrite */
  }
}

// -------------------- PID snapshot (todo 086) --------------------

/**
 * Build a `Map<sessionName, { pid }>` from a single PowerShell call.
 *
 * The wire-shape parsePidLookupOutput already accepts (one PowerShell
 * `Get-CimInstance` call's JSON output) is reusable — we run the
 * lookup once and feed the same buffer to parsePidLookupOutput per
 * session name we care about. That keeps the per-tick PowerShell cost
 * at exactly one process spawn regardless of how many phases × roles
 * the manifest declares.
 *
 * On runner failure (PowerShell missing, AV-blocked, transient WMI
 * hiccup), returns `null` — the tick downgrades to per-call lookups
 * via checkHealth's default path so the loop survives. Callers of
 * `pollAllPhases` see `null` and pass `_pidSnapshot: undefined` to
 * checkHealth, which falls back to its built-in getSessionPid.
 *
 * Shape choice (design decision #9): `Map<sessionName, { pid }>`. The
 * Map keys are unique per phase/role per session-naming convention
 * (orch-<phaseId>-<role>), so Map vs. plain object is purely an
 * ergonomic call. Map gives `.has()` and a clean `null` discriminator
 * for the "not found in this tick's snapshot" case.
 */
function buildPidSnapshot(sessionNames, opts = {}) {
  if (!Array.isArray(sessionNames) || sessionNames.length === 0) {
    return new Map();
  }
  const runner =
    opts._pidRunner ||
    ((program, argv) =>
      execFileSync(program, argv, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }));
  let stdout;
  try {
    stdout = runner('powershell', buildPidLookupArgs());
  } catch (_) {
    return null;
  }
  // Todo 108.p: parse the PowerShell JSON ONCE per snapshot, not
  // once per session name. Pre-fix, parsePidLookupOutput re-parsed
  // the same stdout buffer N times — wasteful for fan-out phases
  // with multiple roles.
  let parsedRows = null;
  if (typeof stdout === 'string' && stdout.trim() !== '') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed !== null && parsed !== undefined) {
        parsedRows = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (_) {
      parsedRows = null; // fall through; parsePidLookupOutput will re-handle
    }
  }
  const map = new Map();
  for (const name of sessionNames) {
    const pid = parsePidLookupOutput(stdout, name, {
      excludeWrappers: true,
      _parsedRows: parsedRows,
    });
    if (Number.isInteger(pid) && pid > 0) {
      map.set(name, { pid });
    }
  }
  return map;
}

// -------------------- pollAllPhases --------------------

/**
 * One tick's state load. Public so the orchestrator's main loop, the
 * future MCP/web operator dashboards, and the unit tests can all share
 * the same per-tick snapshot.
 *
 * Returns:
 *   { ok: true, manifest, phases, status, pidSnapshot }
 *     — `phases` is the normalized array (defaults folded in).
 *     — `status` is the loadStatus shape, never null (we substitute an
 *       empty `{ phases: {} }` if the file does not exist).
 *     — `pidSnapshot` is a Map<sessionName, {pid}> or `null` on runner
 *       failure (see buildPidSnapshot).
 *   { ok: false, error, errorKind }
 *     — `errorKind: 'config'` for manifest load / validate failures.
 *
 * Test seams: `_loadManifest`, `_loadStatus`, `_pidRunner`.
 */
function pollAllPhases(opts) {
  const manifestPath = opts.manifestPath;
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    throw new Error('pollAllPhases: manifestPath is required (non-empty string)');
  }
  const loadManifestFn = opts._loadManifest || loadManifest;
  const loadStatusFn = opts._loadStatus || loadStatus;

  const loaded = loadManifestFn(manifestPath);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, errorKind: 'config' };
  }
  const dangling = findDanglingDeps(
    Array.isArray(loaded.manifest.phases) ? loaded.manifest.phases : []
  );
  const vresult = validate(loaded.manifest);
  if (dangling.length > 0 || !vresult.valid) {
    const errs = [...dangling, ...vresult.errors]
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    return {
      ok: false,
      error: `manifest invalid: ${errs}`,
      errorKind: 'config',
    };
  }
  const phases = normalizePhases(loaded.manifest);

  const statusResult = loadStatusFn(manifestPath);
  if (!statusResult.ok) {
    return { ok: false, error: statusResult.error, errorKind: 'config' };
  }
  const status =
    statusResult.status === null
      ? { phases: Object.create(null) }
      : statusResult.status;

  // Build the session-name list from EVERY phase × role pair the
  // manifest declares. We pre-fetch even for `pending` phases — the
  // marginal cost of one Map.set is trivial, and the same snapshot
  // is reused if a pending phase advances mid-tick.
  //
  // Codex round 4 P1: review-loop phases dispatch a QA role even
  // when the manifest declares only impl agents (executeSpawn
  // synthesizes the QA agent from defaults). Without including
  // `orch-<phase>-qa` in the snapshot's session-name list, the live
  // QA process is invisible to checkHealth's `_pidSnapshot` path —
  // checkHealth treats a missing entry as authoritative ("session
  // not found"), so a healthy QA agent gets recovered as a crash
  // after startup-grace + convergence ticks.
  const sessionNames = [];
  for (const phase of phases) {
    const declaredRoles = new Set(phase.agents.map((a) => a.role));
    for (const role of declaredRoles) {
      sessionNames.push(defaultSessionName(phase.id, role));
    }
    // Synthesized review-loop roles. Two cases need pre-emptive
    // session-name pre-fetching:
    //   - QA on a review-enabled phase whose agents[] declares only
    //     impl (the planner synthesizes a QA dispatch on impl
    //     completion).
    //   - impl on a review-enabled phase whose agents[] declares
    //     only qa (the planner synthesizes an impl dispatch on
    //     initial run; codex round 10 P2).
    // Without these, checkHealth's batched _pidSnapshot path treats
    // the missing entry as authoritative `session_not_found` after
    // startup grace, triggering duplicate recovery spawns for a
    // healthy synthesized session.
    if (phase.review_loop && phase.review_loop.enabled) {
      if (!declaredRoles.has('qa')) {
        sessionNames.push(defaultSessionName(phase.id, 'qa'));
      }
      if (!declaredRoles.has('impl')) {
        sessionNames.push(defaultSessionName(phase.id, 'impl'));
      }
    }
  }
  const pidSnapshot = buildPidSnapshot(sessionNames, opts);
  // Codex round 14 P2 + round 17 P2: build a wrapper-INCLUSIVE
  // snapshot ONLY when there are 'spawning' phases that need the
  // wrapper-aware reconciliation defer. The primary snapshot
  // above excludes wrappers; the inclusive snapshot is required
  // to detect "tab is launching, inner Claude not yet registered"
  // cases for spawning-marker reconciliation. Pre-round-17, this
  // ran every tick — doubling WMI subprocess overhead even on
  // normal running/idle polls where no phase is spawning. Now
  // gated.
  const hasSpawningPhase = (function () {
    if (!status || !status.phases) return false;
    for (const id of Object.keys(status.phases)) {
      const e = status.phases[id];
      if (e && typeof e === 'object' && e.status === 'spawning') return true;
    }
    return false;
  })();
  let pidSnapshotWithWrappers = null;
  if (hasSpawningPhase) {
    try {
      pidSnapshotWithWrappers = buildPidSnapshotInclusive(sessionNames, opts);
    } catch (_) {
      // Best-effort. The reconciliation defer logic falls back to
      // primary-snapshot behavior when this is null.
      pidSnapshotWithWrappers = null;
    }
  }

  return {
    ok: true,
    manifest: loaded.manifest,
    phases,
    status,
    pidSnapshot,
    pidSnapshotWithWrappers,
  };
}

/**
 * Codex round 14 P2: same shape as buildPidSnapshot, but excludeWrappers:false.
 * Used by decideTickActions's spawning-marker reconciliation to detect
 * wrapper-only-still-launching tabs before rolling back to 'pending'.
 */
function buildPidSnapshotInclusive(sessionNames, opts = {}) {
  if (!Array.isArray(sessionNames) || sessionNames.length === 0) {
    return new Map();
  }
  const runner =
    opts._pidRunner ||
    ((program, argv) =>
      execFileSync(program, argv, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }));
  let stdout;
  try {
    stdout = runner('powershell', buildPidLookupArgs());
  } catch (_) {
    return null;
  }
  let parsedRows = null;
  if (typeof stdout === 'string' && stdout.trim() !== '') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed !== null && parsed !== undefined) {
        parsedRows = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (_) {
      parsedRows = null;
    }
  }
  const map = new Map();
  for (const name of sessionNames) {
    const pid = parsePidLookupOutput(stdout, name, {
      excludeWrappers: false,
      _parsedRows: parsedRows,
    });
    if (Number.isInteger(pid) && pid > 0) {
      map.set(name, { pid });
    }
  }
  return map;
}

// -------------------- Status helpers --------------------

function getPhaseStatus(status, phaseId) {
  const entry = status && status.phases ? status.phases[phaseId] : null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { status: 'pending' };
  }
  return entry;
}

function depsMet(phase, status) {
  if (!Array.isArray(phase.depends_on) || phase.depends_on.length === 0) {
    return true;
  }
  for (const dep of phase.depends_on) {
    const depEntry = getPhaseStatus(status, dep);
    if (depEntry.status !== 'completed') return false;
  }
  return true;
}

function depsBlocked(phase, status) {
  // A phase whose depends_on includes a `failed` OR `blocked` upstream
  // cannot advance. The operator must intervene (rerun the failed
  // phase, unblock it, or accept the partial outcome).
  if (!Array.isArray(phase.depends_on) || phase.depends_on.length === 0) {
    return false;
  }
  for (const dep of phase.depends_on) {
    const depEntry = getPhaseStatus(status, dep);
    if (depEntry.status === 'failed' || depEntry.status === 'blocked') return true;
  }
  return false;
}

function isTerminalStatus(s) {
  return s === 'completed' || s === 'failed' || s === 'blocked';
}

/**
 * Todo 108.g: lookup the raw phase entry from the parsed manifest.
 * Several call sites need access to fields parse-manifest's
 * normalizePhases strips (e.g., review_loop.pr_or_branch /
 * qa_scope_rows, plan_path / plan_unit_marker). Returning `null`
 * (rather than `undefined`) keeps the semantics explicit at the
 * read sites.
 */
function findRawPhase(manifest, phaseId) {
  if (!manifest || !Array.isArray(manifest.phases)) return null;
  const raw = manifest.phases.find((p) => p && p.id === phaseId);
  return raw || null;
}

/**
 * Todo 097: validate the SHAPE of `retry_count` on a phase status entry.
 *
 * The pre-fix read path silently coerced any non-integer to 0 — a
 * corrupted `retry_count: "two"` (or `2.5`, `null`, `-1`) would grant
 * up to 3 fresh retries beyond the documented cap, bypassing the
 * convergence guard.
 *
 * Returns:
 *   { ok: true, value: 0 }  when the field is absent (legitimate
 *      fresh-spawn). The caller treats absent as "no retries yet."
 *   { ok: true, value: n }  when the field is a non-negative integer.
 *      Over-budget integers (e.g. n=5 with maxRetries=3) are NOT
 *      corrupt — they're legitimate historical state from a prior
 *      run with --max-recovery-retries=5; the budget comparison
 *      happens later in decideRecoveryAction's exhausted path.
 *   { ok: false, observed }  when the field is present but the SHAPE
 *      is wrong (string, float, negative integer, explicit null).
 *      The caller should mark the phase blocked with a structured
 *      error naming the field + observed value.
 *
 * Critical: the absence-vs-explicit-null distinction. The orchestrator
 * writes manifest-status with `Object.create(null)` phases, so an
 * unset key shows up as `undefined` (absent → ok). A literal
 * `retry_count: null` in the YAML shows up as `null` (corrupt-shape →
 * blocked). Coercing both to 0 the way the pre-fix code did would
 * accept a corrupted file as fresh state.
 */
function validateRetryCountShape(phaseEntry) {
  if (!phaseEntry || typeof phaseEntry !== 'object') {
    return { ok: true, value: 0 };
  }
  if (!('retry_count' in phaseEntry)) {
    return { ok: true, value: 0 };
  }
  const raw = phaseEntry.retry_count;
  if (Number.isInteger(raw) && raw >= 0) {
    return { ok: true, value: raw };
  }
  return { ok: false, observed: raw };
}

// -------------------- Completion-signal parsing --------------------

/**
 * Parse a completion signal's frontmatter and return its `status`
 * field, plus an inferred `pass` bool for QA. If the file is missing,
 * unparseable, or has no frontmatter, returns `null` — the orchestrator
 * treats that as "not yet completed."
 *
 * For QA: `status: complete` ⇒ pass: true. Anything else (`blocked` /
 * `partial` / unrecognized) ⇒ pass: false. This mirrors the QA
 * template's contract: "blocked for any FAIL, partial if you were
 * unable to verify any row." Documented under design notes.
 *
 * If `qa-verdict.json` exists alongside `qa-complete.md`, prefer its
 * structured `pass` field — V1.5 may extend the QA template to write
 * that artifact directly, and parsing it first gives the future
 * dispatcher a cleaner upgrade path.
 */
// Todo 092: bounded-read caps for agent-written files. Hostile or
// buggy agents could write arbitrarily large `.md` / `.json` files
// or symlink them to `/dev/zero`; an unbounded readFileSync OOMs the
// orchestrator. Sized to comfortably exceed legitimate use:
//   - completion-signal: frontmatter + body, typically a few KB.
//   - qa-verdict.json: structured JSON, typically a few KB.
const MAX_COMPLETION_SIGNAL_BYTES = 256 * 1024; // 256 KB
const MAX_QA_VERDICT_BYTES = 64 * 1024; // 64 KB

/**
 * Bounded read with size cap and symlink rejection. Returns the file
 * content as a UTF-8 string, or null if the file is missing, too
 * large, a symlink, or otherwise unsafe. Defense against the
 * hostile-agent threat model the spec invokes (agents can produce
 * files in their own phase dir; the orchestrator must not OOM on
 * adversarial input).
 *
 * Test seams: `_lstatSync`, `_readFileSync`, `_existsSync`.
 */
function safeReadAgentFile(filePath, maxBytes, opts = {}) {
  const lstatSync = opts._lstatSync || fs.lstatSync;
  const readFileSync = opts._readFileSync || fs.readFileSync;
  const existsSync = opts._existsSync || fs.existsSync;
  if (!existsSync(filePath)) return null;
  let st;
  try {
    st = lstatSync(filePath);
  } catch (_) {
    return null;
  }
  // Reject symlinks. lstatSync (not statSync) does NOT follow the
  // link, so isSymbolicLink() is the authoritative check. A
  // symlink-to-/dev/zero would otherwise read forever.
  if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
    return null;
  }
  // Reject non-regular files (sockets, FIFOs, devices). Only regular
  // files have a meaningful size and finite read.
  if (st && typeof st.isFile === 'function' && !st.isFile()) {
    return null;
  }
  // Size cap. lstat's size for a regular file is reliable on Windows
  // and POSIX. Refuse to read anything larger than the cap.
  if (typeof st.size === 'number' && st.size > maxBytes) {
    return null;
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function parseCompletionSignal(signalPath, opts = {}) {
  // Todo 092: bounded read with size cap + symlink rejection. The
  // existsSync + readFileSync pattern was unbounded; a hostile agent
  // could write an arbitrarily large `<role>-complete.md` and OOM
  // the orchestrator.
  const raw = safeReadAgentFile(signalPath, MAX_COMPLETION_SIGNAL_BYTES, opts);
  if (raw === null) return null;
  // Frontmatter parse — same shape generate-prompt + the templates
  // produce. Tolerate CRLF; require leading `---\n`.
  const norm = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!norm.startsWith('---\n')) {
    return { status: 'unknown', frontmatter: null };
  }
  const closeIdx = norm.indexOf('\n---\n', 3);
  if (closeIdx < 0) return { status: 'unknown', frontmatter: null };
  const fmText = norm.slice(4, closeIdx);
  let fm;
  try {
    fm = yaml.load(fmText, { schema: yaml.DEFAULT_SCHEMA });
  } catch (_) {
    return { status: 'unknown', frontmatter: null };
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return { status: 'unknown', frontmatter: null };
  }
  const status = typeof fm.status === 'string' ? fm.status : 'unknown';
  return { status, frontmatter: fm };
}

function parseQaVerdict(phaseDir, role, opts = {}) {
  // Prefer structured qa-verdict.json (future-shape from the dispatch
  // contract: `{ pass, failures: [...] }`). Todo 092: bounded read
  // with size cap + symlink rejection (qa-verdict.json is the most
  // hostile-agent-attack-prone surface).
  const verdictPath = qaVerdictFor(phaseDir);
  const raw = safeReadAgentFile(verdictPath, MAX_QA_VERDICT_BYTES, opts);
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.pass === 'boolean') {
        return {
          pass: obj.pass,
          failures: Array.isArray(obj.failures) ? obj.failures : [],
          source: 'qa-verdict.json',
        };
      }
    } catch (_) {
      // Malformed JSON — fall through.
    }
  }
  // Fall back to the QA completion signal's frontmatter. Codex round
  // 11 P2: when the manifest declares a custom path for QA's signal,
  // callers pass it via `opts.signalPath`; otherwise we use the
  // conventional <phaseDir>/qa-complete.md.
  const signalPath = opts.signalPath || completionSignalFor(phaseDir, role);
  const sig = parseCompletionSignal(signalPath, opts);
  if (!sig) return null;
  return {
    pass: sig.status === 'complete',
    failures: [],
    source: 'qa-complete.md',
    signalStatus: sig.status,
  };
}

// -------------------- decideTickActions (pure) --------------------

/**
 * Pure planner. Given the loaded tick state + transient counters, emit
 * a list of actions. No side effects; tests assert on the actions list.
 *
 * Action types:
 *   { type: 'spawn', phaseId, role, mode: 'initial' | 'recovery' | 'review_retry', context }
 *   { type: 'persist', phaseId, role?, updates }
 *   { type: 'mark_phase_completed', phaseId }
 *   { type: 'mark_phase_failed', phaseId, reason }
 *   { type: 'mark_phase_blocked', phaseId, reason }
 *   { type: 'log', level: 'info'|'warn'|'error'|'debug', message, phaseId?, role? }
 *   { type: 'fatal', message }
 *
 * `runState` is the in-memory transient state (convergence counters,
 * recovery counts, review-loop iterations). It is mutated in place for
 * counters that must persist across ticks; persistence to disk happens
 * via the action stream.
 */
function decideTickActions(tickState, runState, opts) {
  const {
    manifest,
    phases,
    status,
    pidSnapshot,
    pidSnapshotWithWrappers,
    manifestPath,
  } = tickState;
  const actions = [];
  const now = opts._now ? opts._now() : Date.now();
  // `??` not `||`: zero is a legitimate operator override (e.g.,
  // --startup-grace-ms 0 disables grace, --max-recovery-retries 0
  // disables recovery). Codex round 1 P2 — without `??`, the explicit
  // zero falls through to the built-in default and the operator
  // silently gets the opposite of what they asked for.
  const startupGraceMs =
    opts.startupGraceMs != null ? opts.startupGraceMs : DEFAULT_STARTUP_GRACE_MS;
  const convergeN =
    opts.lookupFailedConvergeN != null
      ? opts.lookupFailedConvergeN
      : DEFAULT_LOOKUP_FAILED_CONVERGE_N;
  const maxRetries =
    opts.maxRecoveryRetries != null
      ? opts.maxRecoveryRetries
      : DEFAULT_MAX_RECOVERY_RETRIES;
  const checkHealthFn = opts._checkHealth || checkHealth;
  const manifestDir = path.dirname(path.resolve(manifestPath));

  // -- Todo 097 pre-pass: shape-validate retry_count on every non-terminal
  //    phase entry. Corrupt-shape values (string, float, negative integer,
  //    explicit null) used to silently coerce to 0, granting fresh retries
  //    beyond the cap. Block the phase with a structured error so the
  //    operator sees the corruption in manifest-status.yaml instead of
  //    a silent budget bypass. Use a guard set so we don't double-block
  //    the same phase if monitoring loops below also hit it.
  const shapeBlocked = new Set();
  for (const phase of phases) {
    const phaseEntry = getPhaseStatus(status, phase.id);
    if (phaseEntry && isTerminalStatus(phaseEntry.status)) continue;
    const shape = validateRetryCountShape(phaseEntry);
    if (!shape.ok) {
      actions.push({
        type: 'log',
        level: 'error',
        message:
          `phase ${phase.id} manifest-status.retry_count is shape-corrupt ` +
          `(observed: ${JSON.stringify(shape.observed)}); ` +
          `expected absent OR a non-negative integer. Marking phase blocked.`,
        phaseId: phase.id,
      });
      actions.push({
        type: 'mark_phase_blocked',
        phaseId: phase.id,
        reason: `retry_count_shape_corrupt:${JSON.stringify(shape.observed)}`,
      });
      shapeBlocked.add(phase.id);
    }
  }

  // -- Reconciliation pass (todo 090). Phases with `status: 'spawning'`
  // represent dispatches where the prior orchestrator wrote the
  // pre-spawn marker but died (SIGTERM / Ctrl+C / crash) before the
  // post-spawn `status: 'running'` persist. On the current
  // orchestrator's first tick after --resume, we cross-check each
  // spawning entry against the PID snapshot:
  //   - PID snapshot has the session → tab is alive; adopt by
  //     writing running + the snapshot's pid + started_at =
  //     dispatched_at, then clearing dispatched_at.
  //   - PID snapshot does NOT have the session → tab never
  //     registered (or died before WMI saw it). Reset to pending +
  //     clear dispatched_at + increment retry_count so the next
  //     tick re-dispatches against the recovery budget.
  // The pid snapshot may be `null` when buildPidSnapshot's runner
  // failed; in that case skip reconciliation this tick — next tick
  // re-tries with a fresh snapshot.
  for (const phase of phases) {
    if (shapeBlocked.has(phase.id)) continue;
    const phaseEntry = getPhaseStatus(status, phase.id);
    if (phaseEntry.status !== 'spawning') continue;
    if (pidSnapshot === null) continue; // no snapshot this tick
    // The role recorded as spawning isn't directly available on the
    // phase entry (we don't track per-role status in V1). For
    // multi-role + review-loop cases, reconcile every declared
    // role AND every synthesized role. Codex re-round P2:
    // review-enabled phases synthesize qa (when only impl declared)
    // or impl (when only qa declared); the prior loop only iterated
    // declared agents and missed live synthesized sessions.
    const declaredRoles = new Set(phase.agents.map((a) => a.role));
    const candidateRoles = new Set(declaredRoles);
    if (phase.review_loop && phase.review_loop.enabled) {
      candidateRoles.add('impl');
      candidateRoles.add('qa');
    }
    let reconciledRole = null;
    let snapshotPid = null;
    // Codex round 6 P2 + round 7 P2: detect "wrapper-alive + flag-
    // still-present" cases AND bound the deferral so an orphaned
    // flag (no live process + no flag-consumer) doesn't defer
    // forever. The pidSnapshot here excludes wrappers (production
    // health-check semantic). A tab whose inner Claude hasn't
    // registered yet but whose wrapper is alive shows as no-PID;
    // if its .pending-<name> flag is FRESH (younger than the hook's
    // FLAG_TTL_MS = 60s), the tab is still waiting for its hook
    // to fire — defer reconciliation. If the flag is OLDER than
    // FLAG_TTL_MS, the hook would itself skip it (per
    // hooks/session-start.js soft TTL); the flag is orphaned and
    // we proceed with the rollback so the phase doesn't stay
    // stuck.
    let waitingTabFlag = false;
    const phaseHookOrchDir = (function () {
      // Resolve the workdir-side orchDir for this phase. executeSpawn
      // writes flags under orchDirFor(resolvedWorkdir).
      const wd =
        typeof manifest.workdir === 'string' && manifest.workdir !== ''
          ? path.isAbsolute(manifest.workdir)
            ? manifest.workdir
            : path.resolve(manifestDir, manifest.workdir)
          : manifestDir;
      return orchDirFor(wd);
    })();
    let wrapperOnlyAlive = false;
    for (const r of candidateRoles) {
      const sessionName = defaultSessionName(phase.id, r);
      const snap = pidSnapshot.get(sessionName);
      if (snap && Number.isInteger(snap.pid) && snap.pid > 0) {
        reconciledRole = r;
        snapshotPid = snap.pid;
        break;
      }
      // Codex round 14 P2: also probe the wrapper-inclusive snapshot.
      // After EFLAGTIMEOUT the .pending-* flag is unlinked and the
      // marker stays 'spawning'; if the cmd/powershell wrapper is
      // alive but the inner Claude isn't yet registered, the
      // primary snapshot misses it. Without this guard the
      // reconciliation rolls back and the next tick spawns a
      // duplicate session under the same --name — breaking the
      // per-(phase, role) uniqueness invariant.
      if (
        pidSnapshotWithWrappers &&
        pidSnapshotWithWrappers.get(sessionName) &&
        Number.isInteger(pidSnapshotWithWrappers.get(sessionName).pid) &&
        pidSnapshotWithWrappers.get(sessionName).pid > 0
      ) {
        wrapperOnlyAlive = true;
      }
      // No primary-snapshot hit — check if a .pending-* flag still
      // exists AND is fresh (younger than the hook's FLAG_TTL_MS).
      // An orphaned older flag is treated as "no waiting tab" so
      // the rollback path runs and the phase doesn't stay stuck.
      const fp = path.join(phaseHookOrchDir, `.pending-${sessionName}`);
      const existsFn = opts._existsSync || fs.existsSync;
      const statFn = opts._statSync || fs.statSync;
      if (existsFn(fp)) {
        try {
          const st = statFn(fp);
          // Match the hook's FLAG_TTL_MS = 60_000. Anything older
          // the hook would skip; we treat as orphaned for
          // reconciliation purposes. The hard-TTL unlinker in the
          // hook (10× soft TTL) will eventually remove the file.
          const FLAG_TTL_MS_LOCAL = 60_000;
          const ageMs = now - (typeof st.mtimeMs === 'number' ? st.mtimeMs : 0);
          if (ageMs <= FLAG_TTL_MS_LOCAL) {
            waitingTabFlag = true;
          }
        } catch (_) {
          /* statSync race: treat as no waiting flag, proceed */
        }
      }
    }
    // Codex round 16 P2: wrapper-only defer must be BOUNDED. cmd /k
    // and powershell -NoExit keep the wrapper alive indefinitely
    // after the inner Claude exits (so the user can read post-mortem
    // output). If we deferred on wrapperOnlyAlive forever, a crashed
    // session would stay stuck in 'spawning' until the user manually
    // closed the tab.
    //
    // Bound: wrapper-only defer is honored only when the spawning
    // marker's `dispatched_at` is fresh (within FLAG_TTL_MS_LOCAL).
    // Past that window, the inner Claude should have registered by
    // now; wrapper-only is treated as a post-mortem and the rollback
    // path proceeds.
    let wrapperOnlyFresh = false;
    if (wrapperOnlyAlive) {
      const dispatchedAtMs = phaseEntry && typeof phaseEntry.dispatched_at === 'string'
        ? Date.parse(phaseEntry.dispatched_at)
        : NaN;
      if (Number.isFinite(dispatchedAtMs)) {
        const FLAG_TTL_MS_LOCAL = 60_000;
        const ageMs = now - dispatchedAtMs;
        if (ageMs <= FLAG_TTL_MS_LOCAL) {
          wrapperOnlyFresh = true;
        }
      }
      // If dispatched_at is missing or unparseable, treat as not
      // fresh — better to roll back than to stay stuck. The
      // reconciliation path will re-dispatch from a clean slate.
    }
    if (reconciledRole === null && (waitingTabFlag || wrapperOnlyFresh)) {
      // Defer reconciliation — either the resume sweep's cell-1
      // preservation (waitingTabFlag) or a fresh wrapper-only
      // window (post-EFLAGTIMEOUT or pre-WMI-registration) means
      // a tab may still come up. Rolling back here would risk a
      // duplicate-session-name bug.
      actions.push({
        type: 'log',
        level: 'info',
        message:
          `phase ${phase.id} reconciliation deferred: spawning marker + ` +
          `${waitingTabFlag ? 'fresh .pending-* flag' : ''}` +
          `${waitingTabFlag && wrapperOnlyFresh ? ' + ' : ''}` +
          `${wrapperOnlyFresh ? 'fresh live wrapper (inner Claude not yet registered)' : ''}` +
          `; next tick will re-check`,
        phaseId: phase.id,
      });
      continue;
    }
    if (reconciledRole !== null) {
      // Adopt: tab is alive.
      actions.push({
        type: 'log',
        level: 'info',
        message:
          `phase ${phase.id} resume reconciliation: found live ` +
          `${defaultSessionName(phase.id, reconciledRole)} (pid ${snapshotPid}); ` +
          `adopting and transitioning spawning → running`,
        phaseId: phase.id,
        role: reconciledRole,
      });
      actions.push({
        type: 'persist',
        phaseId: phase.id,
        updates: {
          status: 'running',
          pid: snapshotPid,
          started_at: phaseEntry.dispatched_at || new Date(now).toISOString(),
          dispatched_at: '',
        },
      });
    } else {
      // Reset to pending; budget incremented so the orchestrator's
      // recovery semantics treat this as one of the retry attempts.
      // Todo 097: shape was already validated by the pre-pass above;
      // this read is guaranteed-safe (shape-corrupt phases exit early
      // via mark_phase_blocked). Treating absent as 0 is the legitimate
      // fresh-spawn path validateRetryCountShape codifies.
      const shape = validateRetryCountShape(phaseEntry);
      const cur = shape.ok ? shape.value : 0;
      actions.push({
        type: 'log',
        level: 'warn',
        message:
          `phase ${phase.id} resume reconciliation: no live session ` +
          `for any declared role; resetting to pending (retry_count ${cur} → ${cur + 1})`,
        phaseId: phase.id,
      });
      actions.push({
        type: 'persist',
        phaseId: phase.id,
        updates: {
          status: 'pending',
          dispatched_at: '',
          retry_count: cur + 1,
        },
      });
    }
  }

  // -- First pass: monitor each running phase × role.
  for (const phase of phases) {
    if (shapeBlocked.has(phase.id)) continue;
    const phaseEntry = getPhaseStatus(status, phase.id);
    if (phaseEntry.status !== 'running') continue;
    const phaseDir = phaseDirFor(manifestDir, phase.id);

    // Identify the active role(s) this tick. Review-loop phases
    // alternate between impl and qa stages; non-review phases run all
    // declared roles concurrently. The `review_stage` field on the
    // phase status entry tracks which agent the orchestrator is
    // currently watching — defaults to 'impl' on first dispatch.
    const reviewEnabled = phase.review_loop && phase.review_loop.enabled;
    const reviewStage = phaseEntry.review_stage || 'impl';
    const reviewIteration = Number.isInteger(phaseEntry.review_iteration)
      ? phaseEntry.review_iteration
      : 1;
    // Review-loop iteration cap precedence (codex round 1 P2 + round
    // 4 P2):
    //   1. User-provided per-phase override via the RAW manifest's
    //      `review_loop.max_iterations`. This is the operator's
    //      explicit intent for THIS phase.
    //   2. Orchestrator-wide CLI override via `--review-loop-max-iterations`
    //      (`opts.reviewLoopMaxIterations`).
    //   3. Built-in default DEFAULT_REVIEW_LOOP_MAX_ITERATIONS.
    //
    // The normalized phase always carries `max_iterations: 3` because
    // normalizePhases fills in a default — using the normalized value
    // here would mask the CLI flag whenever the manifest omits the
    // field. We instead probe the raw manifest's phase entry for the
    // user-provided value and fall back to the CLI / built-in default
    // chain.
    // Todo 108.g: use shared findRawPhase helper.
    const rawPhaseForCap = findRawPhase(manifest, phase.id) || {};
    const rawReviewLoopForCap =
      rawPhaseForCap.review_loop && typeof rawPhaseForCap.review_loop === 'object'
        ? rawPhaseForCap.review_loop
        : {};
    // Codex round 14 P2: parse-manifest's `expectPositiveInt`
    // accepts string-numeric like "5" via Number() coercion. The
    // user override here must accept the same shapes — otherwise a
    // valid manifest with `max_iterations: "5"` falls through to
    // CLI/default cap.
    const coerceCap = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string' && v.trim() === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
      return n;
    };
    const userPhaseCap = coerceCap(rawReviewLoopForCap.max_iterations);
    const cliCap = coerceCap(opts.reviewLoopMaxIterations);
    const reviewMaxIter =
      userPhaseCap ?? cliCap ?? DEFAULT_REVIEW_LOOP_MAX_ITERATIONS;

    const activeRoles = reviewEnabled
      ? [reviewStage]
      : phase.agents.map((a) => a.role);

    for (const role of activeRoles) {
      // Find the agent record for this role (defaults).
      const agent = phase.agents.find((a) => a.role === role);
      if (!agent) {
        // Active role (e.g. 'qa') not declared in the phase's agents.
        // Synthesize a minimal agent record so the orchestrator can
        // still dispatch with the manifest defaults. Review loops on
        // an impl-only phase are the typical hit here — the QA
        // dispatch synthesizes from defaults.model.
        // (No action emitted; we just skip the agent lookup.)
      }
      const sessionName = defaultSessionName(phase.id, role);

      // Completion signal — the dominant signal. We parse the
      // frontmatter and dispatch by `status` (codex round 1 P1).
      // Special case: for QA on a review-enabled phase, blocked /
      // partial / complete are ALL legitimate verdicts (the QA
      // template's Output Contract maps `complete: ALL PASS`,
      // `blocked: any FAIL`, `partial: unverifiable rows`). The
      // review-loop branch below routes via parseQaVerdict which
      // honors that mapping. For every other (role × phase-mode)
      // combination the dispatch is:
      //   - 'complete'  → role finished; advance the phase / stage.
      //   - 'blocked'   → agent wrote a blocker and stopped; mark
      //                   phase blocked. Downstream phases must not
      //                   advance.
      //   - 'partial'   → mark phase blocked (operator decides).
      //   - other / unknown / unparseable → log + re-poll.
      // Codex round 5 P2: honor manifest's completion_signal when set.
      const signalPath = resolveCompletionSignal(
        manifest,
        manifestDir,
        phase.id,
        role
      );
      const sigParsed = parseCompletionSignal(signalPath, opts);
      const isQaReviewSignal = reviewEnabled && role === 'qa' && sigParsed !== null;
      if (sigParsed && !isQaReviewSignal) {
        if (sigParsed.status === 'blocked' || sigParsed.status === 'partial') {
          actions.push({
            type: 'log',
            level: 'error',
            message:
              `phase ${phase.id} role ${role} signaled status: ${sigParsed.status}; ` +
              `marking phase blocked. Operator decision needed before this phase advances.`,
            phaseId: phase.id,
            role,
          });
          actions.push({
            type: 'mark_phase_blocked',
            phaseId: phase.id,
            reason: `agent_signal:${sigParsed.status}:${role}`,
          });
          // Codex round 10 P2: stop polling sibling roles for this
          // phase once we've queued mark_phase_blocked. Otherwise a
          // sibling role's timeout / convergence could emit a
          // recovery spawn AFTER the block action, and executeActions
          // would dispatch the spawn before applying the block —
          // marking the phase blocked AND starting another agent. The
          // operator's intervention is required for this phase; no
          // role on it should continue to be monitored or recovered
          // this tick.
          break;
        }
        if (sigParsed.status !== 'complete' && sigParsed.status !== 'unknown') {
          // Codex round 16 P2: log + fall through to the
          // health-check path below, NOT continue. A signal with an
          // unrecognized status (e.g. `status: failed` from an
          // agent that exited mid-write) should NOT block recovery
          // — if the agent has actually died, we still want PID
          // liveness + timeout to drive recovery instead of the
          // phase staying `running` forever on a stale-but-present
          // bad signal.
          actions.push({
            type: 'log',
            level: 'warn',
            message:
              `phase ${phase.id} role ${role} signal has unrecognized status=${JSON.stringify(sigParsed.status)}; ` +
              `falling through to health check`,
            phaseId: phase.id,
            role,
          });
          // Fall through (no continue): isComplete computed below
          // will be false for non-'complete' statuses, so the
          // health-check path runs.
        }
      }
      const isComplete = isQaReviewSignal
        ? true // QA review path: any parseable signal is a verdict; pass/fail handled in the verdict branch below
        : sigParsed && sigParsed.status === 'complete';
      if (isComplete) {
        // Phase or stage completed.
        if (reviewEnabled && role === 'impl') {
          // Impl just completed; advance to QA.
          actions.push({
            type: 'log',
            level: 'info',
            message: `phase ${phase.id} impl complete; dispatching QA (iteration ${reviewIteration})`,
            phaseId: phase.id,
            role,
          });
          actions.push({
            type: 'spawn',
            phaseId: phase.id,
            role: 'qa',
            mode: 'initial',
            iteration: reviewIteration,
            implCompletionSignal: signalPath,
          });
          actions.push({
            type: 'persist',
            phaseId: phase.id,
            updates: { review_stage: 'qa' },
          });
          continue;
        }
        if (reviewEnabled && role === 'qa') {
          // QA just completed; parse verdict.
          // Codex round 11 P2: pass the resolved signalPath so a
          // manifest-declared custom QA completion path is honored.
          const verdict = parseQaVerdict(phaseDir, 'qa', { ...opts, signalPath });
          if (!verdict) {
            actions.push({
              type: 'log',
              level: 'warn',
              message: `phase ${phase.id} qa-complete.md present but verdict unparseable; treating as not-yet-complete`,
              phaseId: phase.id,
              role,
            });
            continue;
          }
          if (verdict.pass) {
            actions.push({
              type: 'log',
              level: 'info',
              message: `phase ${phase.id} review-loop pass on iteration ${reviewIteration}`,
              phaseId: phase.id,
            });
            actions.push({
              type: 'mark_phase_completed',
              phaseId: phase.id,
            });
              continue;
          }
          // Verdict failed.
          if (reviewIteration >= reviewMaxIter) {
            actions.push({
              type: 'log',
              level: 'error',
              message:
                `phase ${phase.id} review-loop exceeded max iterations (${reviewMaxIter}); ` +
                `escalating to operator. Last verdict source: ${verdict.source}.`,
              phaseId: phase.id,
            });
            actions.push({
              type: 'mark_phase_failed',
              phaseId: phase.id,
              reason: `review_loop_exceeded:${reviewMaxIter}`,
            });
              continue;
          }
          // Respawn impl with a fresh prompt + the prior verdict's
          // failures inlined. Iteration counter advances.
          const nextIter = reviewIteration + 1;
          actions.push({
            type: 'log',
            level: 'info',
            message:
              `phase ${phase.id} review-loop verdict failed; respawning impl ` +
              `(iteration ${nextIter} of ${reviewMaxIter})`,
            phaseId: phase.id,
          });
          actions.push({
            type: 'spawn',
            phaseId: phase.id,
            role: 'impl',
            mode: 'review_retry',
            iteration: nextIter,
            verdict,
          });
          actions.push({
            type: 'persist',
            phaseId: phase.id,
            updates: {
              review_stage: 'impl',
              review_iteration: nextIter,
            },
          });
          continue;
        }
        // Non-review phase (or non-impl/qa role on a review phase):
        // role complete. We don't aggregate per-role completion across
        // multi-role phases in V1 — the simplest contract is "phase
        // completes when any single completion signal lands AND no
        // other roles are running." For V1 V1.5 will wire multi-role
        // aggregation; today, the dispatch's typical phase has a
        // single role per phase OR a review_loop, so this branch is
        // correct for the common case.
        actions.push({
          type: 'log',
          level: 'info',
          message: `phase ${phase.id} role ${role} complete`,
          phaseId: phase.id,
          role,
        });
        // Aggregate across all declared roles. The phase advances to
        // `completed` only when EVERY declared role's completion
        // signal exists AND parses to `status: complete` (codex round
        // 4 P2). One role's `status: blocked` / `partial` would
        // otherwise let a half-finished multi-role phase mark
        // completed — silently advancing downstream phases.
        // (The current role already passed the parse check above by
        // virtue of reaching this branch; we re-check the others.)
        //
        // Todo 108.o (Conf 75, perf): for an N-role phase this loop
        // runs N×(N-1) parseCompletionSignal calls per tick (each
        // role iteration re-parses every sibling). For V1 with N≤3
        // (impl + qa + coord) the absolute cost is bounded; a
        // per-tick memoization cache keyed by (phaseId, role) would
        // reduce it to O(N). Deferred behind Conf 75 — acceptable
        // for V1 scale but flagged for V1.5 if a fan-out pattern
        // exceeds 3 roles.
        let allRolesComplete = true;
        for (const a of phase.agents) {
          if (a.role === role) continue; // current role is complete
          const sig = parseCompletionSignal(
            resolveCompletionSignal(manifest, manifestDir, phase.id, a.role),
            opts
          );
          if (!sig || sig.status !== 'complete') {
            allRolesComplete = false;
            break;
          }
        }
        if (allRolesComplete) {
          actions.push({
            type: 'mark_phase_completed',
            phaseId: phase.id,
          });
        }
        continue;
      }

      // Health check via batched seams.
      let health;
      try {
        health = checkHealthFn({
          phaseId: phase.id,
          role,
          manifestPath,
          sessionName,
          startupGraceMs,
          _loadedManifest: manifest,
          _loadedStatus: status,
          _pidSnapshot: pidSnapshot === null ? undefined : pidSnapshot,
          _now: () => now,
        });
      } catch (e) {
        // checkHealth threw (programmer-error path — invalid phaseId/
        // role/manifestPath). Surface as fatal so the loop doesn't
        // silently misbehave on every tick.
        actions.push({
          type: 'fatal',
          message:
            `checkHealth threw for phase=${phase.id} role=${role}: ${e.message}`,
        });
        continue;
      }

      // Todo 101: schema_version guard with MAJOR / MAJOR.MINOR soft-
      // band semantics. Pre-fix any mismatch was a hard fatal — a
      // V1.5 bump from `1` to `1.1` would have broken every consumer.
      //
      // Contract:
      //   - malformed (non-integer, non-MAJOR or MAJOR.MINOR string,
      //     null) → fatal (caller can't reason about compat).
      //   - parsed.major !== SCHEMA_VERSION_EXPECTED → fatal (major
      //     mismatch is by definition breaking).
      //   - parsed.major === SCHEMA_VERSION_EXPECTED && parsed.minor > 0
      //     → warn + proceed (forward-compat: producer is newer than
      //     consumer's known minor, but the major is unchanged so
      //     fields the consumer reads still exist with the same
      //     semantics; new fields are ignored).
      //   - else → ok.
      const parsedSchema = parseSchemaVersion(health.schema_version);
      if (parsedSchema === null) {
        actions.push({
          type: 'fatal',
          message:
            `checkHealth returned malformed schema_version ${JSON.stringify(health.schema_version)}; ` +
            `expected MAJOR (e.g. 1) or MAJOR.MINOR (e.g. 1.1). ` +
            `Consumer cannot reason about compat — refusing to advance.`,
        });
        continue;
      }
      if (parsedSchema.major !== SCHEMA_VERSION_EXPECTED) {
        actions.push({
          type: 'fatal',
          message:
            `checkHealth returned schema_version ${JSON.stringify(health.schema_version)} (major=${parsedSchema.major}); ` +
            `orchestrator expected major=${SCHEMA_VERSION_EXPECTED}. ` +
            `A check-health upgrade is needed before this orchestrator can advance.`,
        });
        continue;
      }
      if (parsedSchema.minor > 0) {
        actions.push({
          type: 'log',
          level: 'warn',
          message:
            `checkHealth output declares schema_version ${JSON.stringify(health.schema_version)}; ` +
            `consumer targets ${SCHEMA_VERSION_EXPECTED} — proceeding under MAJOR/MAJOR.MINOR soft-compat band ` +
            `(new fields are ignored; existing field semantics unchanged).`,
          phaseId: phase.id,
          role,
        });
      }

      // errorKind dispatch (design decision #3).
      if (health.error) {
        if (health.errorKind === 'config') {
          actions.push({
            type: 'log',
            level: 'error',
            message:
              `phase ${phase.id} role ${role} config error: ${health.error}; ` +
              `marking phase blocked and pausing polling on this phase`,
            phaseId: phase.id,
            role,
          });
          actions.push({
            type: 'mark_phase_blocked',
            phaseId: phase.id,
            reason: `config_error:${health.error}`,
          });
          continue;
        }
        if (health.errorKind === 'runtime') {
          // Phase dir missing mid-flight — log + treat as recovery
          // candidate next tick (we keep polling). PID is still
          // meaningful here per check-health's contract.
          actions.push({
            type: 'log',
            level: 'warn',
            message:
              `phase ${phase.id} role ${role} runtime advisory: ${health.error}`,
            phaseId: phase.id,
            role,
          });
          // Fall through to pidAlive / timeout handling — runtime
          // errors do NOT skip the rest of the diagnostic.
        } else {
          // Unknown errorKind. Log loudly so an upstream check-health
          // bump that adds a new errorKind doesn't silently misroute.
          actions.push({
            type: 'log',
            level: 'warn',
            message:
              `phase ${phase.id} role ${role} unknown errorKind=${JSON.stringify(health.errorKind)}: ${health.error}`,
            phaseId: phase.id,
            role,
          });
        }
      }

      // Heartbeat advisories (design decisions #5).
      if (health.heartbeatTruncated) {
        actions.push({
          type: 'log',
          level: 'debug',
          message:
            `phase ${phase.id} role ${role} heartbeatTruncated — ` +
            `tail-read window exhausted; not triggering recovery on truncation alone`,
          phaseId: phase.id,
          role,
        });
      }
      if (health.heartbeatCorrupt) {
        actions.push({
          type: 'log',
          level: 'warn',
          message:
            `phase ${phase.id} role ${role} heartbeatCorrupt — ` +
            `agent may be hung emitting garbage`,
          phaseId: phase.id,
          role,
        });
      }

      // Tri-state convergence + crash decision.
      const cKey = `${phase.id}:${role}`;
      const counters = runState.convergenceCounters;

      if (health.pidAlive === true) {
        // Reset counters on any non-null reading.
        counters.delete(cKey);
        if (health.timedOut) {
          actions.push({
            type: 'log',
            level: 'warn',
            message:
              `phase ${phase.id} role ${role} timed out; treating as crash`,
            phaseId: phase.id,
            role,
          });
          // Treat timeout as a crash — recovery path covers it.
          decideRecoveryAction(actions, runState, opts, {
            phase,
            role,
            agent,
            phaseDir,
            reason: 'timed_out',
            maxRetries,
            now,
            phaseEntry,
            // Todo 094: thread health + tick-state into the recovery
            // action builder so priorPid / lastHeartbeatTimestamp /
            // remainingWorkBlock / completedCheckpointsBlock can be
            // populated.
            health,
            status,
            manifest,
          });
          continue;
        }
        // Healthy. Continue polling next tick.
        continue;
      }

      if (health.pidAlive === false) {
        // ESRCH from kill(pid, 0) — strongest dead signal. Recover
        // immediately, no convergence required.
        counters.delete(cKey);
        actions.push({
          type: 'log',
          level: 'warn',
          message: `phase ${phase.id} role ${role} pidAlive=false (ESRCH); recovering`,
          phaseId: phase.id,
          role,
        });
        decideRecoveryAction(actions, runState, opts, {
          phase,
          role,
          agent,
          phaseDir,
          reason: 'pid_esrch',
          maxRetries,
          now,
          phaseEntry,
          health,
          status,
          manifest,
        });
        continue;
      }

      // pidAlive === null. Check the reason.
      const reason = health.pidAliveReason;
      if (reason === 'startup_grace') {
        // Todo 098: startup_grace must RESET the counter (not just
        // skip-the-increment). The convergence contract from todo 071
        // says "N consecutive lookup_failed/session_not_found past
        // startup-grace = crash"; the word `consecutive` is
        // load-bearing. Pre-fix, a flap pattern of `lookup_failed →
        // startup_grace → lookup_failed` left counter=1 across the
        // grace tick, so the second null was counted as the second
        // consecutive failure even though grace interrupted the run.
        // Resetting on startup_grace makes the counter only fire when
        // failures are actually consecutive past grace.
        counters.delete(cKey);
        continue;
      }
      // 'lookup_failed' OR 'session_not_found' OR null reason ⇒ count.
      const cur = (counters.get(cKey) || 0) + 1;
      counters.set(cKey, cur);
      if (cur < convergeN) {
        actions.push({
          type: 'log',
          level: 'debug',
          message:
            `phase ${phase.id} role ${role} pidAlive=null reason=${reason} ` +
            `(${cur}/${convergeN} consecutive); re-polling`,
          phaseId: phase.id,
          role,
        });
        continue;
      }
      // Convergence reached. Recover.
      counters.delete(cKey);
      actions.push({
        type: 'log',
        level: 'warn',
        message:
          `phase ${phase.id} role ${role} pidAlive=null converged ` +
          `(reason=${reason}, ${convergeN} consecutive); recovering`,
        phaseId: phase.id,
        role,
      });
      decideRecoveryAction(actions, runState, opts, {
        phase,
        role,
        agent,
        phaseDir,
        reason: `null_converged:${reason}`,
        maxRetries,
        now,
        phaseEntry,
        health,
        status,
        manifest,
      });
    }
    // Todo 108.c: removed write-only `phaseAdvanced` (9 assignments,
    // 0 reads, suppressed via `void`). Loop ordering already
    // guarantees a single-action-per-(phase, role) emission via the
    // explicit `continue` at each terminal branch.
  }

  // -- Second pass: advance pending phases.
  for (const phase of phases) {
    if (shapeBlocked.has(phase.id)) continue;
    const phaseEntry = getPhaseStatus(status, phase.id);
    const curStatus = phaseEntry.status || 'pending';
    if (curStatus !== 'pending') continue;

    if (depsBlocked(phase, status)) {
      actions.push({
        type: 'log',
        level: 'error',
        message:
          `phase ${phase.id} depends on a failed phase; marking blocked. ` +
          `Operator decision needed before this phase can advance.`,
        phaseId: phase.id,
      });
      actions.push({
        type: 'mark_phase_blocked',
        phaseId: phase.id,
        reason: 'dependency_failed',
      });
      continue;
    }
    if (!depsMet(phase, status)) continue;

    // Codex round 9 P2: validate roles BEFORE scheduling. parse-
    // manifest accepts arbitrary `agent.role` strings (validates only
    // non-empty), but generate-prompt's ROLE_TEMPLATES only knows
    // 'impl', 'qa', 'coord', and 'recovery' (the last is reserved
    // for V1.5). A manifest with role: 'coordinator' would otherwise
    // hit generatePrompt → throw → spawn failure → phase stays
    // pending → infinite loop.
    const validRoleSet = new Set(VALID_ROLES);
    const invalidRoles = phase.agents
      .map((a) => a.role)
      .filter((r) => !validRoleSet.has(r));
    if (invalidRoles.length > 0) {
      actions.push({
        type: 'log',
        level: 'error',
        message:
          `phase ${phase.id} declares unsupported role(s) ${JSON.stringify(invalidRoles)}; ` +
          `valid roles are ${JSON.stringify([...VALID_ROLES])}. ` +
          `Marking phase blocked.`,
        phaseId: phase.id,
      });
      actions.push({
        type: 'mark_phase_blocked',
        phaseId: phase.id,
        reason: `unsupported_role:${invalidRoles.join(',')}`,
      });
      continue;
    }
    // Codex round 19 P2: reject duplicate roles. Two agents with
    // the same role would share a session name (`orch-<phase>-<role>`)
    // and a single .pending-* flag — the second dispatch overwrites
    // the first, PID lookup conflates them, and the SessionStart
    // hook delivers the same prompt to two agents. parse-manifest
    // doesn't enforce role-uniqueness (multiple agents per phase is
    // a valid V1 shape with distinct roles).
    const roleCounts = new Map();
    for (const a of phase.agents) {
      roleCounts.set(a.role, (roleCounts.get(a.role) || 0) + 1);
    }
    const duplicateRoles = [];
    for (const [r, c] of roleCounts) {
      if (c > 1) duplicateRoles.push(r);
    }
    if (duplicateRoles.length > 0) {
      actions.push({
        type: 'log',
        level: 'error',
        message:
          `phase ${phase.id} declares duplicate role(s) ${JSON.stringify(duplicateRoles)} ` +
          `— each agent within a phase must have a unique role (session names + flag files ` +
          `key on orch-<phase>-<role>). Marking phase blocked.`,
        phaseId: phase.id,
      });
      actions.push({
        type: 'mark_phase_blocked',
        phaseId: phase.id,
        reason: `duplicate_role:${duplicateRoles.join(',')}`,
      });
      continue;
    }
    // Spawn each declared role for the phase. Review-loop phases
    // dispatch only impl on first run — qa fires on impl completion.
    const reviewEnabled = phase.review_loop && phase.review_loop.enabled;
    const initialRoles = reviewEnabled
      ? phase.agents.filter((a) => a.role === 'impl').map((a) => a.role)
      : phase.agents.map((a) => a.role);

    if (initialRoles.length === 0) {
      // Review-enabled phase with no impl agent declared — synthesize
      // an impl dispatch from manifest defaults so the loop can
      // proceed. (Validator allows agents without 'impl', but the
      // review-loop semantics require one.)
      actions.push({
        type: 'log',
        level: 'warn',
        message:
          `phase ${phase.id} has review_loop.enabled but no impl agent; ` +
          `dispatching an impl with manifest defaults`,
        phaseId: phase.id,
      });
      initialRoles.push('impl');
    }

    for (const role of initialRoles) {
      actions.push({
        type: 'spawn',
        phaseId: phase.id,
        role,
        mode: 'initial',
        iteration: 1,
      });
    }
    actions.push({
      type: 'persist',
      phaseId: phase.id,
      updates: reviewEnabled
        ? {
            status: 'running',
            review_stage: 'impl',
            review_iteration: 1,
          }
        : { status: 'running' },
    });
  }

  // Codex round 12 P2: post-process the action stream. If a phase
  // has a terminal mark_phase_blocked / mark_phase_failed action,
  // drop ANY spawn or persist actions targeting that same phase.
  // This guards the case where role 1's recovery spawn was emitted
  // before role 2's `blocked` signal triggered the phase block.
  // executeActions runs actions in order, so without this filter the
  // recovery spawn would fire before the block — defeating the
  // operator-intervention contract.
  const terminalPhases = new Set();
  for (const a of actions) {
    if (
      a.type === 'mark_phase_blocked' ||
      a.type === 'mark_phase_failed' ||
      a.type === 'mark_phase_completed'
    ) {
      terminalPhases.add(a.phaseId);
    }
  }
  if (terminalPhases.size === 0) return actions;
  return actions.filter((a) => {
    if (a.type !== 'spawn' && a.type !== 'persist') return true;
    if (!terminalPhases.has(a.phaseId)) return true;
    // Allow persist updates that target a phase being marked
    // completed/failed/blocked (e.g. completed_at) — these are the
    // mark_phase_* actions themselves, which are NOT 'persist' type
    // here. Bare 'persist' actions bound to a now-terminal phase
    // were emitted assuming the phase was still running; drop them.
    return false;
  });
}

function decideRecoveryAction(actions, runState, opts, ctx) {
  const { phase, role, phaseDir, reason, maxRetries, phaseEntry, health, status, manifest, now } = ctx;
  // Todo 097: shape is enforced by decideTickActions's pre-pass; when
  // we reach here the entry is either absent (fresh-spawn path → 0) or
  // a non-negative integer. Over-budget integers fall through to the
  // exhausted branch below — that's the documented recovery contract.
  const shape = validateRetryCountShape(phaseEntry);
  const cur = shape.ok ? shape.value : 0;
  if (cur >= maxRetries) {
    actions.push({
      type: 'log',
      level: 'error',
      message:
        `phase ${phase.id} role ${role} exceeded recovery budget ` +
        `(retry_count=${cur} >= ${maxRetries}); marking failed. Reason: ${reason}.`,
      phaseId: phase.id,
      role,
    });
    actions.push({
      type: 'mark_phase_failed',
      phaseId: phase.id,
      reason: `recovery_budget_exhausted:${reason}`,
    });
    return;
  }

  // Todo 094: populate the V1.5 recovery-analyst hook's diagnostic
  // context fields. Each field is sourced from the data already in
  // scope; absent sources land as explicit `null` (NOT omitted /
  // undefined) per the RA acceptance criteria so the hook can
  // distinguish "field not populated" from "field absent from
  // contract."
  //
  //   priorPid: phaseEntry.pid is the writer-side breadcrumb the
  //     prior session persisted before crashing. Integer or null.
  //   lastHeartbeatTimestamp: derived from check-health's
  //     `heartbeatAge` (seconds since last heartbeat record). When
  //     heartbeatAge is null (no record), we emit null.
  //   remainingWorkBlock: pulled from the manifest's plan_units
  //     literal (or null when the operator wired plan_path /
  //     plan_unit_marker — generate-prompt extracts from there at
  //     spawn time, so the recovery hook sees the rendered prompt
  //     not a separate block).
  //   completedCheckpointsBlock: built by ITERATING
  //     `status.phases` for entries with `status: 'completed'`
  //     (RA correction post-codex round 9 of PR #22: there is NO
  //     top-level `completed_phases` field — the canonical source
  //     is the per-phase status map).
  const priorPid =
    phaseEntry && Number.isInteger(phaseEntry.pid) ? phaseEntry.pid : null;

  let lastHeartbeatTimestamp = null;
  if (
    health &&
    Number.isInteger(health.heartbeatAge) &&
    Number.isFinite(now)
  ) {
    lastHeartbeatTimestamp = new Date(now - health.heartbeatAge * 1000).toISOString();
  }

  // For remainingWorkBlock, the simpler V1 sourcing is the manifest's
  // raw `plan_units` literal. Filtering to non-completed units would
  // require parsing the plan markdown — deferred to V1.5 where the
  // recovery analyst can read the plan directly. Until then, the
  // hook receives the full plan_units block (or null).
  // Todo 108.g: use shared findRawPhase helper.
  const rawPhase094 = findRawPhase(manifest, phase.id);
  let remainingWorkBlock = null;
  if (rawPhase094 && typeof rawPhase094.plan_units === 'string' && rawPhase094.plan_units !== '') {
    remainingWorkBlock = rawPhase094.plan_units;
  }

  // completedCheckpointsBlock — iterate status.phases. Absent / empty
  // status, or no completed phases, yields explicit null (not the
  // empty-string fallback executeSpawn defaulted to before).
  let completedCheckpointsBlock = null;
  if (status && status.phases && typeof status.phases === 'object') {
    const completedIds = [];
    for (const id of Object.keys(status.phases)) {
      const e = status.phases[id];
      if (e && typeof e === 'object' && e.status === 'completed') {
        completedIds.push(id);
      }
    }
    if (completedIds.length > 0) {
      completedCheckpointsBlock = completedIds
        .map((id) => `- ${id} (status: completed)`)
        .join('\n');
    }
  }

  actions.push({
    type: 'spawn',
    phaseId: phase.id,
    role,
    mode: 'recovery',
    iteration: cur + 1,
    crashReason: reason,
    // Todo 094: explicit nulls when source is missing.
    priorPid,
    lastHeartbeatTimestamp,
    remainingWorkBlock,
    completedCheckpointsBlock,
  });
  actions.push({
    type: 'persist',
    phaseId: phase.id,
    updates: { retry_count: cur + 1 },
  });
}

// -------------------- executeActions (side effects) --------------------

/**
 * Apply the action list. Each side effect — spawn, persist, log — is
 * dispatched here. Tests inject fakes via the `_*` seams so the action
 * stream can be exercised without real spawns or disk writes.
 *
 * Returns:
 *   { warnings: string[], completed: string[], failed: string[],
 *     blocked: string[], spawned: number, fatal: string | null }
 */
function executeActions(actions, tickState, runState, opts) {
  const out = {
    warnings: [],
    completed: [],
    failed: [],
    blocked: [],
    spawned: 0,
    fatal: null,
  };
  const logger = opts.logger || makeDefaultLogger();
  const spawnFn = opts._spawnSession || spawnSession;
  const generateFn = opts._generatePrompt || generatePrompt;
  const baseRunUpdate = opts._runUpdate || runUpdate;
  // Todo 103: tick-level cache. tickState.manifest is already
  // validated by pollAllPhases; tickState.status is the canonical
  // mutable shared instance the writer-side runUpdates mutate
  // across this tick. The wrapper threads both through to every
  // runUpdate call so a 5-role fan-out tick re-loads + re-validates
  // manifest+status ONCE (not 2N times). Mutation contract: the
  // shared status object preserves prior call's pid / started_at /
  // review_stage so the second writer in the same tick doesn't
  // start from a stale pre-call-1 snapshot.
  //
  // Test injection: when opts._runUpdate is set, callers usually
  // want a fully-stubbed writer (test fakes return ok without
  // touching disk). We still pass the seam — the fake can ignore
  // it; the real runUpdate honors it.
  const runUpdateFn = (manifestPath, phaseId, updates, extraOpts = {}) =>
    baseRunUpdate(manifestPath, phaseId, updates, {
      _loadedManifest: tickState.manifest,
      _loadedStatus: tickState.status,
      ...extraOpts,
    });
  const writeFile = opts._writeFileSync || fs.writeFileSync;
  const renameFile = opts._renameSync || fs.renameSync;
  const mkdir = opts._mkdirSync || fs.mkdirSync;
  const readFileSync = opts._readFileSync || fs.readFileSync;
  const existsSync = opts._existsSync || fs.existsSync;
  const dryRun = !!opts.dryRun;
  const projectName = opts.projectName || tickState.manifest.name || 'project';
  const manifestPath = tickState.manifestPath;
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const orchDir = orchDirFor(manifestDir);
  // Codex round 18 P2: under --dry-run, scaffold-protocol's
  // template-copy step is reported but not executed, so the live
  // `docs/orchestration/templates/` path won't exist. Fall back to
  // the templates dir that scaffold-protocol WOULD have copied
  // from — that's `<pluginDir>/templates`, where pluginDir comes
  // from --plugin-dir or this plugin's own root. Codex round 19
  // P2: previous default ignored --plugin-dir, so dry-run validated
  // against the wrong templates when the operator was previewing
  // an alternate plugin.
  const dryRunTemplateSource = (() => {
    const pluginRoot =
      typeof opts.pluginDir === 'string' && opts.pluginDir !== ''
        ? path.isAbsolute(opts.pluginDir)
          ? opts.pluginDir
          : path.resolve(opts.pluginDir)
        : path.resolve(__dirname, '..');
    return path.join(pluginRoot, 'templates');
  })();
  const templatesDir =
    opts.templatesDir ||
    (dryRun ? dryRunTemplateSource : templatesDirFor(manifestDir));

  for (const action of actions) {
    if (out.fatal) break; // fatal halts further execution this tick

    switch (action.type) {
      case 'log': {
        logger(action.level || 'info', action.message, {
          phaseId: action.phaseId,
          role: action.role,
        });
        break;
      }
      case 'fatal': {
        logger('error', action.message);
        out.fatal = action.message;
        break;
      }
      case 'spawn': {
        // Codex round 17 P1: if an earlier spawn this tick hit a
        // flag-consume timeout (EFLAGTIMEOUT), STOP scheduling
        // further spawns. The timed-out tab is still alive without
        // having consumed its prompt; the SessionStart hook in that
        // tab may eventually fire and pick up the next .pending-*
        // we'd write — delivering the WRONG prompt to the wrong
        // agent. Skipping subsequent spawns this tick lets the next
        // tick re-evaluate (the flag was already unlinked, so the
        // late hook reads {} and the orphan tab gets nothing —
        // recovery handles the orphan via session_not_found
        // convergence).
        if (runState.flagTimeoutThisTick) {
          out.warnings.push(
            `spawn skipped for phase=${action.phaseId} role=${action.role}: ` +
              `prior spawn this tick hit a flag-consume timeout; deferring to next tick`
          );
          // Todo 108.f investigated: runOneTick initializes the Set
          // at tick start, but the orchestrate.test.js suite calls
          // executeActions DIRECTLY with a runState that lacks
          // spawnFailedThisTick — so the lazy guards aren't dead.
          // Kept the guard but documented intent.
          if (!runState.spawnFailedThisTick) {
            runState.spawnFailedThisTick = new Set();
          }
          runState.spawnFailedThisTick.add(action.phaseId);
          break;
        }
        try {
          executeSpawn(action, tickState, runState, opts, {
            spawnFn,
            generateFn,
            writeFile,
            renameFile,
            mkdir,
            readFileSync,
            existsSync,
            runUpdateFn,
            orchDir,
            templatesDir,
            projectName,
            dryRun,
            logger,
          });
          out.spawned += 1;
          if (!runState.spawnSucceededThisTick) {
            runState.spawnSucceededThisTick = new Set();
          }
          runState.spawnSucceededThisTick.add(action.phaseId);
        } catch (e) {
          out.warnings.push(
            `spawn failed for phase=${action.phaseId} role=${action.role}: ${e.message}`
          );
          logger('error', `spawn failed: ${e.message}`, {
            phaseId: action.phaseId,
            role: action.role,
          });
          // Codex round 2 P2: track which phases had a spawn failure
          // this tick. Used by the persist branch below to decide
          // whether to skip the phase-level status: running update.
          if (!runState.spawnFailedThisTick) {
            runState.spawnFailedThisTick = new Set();
          }
          runState.spawnFailedThisTick.add(action.phaseId);
          // Codex round 17 P1: flag-timeout is special — the slow
          // tab can still steal subsequent flags from THIS tick.
          // Set a tick-wide poison-pill flag.
          if (e && e.code === 'EFLAGTIMEOUT') {
            runState.flagTimeoutThisTick = true;
          }
        }
        break;
      }
      case 'persist': {
        if (dryRun) break;
        // Codex round 2 P2 + round 6 P2: persist policy when sibling
        // spawn(s) for the same phase fail.
        //   - If ALL spawns for the phase failed, skip persist —
        //     phase stays pending, next tick re-attempts.
        //   - If ANY spawn for the phase succeeded (multi-role with
        //     partial failure), DO persist — otherwise the next tick
        //     sees status: pending and re-spawns the already-running
        //     role, creating duplicate tabs. The role(s) whose spawn
        //     failed get picked up via the recovery path on the next
        //     tick (their session_not_found verdict converges into
        //     recovery).
        const failed =
          runState.spawnFailedThisTick &&
          runState.spawnFailedThisTick.has(action.phaseId);
        const succeeded =
          runState.spawnSucceededThisTick &&
          runState.spawnSucceededThisTick.has(action.phaseId);
        if (failed && !succeeded) {
          out.warnings.push(
            `persist skipped for phase=${action.phaseId}: all spawns failed this tick`
          );
          break;
        }
        // Codex round 4 P2 + round 11 P2: skip persist if executeSpawn
        // observed a post-spawn runUpdate failure AND this persist
        // would overwrite `status` with 'running'. Todo 096's
        // contract requires the 'spawning' marker to stay intact so
        // reconciliation adopts the live tab next tick — but ONLY
        // the status field overwrites the marker. Field-only
        // persists (review_stage, review_iteration, retry_count)
        // merge with existing fields and preserve 'spawning';
        // skipping them would lose review/retry state. Allow them.
        const wouldOverwriteMarker =
          action.updates &&
          (action.updates.status === 'running' || action.updates.status === 'pending');
        if (
          wouldOverwriteMarker &&
          runState.postSpawnUpdateFailedThisTick &&
          runState.postSpawnUpdateFailedThisTick.has(action.phaseId)
        ) {
          out.warnings.push(
            `persist skipped for phase=${action.phaseId}: post-spawn runUpdate failed; status-overwriting persist suppressed (marker left 'spawning' for next-tick reconciliation)`
          );
          break;
        }
        const r = runUpdateFn(manifestPath, action.phaseId, action.updates);
        if (!r.ok) {
          out.warnings.push(
            `persist failed for phase=${action.phaseId}: ${r.error}`
          );
          logger('error', `persist failed: ${r.error}`, {
            phaseId: action.phaseId,
          });
        }
        break;
      }
      case 'mark_phase_completed': {
        if (!dryRun) {
          const r = runUpdateFn(manifestPath, action.phaseId, {
            status: 'completed',
            completed_at: new Date(
              opts._now ? opts._now() : Date.now()
            ).toISOString(),
          });
          if (!r.ok) {
            out.warnings.push(
              `mark_phase_completed failed for ${action.phaseId}: ${r.error}`
            );
          }
        }
        out.completed.push(action.phaseId);
        break;
      }
      case 'mark_phase_failed': {
        if (!dryRun) {
          const r = runUpdateFn(manifestPath, action.phaseId, {
            status: 'failed',
            error: action.reason || 'unknown',
            completed_at: new Date(
              opts._now ? opts._now() : Date.now()
            ).toISOString(),
          });
          if (!r.ok) {
            out.warnings.push(
              `mark_phase_failed failed for ${action.phaseId}: ${r.error}`
            );
          }
        }
        out.failed.push(action.phaseId);
        // Render structured terminal block.
        logger(
          'error',
          renderProblemBlock({
            problem: `phase ${action.phaseId} marked failed`,
            file: `${manifestPath} (manifest-status)`,
            fix: action.reason || 'inspect phase artifacts and retry',
          })
        );
        break;
      }
      case 'mark_phase_blocked': {
        if (!dryRun) {
          const r = runUpdateFn(manifestPath, action.phaseId, {
            status: 'blocked',
            error: action.reason || 'blocked',
          });
          if (!r.ok) {
            out.warnings.push(
              `mark_phase_blocked failed for ${action.phaseId}: ${r.error}`
            );
          }
        }
        out.blocked.push(action.phaseId);
        logger(
          'warn',
          renderProblemBlock({
            problem: `phase ${action.phaseId} blocked`,
            file: `${manifestPath} (manifest-status)`,
            fix: action.reason || 'inspect upstream phases',
          })
        );
        break;
      }
      // Todo 108.b: removed dead `mark_phase_running` handler — the
      // action type was documented in decideTickActions's JSDoc but
      // never emitted by any decideTickActions code path. The
      // post-spawn persist inside executeSpawn writes
      // `status: 'running'` directly via runUpdate, so the handler
      // was unreachable.
      default: {
        out.warnings.push(`unknown action type: ${action.type}`);
      }
    }
  }
  return out;
}

/**
 * Execute a single spawn action: render the prompt, write it to the
 * phase directory, write the `.pending-<sessionName>` flag file, then
 * call spawnSession and persist the result.
 *
 * Original-prompt preservation (recovery dispatches) is delegated to
 * generatePrompt — passing role: 'recovery' + recoveryRole triggers
 * the in-generator copy of `<role>-prompt.md` → `<role>-prompt.original.md`
 * before overwrite.
 *
 * **Stale-signal cleanup (codex round 1 P1).** Before any respawn (
 * review-retry, recovery, or review_loop progression from impl→qa
 * within the same iteration), delete the completion signal AND the
 * structured qa-verdict.json the prior dispatch wrote. Without this,
 * the next tick's pollAllPhases would see the old signal still on
 * disk and immediately advance the phase before the freshly spawned
 * agent has done any work.
 */
function executeSpawn(action, tickState, runState, opts, deps) {
  const {
    spawnFn,
    generateFn,
    writeFile,
    renameFile,
    mkdir,
    readFileSync,
    existsSync,
    runUpdateFn,
    orchDir,
    templatesDir,
    projectName,
    dryRun,
    logger,
  } = deps;
  const unlinkSync = opts._unlinkSync || fs.unlinkSync;
  const { manifest, phases, manifestPath } = tickState;
  const phase = phases.find((p) => p.id === action.phaseId);
  if (!phase) {
    throw new Error(`spawn action references unknown phase ${action.phaseId}`);
  }
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const phaseDir = phaseDirFor(manifestDir, phase.id);
  // Ensure the phase directory exists. scaffold-protocol creates it
  // upfront, but a recovery/respawn after a crashed orchestrator may
  // hit a missing dir if the operator deleted the protocol root.
  // Codex round 14 P2: respect dry-run — no FS mutations under
  // --dry-run, including phase-dir creation.
  if (!dryRun) mkdir(phaseDir, { recursive: true });

  const role = action.role;
  const sessionName = defaultSessionName(phase.id, role);
  const isRecovery = action.mode === 'recovery';
  const isReviewRetry = action.mode === 'review_retry';
  const isInitial = action.mode === 'initial';

  // Codex round 3 P2: normalizePhases keeps only `enabled` and
  // `max_iterations` from the manifest's review_loop block; the
  // user-provided `pr_or_branch` and `qa_scope_rows` are silently
  // dropped from the normalized phase. Recover them by reading the
  // raw phase entry off the manifest's untouched `phases` array.
  // Same pattern for `plan_path` / `plan_unit_marker` (codex round 3
  // P1) — these are NOT in parse-manifest's KNOWN_PHASE today; the
  // manifest validator warns on them but accepts the manifest, so
  // the orchestrator reads them from the raw phase.
  // Todo 108.g: use shared findRawPhase helper.
  const rawPhase = findRawPhase(manifest, phase.id) || {};
  const rawReviewLoop =
    rawPhase.review_loop && typeof rawPhase.review_loop === 'object'
      ? rawPhase.review_loop
      : {};

  // Stale-signal cleanup queue. Three respawn cases that need cleanup:
  //   1. recovery — same role respawned after crash. The prior
  //      session may have written a completion signal moments before
  //      crashing; without cleanup the orchestrator would immediately
  //      mark the phase complete on the next tick.
  //   2. review_retry — impl respawned after a failed QA verdict. The
  //      prior iteration's impl-complete.md AND qa-complete.md must
  //      both be removed so the next tick correctly observes "neither
  //      stage has emitted yet."
  //   3. initial QA dispatch on a review-enabled phase — the prior
  //      iteration's qa-complete.md (if any) must be removed before
  //      the new QA agent runs. (impl-complete.md stays — that's the
  //      trigger that brought us here.)
  //
  // Codex round 5 P2: defer the unlinks until AFTER the spawn
  // succeeds. If the spawn fails first, the QA verdict / completion
  // signals stay on disk so the next tick can re-decide cleanly. The
  // executeActions error path skips the matching `persist` action,
  // so the phase remains in its prior `review_stage: qa` (or
  // equivalent) state — the verdict isn't lost.
  // Codex round 5 P2 + round 13 P2: stale-signal cleanup pattern.
  // The cleanup unlinks completion signals from a PRIOR dispatch so
  // the next tick doesn't immediately mark the phase complete on
  // the stale signal. Two competing constraints:
  //   - Round 5: don't unlink BEFORE spawn — if spawn fails, the
  //     prior verdict signals would be lost and the phase stuck.
  //   - Round 13: don't unlink AFTER spawn unconditionally — a fast
  //     agent could have already written its NEW signal between
  //     spawn-return and our cleanup; we'd delete the fresh signal
  //     and the phase would hang until timeout.
  // Resolution: snapshot pre-spawn mtimes, run cleanup AFTER spawn
  // succeeds, but only unlink files whose current mtime <= the
  // pre-spawn snapshot. If the file's mtime is newer, the agent has
  // overwritten it — leave it alone.
  const staleUnlinks = [];
  // staleSnapshot: Map<absPath, { existed: bool, mtimeMs: number | null }>
  const staleSnapshot = new Map();
  if (!dryRun) {
    const sigFor = (r) =>
      resolveCompletionSignal(manifest, manifestDir, phase.id, r);
    // Todo 108.d: isRecovery and isInitial branches were
    // character-identical pre-fix. Both single-role respawn paths
    // (recovery after crash, initial dispatch with a leftover
    // signal) need the same cleanup queue. Merge them into one
    // branch keyed off `respawnsRole`.
    const respawnsRole = isRecovery || isInitial;
    if (respawnsRole) {
      staleUnlinks.push(sigFor(role));
      staleUnlinks.push(completionSignalFor(phaseDir, role));
      if (role === 'qa') {
        staleUnlinks.push(qaVerdictFor(phaseDir));
      }
    }
    if (isReviewRetry) {
      // Review-retry cleans BOTH impl and qa signals because the new
      // impl iteration must observe "neither stage has emitted yet."
      staleUnlinks.push(sigFor('impl'));
      staleUnlinks.push(sigFor('qa'));
      staleUnlinks.push(completionSignalFor(phaseDir, 'impl'));
      staleUnlinks.push(completionSignalFor(phaseDir, 'qa'));
      staleUnlinks.push(qaVerdictFor(phaseDir));
    }
    // Snapshot pre-spawn mtimes. Files that don't exist now are
    // recorded as `existed: false`; the post-spawn cleanup skips
    // anything that wasn't there before (any post-spawn write is a
    // fresh signal).
    const statSync = opts._statSync || fs.statSync;
    for (const p of staleUnlinks) {
      try {
        const st = statSync(p);
        staleSnapshot.set(p, {
          existed: true,
          mtimeMs: typeof st.mtimeMs === 'number' ? st.mtimeMs : 0,
        });
      } catch (_) {
        staleSnapshot.set(p, { existed: false, mtimeMs: null });
      }
    }
  }

  // Build generatePrompt opts. Plan extraction is best-effort: when the
  // manifest declares `plan_path` + `plan_unit_marker` per phase the
  // orchestrator passes them through; otherwise the impl/qa templates
  // accept an empty `plan_units` (Unit 7 contract).
  const agent = phase.agents.find((a) => a.role === role) || {
    role,
    model: (manifest.defaults && manifest.defaults.model) || null,
  };

  // Previous-phase signals: enumerate completion signals from upstream
  // phases — generate-prompt builds the briefing from those.
  // Codex round 5 P2: honor manifest's completion_signal when set.
  const priorPhaseSignals = [];
  for (const dep of phase.depends_on || []) {
    const depPhase = phases.find((p) => p.id === dep);
    if (!depPhase) continue;
    for (const a of depPhase.agents) {
      const sigPath = resolveCompletionSignal(manifest, manifestDir, dep, a.role);
      if (existsSync(sigPath)) priorPhaseSignals.push(sigPath);
    }
  }

  // Resolve workdir. Per docs/manifest-reference.md §workdir, the
  // manifest's `workdir` field is allowed to be a path RELATIVE to
  // the manifest file's directory (e.g. `workdir: ../sibling-repo`).
  // The orchestrator may be launched from any cwd, so we resolve
  // against manifestDir explicitly. Codex round 1 P2 caught this:
  // without explicit resolution, a relative workdir would resolve
  // against the orchestrator's cwd at launch time and the spawned
  // session's `wt --startingDirectory` would point at the wrong tree.
  const resolvedWorkdir = manifest.workdir
    ? path.resolve(manifestDir, manifest.workdir)
    : manifestDir;

  // Resolve the completion-signal path for this role's dispatch. This
  // is the path the AGENT writes to (rendered into the prompt's
  // {{completion_signal_path}}) — same path the orchestrator polls.
  // Manifest-declared custom paths flow through resolveCompletionSignal
  // (codex round 5 P2). For non-impl roles whose role doesn't match
  // the manifest's basename, the convention default applies.
  // Todo 108.a: removed no-op `isRecovery ? role : role` ternary —
  // both branches resolved to the same value. Recovery dispatches
  // already render to the role's canonical signal path; nothing in
  // this scope needs to differentiate the two.
  const dispatchCompletionSignal = resolveCompletionSignal(
    manifest,
    manifestDir,
    phase.id,
    role
  );
  // Codex round 13 P2: ensure the parent directory of the custom
  // completion path exists before the agent runs. If the manifest
  // declares `signals/phase-0-done.md`, the agent's `mkdir -p`
  // semantics are not guaranteed (template instructions don't
  // promise directory creation, and an agent dispatched with auto-
  // mode permissions might not have FS-create privileges in
  // arbitrary paths). Create the parent now so the write succeeds.
  if (!dryRun) {
    mkdir(path.dirname(dispatchCompletionSignal), { recursive: true });
  }

  const genOpts = {
    role: isRecovery ? 'recovery' : role,
    recoveryRole: isRecovery ? role : undefined,
    phaseId: phase.id,
    templatesDir,
    projectName,
    workdir: resolvedWorkdir,
    phaseDir,
    priorPhaseSignals,
    completionSignalPath: dispatchCompletionSignal,
    // Codex round 11 P3: render the heartbeat path so agents emit
    // heartbeats. Without this, generate-prompt's `{{heartbeat_path}}`
    // is empty and protocol-header.md instructs the agent to skip
    // heartbeats — disabling check-health's secondary liveness signal.
    // The path matches check-health.js's hard-coded read path
    // (<phaseDir>/heartbeat.jsonl).
    heartbeatPath: path.join(phaseDir, 'heartbeat.jsonl'),
  };

  // plan_units (codex round 3 P1). impl-prompt.md, qa-prompt.md, and
  // recovery-prompt.md all declare it as required. Resolution order:
  //   1. raw phase's `plan_path` + `plan_unit_marker` → generate-prompt
  //      extracts the marked unit's text from the plan file.
  //   2. raw phase's `plan_units` literal string → use verbatim.
  //   3. opts.planUnitsFor(phase) callback → orchestrator-wide
  //      programmatic resolution (test seam).
  //   4. Fallback stub. impl-prompt.md fails on empty plan_units, so
  //      we render a minimal phase descriptor that satisfies the
  //      "non-empty string" gate while making the absence visible to
  //      the agent.
  if (
    typeof rawPhase.plan_path === 'string' &&
    typeof rawPhase.plan_unit_marker === 'string' &&
    rawPhase.plan_path !== '' &&
    rawPhase.plan_unit_marker !== ''
  ) {
    genOpts.planPath = path.isAbsolute(rawPhase.plan_path)
      ? rawPhase.plan_path
      : path.resolve(manifestDir, rawPhase.plan_path);
    genOpts.planUnitMarker = rawPhase.plan_unit_marker;
  } else if (typeof rawPhase.plan_units === 'string' && rawPhase.plan_units !== '') {
    genOpts.planUnits = rawPhase.plan_units;
  } else if (typeof opts.planUnitsFor === 'function') {
    const v = opts.planUnitsFor(phase);
    if (typeof v === 'string' && v !== '') genOpts.planUnits = v;
  }
  if (
    !genOpts.planUnits &&
    !(genOpts.planPath && genOpts.planUnitMarker)
  ) {
    // Last-resort stub. The impl prompt's `plan_units` is REQUIRED;
    // without something here, generatePrompt throws. Render a minimal
    // descriptor from the phase metadata so the agent at least knows
    // which phase it's running.
    const rolesList = phase.agents.map((a) => a.role).join(', ') || 'impl';
    genOpts.planUnits =
      `(No plan excerpt configured for phase ${phase.id}. Set ` +
      `\`phases[].plan_path\` + \`plan_unit_marker\` in the manifest, or ` +
      `\`phases[].plan_units\` for a literal block, to wire one.)\n\n` +
      `**Phase:** ${phase.id}\n` +
      `**Title:** ${phase.title || '(untitled)'}\n` +
      `**Completion signal:** ${phase.completion_signal}\n` +
      `**Agent roles:** ${rolesList}\n`;
  }
  if (isRecovery) {
    genOpts.crashTimestamp = new Date(
      opts._now ? opts._now() : Date.now()
    ).toISOString();
    genOpts.recoveryCheckpointPath = phaseDir;
    genOpts.priorSessionPid = String(action.priorPid || 'unknown');
    genOpts.lastHeartbeatTimestamp = action.lastHeartbeatTimestamp || '';
    genOpts.remainingWorkBlock =
      action.remainingWorkBlock || `(see ${phaseDir} for prior artifacts)`;
    genOpts.completedCheckpointsBlock =
      action.completedCheckpointsBlock || '(reconstruct from phase directory)';
  }
  if (isReviewRetry && action.verdict) {
    // Inline the prior verdict's failures into the impl prompt's
    // previous-phase briefing slot. Templates accept this as
    // pre-rendered text; we render a minimal structured block.
    const failures = Array.isArray(action.verdict.failures)
      ? action.verdict.failures
      : [];
    const failureBlock =
      failures.length > 0
        ? failures
            .map(
              (f, i) =>
                `${i + 1}. test=${JSON.stringify(f.test || f.row || 'unknown')} ` +
                `expected=${JSON.stringify(f.expected || '')} ` +
                `actual=${JSON.stringify(f.actual || '')}`
            )
            .join('\n')
        : `(QA reported a non-pass verdict from ${action.verdict.source}; see qa-complete.md for details)`;
    genOpts.previousPhaseBriefing =
      `# Prior QA verdict (iteration ${action.iteration - 1})\n\n` +
      `Status: ${action.verdict.signalStatus || 'fail'}. The prior implementation ` +
      `did not pass review. Address the failures below before signalling complete.\n\n` +
      `${failureBlock}\n`;
  }
  // Coord-template empty placeholders are auto-injected by generate-
  // prompt; we do nothing here.
  if (role === 'qa' || (isRecovery && action.role === 'qa')) {
    // QA dispatch: pass the artifact under test (default is the
    // current branch HEAD; the orchestrator does not run git commands
    // — it leaves that to the QA agent itself). The qa_scope_rows are
    // taken from the phase's manifest entry if present.
    // Codex round 3 P2: pr_or_branch and qa_scope_rows live on the
    // raw manifest's review_loop block — normalizePhases drops them.
    genOpts.prOrBranchUnderTest =
      (rawReviewLoop && typeof rawReviewLoop.pr_or_branch === 'string'
        ? rawReviewLoop.pr_or_branch
        : null) ||
      `HEAD of ${resolvedWorkdir}`;
    genOpts.qaScopeRows =
      (rawReviewLoop && typeof rawReviewLoop.qa_scope_rows === 'string'
        ? rawReviewLoop.qa_scope_rows
        : null) ||
      `1. Implementation matches plan excerpt for phase ${phase.id} — PASS/FAIL`;
  }
  if (role === 'coord') {
    genOpts.statusSummaryBlock =
      action.statusSummaryBlock ||
      `phase ${phase.id} dispatched in coord mode at ` +
        new Date(opts._now ? opts._now() : Date.now()).toISOString();
    genOpts.coordNextActions =
      action.coordNextActions || `(coord decides next routing)`;
    genOpts.projectContextBlock =
      action.projectContextBlock || `Project: ${projectName}`;
  }
  if (role === 'impl') {
    genOpts.outputPaths =
      action.outputPaths || `(see plan excerpt for ${phase.id})`;
  }

  let renderResult;
  if (dryRun) {
    // Don't write the prompt; render to compute the flag content via
    // a separate dry-run path.
    renderResult = generateFn({ ...genOpts, dryRun: true });
  } else {
    renderResult = generateFn(genOpts);
  }
  if (renderResult && renderResult.warnings && renderResult.warnings.length) {
    for (const w of renderResult.warnings) {
      logger('warn', `prompt warning [${phase.id}/${role}]: ${w}`);
    }
  }

  // Read the rendered prompt and write the flag file. On dry-run, skip
  // the flag write — there's no agent to consume it.
  //
  // Codex round 5 P1: the SessionStart hook reads
  // `$CLAUDE_PROJECT_DIR/docs/orchestration/.pending-<id>`. Claude Code
  // sets `CLAUDE_PROJECT_DIR` from the spawned tab's
  // `--startingDirectory` (i.e., `resolvedWorkdir`). When manifest's
  // `workdir` differs from manifestDir, the hook's read path is under
  // resolvedWorkdir, NOT manifestDir.
  //
  // Codex round 7 P1: the hook does NOT match `.pending-*` files by
  // sessionName; it picks the oldest fresh flag and returns its
  // content. With multiple flags written + multiple parallel
  // wt new-tab spawns, the hook of one tab can consume another
  // tab's prompt. The orchestrator MUST serialize: write flag,
  // spawn tab, wait for the hook to consume the flag (atomic
  // rename converts it to `.consuming-*`, then unlink), THEN
  // proceed to the next spawn. If the wait times out, log and
  // continue — a slow tab is a recovery candidate, not a fatal.
  const hookOrchDir = orchDirFor(resolvedWorkdir);
  // Todo 099: per-spawn token for cross-tick poison-pill protection.
  // The SessionStart hook reads AGENT_FLAG_TOKEN from process.env and
  // compares against the .pending-*'s first-line `# spawn_token: <uuid>`
  // header BEFORE the destructive `.consuming-*` rename. Mismatch ⇒
  // skip without consuming, so an orphan tab whose argv-token was
  // bound at spawn-time can't consume the next-tick fresh flag.
  //
  // **Spawn-session env propagation is wired separately (out-of-scope
  // for this site).** This site (1) generates the token, (2) embeds
  // it in the flag content. Closing the cross-tick gap end-to-end
  // requires spawn-session.js to also propagate AGENT_FLAG_TOKEN to
  // the spawned tab — see todo 099's RA "out-of-band token binding"
  // for the channel choices (env var via cmd /k prefix, argv via
  // launcher passthrough, or per-tab manifest entry).
  const spawnToken =
    typeof opts._spawnToken === 'string' && opts._spawnToken !== ''
      ? opts._spawnToken
      : `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let flagPath = null;
  if (!dryRun) {
    let promptText;
    try {
      promptText = readFileSync(renderResult.promptPath, 'utf8');
    } catch (e) {
      throw new Error(
        `cannot read rendered prompt at ${renderResult.promptPath}: ${e.message}`
      );
    }
    // Todo 099: prepend the spawn-token header. The hook reads the
    // first line and skips candidates whose token doesn't match the
    // tab-bound AGENT_FLAG_TOKEN. Header shape MUST match
    // SPAWN_TOKEN_HEADER_RE in hooks/session-start.js.
    const tokenHeader = `# spawn_token: ${spawnToken}\n`;
    const flagContent = tokenHeader + promptText;
    if (Buffer.byteLength(flagContent, 'utf8') > MAX_FLAG_BYTES) {
      throw new Error(
        `prompt for ${sessionName} is ${Buffer.byteLength(flagContent, 'utf8')} bytes ` +
          `(including spawn-token header) — exceeds MAX_FLAG_BYTES=${MAX_FLAG_BYTES} ` +
          `(the SessionStart hook would refuse it). Trim the prompt or split the phase.`
      );
    }
    mkdir(hookOrchDir, { recursive: true });
    // Codex round 20 P2: sweep stale `.pending-*` flags before
    // writing this dispatch's flag. The SessionStart hook picks the
    // OLDEST fresh flag with no per-session matching; if the hook
    // dir contains a leftover from a crashed prior orchestrator (or
    // a session whose tab never started), the new spawn's hook
    // could consume the stale prompt instead of ours. We hold the
    // orchestrator lock, so no concurrent writer is racing us;
    // every existing `.pending-*` is by definition stale. Skip
    // entries matching this dispatch's session name (they'll be
    // overwritten by the rename below), and skip our own pending
    // tmp suffix patterns.
    const readdirSync = opts._readdirSync || fs.readdirSync;
    let entries = [];
    try {
      entries = readdirSync(hookOrchDir);
    } catch (e) {
      // Todo 108.i: differentiate ENOENT (dir doesn't exist yet —
      // mkdir above handles it; expected) from EACCES / EPERM
      // (cross-user perms or read-only mount — stale flags may
      // persist and re-introduce the codex-round-20 cross-tick
      // wrong-prompt bug). Surface non-ENOENT failures so the
      // operator sees the missing-sweep risk.
      if (e && e.code !== 'ENOENT') {
        logger('warn', `stale-flag sweep readdir failed at ${hookOrchDir}: ${e.message}`, {
          phaseId: phase.id,
          role,
        });
      }
    }
    const ourFlagBasename = `.pending-${sessionName}`;
    // Codex round 7 P2: honor cell-1-preserved flags from the resume
    // sweep. opts._preservedResumeFlags is a Set of flag basenames
    // that the resume sweep determined are still-valid prompts for
    // live waiting tabs. Without this guard, an UNRELATED spawn in
    // the same first-tick window would delete the preserved flag
    // and orphan the waiting tab.
    const preservedResumeFlags =
      opts._preservedResumeFlags instanceof Set
        ? opts._preservedResumeFlags
        : null;
    for (const name of entries) {
      if (typeof name !== 'string') continue;
      if (!name.startsWith('.pending-')) continue;
      if (name === ourFlagBasename) continue; // we'll rename over it
      if (preservedResumeFlags && preservedResumeFlags.has(name)) continue;
      // The new `.flagtmp-` prefix doesn't start with `.pending-`,
      // so it's already excluded. Legacy `.pending-*.tmp-*` from
      // older orchestrator versions: skip via substring check.
      if (name.includes('.tmp-')) continue;
      bestEffortUnlink(unlinkSync, path.join(hookOrchDir, name));
    }
    flagPath = flagFilePath(hookOrchDir, sessionName);
    // Atomic write per todo 029: tmp + rename (same filesystem).
    // Codex round 21 P2: the tmp basename MUST NOT match the hook's
    // FLAG_NAME_RE (`/^\.pending-[A-Za-z0-9._-]+$/`). The prior
    // shape `.pending-${sessionName}.tmp-...` matched (the regex
    // accepts dots and hyphens), so a hook firing during the rename
    // window or a crashed orchestrator's leftover tmp could be
    // consumed as a real prompt. Use a `.flagtmp-` prefix that the
    // hook explicitly does not match.
    const tmpPath = path.join(
      hookOrchDir,
      `.flagtmp-${sessionName}-${process.pid}-${Date.now()}`
    );
    writeFile(tmpPath, flagContent, { encoding: 'utf8' });
    renameFile(tmpPath, flagPath);
  }

  // Todo 090 (ce:review P1): pre-spawn dispatch marker. Persist
  // `status: 'spawning'` + `dispatched_at` BEFORE wt new-tab fires.
  // This closes the SIGTERM-during-spawn-window where the prior
  // logic would: (1) fire wt new-tab, (2) Claude tab launches and
  // is now alive, (3) orchestrator dies before persisting the
  // running status, (4) --resume sees status: 'pending' and
  // re-dispatches → duplicate session for the same (phase, role).
  //
  // The reconciliation path in decideTickActions's first pass
  // detects `status: 'spawning'` entries on resume, looks up the
  // session in the PID snapshot, and either adopts the existing
  // tab (write running + pid + actual started_at) OR resets to
  // pending + increments retry_count if the tab never registered.
  //
  // Skip the pre-marker on dry-run (no FS mutations).
  const dispatchTime = new Date(opts._now ? opts._now() : Date.now()).toISOString();
  if (!dryRun) {
    const preMarkerUpdates = {
      status: 'spawning',
      dispatched_at: dispatchTime,
    };
    // Reset retry_count on initial / review_retry dispatches
    // (matches the post-spawn persist's reset). Recovery dispatches
    // don't touch retry_count here — the planner already incremented
    // it via decideRecoveryAction.
    if (action.mode === 'initial' || action.mode === 'review_retry') {
      preMarkerUpdates.retry_count = 0;
    }
    const preR = runUpdateFn(manifestPath, phase.id, preMarkerUpdates);
    if (!preR.ok) {
      // Pre-marker write failed (FS error). Don't proceed to spawn —
      // we'd lose the recovery breadcrumb. Surface as a spawn failure
      // and let the next tick re-attempt.
      //
      // Codex round 5 P2: unlink the .pending-* flag we just wrote.
      // No tab will be spawned for this prompt; leaving the flag on
      // disk would let the next SessionStart hook (any unrelated
      // tab launching, cross-tick reconciliation sweep, or even a
      // later spawn for a different role within this same tick)
      // consume the stale prompt.
      if (flagPath) bestEffortUnlink(unlinkSync, flagPath);
      logger('error', `pre-spawn marker write failed: ${preR.error}`, {
        phaseId: phase.id,
        role,
      });
      throw new Error(`pre-spawn marker write failed: ${preR.error}`);
    }
  }

  // Spawn (or fake spawn on dry-run).
  // Codex round 7 P1: wrap in try so we can unlink the flag if spawn
  // throws. A leaked flag would otherwise be visible to the NEXT
  // spawn's hook (oldest-flag-wins) and the second tab would receive
  // this dead session's prompt.
  let spawnResult;
  if (dryRun) {
    spawnResult = {
      pid: null,
      command: '(dry-run)',
      argv: [],
      sessionName,
      title: sessionName,
      spawnedAt: new Date(opts._now ? opts._now() : Date.now()).toISOString(),
    };
  } else {
    // Plugin-dir resolution. The orchestrator plugin (this repo)
    // ships the SessionStart hook that consumes the .pending-*
    // flag and injects the prompt — every spawned tab MUST load
    // it, otherwise the agent never receives its dispatch.
    // spawn-session's --plugin-dir is single-valued, so we cannot
    // pass two paths in V1 (modifying Unit 4 to support multi-
    // plugin is V1.5 deferred). Resolution order:
    //   1. CLI --plugin-dir (path explicitly chosen by operator —
    //      assumed to either BE the orchestrator plugin or a
    //      compatible plugin that includes the SessionStart hook).
    //   2. Default to this plugin's root.
    // agents[].plugin_dir is V1.5 (deferred). Codex round 2 P2
    // briefly enabled it; round 15 P2 caught that doing so without
    // multi-plugin support breaks prompt injection. We log a
    // warning when agent.plugin_dir is set so the operator knows
    // why their per-agent plugin isn't loading.
    if (agent && typeof agent.plugin_dir === 'string' && agent.plugin_dir !== '') {
      logger(
        'warn',
        `phase ${phase.id} role ${role}: manifest sets agents[].plugin_dir=${JSON.stringify(agent.plugin_dir)}, ` +
          `but agent-orchestrator V1 requires the orchestrator plugin to be the ONLY --plugin-dir ` +
          `(the SessionStart hook lives in this plugin and must load to deliver prompts). ` +
          `Per-agent plugin support is V1.5 deferred. Ignoring agents[].plugin_dir for this dispatch.`,
        { phaseId: phase.id, role }
      );
    }
    let effectivePluginDir;
    if (typeof opts.pluginDir === 'string' && opts.pluginDir !== '') {
      effectivePluginDir = path.isAbsolute(opts.pluginDir)
        ? opts.pluginDir
        : path.resolve(opts.pluginDir);
    } else {
      // Codex round 9 P2: default to THIS plugin's root.
      // `__dirname` is `agent-orchestrator/scripts/`;
      // `path.resolve(__dirname, '..')` is the plugin root.
      effectivePluginDir = path.resolve(__dirname, '..');
    }
    try {
      // Codex round 15 P2: translate manifest.defaults.permission_mode
    // into the launcher's auto_mode_flag. spawn-session's default
    // launcher uses `--permission-mode auto`; if the manifest sets
    // `defaults.permission_mode: default` (or any other valid
    // permission mode), we override the launcher's flag so the
    // spawned Claude session honors the operator's choice. The
    // override merges with whatever launcher the manifest specifies
    // (or with DEFAULT_LAUNCHER when unspecified).
    let effectiveLauncher = manifest.launcher || null;
    const permissionMode =
      manifest.defaults && typeof manifest.defaults.permission_mode === 'string'
        ? manifest.defaults.permission_mode.trim()
        : '';
    // Codex round 15 P2: legacy 'auto' must NOT override the
    // launcher's auto_mode_flag. The launcher (e.g. agency baseline,
    // custom wrapper) may emit a different shape like
    // `--enable-auto-mode`; clobbering it with `--permission-mode auto`
    // turns valid invocations into unsupported commands. Only the
    // four documented Claude Code modes (plan | default | acceptEdits
    // | bypassPermissions) override; legacy 'auto' preserves the
    // launcher default.
    const PERMISSION_MODE_OVERRIDES = new Set([
      'plan',
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
    if (permissionMode !== '' && PERMISSION_MODE_OVERRIDES.has(permissionMode)) {
      const baseLauncher = effectiveLauncher || {};
      effectiveLauncher = {
        ...baseLauncher,
        auto_mode_flag: `--permission-mode ${permissionMode}`,
      };
    }
    spawnResult = spawnFn({
        name: sessionName,
        workdir: resolvedWorkdir,
        model: agent.model || null,
        title: `${sessionName} — ${phase.title || phase.id}`,
        pluginDir: effectivePluginDir,
        launcher: effectiveLauncher,
        // Todo 099: propagate the per-spawn token so the spawned tab
        // sees AGENT_FLAG_TOKEN in its environment. The hook's
        // pre-rename token filter then rejects any flag whose
        // embedded token doesn't match.
        spawnToken,
      });
    } catch (e) {
      // Spawn failed AFTER the flag was written. Clean up the flag
      // so the next spawn this tick (or any spawn before the hook's
      // soft-TTL elapses) doesn't pick up this dead session's prompt
      // (codex round 7 P1).
      if (flagPath) bestEffortUnlink(unlinkSync, flagPath);
      // Todo 090 + 110: roll back the pre-spawn `'spawning'` marker via
      // the shared helper so the next tick sees the phase as the
      // PRE-SPAWN state (not stuck in 'spawning' with no matching
      // live PID). Codex round 2 P1: the prior status depends on
      // dispatch mode — initial spawns came from 'pending', but
      // recovery and review_retry came from 'running' and rolling
      // back to 'pending' would lose review state and bypass retry
      // accounting.
      if (!dryRun) {
        // Codex round 8 P2: review-loop QA handoff is emitted as
        // mode: 'initial' even though the phase is already 'running'
        // (the impl-complete signal triggered the QA dispatch). For
        // those, the prior status is 'running', not 'pending' —
        // rolling back to 'pending' would let the next tick treat
        // the phase as fresh and re-dispatch impl, deleting the
        // existing impl-complete signal. Detect via the manifest's
        // review_loop block + the phase status entry's review_stage.
        const reviewEnabledHere =
          phase.review_loop && phase.review_loop.enabled;
        const phaseEntryHere =
          tickState.status &&
          tickState.status.phases &&
          tickState.status.phases[phase.id];
        const inReviewLoopRunning =
          reviewEnabledHere &&
          phaseEntryHere &&
          (typeof phaseEntryHere.review_stage === 'string' ||
            (Number.isInteger(phaseEntryHere.review_iteration) &&
              phaseEntryHere.review_iteration > 0));
        const priorStatus =
          isRecovery || isReviewRetry || inReviewLoopRunning
            ? 'running'
            : 'pending';
        rollbackSpawningMarker({
          manifestPath,
          phaseId: phase.id,
          role,
          runUpdateFn,
          logger,
          reason: 'spawnFn_threw',
          priorStatus,
        });
      }
      throw e;
    }
  }

  // Codex round 7 P1: serialize flag consumption. After the spawn
  // returns, wait for the hook to atomically rename the flag away
  // (the hook moves it to `.consuming-*` then unlinks). Bounded
  // wait — default 10s, configurable via opts.flagConsumeTimeoutMs
  // for tests. If the timeout elapses, log + continue — the tab
  // may legitimately take longer (cold launch, JIT) and the
  // orchestrator's recovery path will still detect a never-spawning
  // session.
  if (!dryRun && flagPath) {
    // Default timeout: 10s for production, 0 for tests that inject a
    // fake spawn (the test fake doesn't consume the flag, so a real
    // poll would always time out and slow the suite to a crawl).
    // Production callers (which pass no `_spawnSession` seam) get the
    // real serialization. The CLI / runOrchestrator path always
    // exercises the production default.
    const usingFakeSpawn = typeof opts._spawnSession === 'function';
    const consumeTimeoutMs =
      typeof opts.flagConsumeTimeoutMs === 'number' && opts.flagConsumeTimeoutMs >= 0
        ? opts.flagConsumeTimeoutMs
        : usingFakeSpawn
          ? 0
          : 10_000;
    const pollMs =
      typeof opts.flagConsumePollMs === 'number' && opts.flagConsumePollMs > 0
        ? opts.flagConsumePollMs
        : 250;
    if (consumeTimeoutMs > 0) {
      // Busy-wait via existsSync. The wait IS the serialization —
      // executeSpawn is synchronous inside executeActions, so polling
      // the disk here pauses the next spawn until this one's flag is
      // consumed.
      //
      // Bounded loop: max consumeTimeoutMs / pollMs iterations. Each
      // iteration sleeps via a synchronous Atomics-free pollMs delay
      // built from a tight setTimeout-based equivalent. We can't use
      // setTimeout directly inside a sync function, but we can use a
      // pseudo-sleep by busy-checking Date.now until deadline. That
      // burns CPU for the wait window — acceptable because:
      //   1. The wait is short (seconds), bounded by timeout.
      //   2. Tests opt out via the fake-spawn detection.
      //   3. The orchestrator process is single-threaded; nothing
      //      else useful happens on this thread during a spawn.
      const startNow = Date.now();
      while (Date.now() < startNow + consumeTimeoutMs) {
        if (!existsSync(flagPath)) break;
        const until = Date.now() + pollMs;
        while (Date.now() < until) {
          /* busy-spin */
        }
      }
      if (existsSync(flagPath)) {
        // Codex round 8 P1 + round 9 P2: trade-off between two
        // failure modes:
        //   a. Leave flag → next spawn's hook consumes it (oldest-
        //      first), delivering THIS session's prompt to a
        //      different agent. CRITICAL bug; must avoid.
        //   b. Unlink flag → if THIS session's hook is just slow
        //      (>10s), it gets no prompt when it eventually starts.
        //      Visible bug, but recoverable via the recovery path.
        // We pick (b) and treat the timeout AS A SPAWN FAILURE — the
        // flag is unlinked, the spawn is logged as failed, and the
        // matching persist for this role is skipped (per the
        // partial-failure policy). Recovery on the next tick
        // re-dispatches the role with a fresh prompt + flag, so the
        // slow agent still gets work — just with one tick of delay.
        // (a) would lose the trust chain entirely; (b) loses one
        // tick.
        bestEffortUnlink(unlinkSync, flagPath);
        // Todo 111 — REVERTED post-codex round 10 P1.
        //
        // Codex caught: rolling the marker back to 'pending' lets the
        // next tick re-dispatch a fresh tab WITH THE SAME SESSION
        // NAME (orch-<phase>-<role>) while the original timed-out
        // tab may still be alive. 099's token-binding prevents
        // wrong-prompt delivery, but PID lookup is keyed by --name
        // and cannot tell which of two same-named processes is
        // ours — the orchestrator could end up monitoring the wrong
        // PID, breaking the per-(phase, role) uniqueness invariant
        // the rest of the orchestrator depends on.
        //
        // Safer path: leave the 'spawning' marker intact. The next
        // tick's reconciliation pass (decideTickActions, with the
        // wrapper-inclusive defer logic from codex round 6/7)
        // verifies whether the timed-out tab is genuinely dead
        // before allowing a respawn. If it dies → marker rolls back
        // there. If it lives → reconciliation adopts. Either way,
        // session-name uniqueness is preserved.
        //
        // The wasted retry-count increment that 111's RA wanted to
        // save is a smaller cost than the duplicate-session-name
        // bug. Surface in V1.5 design if a more aggressive rollback
        // is needed once spawn-session learns to verify session-
        // name uniqueness before launching.
        const err = new Error(
          `flag ${path.basename(flagPath)} not consumed within ` +
            `${consumeTimeoutMs}ms; treating as spawn failure (cross-session ` +
            `flag delivery would otherwise corrupt the prompt protocol)`
        );
        err.code = 'EFLAGTIMEOUT';
        throw err;
      }
    }
  }

  // Stale-signal cleanup runs ONLY after the spawn succeeds (codex
  // round 5 P2). Codex round 13 P2: only unlink files whose
  // current mtime is ≤ the pre-spawn snapshot. A newer mtime means
  // the agent already wrote a fresh signal — leave it alone.
  // Files that didn't exist pre-spawn are also skipped (any
  // present file is fresh).
  if (!dryRun) {
    const statSync = opts._statSync || fs.statSync;
    for (const p of staleUnlinks) {
      const snap = staleSnapshot.get(p);
      if (!snap || !snap.existed) continue; // wasn't there pre-spawn
      let curMtime = null;
      try {
        const st = statSync(p);
        curMtime = typeof st.mtimeMs === 'number' ? st.mtimeMs : 0;
      } catch (_) {
        continue; // file gone (already cleaned by some other path)
      }
      if (curMtime > snap.mtimeMs) {
        // Fresh write since spawn. Leave it.
        continue;
      }
      bestEffortUnlink(unlinkSync, p);
    }
  }

  // Persist spawn metadata. CRITICAL — design decision #7 / todo 087:
  // spawn-session returns `spawnedAt` (camelCase, JS ergonomic). The
  // manifest-status schema is snake_case (per parse-manifest.
  // KNOWN_UPDATE_FIELDS), and check-health.js reads only `started_at`
  // (the `spawned_at` fallback was dropped in todo 078). We translate
  // here, at the seam between spawn-session output and runUpdate's
  // write.
  if (!dryRun) {
    const updates = {
      // Codex re-round P2: ALWAYS transition status: 'spawning' →
      // 'running' here. Pre-fix relied on the phase-level `persist`
      // action emitted by decideTickActions to set `status: 'running'`,
      // but several spawn paths (e.g., QA dispatch after impl
      // completion) only persist `review_stage` and never set
      // `status` — leaving the phase stuck in 'spawning' after a
      // successful spawn. Next tick's reconciliation would then
      // potentially reset to 'pending' and re-dispatch.
      status: 'running',
      pid: Number.isInteger(spawnResult.pid) ? spawnResult.pid : -1,
      started_at: spawnResult.spawnedAt, // <-- THE TRANSLATION (todo 087)
      // Todo 090: clear the pre-spawn dispatch marker. Empty string
      // (rather than undefined) is intentional — runUpdate's spread
      // overwrites the field.
      dispatched_at: '',
    };
    if (action.mode === 'initial' || action.mode === 'review_retry') {
      // Reset retry_count on a fresh dispatch (initial OR review_retry
      // — both are non-recovery starts of the role's session).
      updates.retry_count = 0;
    }
    // Todo 096: wrap the post-spawn runUpdate in try/catch. The
    // spawnFn ALREADY RETURNED — the wt tab is live. If runUpdate
    // throws (FS error, validation drift, etc.) we MUST NOT touch the
    // manifest-status: leaving the `'spawning'` marker intact lets
    // the next tick's reconciliation pass (orchestrate.js's spawning-
    // marker loop in decideTickActions) detect `'spawning'` + a live
    // PID match and adopt the session — transitioning to 'running'
    // and persisting pid lazily.
    //
    // **DO NOT call rollbackSpawningMarker here.** That helper is for
    // pre-spawnFn-launch failures only (todo 110). At THIS catch
    // site the spawn launched and the tab is alive; rolling the
    // marker back to 'pending' would orphan the live tab AND make
    // the phase eligible for re-dispatch on the next tick — exactly
    // the duplicate-spawn bug 088 / 093 / 096 are designed to close.
    //
    // {ok: false} return + thrown errors are both handled here so
    // a future runUpdate refactor that converts soft-fails to
    // throws can't reintroduce the bug.
    let postSpawnUpdateFailed = false;
    try {
      const r = runUpdateFn(manifestPath, phase.id, updates);
      if (!r || !r.ok) {
        postSpawnUpdateFailed = true;
        logger('error', `runUpdate post-spawn failed: ${(r && r.error) || 'unknown error'}`, {
          phaseId: phase.id,
          role,
        });
      }
    } catch (e) {
      // Marker stays as 'spawning'; reconciliation adopts next tick.
      postSpawnUpdateFailed = true;
      logger('error', `runUpdate post-spawn threw (marker left 'spawning' for reconciliation): ${e && e.message ? e.message : String(e)}`, {
        phaseId: phase.id,
        role,
      });
    }
    // Codex round 4 P2: when the post-spawn runUpdate fails for ANY
    // reason ({ok:false} or thrown), signal the tick so the follow-
    // up `persist` action in executeActions SKIPS this phase. Without
    // this, executeActions would run the persist with stale-or-empty
    // updates on top of the 'spawning' marker — overwriting it with
    // 'running' but without pid/started_at, defeating 096's
    // reconciliation-adopts-next-tick contract.
    if (postSpawnUpdateFailed) {
      if (!runState.postSpawnUpdateFailedThisTick) {
        runState.postSpawnUpdateFailedThisTick = new Set();
      }
      runState.postSpawnUpdateFailedThisTick.add(phase.id);
    }
  }
  logger('info', `spawned ${sessionName} pid=${spawnResult.pid}`, {
    phaseId: phase.id,
    role,
    sessionName,
    pid: spawnResult.pid,
  });
}

// -------------------- Main loop --------------------

/**
 * Run one tick. Public for tests; used by `runOrchestrator` internally.
 * Returns the executeActions output plus the loaded tick state, so
 * callers can introspect or test.
 */
function runOneTick(runState, opts) {
  // Reset per-tick state. spawnFailedThisTick + spawnSucceededThisTick
  // are the cross-action signals letting subsequent `persist` actions
  // decide whether to apply the status: running update — see
  // executeActions's persist handler for the all-failed-vs-partial
  // policy (codex round 6 P2). flagTimeoutThisTick is the poison-
  // pill that stops further spawns once a prior spawn's flag-consume
  // timeout left a slow tab that could steal subsequent prompts
  // (codex round 17 P1).
  runState.spawnFailedThisTick = new Set();
  runState.spawnSucceededThisTick = new Set();
  runState.flagTimeoutThisTick = false;
  // Codex round 4 P2: track phases whose post-spawn runUpdate
  // (todo 096) failed this tick so the follow-up persist in
  // executeActions skips them.
  runState.postSpawnUpdateFailedThisTick = new Set();
  const tickResult = pollAllPhases(opts);
  if (!tickResult.ok) {
    const logger = opts.logger || makeDefaultLogger();
    logger('error', `tick failed: ${tickResult.error}`);
    if (tickResult.errorKind === 'config') {
      // Config-level tick failure halts the orchestrator. The operator
      // must edit the manifest before we can advance. Do NOT spin
      // tight — this is the dispatch's "errorKind: 'config' ⇒ pause +
      // escalate" policy at the top level.
      return {
        ok: false,
        halt: true,
        error: tickResult.error,
        warnings: [],
        completed: [],
        failed: [],
        blocked: [],
        spawned: 0,
      };
    }
    return {
      ok: false,
      halt: false,
      error: tickResult.error,
      warnings: [],
      completed: [],
      failed: [],
      blocked: [],
      spawned: 0,
    };
  }
  const tickState = { ...tickResult, manifestPath: opts.manifestPath };
  const actions = decideTickActions(tickState, runState, opts);
  const result = executeActions(actions, tickState, runState, opts);
  result.tickState = tickState;
  result.actions = actions;
  result.ok = !result.fatal;
  result.halt = !!result.fatal;
  return result;
}

/**
 * Main loop. Polls every `activeIntervalMs` (or `idleIntervalMs` when
 * no phase is running) until every phase reaches a terminal status,
 * the AbortSignal aborts, or a fatal error halts the loop.
 *
 * Returns:
 *   { ok, summary, history, lockPath }
 *
 * `lockPath` is returned for tests + advanced callers; production
 * callers do not need to reference it (the loop releases the lock on
 * normal exit).
 */
async function runOrchestrator(opts) {
  if (!opts || typeof opts.manifestPath !== 'string' || opts.manifestPath.trim() === '') {
    throw new Error('runOrchestrator: manifestPath is required (non-empty string)');
  }
  const logger = opts.logger || makeDefaultLogger();
  const sleep = opts._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const activeMs = opts.activeIntervalMs || DEFAULT_ACTIVE_INTERVAL_MS;
  const idleMs = opts.idleIntervalMs || DEFAULT_IDLE_INTERVAL_MS;
  const maxTicks = Number.isInteger(opts.maxTicks) ? opts.maxTicks : null;
  const signal = opts.signal || null;
  const dryRun = !!opts.dryRun;

  // Pre-flight: scaffold protocol + acquire lock + (initial mode only)
  // re-render initial prompts via scaffold's templates copy.
  const manifestDir = path.dirname(path.resolve(opts.manifestPath));
  const orchDir = orchDirFor(manifestDir);

  // Codex round 21 P2: honor --resume vs bare-run distinction.
  // Bare run (no --resume) refuses to start when manifest-status
  // exists with non-completed phases — otherwise the operator
  // would silently re-attach to a half-finished prior run, which
  // could re-spawn already-running agents or treat completed
  // phases as terminal without verification. Force the operator
  // to either pass --resume or delete the status file.
  if (!opts.resume && !dryRun) {
    const statusFn = opts._loadStatus || loadStatus;
    const sr = statusFn(opts.manifestPath);
    if (sr.ok && sr.status && sr.status.phases) {
      const nonCompleted = Object.entries(sr.status.phases).filter(
        ([, v]) =>
          v && typeof v === 'object' && v.status && v.status !== 'completed'
      );
      if (nonCompleted.length > 0) {
        const ids = nonCompleted.map(([id]) => id).join(', ');
        const msg =
          `manifest-status.yaml has non-completed phase(s): ${ids}. ` +
          `Pass --resume to continue from existing state, or delete ` +
          `the status file to start fresh.`;
        logger('error', msg);
        return {
          ok: false,
          summary: 'resume_required',
          history: [],
          error: msg,
        };
      }
    }
  }

  // Scaffold protocol (idempotent — never clobbers existing artifacts).
  if (!opts.skipScaffold) {
    const scaffoldFn = opts._scaffoldProtocol || scaffoldProtocol;
    const scaffoldResult = scaffoldFn({
      manifestPath: opts.manifestPath,
      pluginDir: opts.pluginDir || null,
      dryRun,
    });
    if (!scaffoldResult.ok) {
      const errs = scaffoldResult.errors
        ? scaffoldResult.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
        : scaffoldResult.error;
      logger('error', `scaffold failed: ${errs}`);
      return {
        ok: false,
        summary: 'scaffold_failed',
        history: [],
        error: errs,
      };
    }
    // Codex round 23 P2 + round 24 P2: scaffold returns ok: true
    // with a warning when the source `templates/` directory is
    // missing (templates_dir null) AND ALSO returns ok with
    // templates_dir set when the dir exists but is empty/
    // incomplete. Either case dooms every spawn to a "cannot read
    // template" error and an infinite phase-pending retry loop.
    // Verify ALL required templates are present before starting.
    if (!dryRun) {
      const REQUIRED_TEMPLATES = [
        'protocol-header.md',
        'impl-prompt.md',
        'qa-prompt.md',
        'qa-playbook-prompt.md',
        'coordinator-briefing.md',
        'recovery-prompt.md',
      ];
      const tmplDir = scaffoldResult.templates_dir;
      const existsSync = opts._existsSync || fs.existsSync;
      const missing =
        !tmplDir
          ? REQUIRED_TEMPLATES
          : REQUIRED_TEMPLATES.filter(
              (n) => !existsSync(path.join(tmplDir, n))
            );
      if (missing.length > 0) {
        const warnings = (scaffoldResult.warnings || []).join('; ');
        const msg =
          `scaffold completed but required template(s) ${JSON.stringify(missing)} ` +
          `are missing from ${tmplDir || '(no templates dir)'}${warnings ? ` (${warnings})` : ''} ` +
          `— orchestrator cannot render prompts`;
        logger('error', msg);
        return {
          ok: false,
          summary: 'scaffold_no_templates',
          history: [],
          error: msg,
        };
      }
    }
  }

  // Lockfile. Acquired per orchestrator instance; released on exit.
  // Codex round 18 P2: dry-run is the previewer — it must not
  // mutate the filesystem, including the lockfile. Skip both
  // acquire and release on dry-run; concurrent dry-runs are
  // harmless since they don't touch any persistent state.
  //
  // Codex round 22 P2: when manifest.workdir != manifestDir, the
  // hook flag directory is separate from the manifest directory.
  // Two orchestrators targeting the same workdir from DIFFERENT
  // manifests would each hold their own manifest-dir lock but
  // race on the shared workdir's `.pending-*` files. Acquire a
  // SECONDARY lock at the hook flag directory when it differs
  // from the manifest's so shared-workdir concurrent runs are
  // detected and refused. We don't yet know workdir at this
  // scope, so we read the raw manifest once for the lock
  // decision; the rest of the loop uses pollAllPhases.
  let lockPath = null;
  let workdirLockPath = null;
  if (!dryRun) {
    try {
      lockPath = acquireLock(orchDir, opts);
    } catch (e) {
      logger('error', e.message);
      return {
        ok: false,
        summary: 'lock_contention',
        history: [],
        error: e.message,
        code: e.code === 'ELOCKED' ? 2 : 1,
      };
    }
    // Conditional secondary lock for shared-workdir concurrency.
    try {
      const loadFn = opts._loadManifest || loadManifest;
      const preLoad = loadFn(opts.manifestPath);
      if (preLoad.ok && preLoad.manifest && typeof preLoad.manifest.workdir === 'string') {
        const wd = path.isAbsolute(preLoad.manifest.workdir)
          ? preLoad.manifest.workdir
          : path.resolve(manifestDir, preLoad.manifest.workdir);
        const wdOrch = orchDirFor(wd);
        // Codex round 23 P2: case-insensitive comparison on Windows.
        // path.normalize preserves casing, so absolute paths like
        // C:\Repo and c:\repo compare unequal even though Windows
        // treats them as the same directory. The orchestrator would
        // then try to acquire its own lock a second time (filesystem
        // sees the same file) and report contention against its own
        // PID. Use a platform-aware compare.
        const samePath = (a, b) => {
          const na = path.normalize(a);
          const nb = path.normalize(b);
          return process.platform === 'win32'
            ? na.toLowerCase() === nb.toLowerCase()
            : na === nb;
        };
        if (!samePath(wdOrch, orchDir)) {
          // Codex round 24 P2: validate workdir EXISTS before
          // acquiring its lock. acquireLock's recursive mkdir would
          // otherwise silently create a typoed/missing workdir
          // (e.g. `workdir: ../sibling-repo-typo`), masking the
          // config error and starting agents in an empty
          // directory.
          const wdExists = (opts._existsSync || fs.existsSync)(wd);
          if (!wdExists) {
            const msg = `manifest.workdir does not exist: ${wd}`;
            logger('error', msg);
            releaseLock(lockPath, opts);
            return {
              ok: false,
              summary: 'workdir_not_found',
              history: [],
              error: msg,
            };
          }
          try {
            workdirLockPath = acquireLock(wdOrch, opts);
          } catch (e) {
            logger('error', e.message);
            releaseLock(lockPath, opts);
            return {
              ok: false,
              summary: 'lock_contention',
              history: [],
              error: `secondary workdir lock: ${e.message}`,
              code: e.code === 'ELOCKED' ? 2 : 1,
            };
          }
        }
      }
    } catch (_) {
      /* manifest load is best-effort here; pollAllPhases will surface real errors */
    }
  }

  // Todo 105: --resume reconciliation-aware sweep with the four-cell
  // decision table.
  //
  // Cells (live PID? × matching .pending-<name> present?):
  //   1. PID alive + flag present  → preserve flag (tab is waiting).
  //   2. PID alive + no flag       → adopt: 'spawning' → 'running' now.
  //   3. No PID + flag present     → orphan: rollback marker, sweep flag.
  //   4. No PID + no flag          → rollback marker (no flag to sweep).
  //
  // After the per-phase reconciliation, sweep every .pending-* in the
  // orch dir EXCEPT the preserved set (cell 1 flags). Each subsequent
  // spawn from this resume's main loop writes its own .pending-<name>
  // after the sweep — no tick-1 leakage.
  //
  // Degenerate case: when buildPidSnapshot returns null (PowerShell /
  // WMI failure on this resume entry), the preserved set can't be
  // computed reliably. The sweep DEFERS entirely — no flags swept,
  // no markers rolled back. Matches the existing 090 reconciliation's
  // skip-on-null behavior at decideTickActions.
  if (opts.resume && !dryRun) {
    try {
      const loadFn = opts._loadManifest || loadManifest;
      const statusFn = opts._loadStatus || loadStatus;
      const ml = loadFn(opts.manifestPath);
      const sl = statusFn(opts.manifestPath);
      // Codex round 1 P2 fix: resolve the HOOK orch dir, NOT the
      // manifest-dir orch dir. executeSpawn writes flags under
      // orchDirFor(resolvedWorkdir); for manifests with a separate
      // workdir, those two paths diverge. Pre-fix the resume sweep
      // checked/swept the manifest-dir orchDir and missed the
      // workdir-side flags entirely — misclassifying every
      // spawning-with-flag case as cell 4 (no flag) and adopting
      // every spawning-with-no-flag-on-disk case as cell 2.
      let resumeOrchDir = orchDir;
      if (ml.ok && ml.manifest && typeof ml.manifest.workdir === 'string') {
        const wd = path.isAbsolute(ml.manifest.workdir)
          ? ml.manifest.workdir
          : path.resolve(manifestDir, ml.manifest.workdir);
        resumeOrchDir = orchDirFor(wd);
      }
      if (ml.ok && sl.ok && sl.status && sl.status.phases) {
        // Build a pidSnapshot for every spawning (phase, role).
        const spawningEntries = [];
        for (const phaseId of Object.keys(sl.status.phases)) {
          const e = sl.status.phases[phaseId];
          if (!e || typeof e !== 'object' || e.status !== 'spawning') continue;
          // Determine candidate roles: declared agents in the manifest,
          // plus review-loop synthesized roles.
          const phase = ml.manifest && Array.isArray(ml.manifest.phases)
            ? ml.manifest.phases.find((p) => p && p.id === phaseId)
            : null;
          const declaredRoles = new Set(
            Array.isArray(phase && phase.agents)
              ? phase.agents.map((a) => a && a.role).filter((r) => typeof r === 'string')
              : phase && phase.agent && typeof phase.agent.role === 'string'
                ? [phase.agent.role]
                : []
          );
          if (phase && phase.review_loop && phase.review_loop.enabled) {
            declaredRoles.add('impl');
            declaredRoles.add('qa');
          }
          for (const role of declaredRoles) {
            spawningEntries.push({ phaseId, role });
          }
        }
        const sessionNames = spawningEntries.map((s) =>
          defaultSessionName(s.phaseId, s.role)
        );
        const pidSnapshot = buildPidSnapshot(sessionNames, opts);
        // Codex round 4 P2: build a SECONDARY snapshot that includes
        // wrappers (cmd/powershell). On --resume immediately after a
        // crash during dispatch, the only process WMI may show for a
        // tab that has not consumed its prompt yet is the wrapper.
        // The primary snapshot above excludes wrappers by design (so
        // health checks don't report a dead Claude as alive via its
        // surviving cmd /k wrapper), but for resume reconciliation
        // we want to know "is ANY process alive for this session" —
        // wrapper-only counts.
        //
        // Codex round 10 P2: pidSnapshotWithWrappers === null means
        // the secondary lookup failed. Without it we'd misclassify
        // wrapper-only waiting tabs as cell 3 (sweep flag) and
        // orphan them. Treat this as "snapshot unavailable" for
        // the entire sweep — defer like the primary-null case.
        let pidSnapshotWithWrappers = null;
        let wrapperSnapshotFailed = false;
        if (pidSnapshot !== null) {
          try {
            const buildWithWrappers = (sn, oo) => {
              const m = new Map();
              const runner = (oo && oo._pidRunner) ||
                ((program, argv) =>
                  require('child_process').execFileSync(program, argv, {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    encoding: 'utf8',
                  }));
              let stdout;
              try {
                stdout = runner('powershell', require('./spawn-session').buildPidLookupArgs
                  ? require('./spawn-session').buildPidLookupArgs()
                  : ['-NoProfile', '-NoLogo', '-Command',
                    "@(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--name %'\" | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress -Depth 1"
                  ]);
              } catch (_) {
                return null;
              }
              const { parsePidLookupOutput } = require('./spawn-session');
              for (const name of sn) {
                const pid = parsePidLookupOutput(stdout, name, { excludeWrappers: false });
                if (Number.isInteger(pid) && pid > 0) {
                  m.set(name, { pid });
                }
              }
              return m;
            };
            pidSnapshotWithWrappers = buildWithWrappers(sessionNames, opts);
            if (pidSnapshotWithWrappers === null) wrapperSnapshotFailed = true;
          } catch (_) {
            pidSnapshotWithWrappers = null;
            wrapperSnapshotFailed = true;
          }
        }
        if (pidSnapshot === null || wrapperSnapshotFailed) {
          logger(
            'warn',
            `resume sweep deferred: pid snapshot unavailable (${pidSnapshot === null ? 'primary' : 'wrapper-inclusive'} PowerShell/WMI failure); next tick will retry`
          );
        } else {
          const preservedFlags = new Set();
          const runUpdateFn = opts._runUpdate || runUpdate;
          // Codex round 3 P2: the manifest-status `'spawning'` marker
          // is PHASE-SCOPED (single status per phase), but
          // spawningEntries iterates over ROLES. For multi-role /
          // review-loop phases we MUST track which phases have
          // already been adopted (cell 2) or had a flag preserved
          // (cell 1) so a sibling role's cell-4 rollback doesn't
          // clobber the phase-level adoption back to 'pending'.
          const phaseDecided = new Set();
          for (const { phaseId, role } of spawningEntries) {
            const sessionName = defaultSessionName(phaseId, role);
            const flagBasename = `.pending-${sessionName}`;
            const flagAbsPath = path.join(resumeOrchDir, flagBasename);
            const snap = pidSnapshot.get(sessionName);
            // Codex round 5 P2: infer the pre-marker status from the
            // phase entry's existing fields. A 'spawning' marker can
            // come from THREE dispatch modes:
            //   - initial: phase was 'pending'; rollback to 'pending'.
            //   - recovery: phase was 'running' before the crash that
            //     triggered the recovery dispatch; rollback to 'running'
            //     to preserve retry_count and let the next tick continue
            //     the recovery rather than restart from initial.
            //   - review_retry: phase was 'running' (in review_stage:
            //     review_retry_pending or similar); rollback to 'running'
            //     preserves review_iteration / review_stage.
            //
            // Heuristic: if review_iteration > 0 OR review_stage is set
            // → was in a review-loop dispatch ('running'). Else if
            // retry_count > 0 → recovery dispatch ('running'). Else
            // initial → 'pending'.
            const phaseEntry = sl.status.phases[phaseId];
            const inReviewLoop =
              phaseEntry &&
              (Number.isInteger(phaseEntry.review_iteration) && phaseEntry.review_iteration > 0 ||
                (typeof phaseEntry.review_stage === 'string' && phaseEntry.review_stage !== ''));
            const inRecovery =
              phaseEntry &&
              Number.isInteger(phaseEntry.retry_count) &&
              phaseEntry.retry_count > 0;
            const inferredPriorStatus =
              inReviewLoop || inRecovery ? 'running' : 'pending';
            // Codex round 4 P2: a tab that hasn't consumed its prompt
            // yet may only have its wrapper (cmd/powershell) visible
            // to WMI. The primary snapshot (excludeWrappers:true)
            // misses the wrapper-only case; the secondary snapshot
            // (excludeWrappers:false) catches it. For resume
            // reconciliation we accept ANY live process — wrapper-
            // only or inner Claude — so we don't sweep a flag whose
            // intended tab is still waiting for its hook to fire.
            const wrapperSnap =
              pidSnapshotWithWrappers && pidSnapshotWithWrappers.get(sessionName);
            const liveAlive = !!(
              (snap && Number.isInteger(snap.pid) && snap.pid > 0) ||
              (wrapperSnap && Number.isInteger(wrapperSnap.pid) && wrapperSnap.pid > 0)
            );
            const existsSync = opts._existsSync || fs.existsSync;
            const flagPresent = existsSync(flagAbsPath);
            // Codex round 13 P2: differentiate inner-Claude alive vs
            // wrapper-only. Cell 1 (preserve flag) accepts wrapper-
            // only as evidence the tab is still launching. Cell 2
            // (adopt as running) requires INNER Claude alive — a
            // wrapper-only with no flag means Claude exited and the
            // wrapper is post-mortem; adopting it would mark a dead
            // session 'running' with a fresh started_at grace window.
            const innerAlive = !!(snap && Number.isInteger(snap.pid) && snap.pid > 0);
            const wrapperAlive = !!(
              wrapperSnap && Number.isInteger(wrapperSnap.pid) && wrapperSnap.pid > 0
            );
            // Resolve the actual PID for adoption / logging. Prefer
            // the inner Claude's PID; fall back to the wrapper's PID
            // when only it is visible (used for logs / cell 1).
            const adoptedPid = innerAlive ? snap.pid
              : wrapperAlive ? wrapperSnap.pid
              : null;
            if (liveAlive && flagPresent) {
              // Cell 1: tab waiting for prompt — preserve flag.
              // Wrapper-only is fine here; the SessionStart hook
              // will fire when Claude eventually starts, consume
              // the flag, and the next tick's reconciliation will
              // adopt via the normal inner-Claude PID match.
              preservedFlags.add(flagBasename);
              phaseDecided.add(phaseId);
              logger(
                'info',
                `resume reconciliation [cell 1]: preserving ${flagBasename} (tab pid=${adoptedPid} waiting for prompt)`,
                { phaseId, role }
              );
            } else if (innerAlive && !flagPresent) {
              // Cell 2: adopt — transition to running. Codex round 13
              // P2: gate on innerAlive specifically (NOT liveAlive),
              // so a wrapper-only post-mortem doesn't get adopted as
              // a fresh running phase.
              //
              // Codex round 15 P2: preserve the original
              // dispatched_at as started_at (mirrors the normal
              // reconciliation path at decideTickActions). Pre-fix
              // this used resume-time, giving an old session a
              // fresh startup-grace and phase-timeout window —
              // hiding sessions that should have already timed out
              // or triggered recovery.
              const startedAt =
                phaseEntry && typeof phaseEntry.dispatched_at === 'string' && phaseEntry.dispatched_at !== ''
                  ? phaseEntry.dispatched_at
                  : new Date(opts._now ? opts._now() : Date.now()).toISOString();
              const r = runUpdateFn(opts.manifestPath, phaseId, {
                status: 'running',
                pid: adoptedPid,
                started_at: startedAt,
                dispatched_at: '',
              });
              if (r && r.ok) phaseDecided.add(phaseId);
              logger(
                r && r.ok ? 'info' : 'warn',
                `resume reconciliation [cell 2]: adopting live session pid=${adoptedPid} (no flag — already consumed)${r && r.ok ? '' : ' — runUpdate failed: ' + (r && r.error || 'unknown')}`,
                { phaseId, role }
              );
            } else if (flagPresent) {
              // Cell 3: orphan — flag without an inner-Claude PID
              // (and either no wrapper alive, or the wrapper-only
              // window has elapsed). Rollback marker, sweep flag.
              // Codex round 3 P2: skip the rollback if a sibling role
              // for the same phase already adopted (cell 1/2). The
              // 'spawning' marker is phase-scoped, so the adoption
              // already overwrote it with 'running'; rolling back here
              // would undo the adoption.
              if (phaseDecided.has(phaseId)) {
                try { fs.unlinkSync(flagAbsPath); } catch (_) { /* ignore */ }
                logger(
                  'info',
                  `resume reconciliation [cell 3, sibling-skip]: phase already adopted via another role — sweeping ${flagBasename} only`,
                  { phaseId, role }
                );
              } else {
                rollbackSpawningMarker({
                  manifestPath: opts.manifestPath,
                  phaseId,
                  role,
                  runUpdateFn,
                  logger,
                  reason: 'resume_orphan_with_flag',
                  priorStatus: inferredPriorStatus,
                });
                // Codex round 12 P2: charge the failed mid-spawn
                // attempt against retry_count — symmetric with
                // decideTickActions's reconciliation rollback.
                // Codex round 13 P2: ONLY increment if the existing
                // retry_count has a well-formed shape. A corrupt
                // value (e.g. "two") would otherwise be silently
                // coerced to 0 and overwritten with 1, defeating
                // the next-tick shape-validation pre-pass that
                // would have blocked the phase. Leave corrupt
                // values in place so the pre-pass surfaces them.
                const shape = validateRetryCountShape(phaseEntry);
                if (shape.ok) {
                  runUpdateFn(opts.manifestPath, phaseId, { retry_count: shape.value + 1 });
                }
                try { fs.unlinkSync(flagAbsPath); } catch (_) { /* ignore */ }
                logger(
                  'info',
                  `resume reconciliation [cell 3]: rolled back marker (retry_count${shape.ok ? ` ${shape.value} → ${shape.value + 1}` : ' left corrupt for pre-pass to block'}), swept orphan ${flagBasename}`,
                  { phaseId, role }
                );
                phaseDecided.add(phaseId);
              }
            } else {
              // Cell 4: clean rollback. Includes:
              //   - !liveAlive && !flagPresent (no process anywhere)
              //   - wrapperAlive && !innerAlive && !flagPresent
              //     (wrapper-only post-mortem after Claude exited)
              // Both warrant rollback so the phase becomes eligible
              // for re-dispatch / recovery on the next tick.
              // Codex round 3 P2: same sibling-skip discipline as
              // cell 3 — don't undo a sibling's adoption.
              if (phaseDecided.has(phaseId)) {
                logger(
                  'info',
                  'resume reconciliation [cell 4, sibling-skip]: phase already adopted via another role',
                  { phaseId, role }
                );
              } else {
                rollbackSpawningMarker({
                  manifestPath: opts.manifestPath,
                  phaseId,
                  role,
                  runUpdateFn,
                  logger,
                  reason: 'resume_clean_rollback',
                  priorStatus: inferredPriorStatus,
                });
                // Codex round 13 P2: shape-conditional increment as
                // in cell 3 — corrupt values stay corrupt so the
                // next-tick pre-pass blocks them.
                const shape = validateRetryCountShape(phaseEntry);
                if (shape.ok) {
                  runUpdateFn(opts.manifestPath, phaseId, { retry_count: shape.value + 1 });
                }
                const wrapperOnly = !innerAlive && wrapperAlive;
                logger(
                  'info',
                  `resume reconciliation [cell 4]: rolled back marker (retry_count${shape.ok ? ` ${shape.value} → ${shape.value + 1}` : ' left corrupt for pre-pass to block'}; ${wrapperOnly ? 'wrapper-only post-mortem' : 'no live PID'}, no flag)`,
                  { phaseId, role }
                );
                phaseDecided.add(phaseId);
              }
            }
          }
          // Sweep all .pending-* in the (workdir-side) orch dir EXCEPT
          // preservedFlags. Each subsequent spawn writes its own flag
          // after the sweep. Use resumeOrchDir (= workdir's orchDir
          // when manifest declares a separate workdir) — codex round 1
          // P2 caught the misalignment with executeSpawn's write site.
          let entries = [];
          try {
            entries = (opts._readdirSync || fs.readdirSync)(resumeOrchDir);
          } catch (e) {
            if (e && e.code !== 'ENOENT') {
              logger('warn', `resume sweep readdir failed at ${resumeOrchDir}: ${e.message}`);
            }
          }
          let swept = 0;
          for (const name of entries) {
            if (typeof name !== 'string') continue;
            if (!name.startsWith('.pending-')) continue;
            if (preservedFlags.has(name)) continue;
            if (name.includes('.tmp-')) continue;
            const p = path.join(resumeOrchDir, name);
            try {
              fs.unlinkSync(p);
              swept += 1;
            } catch (_) { /* best-effort */ }
          }
          // Codex round 7 P2: carry the cell-1-preserved set forward
          // so executeSpawn's own stale-flag sweep (in the same
          // first-tick window) doesn't delete the preserved flag.
          // executeSpawn's sweep iterates ALL `.pending-*` in the
          // hook orch dir except its own session — without this
          // carry, a subsequent spawn this tick would clobber the
          // waiting tab's flag and the tab would lose its prompt.
          if (preservedFlags.size > 0) {
            opts._preservedResumeFlags = preservedFlags;
          }
          logger(
            'info',
            `resume sweep complete: preserved=${preservedFlags.size}, swept=${swept}, adopted=${spawningEntries.length}`
          );
        }
      }
    } catch (e) {
      logger('warn', `resume reconciliation failed: ${e && e.message ? e.message : String(e)}`);
    }
  }

  const runState = {
    convergenceCounters: new Map(),
    tickIndex: 0,
    history: [],
  };

  let exitOk = true;
  // Cumulative failure tracker across the whole run. Codex round 2
  // P2: tickState.status loaded at START-of-tick does NOT reflect the
  // mark_phase_failed actions executeActions just dispatched, so the
  // single end-of-tick allTerminal check could miss a phase that just
  // failed this tick under --once / --max-ticks 1. We OR in
  // `tickRes.failed.length > 0` per-tick so exit code stays correct.
  let sawFailureOrBlocked = false;
  let exitReason = null; // 'completed' | 'aborted' | 'max_ticks_unfinished' | 'max_ticks_failed' | etc.

  // Todo 095: register a SINGLE abort listener for the lifetime of the
  // run. Pre-fix, the inter-tick sleep wired a fresh `addEventListener`
  // each tick, and `{once:true}` only auto-removes when the abort
  // actually fires — so over 24h of idle polling (~720 ticks) we'd
  // accumulate 720 listeners on the same signal, tripping Node's
  // MaxListenersExceededWarning at 11 and pinning unbounded references
  // to closed-over per-tick state.
  //
  // Pattern: a shared `pendingSleepAbort` ref points at the current
  // tick's resolver (or `null` between ticks). The single listener
  // calls whatever resolver is currently parked on the ref.
  let pendingSleepAbort = null;
  let sleepAbortListener = null;
  if (signal && typeof signal.addEventListener === 'function') {
    sleepAbortListener = () => {
      const r = pendingSleepAbort;
      pendingSleepAbort = null;
      if (r) r();
    };
    signal.addEventListener('abort', sleepAbortListener, { once: true });
  }

  try {
    for (;;) {
      if (signal && signal.aborted) {
        logger('info', 'aborted via signal');
        // Codex round 14 P2: aborted = unfinished. Documented exit
        // contract: 0 = every phase completed. Ctrl+C / SIGTERM
        // mid-run is by definition NOT every-phase-completed.
        exitOk = false;
        exitReason = 'aborted';
        break;
      }
      if (maxTicks !== null && runState.tickIndex >= maxTicks) {
        logger('info', `max ticks reached (${maxTicks}); exiting`);
        // Codex round 6 P2: if --once / --max-ticks exits while
        // phases are still running (or pending), the run did NOT
        // complete. exit code must be non-zero with a clear summary
        // — the documented contract is "0 = every phase completed",
        // and a tick that just spawned sessions and left them running
        // is not "completed."
        if (sawFailureOrBlocked) {
          exitOk = false;
          exitReason = 'max_ticks_failed';
        } else {
          // Inspect the last tick's loaded state to distinguish
          // "everything terminal at maxTicks" (rare; would have hit
          // allTerminal exit first) from "phases still running".
          const lastTickState = runState.history[runState.history.length - 1];
          // The loop exits via allTerminal BEFORE this branch when
          // every phase is terminal, so reaching here with maxTicks
          // implies at least one phase is non-terminal.
          exitOk = false;
          exitReason = 'max_ticks_unfinished';
          void lastTickState;
        }
        break;
      }
      runState.tickIndex += 1;
      // Todo 088: defense-in-depth try/catch around runOneTick. The
      // ce:review identified that any uncaught throw inside the tick
      // body (e.g., a bare fs.writeFileSync that hits EBUSY before
      // the round-13 atomic-rename fix lands, or any future bare
      // throw introduced by a downstream change) would tank the
      // entire polling loop. Per the unit's stated invariant —
      // "failure of one tick must not tank the loop" — log and
      // continue. Recovery on the next tick handles whatever state
      // the partial tick left behind.
      let tickRes;
      try {
        tickRes = runOneTick(runState, opts);
      } catch (e) {
        logger(
          'error',
          renderProblemBlock({
            problem: `tick ${runState.tickIndex} threw an uncaught error`,
            file: opts.manifestPath,
            fix:
              `inspect the error and the manifest-status state; the orchestrator ` +
              `will continue polling on the next tick. Repeated throws on the same ` +
              `tick suggest a config issue (read-only worktree, full disk).`,
          })
        );
        logger('error', `uncaught: ${e && e.message}`);
        // Synthesize an empty tick result so the loop continues
        // cleanly. Skip the post-action terminal-state check this
        // iteration (status didn't load) — next tick re-evaluates.
        tickRes = {
          ok: false,
          halt: false,
          error: e && e.message,
          warnings: [`uncaught tick error: ${e && e.message}`],
          completed: [],
          failed: [],
          blocked: [],
          spawned: 0,
          tickState: null,
          actions: [],
        };
      }
      runState.history.push({
        tick: runState.tickIndex,
        spawned: tickRes.spawned,
        completed: tickRes.completed.length,
        failed: tickRes.failed.length,
        blocked: tickRes.blocked.length,
      });
      if (tickRes.failed.length > 0 || tickRes.blocked.length > 0) {
        sawFailureOrBlocked = true;
      }
      if (tickRes.fatal) {
        logger('error', `fatal: ${tickRes.fatal}`);
        exitOk = false;
        break;
      }
      if (tickRes.halt) {
        logger('error', `halting: ${tickRes.error}`);
        exitOk = false;
        break;
      }

      // Check terminal completion. The terminal condition: every phase
      // is in a terminal status (completed / failed / blocked).
      //
      // Codex round 7 P2: tickState.status was loaded BEFORE
      // executeActions ran, so mark_phase_completed / failed / blocked
      // updates aren't visible to the original status object. Re-read
      // manifest-status once here so the terminal check sees the
      // post-action truth. Without this, --once on a manifest whose
      // last phase completes this tick would exit as
      // max_ticks_unfinished, and even normal runs would burn an
      // extra polling interval before noticing all-done.
      // Todo 088 follow-on: when the tick threw before producing a
      // tickState (synthesized empty result above), skip the
      // terminal-state check — there's no manifest snapshot to
      // reason about. Next tick re-loads cleanly.
      if (!tickRes.tickState) {
        // Sleep + continue.
        if (maxTicks !== null && runState.tickIndex >= maxTicks) continue;
        await sleep(activeMs);
        continue;
      }
      const loadStatusFn = opts._loadStatus || loadStatus;
      const postStatusResult = loadStatusFn(opts.manifestPath);
      const postStatus =
        postStatusResult.ok && postStatusResult.status
          ? postStatusResult.status
          : tickRes.tickState.status;
      const allTerminal = (() => {
        if (!tickRes.tickState || !tickRes.tickState.phases) return false;
        for (const p of tickRes.tickState.phases) {
          const e = getPhaseStatus(postStatus, p.id);
          if (!isTerminalStatus(e.status)) return false;
        }
        return true;
      })();
      if (allTerminal) {
        const anyFailed = tickRes.tickState.phases.some((p) => {
          const e = getPhaseStatus(postStatus, p.id);
          return e.status === 'failed';
        });
        const anyBlocked = tickRes.tickState.phases.some((p) => {
          const e = getPhaseStatus(postStatus, p.id);
          return e.status === 'blocked';
        });
        if (anyFailed || anyBlocked) {
          exitOk = false;
          exitReason = 'completed_with_failures';
        } else {
          exitReason = 'completed';
        }
        logger(
          'info',
          `all phases terminal — completed=${tickRes.tickState.phases.length - tickRes.failed.length - tickRes.blocked.length} failed=${anyFailed} blocked=${anyBlocked}`
        );
        break;
      }

      // Codex round 14 P2: skip the sleep when the next iteration's
      // top-of-loop maxTicks check is going to break out anyway. A
      // `--once` / `--max-ticks 1` invocation should return
      // immediately after the requested tick, not wait active/idle
      // interval first.
      if (maxTicks !== null && runState.tickIndex >= maxTicks) {
        continue;
      }
      // Pick cadence. Active = at least one phase running this tick.
      // Codex round 10 P2: tickState.status was loaded BEFORE
      // executeActions, so a tick that just spawned a pending phase
      // still sees it as `pending` here — the loop would idle 120s
      // before ever polling the freshly spawned session. Treat
      // `tickRes.spawned > 0` as an active signal in addition to
      // the phase-status check, so the very next tick after a
      // dispatch runs at active cadence.
      const isActive =
        isActiveTick(tickRes.tickState) || tickRes.spawned > 0;
      const sleepMs = isActive ? activeMs : idleMs;
      // Codex round 16 P2: race the sleep against the abort signal
      // so SIGINT/SIGTERM mid-poll exits within ~50ms instead of
      // waiting up to idleMs (120s). When tests pass `_sleep` that
      // resolves immediately, this path is a no-op in practice.
      //
      // Todo 095: this used to register a fresh `addEventListener`
      // per tick, leaking ~720 listeners over 24h idle. The single
      // run-lifetime listener registered above (around the for-loop)
      // forwards aborts to whichever resolver is parked on the
      // shared `pendingSleepAbort` ref. We park it before sleep,
      // clear it after, so the ref points only to the current tick's
      // sleep — never accumulates.
      if (signal && typeof signal.addEventListener === 'function') {
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          pendingSleepAbort = resolve;
          // sleep() resolves on its own; either it wins or the
          // abort listener wins via pendingSleepAbort.
          sleep(sleepMs).then(() => {
            // Clear the parked ref only if this sleep resolved
            // first; if abort fired the listener already cleared it.
            if (pendingSleepAbort === resolve) pendingSleepAbort = null;
            resolve();
          });
        });
      } else {
        await sleep(sleepMs);
      }
    }
  } finally {
    // Todo 095: graceful shutdown removes the single run-lifetime
    // abort listener. {once:true} would auto-remove on actual abort,
    // but a clean exit (allTerminal, max_ticks_*, spawn_failure_path)
    // never fires the abort — without explicit removal the listener
    // would outlive the run on long-running test harnesses sharing
    // an AbortController across runs.
    if (signal && sleepAbortListener && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', sleepAbortListener); } catch (_) { /* ignore */ }
    }
    if (lockPath) {
      releaseLock(lockPath, opts);
    }
    if (workdirLockPath) {
      releaseLock(workdirLockPath, opts);
    }
  }

  return {
    ok: exitOk,
    summary:
      exitReason ||
      (exitOk ? 'completed' : 'completed_with_failures'),
    history: runState.history,
    lockPath,
  };
}

/**
 * Best-effort unlink. ENOENT (file doesn't exist) is the common-case
 * non-error — the prior dispatch may not have produced the artifact
 * we're trying to clean up. Other errors are silently swallowed; the
 * orchestrator survives a failed cleanup, and a stale signal will
 * surface as a noisy log next tick rather than crashing the loop.
 */
/**
 * Todo 110: shared rollback helper for the pre-spawnFn-launch failure
 * paths in `executeSpawn`. Reverts the `'spawning'` marker (written
 * before the spawn launches) back to `'pending'` + clears
 * `dispatched_at` so the next tick is eligible to re-dispatch the
 * phase fresh.
 *
 * **Scope discipline (codex round 1+10 corrections to PR #22 RA):**
 *
 *   - Call from `executeSpawn`'s spawnFn-throws catch — the spawn
 *     never produced a live tab, so rolling the marker back is safe.
 *   - Call from the EFLAGTIMEOUT branch ONLY when todo 099's
 *     out-of-band token binding is in place. Pre-099, an orphan tab
 *     from the timed-out spawn is still alive and would consume the
 *     next tick's fresh `.pending-<name>` flag, restoring the cross-
 *     tick wrong-prompt-to-wrong-agent bug. Post-099, the orphan's
 *     argv-token can't match the new flag's file-token, so the
 *     orphan's hook filters the fresh flag out.
 *   - DO NOT call from the post-spawn `runUpdate`-throw path
 *     (todo 096). When `spawnFn` already returned successfully,
 *     the wt tab is live; rolling back the marker would orphan the
 *     tab and trigger duplicate dispatch on the next tick (the
 *     opposite of the intended fix). The reconciliation pass at
 *     `decideTickActions` (orchestrate.js's spawning-marker loop)
 *     adopts the live session next tick, so leaving the marker
 *     intact is the correct behavior there.
 *
 * Failure to roll back is logged and swallowed — the resume
 * reconciliation path also handles `'spawning'` + no-live-PID, so
 * a missed rollback is recoverable, just one tick of churn.
 *
 * Returns `true` on success, `false` if the rollback runUpdate failed
 * (logged via the supplied logger).
 */
function rollbackSpawningMarker({
  manifestPath,
  phaseId,
  role,
  runUpdateFn,
  logger,
  reason,
  // Codex round 2 P1: callers passing a non-initial dispatch
  // (`recovery` or `review_retry`) MUST supply `priorStatus: 'running'`
  // so the rollback restores the pre-spawn `running` state instead
  // of corrupting it to `pending`. Pre-fix the helper unconditionally
  // wrote `pending`, which made the next tick treat a recovery /
  // review_retry phase as fresh pending work — losing review_stage /
  // review_iteration and bypassing retry accounting.
  //
  // Default 'pending' preserves the existing contract for the initial
  // dispatch path (which is the only call site that doesn't pass a
  // prior status).
  priorStatus = 'pending',
  // Pass `priorDispatchedAt: <iso>` to keep the original dispatch
  // breadcrumb when the marker is rolled back to a non-initial
  // state. Default empty string clears it (matches the initial-
  // dispatch contract).
  priorDispatchedAt = '',
}) {
  const updates = {
    status: priorStatus,
    dispatched_at: priorDispatchedAt,
  };
  const r = runUpdateFn(manifestPath, phaseId, updates);
  if (!r || !r.ok) {
    logger('warn', `pre-spawn marker rollback failed (${reason}): ${(r && r.error) || 'unknown error'}`, {
      phaseId,
      role,
    });
    return false;
  }
  return true;
}

function bestEffortUnlink(unlinkSync, p) {
  try {
    unlinkSync(p);
  } catch (_) {
    /* ENOENT is the common case; we don't differentiate */
  }
}

function isActiveTick(tickState) {
  if (!tickState || !Array.isArray(tickState.phases)) return false;
  for (const p of tickState.phases) {
    const e = getPhaseStatus(tickState.status, p.id);
    if (e.status === 'running') return true;
  }
  return false;
}

// -------------------- Logger + structured-block helpers --------------------

function makeDefaultLogger() {
  return (level, message, meta) => {
    const ts = new Date().toISOString();
    const tag = `[${ts}] [${(level || 'info').toUpperCase()}]`;
    const suffix =
      meta && (meta.phaseId || meta.role)
        ? ` (phase=${meta.phaseId || '-'} role=${meta.role || '-'})`
        : '';
    process.stderr.write(`${tag}${suffix} ${message}\n`);
  };
}

function renderProblemBlock({ problem, file, fix }) {
  return [
    '┌─ problem ─────────────────────────────',
    `│ ${problem}`,
    '├─ file ────────────────────────────────',
    `│ ${file}`,
    '├─ fix hint ────────────────────────────',
    `│ ${fix}`,
    '└───────────────────────────────────────',
  ].join('\n');
}

// -------------------- CLI --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  orchestrate.js <manifest.yaml>',
      '  orchestrate.js --resume <manifest.yaml>',
      '',
      'Options:',
      '  --resume                          read manifest-status, skip completed phases, respawn crashed',
      '  --once                            run a single tick then exit (testing aid).',
      '                                    Equivalent to `--max-ticks 1`. When both flags',
      '                                    are passed, the LATER flag on the command line',
      '                                    wins (parser is left-to-right; --once 0 is',
      '                                    not allowed because --once takes no value).',
      '  --max-ticks <n>                   exit after N ticks (default: unlimited)',
      '  --active-interval-ms <n>          poll cadence when at least one phase is running (default 30000)',
      '  --idle-interval-ms <n>            poll cadence when nothing is running (default 120000)',
      '  --max-recovery-retries <n>        per-phase crash-retry budget (default 3)',
      '  --converge-n <n>                  consecutive null pidAlive readings before recovery (default 3)',
      '  --startup-grace-ms <n>            forwarded to checkHealth (default 60000)',
      '  --review-loop-max-iterations <n>  per-phase review-loop iteration cap (default 3)',
      '  --plugin-dir <path>               source for templates copy (default: ../)',
      '  --project-name <s>                rendered into prompts (default: manifest.name)',
      '  --dry-run                         render prompts + log actions without spawning',
      '  --skip-scaffold                   skip scaffold-protocol pre-flight (advanced)',
      '  -h | --help                       this message',
      '',
      'Exit codes:',
      '  0 — every phase reached `completed`',
      '  1 — one or more phases failed, or fatal error',
      '  2 — refused to start (lockfile contention)',
    ].join('\n')
  );
}

/**
 * Pure CLI parser. Throws on bad input; the CLI main() catches the
 * throw and converts it to `process.stderr` + `process.exit(1)`. Tests
 * can therefore assert on the throw without crashing the test runner.
 *
 * The empty-string-as-explicit-override guard is intentional and
 * tested: `--active-interval-ms ""` is a USER mistake, not a request
 * to use the default (institutional memory: PR #6 codex round caught
 * the same bug class). Empty / whitespace-only / non-integer values
 * are rejected with the flag name in the error message.
 */
function parseCliArgs(argv) {
  const out = {
    manifestPath: null,
    resume: false,
    // Todo 108.e: removed `once: false` default — the field was set
    // by --once but never read; maxTicks is the canonical signal.
    maxTicks: null,
    activeIntervalMs: null,
    idleIntervalMs: null,
    maxRecoveryRetries: null,
    lookupFailedConvergeN: null,
    startupGraceMs: null,
    reviewLoopMaxIterations: null,
    pluginDir: null,
    projectName: null,
    dryRun: false,
    skipScaffold: false,
    showHelp: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v === '') {
        throw new CliError(`${a} requires a value`);
      }
      return v;
    };
    // Todo 106: stricter `next()` for path-typed flags that must NOT
    // greedily consume the next argv flag as their value.
    // `--plugin-dir --resume foo.yaml` used to silently parse as
    // `pluginDir = '--resume'` and drop the `--resume` flag — the
    // operator had no signal that anything went wrong. Reject any
    // value that starts with `-`; offer the `--flag=value` form as
    // an escape hatch for legitimate paths beginning with `-`.
    const nextNonFlag = () => {
      const v = argv[++i];
      if (v === undefined || v === '') {
        throw new CliError(`${a} requires a value`);
      }
      if (v.startsWith('-')) {
        throw new CliError(
          `${a} requires a path; got ${JSON.stringify(v)} (looks like another flag — use ${a}=<path> for paths starting with -)`
        );
      }
      return v;
    };
    // Todo 106 escape hatch: support `--plugin-dir=<value>` and
    // `--project-name=<value>` forms so operators with paths that
    // start with `-` can still pass them.
    if (a.startsWith('--plugin-dir=')) {
      const v = a.slice('--plugin-dir='.length);
      if (v === '') throw new CliError('--plugin-dir= requires a value');
      // Codex round 12 P3: parity with the bare `--plugin-dir <path>`
      // form — verify the path exists at the CLI boundary so a typo
      // surfaces with the offending flag named, not deep inside
      // scaffold-protocol.
      if (!fs.existsSync(v)) {
        throw new CliError(
          `--plugin-dir path does not exist: ${JSON.stringify(v)}`
        );
      }
      out.pluginDir = v;
      continue;
    }
    if (a.startsWith('--project-name=')) {
      const v = a.slice('--project-name='.length);
      if (v === '') throw new CliError('--project-name= requires a value');
      out.projectName = v;
      continue;
    }
    switch (a) {
      case '-h':
      case '--help':
        out.showHelp = true;
        break;
      case '--resume':
        out.resume = true;
        break;
      case '--once':
        // Todo 108.e: removed write-only `out.once = true`. The
        // documented contract is "--once sets maxTicks to 1"; the
        // separate `once` field was set but never consumed by
        // runOrchestrator. maxTicks is the canonical signal.
        // Todo 108.n: --help (above) now documents the maxTicks=1
        // equivalence so operators don't expect a separate
        // semantic.
        out.maxTicks = 1;
        break;
      case '--max-ticks':
        out.maxTicks = parseIntFlag(a, next());
        break;
      case '--active-interval-ms':
        out.activeIntervalMs = parseIntFlag(a, next(), { allowZero: false });
        break;
      case '--idle-interval-ms':
        out.idleIntervalMs = parseIntFlag(a, next(), { allowZero: false });
        break;
      case '--max-recovery-retries':
        out.maxRecoveryRetries = parseIntFlag(a, next(), { allowZero: true });
        break;
      case '--converge-n':
        out.lookupFailedConvergeN = parseIntFlag(a, next(), { allowZero: false });
        break;
      case '--startup-grace-ms':
        out.startupGraceMs = parseIntFlag(a, next(), { allowZero: true });
        break;
      case '--review-loop-max-iterations':
        out.reviewLoopMaxIterations = parseIntFlag(a, next(), { allowZero: false });
        break;
      case '--plugin-dir':
        out.pluginDir = nextNonFlag();
        // Todo 108.m: cheap existence check at the CLI boundary.
        // Pre-fix `--plugin-dir /nonexistent` only failed deep inside
        // scaffold-protocol's templates copy, with a stack-traceish
        // error that didn't name the offending flag. fs.existsSync
        // is a fast read; failure surfaces as a clean parser error
        // pointing at --plugin-dir. We DON'T check the directory's
        // shape (templates/ subdir, etc.) — that's scaffold's job;
        // we just confirm the path is reachable.
        if (out.pluginDir && !fs.existsSync(out.pluginDir)) {
          throw new CliError(
            `--plugin-dir path does not exist: ${JSON.stringify(out.pluginDir)}`
          );
        }
        break;
      case '--project-name':
        out.projectName = nextNonFlag();
        break;
      case '--dry-run':
        out.dryRun = true;
        // Codex round 17 P2: dry-run never persists, so phase
        // status can never advance. Without a tick cap, the CLI
        // would loop forever re-rendering the same pending actions.
        // Default to a single tick unless the operator explicitly
        // overrode with --max-ticks.
        if (out.maxTicks === null) out.maxTicks = 1;
        break;
      case '--skip-scaffold':
        out.skipScaffold = true;
        break;
      default:
        if (!a.startsWith('-') && out.manifestPath === null) {
          out.manifestPath = a;
        } else {
          throw new CliError(`unknown argument: ${a}`);
        }
    }
  }
  if (out.showHelp) return out;
  if (!out.manifestPath || out.manifestPath.trim() === '') {
    throw new CliError('manifest path is required (see --help)');
  }
  return out;
}

class CliError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'CliError';
  }
}

function parseIntFlag(flag, raw, { allowZero = false } = {}) {
  if (raw === undefined || raw === '') {
    throw new CliError(`${flag} requires an integer (got ${JSON.stringify(raw)})`);
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw new CliError(`${flag} requires an integer (got ${JSON.stringify(raw)})`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CliError(`${flag} requires an integer (got ${JSON.stringify(raw)})`);
  }
  if (!allowZero && n <= 0) {
    throw new CliError(`${flag} requires a positive integer (got ${JSON.stringify(raw)})`);
  }
  if (allowZero && n < 0) {
    throw new CliError(`${flag} requires a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function failExit(msg, code = 1) {
  process.stderr.write(`orchestrate: ${msg}\n`);
  process.exit(code);
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv);
  } catch (e) {
    if (e instanceof CliError) failExit(e.message);
    throw e;
  }
  if (args.showHelp) {
    printHelp();
    process.exit(0);
  }
  // Surface manifest path defense: the `parseCliArgs` empty-string
  // guard already caught `--manifest ""`-style invocations above. The
  // manifestPath also resolves to absolute via path.resolve so a
  // relative path is safe.
  const opts = {
    manifestPath: path.resolve(args.manifestPath),
    resume: args.resume,
    maxTicks: args.maxTicks,
    activeIntervalMs: args.activeIntervalMs,
    idleIntervalMs: args.idleIntervalMs,
    maxRecoveryRetries: args.maxRecoveryRetries,
    lookupFailedConvergeN: args.lookupFailedConvergeN,
    startupGraceMs: args.startupGraceMs,
    reviewLoopMaxIterations: args.reviewLoopMaxIterations,
    pluginDir: args.pluginDir,
    projectName: args.projectName,
    dryRun: args.dryRun,
    skipScaffold: args.skipScaffold,
  };
  // Graceful shutdown: SIGINT / SIGTERM aborts the loop cleanly.
  const ac = new AbortController();
  opts.signal = ac.signal;
  const onSignal = () => {
    process.stderr.write('\norchestrate: shutdown signal received; exiting after current tick\n');
    ac.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let result;
  try {
    result = await runOrchestrator(opts);
  } catch (e) {
    // Todo 108.q: remove SIGINT / SIGTERM listeners on the error
    // path too. Cosmetic in practice (process.exit(1) below tears
    // the process down regardless), but removing them satisfies
    // the symmetry-with-the-success-path expectation a future
    // refactor that promotes the catch into a non-fatal handler
    // would otherwise miss.
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.stderr.write(`orchestrate: fatal — ${e.message}\n`);
    process.exit(1);
  }
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  if (result.code === 2) process.exit(2);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  // Constants
  DEFAULT_ACTIVE_INTERVAL_MS,
  DEFAULT_IDLE_INTERVAL_MS,
  DEFAULT_MAX_RECOVERY_RETRIES,
  DEFAULT_REVIEW_LOOP_MAX_ITERATIONS,
  DEFAULT_LOOKUP_FAILED_CONVERGE_N,
  DEFAULT_STARTUP_GRACE_MS,
  SCHEMA_VERSION_EXPECTED,
  MAX_FLAG_BYTES,
  LOCKFILE_NAME,
  // Public functions
  runOrchestrator,
  runOneTick,
  pollAllPhases,
  decideTickActions,
  executeActions,
  acquireLock,
  releaseLock,
  probeProcessStartTime,
  buildPidSnapshot,
  parseQaVerdict,
  parseCompletionSignal,
  safeReadAgentFile,
  MAX_COMPLETION_SIGNAL_BYTES,
  MAX_QA_VERDICT_BYTES,
  // Path helpers
  defaultSessionName,
  flagFilePath,
  phaseDirFor,
  orchDirFor,
  templatesDirFor,
  completionSignalFor,
  resolveCompletionSignal,
  qaVerdictFor,
  // CLI helpers (exported for tests)
  parseCliArgs,
  parseIntFlag,
  renderProblemBlock,
  isActiveTick,
  isTerminalStatus,
  depsMet,
  depsBlocked,
  getPhaseStatus,
  validateRetryCountShape,
};
