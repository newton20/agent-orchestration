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
  const phaseEntry =
    Array.isArray(manifest.phases)
      ? manifest.phases.find((p) => p && p.id === phaseId)
      : null;
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

  const content = JSON.stringify(
    { pid: ourPid, startedAt: now, hostname },
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
  const map = new Map();
  for (const name of sessionNames) {
    const pid = parsePidLookupOutput(stdout, name, { excludeWrappers: true });
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

  return {
    ok: true,
    manifest: loaded.manifest,
    phases,
    status,
    pidSnapshot,
  };
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
function parseCompletionSignal(signalPath, opts = {}) {
  const readFileSync = opts._readFileSync || fs.readFileSync;
  const existsSync = opts._existsSync || fs.existsSync;
  if (!existsSync(signalPath)) return null;
  let raw;
  try {
    raw = readFileSync(signalPath, 'utf8');
  } catch (_) {
    return null;
  }
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
  const readFileSync = opts._readFileSync || fs.readFileSync;
  const existsSync = opts._existsSync || fs.existsSync;
  // Prefer structured qa-verdict.json (future-shape from the dispatch
  // contract: `{ pass, failures: [...] }`).
  const verdictPath = qaVerdictFor(phaseDir);
  if (existsSync(verdictPath)) {
    let raw;
    try {
      raw = readFileSync(verdictPath, 'utf8');
    } catch (_) {
      // Fall through to frontmatter parse on read failure.
    }
    if (raw !== undefined) {
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
 *   { type: 'spawn', phaseId, role, mode: 'initial' | 'recovery', context }
 *   { type: 'persist', phaseId, role?, updates }
 *   { type: 'mark_phase_running', phaseId }
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

  // -- First pass: monitor each running phase × role.
  for (const phase of phases) {
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
    const rawPhaseForCap =
      (Array.isArray(manifest.phases)
        ? manifest.phases.find((p) => p && p.id === phase.id)
        : null) || {};
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

    let phaseAdvanced = false;
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
          actions.push({
            type: 'log',
            level: 'warn',
            message:
              `phase ${phase.id} role ${role} signal has unrecognized status=${JSON.stringify(sigParsed.status)}; ` +
              `treating as not-yet-complete and re-polling`,
            phaseId: phase.id,
            role,
          });
          continue;
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
          phaseAdvanced = true;
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
            phaseAdvanced = true;
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
            phaseAdvanced = true;
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
          phaseAdvanced = true;
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
          phaseAdvanced = true;
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

      // schema_version guard (design decision #4).
      if (health.schema_version !== SCHEMA_VERSION_EXPECTED) {
        actions.push({
          type: 'fatal',
          message:
            `checkHealth returned schema_version ${health.schema_version}; ` +
            `orchestrator expected ${SCHEMA_VERSION_EXPECTED}. ` +
            `A check-health upgrade is needed before this orchestrator can advance.`,
        });
        continue;
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
          phaseAdvanced = true;
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
          });
          phaseAdvanced = true;
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
        });
        phaseAdvanced = true;
        continue;
      }

      // pidAlive === null. Check the reason.
      const reason = health.pidAliveReason;
      if (reason === 'startup_grace') {
        // Do NOT count toward the heuristic. The agent is still
        // spawning; resolve deterministically next tick.
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
      });
      phaseAdvanced = true;
    }
    // (silence "unused" warning — phaseAdvanced is informational only)
    void phaseAdvanced;
  }

  // -- Second pass: advance pending phases.
  for (const phase of phases) {
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
  const { phase, role, phaseDir, reason, maxRetries, phaseEntry } = ctx;
  const cur = Number.isInteger(phaseEntry.retry_count)
    ? phaseEntry.retry_count
    : 0;
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
  actions.push({
    type: 'spawn',
    phaseId: phase.id,
    role,
    mode: 'recovery',
    iteration: cur + 1,
    crashReason: reason,
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
  const runUpdateFn = opts._runUpdate || runUpdate;
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
  const templatesDir = opts.templatesDir || templatesDirFor(manifestDir);

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
      case 'mark_phase_running': {
        if (!dryRun) {
          runUpdateFn(manifestPath, action.phaseId, { status: 'running' });
        }
        break;
      }
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
  const rawPhase =
    (Array.isArray(manifest.phases)
      ? manifest.phases.find((p) => p && p.id === phase.id)
      : null) || {};
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
    if (isRecovery) {
      staleUnlinks.push(sigFor(role));
      staleUnlinks.push(completionSignalFor(phaseDir, role));
      if (role === 'qa') {
        staleUnlinks.push(qaVerdictFor(phaseDir));
      }
    }
    if (isReviewRetry) {
      staleUnlinks.push(sigFor('impl'));
      staleUnlinks.push(sigFor('qa'));
      staleUnlinks.push(completionSignalFor(phaseDir, 'impl'));
      staleUnlinks.push(completionSignalFor(phaseDir, 'qa'));
      staleUnlinks.push(qaVerdictFor(phaseDir));
    }
    if (isInitial) {
      staleUnlinks.push(sigFor(role));
      staleUnlinks.push(completionSignalFor(phaseDir, role));
      if (role === 'qa') {
        staleUnlinks.push(qaVerdictFor(phaseDir));
      }
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
  const effectiveRoleForSignal = isRecovery ? role : role;
  const dispatchCompletionSignal = resolveCompletionSignal(
    manifest,
    manifestDir,
    phase.id,
    effectiveRoleForSignal
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
    if (Buffer.byteLength(promptText, 'utf8') > MAX_FLAG_BYTES) {
      throw new Error(
        `prompt for ${sessionName} is ${Buffer.byteLength(promptText, 'utf8')} bytes — ` +
          `exceeds MAX_FLAG_BYTES=${MAX_FLAG_BYTES} (the SessionStart hook would refuse it). ` +
          `Trim the prompt or split the phase.`
      );
    }
    mkdir(hookOrchDir, { recursive: true });
    flagPath = flagFilePath(hookOrchDir, sessionName);
    // Atomic write per todo 029: tmp + rename (same filesystem).
    const tmpPath = path.join(
      hookOrchDir,
      `.pending-${sessionName}.tmp-${process.pid}-${Date.now()}`
    );
    writeFile(tmpPath, promptText, { encoding: 'utf8' });
    renameFile(tmpPath, flagPath);
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
    // Per-agent plugin_dir overrides the orchestrator-wide --plugin-dir
    // (codex round 2 P2). The manifest's `agents[].plugin_dir` is
    // documented in docs/manifest-reference.md as "extra plugin
    // directory for this agent"; it must reach spawnSession's
    // pluginDir field for the per-agent plugin to load.
    //
    // Codex round 8 P2: resolve relative paths against manifestDir.
    // Without this, a manifest-relative path like `./my-plugin`
    // would be passed verbatim to wt's child shell which interprets
    // it relative to the spawned tab's cwd (workdir, possibly
    // different from manifestDir).
    let effectivePluginDir = null;
    if (agent && typeof agent.plugin_dir === 'string' && agent.plugin_dir !== '') {
      effectivePluginDir = path.isAbsolute(agent.plugin_dir)
        ? agent.plugin_dir
        : path.resolve(manifestDir, agent.plugin_dir);
    } else if (typeof opts.pluginDir === 'string' && opts.pluginDir !== '') {
      effectivePluginDir = path.isAbsolute(opts.pluginDir)
        ? opts.pluginDir
        : path.resolve(opts.pluginDir);
    } else {
      // Codex round 9 P2: default to THIS plugin's root so the
      // spawned tabs load the SessionStart hook + skills that ship
      // with agent-orchestrator. Without this, a `/orchestrate`
      // invocation that doesn't pass `--plugin-dir` (the documented
      // default) spawns Claude tabs without the hook, the
      // `.pending-*` flags are never read, and phases hang until
      // timeout. `__dirname` is `agent-orchestrator/scripts/`;
      // `path.resolve(__dirname, '..')` is the plugin root.
      effectivePluginDir = path.resolve(__dirname, '..');
    }
    try {
      spawnResult = spawnFn({
        name: sessionName,
        workdir: resolvedWorkdir,
        model: agent.model || null,
        title: `${sessionName} — ${phase.title || phase.id}`,
        pluginDir: effectivePluginDir,
        launcher: manifest.launcher || null,
      });
    } catch (e) {
      // Spawn failed AFTER the flag was written. Clean up the flag
      // so the next spawn this tick (or any spawn before the hook's
      // soft-TTL elapses) doesn't pick up this dead session's prompt
      // (codex round 7 P1).
      if (flagPath) bestEffortUnlink(unlinkSync, flagPath);
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
      pid: Number.isInteger(spawnResult.pid) ? spawnResult.pid : -1,
      started_at: spawnResult.spawnedAt, // <-- THE TRANSLATION (todo 087)
    };
    if (action.mode === 'initial' || action.mode === 'review_retry') {
      // Reset retry_count on a fresh dispatch (initial OR review_retry
      // — both are non-recovery starts of the role's session).
      updates.retry_count = 0;
    }
    const r = runUpdateFn(manifestPath, phase.id, updates);
    if (!r.ok) {
      // Don't throw — the spawn already happened. Surface for triage.
      logger('error', `runUpdate post-spawn failed: ${r.error}`, {
        phaseId: phase.id,
        role,
      });
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
  // policy (codex round 6 P2).
  runState.spawnFailedThisTick = new Set();
  runState.spawnSucceededThisTick = new Set();
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
  }

  // Lockfile. Acquired per orchestrator instance; released on exit.
  let lockPath = null;
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
      const tickRes = runOneTick(runState, opts);
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
      await sleep(sleepMs);
    }
  } finally {
    if (lockPath) {
      releaseLock(lockPath, opts);
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
      '  --once                            run a single tick then exit (testing aid)',
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
    once: false,
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
    switch (a) {
      case '-h':
      case '--help':
        out.showHelp = true;
        break;
      case '--resume':
        out.resume = true;
        break;
      case '--once':
        out.once = true;
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
        out.pluginDir = next();
        break;
      case '--project-name':
        out.projectName = next();
        break;
      case '--dry-run':
        out.dryRun = true;
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
  buildPidSnapshot,
  parseQaVerdict,
  parseCompletionSignal,
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
};
