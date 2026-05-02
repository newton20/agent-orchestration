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
  const renameSync = opts._renameSync || fs.renameSync;
  const mkdirSync = opts._mkdirSync || fs.mkdirSync;
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
    // Stale lock — fall through and overwrite.
  }

  const content = JSON.stringify(
    { pid: ourPid, startedAt: now, hostname },
    null,
    2
  );
  if (Buffer.byteLength(content, 'utf8') === 0) {
    throw new Error('lockfile content is empty — internal error'); // unreachable
  }
  // Atomic write: tmp + rename within same filesystem.
  const tmp = path.join(orchDir, `${LOCKFILE_NAME}.tmp-${ourPid}-${Date.now()}`);
  writeFileSync(tmp, content, { encoding: 'utf8' });
  renameSync(tmp, lockPath);
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
  const sessionNames = [];
  for (const phase of phases) {
    for (const agent of phase.agents) {
      sessionNames.push(defaultSessionName(phase.id, agent.role));
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
  // Fall back to qa-complete.md frontmatter (V1 default — the template
  // does not yet produce qa-verdict.json).
  const signalPath = completionSignalFor(phaseDir, role);
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
    // Per-phase iteration cap takes precedence over the orchestrator-
    // wide CLI default (codex round 1 P2). normalizePhases guarantees
    // `phase.review_loop` exists with `max_iterations` set; we still
    // guard for safety in case a future schema bump leaves it null.
    const reviewMaxIter =
      (phase.review_loop && Number.isInteger(phase.review_loop.max_iterations)
        ? phase.review_loop.max_iterations
        : null) ??
      (opts.reviewLoopMaxIterations != null
        ? opts.reviewLoopMaxIterations
        : DEFAULT_REVIEW_LOOP_MAX_ITERATIONS);

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
      const signalPath = completionSignalFor(phaseDir, role);
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
          continue;
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
          const verdict = parseQaVerdict(phaseDir, 'qa', opts);
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
        // Aggregate across all declared roles: the phase is complete
        // only when every declared role has a completion signal.
        const allRoleSignalsPresent = phase.agents.every((a) =>
          (opts._existsSync || fs.existsSync)(completionSignalFor(phaseDir, a.role))
        );
        if (allRoleSignalsPresent) {
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

  return actions;
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
        } catch (e) {
          out.warnings.push(
            `spawn failed for phase=${action.phaseId} role=${action.role}: ${e.message}`
          );
          logger('error', `spawn failed: ${e.message}`, {
            phaseId: action.phaseId,
            role: action.role,
          });
          // Codex round 2 P2: track which phases had a spawn failure
          // this tick so subsequent `persist` actions targeting the
          // same phase (which would otherwise mark it `running`) can
          // skip — leaving the phase `pending` so the next tick
          // re-attempts the dispatch instead of polling/recovering a
          // session that never started.
          if (!runState.spawnFailedThisTick) {
            runState.spawnFailedThisTick = new Set();
          }
          runState.spawnFailedThisTick.add(action.phaseId);
        }
        break;
      }
      case 'persist': {
        if (dryRun) break;
        // Codex round 2 P2: skip the post-spawn persist when its
        // sibling spawn for this phase failed. The persist would have
        // transitioned the phase to `running`; without a real session,
        // that lies to checkHealth and the recovery path. Other
        // persist updates (review_stage, retry_count) ride on the
        // same action and are intentionally also skipped — the phase
        // stays in its prior state and the next tick re-decides
        // cleanly.
        if (
          runState.spawnFailedThisTick &&
          runState.spawnFailedThisTick.has(action.phaseId)
        ) {
          out.warnings.push(
            `persist skipped for phase=${action.phaseId}: spawn failed this tick`
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
  mkdir(phaseDir, { recursive: true });

  const role = action.role;
  const sessionName = defaultSessionName(phase.id, role);
  const isRecovery = action.mode === 'recovery';
  const isReviewRetry = action.mode === 'review_retry';
  const isInitialQa = action.mode === 'initial' && role === 'qa';

  // Stale-signal cleanup. Three respawn cases that need cleanup:
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
  // dryRun skips all disk writes including the cleanup.
  if (!dryRun) {
    if (isRecovery) {
      bestEffortUnlink(unlinkSync, completionSignalFor(phaseDir, role));
      if (role === 'qa') {
        bestEffortUnlink(unlinkSync, qaVerdictFor(phaseDir));
      }
    }
    if (isReviewRetry) {
      // role here is 'impl' — but we need to clear the previous
      // iteration's BOTH signals so the next impl-complete (and the
      // subsequent qa-complete) are clean.
      bestEffortUnlink(unlinkSync, completionSignalFor(phaseDir, 'impl'));
      bestEffortUnlink(unlinkSync, completionSignalFor(phaseDir, 'qa'));
      bestEffortUnlink(unlinkSync, qaVerdictFor(phaseDir));
    }
    if (isInitialQa) {
      bestEffortUnlink(unlinkSync, completionSignalFor(phaseDir, 'qa'));
      bestEffortUnlink(unlinkSync, qaVerdictFor(phaseDir));
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
  const priorPhaseSignals = [];
  for (const dep of phase.depends_on || []) {
    const depPhase = phases.find((p) => p.id === dep);
    if (!depPhase) continue;
    for (const a of depPhase.agents) {
      const sigPath = completionSignalFor(
        phaseDirFor(manifestDir, dep),
        a.role
      );
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

  const genOpts = {
    role: isRecovery ? 'recovery' : role,
    recoveryRole: isRecovery ? role : undefined,
    phaseId: phase.id,
    templatesDir,
    projectName,
    workdir: resolvedWorkdir,
    phaseDir,
    priorPhaseSignals,
  };
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
    genOpts.prOrBranchUnderTest =
      (phase.review_loop && phase.review_loop.pr_or_branch) ||
      `HEAD of ${resolvedWorkdir}`;
    genOpts.qaScopeRows =
      (phase.review_loop && phase.review_loop.qa_scope_rows) ||
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
    mkdir(orchDir, { recursive: true });
    const flagPath = flagFilePath(orchDir, sessionName);
    // Atomic write per todo 029: tmp + rename (same filesystem).
    const tmpPath = path.join(
      orchDir,
      `.pending-${sessionName}.tmp-${process.pid}-${Date.now()}`
    );
    writeFile(tmpPath, promptText, { encoding: 'utf8' });
    renameFile(tmpPath, flagPath);
  }

  // Spawn (or fake spawn on dry-run).
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
    const effectivePluginDir =
      (agent && agent.plugin_dir) || opts.pluginDir || null;
    spawnResult = spawnFn({
      name: sessionName,
      workdir: resolvedWorkdir,
      model: agent.model || null,
      title: `${sessionName} — ${phase.title || phase.id}`,
      pluginDir: effectivePluginDir,
      launcher: manifest.launcher || null,
    });
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
  // Reset per-tick state. spawnFailedThisTick is the cross-action
  // signal letting subsequent `persist` actions know the matching
  // spawn failed — see executeActions's persist handler.
  runState.spawnFailedThisTick = new Set();
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
  try {
    for (;;) {
      if (signal && signal.aborted) {
        logger('info', 'aborted via signal');
        break;
      }
      if (maxTicks !== null && runState.tickIndex >= maxTicks) {
        logger('info', `max ticks reached (${maxTicks}); exiting`);
        if (sawFailureOrBlocked) exitOk = false;
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
      const allTerminal = (() => {
        if (!tickRes.tickState || !tickRes.tickState.phases) return false;
        for (const p of tickRes.tickState.phases) {
          const e = getPhaseStatus(tickRes.tickState.status, p.id);
          if (!isTerminalStatus(e.status)) return false;
        }
        return true;
      })();
      if (allTerminal) {
        const anyFailed = tickRes.tickState.phases.some((p) => {
          const e = getPhaseStatus(tickRes.tickState.status, p.id);
          return e.status === 'failed';
        });
        const anyBlocked = tickRes.tickState.phases.some((p) => {
          const e = getPhaseStatus(tickRes.tickState.status, p.id);
          return e.status === 'blocked';
        });
        if (anyFailed || anyBlocked) {
          exitOk = false;
        }
        logger(
          'info',
          `all phases terminal — completed=${tickRes.tickState.phases.length - tickRes.failed.length - tickRes.blocked.length} failed=${anyFailed} blocked=${anyBlocked}`
        );
        break;
      }

      // Pick cadence. Active = at least one phase running this tick.
      const isActive = isActiveTick(tickRes.tickState);
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
    summary: exitOk ? 'completed' : 'completed_with_failures',
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
