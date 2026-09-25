'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const yaml = require('js-yaml');
const W = require('./workspace-owner');
const {
  canonicalJson, fingerprint, EXECUTION_BINDING_VERSION, executionRequest, executionEvidence,
  sealExecutionBinding, validateExecutionBinding, exactKeys, CAPABILITY_FIELDS,
} = require('./state-store');
const { V2_ENGINES } = require('./parse-manifest');
const { INVENTORY_FILENAME } = require('./package-plugin');
const { observeProcessIdentity, sameHostname, creationTimeKey } = require('./check-health');
const { observeProcessTable } = require('./spawn-session');
const { generatePrompt, atomicWrite } = require('./generate-prompt');
const { assertArtifactPath } = require('./artifact-path');
const { MAX_OUTBOX_EVENTS, MAX_OUTBOX_BYTES } = require('./event-log');

const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ATTEMPTS_PER_ROLE = 64;
const MAX_OBSERVATIONS = 64;
// Intent, reservation, launch, every allowed observation, the outcome, and binding/blocker bookkeeping.
const DISPATCH_EVENT_RESERVE = MAX_OBSERVATIONS + 6;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_ENTRIES = 2 * MAX_PACKAGE_FILES;
const MAX_PACKAGE_DEPTH = 32;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 60 * 1000;
const EXECUTION_RECHECK_MS = 5 * 60 * 1000;
const EXECUTION_REASONS = Object.freeze({
  adapter_unavailable: 'no trusted engine adapter is configured for the accepted engine',
  preflight_failed: 'engine preflight could not establish an execution binding; dispatch is blocked',
  binding_drift: 'the pinned execution binding no longer matches; restore the pinned identity or start an explicit new run',
  binding_unverified: 'the pinned execution binding could not be re-verified; dispatch is blocked until preflight succeeds',
});
const RETRY_LIMITS = Object.freeze({ launch: 2, execution: 2 });
const QA_VERIFICATION = Object.freeze(['scope', 'P1', 'P2', 'P3', 'P4', 'P6']);
const ID_FIELDS = ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'];
const ARTIFACT_KINDS = ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release'];
const safeId = (id) => typeof id === 'string' && /^(?!\.+$)[A-Za-z0-9._-]+$/.test(id) &&
  !['__proto__', 'constructor', 'prototype'].includes(id);
const copy = (value) => JSON.parse(canonicalJson(value));
const identityOf = (attempt) => Object.fromEntries(ID_FIELDS.map((key) => [key, attempt[key]]));
const sameIdentity = (a, b) => ID_FIELDS.every((key) => a[key] === b[key]);
const currentAttempt = (role) => role.attempts.find((a) => a.attempt_id === role.current_attempt_id);
const allAttempts = (state) => Object.values(state.phases).flatMap((p) => Object.values(p.roles).flatMap((r) => r.attempts));
const unreleased = (a) => a.access === 'mutating' && a.reservation.state !== 'released';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isProgress = (kind) => ['heartbeat', 'checkpoint'].includes(kind);
const sameProcess = (a, b) => a.pid === b.pid && creationTimeKey(a.creation_time) === creationTimeKey(b.creation_time) &&
  a.host_boot_id === b.host_boot_id && sameHostname(a.hostname, b.hostname);

function hasDispatchCapacity(state) {
  return state.outbox.length <= MAX_OUTBOX_EVENTS - DISPATCH_EVENT_RESERVE &&
    Buffer.byteLength(canonicalJson(state.outbox)) <= MAX_OUTBOX_BYTES - DISPATCH_EVENT_RESERVE * 1024;
}

// Only controller-authored check messages may reach canonical state; adapter error text is never persisted.
class ExecutionCheckError extends Error {}
const check = (message) => new ExecutionCheckError(message);

function validateEngineAdapters(adapters) {
  const registry = new Map();
  if (adapters === undefined) return registry;
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error('trusted engine adapters must be a nonempty array; production V2 dispatch is disabled');
  }
  for (const adapter of adapters) {
    const capabilities = adapter?.capabilities;
    const engine = Array.isArray(capabilities?.engines) && capabilities.engines.length === 1 ? capabilities.engines[0] : null;
    if (!adapter || adapter.kind !== 'engine' || !V2_ENGINES.includes(engine) ||
        typeof adapter.preflight !== 'function' || typeof adapter.launch !== 'function' ||
        (adapter.reconcile !== undefined && typeof adapter.reconcile !== 'function') ||
        typeof capabilities.read_only_enforced !== 'boolean' || typeof capabilities.tracks_descendants !== 'boolean' ||
        capabilities.live_verified !== false) {
      throw new Error('each trusted engine adapter needs kind engine, exactly one supported engine, strict capabilities, ' +
        'preflight and launch; an adapter cannot claim live verification');
    }
    if (registry.has(engine)) throw new Error(`duplicate trusted engine adapter for ${engine}`);
    registry.set(engine, adapter);
  }
  return registry;
}

// Allowlisted evidence only: invocations, environments and credentials never reach canonical state.
function normalizePreflight(raw, adapter) {
  if (!exactKeys(raw, ['executable', 'package', 'capabilities']) || !exactKeys(raw.executable, ['path', 'sha256']) ||
      !exactKeys(raw.package, ['root', 'inventory_sha256']) ||
      !exactKeys(raw.capabilities, [...CAPABILITY_FIELDS, 'live_verified'])) {
    throw check('engine preflight evidence must contain only executable, package and capability facts');
  }
  const { live_verified: live, ...capabilities } = raw.capabilities;
  if (live !== false) throw check('engine preflight cannot claim live verification');
  if (capabilities.read_only_enforced !== adapter.capabilities.read_only_enforced ||
      capabilities.tracks_descendants !== adapter.capabilities.tracks_descendants) {
    throw check('engine preflight capabilities disagree with the adapter declaration');
  }
  return copy({ executable: raw.executable, package: raw.package, capabilities });
}

// Preflight must be effect-free, so abandoning it at the deadline cannot strand an external launch.
async function runPreflight(adapter, request, timeoutMs) {
  const abort = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(check(`engine adapter preflight exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => adapter.preflight(request, { signal: abort.signal })), deadline]);
    return normalizePreflight(raw, adapter);
  } catch (error) {
    if (error instanceof ExecutionCheckError) throw error;
    throw check('engine adapter preflight failed');
  } finally { clearTimeout(timer); }
}

function evidenceDrift(binding, evidence) {
  const sections = { executable: ['path', 'sha256'], package: ['root', 'inventory_sha256'], capabilities: CAPABILITY_FIELDS };
  return Object.entries(sections).flatMap(([section, fields]) => fields
    .filter((field) => canonicalJson(binding[section][field] ?? null) !== canonicalJson(evidence[section][field] ?? null))
    .map((field) => `${section}.${field}`));
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The controller re-hashes pinned files itself so adapter-reported evidence cannot vouch for a changed file.
function verifyPinnedFiles({ executable, package: pkg }) {
  if (fs.realpathSync.native(executable.path) !== executable.path || !fs.lstatSync(executable.path).isFile() ||
      !/\.exe$/i.test(executable.path)) throw check('executable is no longer the pinned native file');
  if (sha256File(executable.path) !== executable.sha256) throw check('executable sha256 changed');
  if (fs.realpathSync.native(pkg.root) !== pkg.root || !fs.lstatSync(pkg.root).isDirectory()) {
    throw check('package root is no longer the pinned directory');
  }
  const inventoryPath = path.join(pkg.root, INVENTORY_FILENAME);
  const stat = fs.lstatSync(inventoryPath);
  if (!stat.isFile() || stat.size > MAX_INVENTORY_BYTES) throw check('package inventory is not a bounded regular file');
  const bytes = fs.readFileSync(inventoryPath);
  if (createHash('sha256').update(bytes).digest('hex') !== pkg.inventory_sha256) throw check('package inventory sha256 changed');
  let inventory;
  try { inventory = JSON.parse(bytes.toString('utf8')); } catch { throw check('package inventory is not valid JSON'); }
  if (!isObject(inventory) || inventory.version !== 1 || inventory.algorithm !== 'sha256' ||
      !Array.isArray(inventory.files) || inventory.files.length > MAX_PACKAGE_FILES) {
    throw check('package inventory format is unsupported');
  }
  const listed = new Map();
  for (const entry of inventory.files) {
    if (!isObject(entry) || typeof entry.path !== 'string' || entry.path === INVENTORY_FILENAME || listed.has(entry.path) ||
        entry.path.split('/').some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw check('package inventory entry is invalid');
    }
    listed.set(entry.path, entry);
  }
  const found = new Set();
  let entries = 0;
  (function visit(directory, prefix, depth) {
    if (depth > MAX_PACKAGE_DEPTH) throw check('package directory tree exceeds the supported depth');
    const handle = fs.opendirSync(directory);
    try {
      for (let dirent = handle.readSync(); dirent; dirent = handle.readSync()) {
        if (++entries > MAX_PACKAGE_ENTRIES) throw check('package contains too many entries');
        const file = path.join(directory, dirent.name);
        const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        const entry = fs.lstatSync(file);
        if (entry.isSymbolicLink()) throw check('package contains a redirected entry');
        if (entry.isDirectory()) visit(file, relative, depth + 1);
        else if (!entry.isFile()) throw check('package contains an unsupported entry');
        else if (relative !== INVENTORY_FILENAME) found.add(relative);
      }
    } finally { handle.closeSync(); }
  })(pkg.root, '', 0);
  // Package-relative names are filesystem data, so they stay out of persisted diagnostics.
  for (const relative of found) if (!listed.has(relative)) throw check('package contains an unlisted file');
  for (const [relative, entry] of listed) {
    const file = path.join(pkg.root, ...relative.split('/'));
    if (!found.has(relative) || fs.statSync(file).size !== entry.size || sha256File(file) !== entry.sha256) {
      throw check('package file changed');
    }
  }
}

function executionDetail(error) {
  if (error instanceof ExecutionCheckError) return error.message;
  if (typeof error?.message === 'string' && error.message.startsWith('invalid state: ')) return error.message;
  if (typeof error?.code === 'string' && /^E[A-Z0-9]{1,31}$/.test(error.code)) {
    return `${error.code} during ${/^[a-z]{1,32}$/.test(error.syscall || '') ? error.syscall : 'file verification'}`;
  }
  return 'unexpected execution verification error';
}

function executionFailure(code, detail) {
  const text = typeof detail === 'string' ? detail : executionDetail(detail);
  return { code, reason: EXECUTION_REASONS[code], detail: text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 256) };
}
function newerSample(sample, watermark) {
  return !watermark || (sample.sample_id !== watermark.sample_id &&
    Date.parse(sample.observed_at) > Date.parse(watermark.observed_at));
}

function afterProcessWatermark(attempt, sample) {
  return newerSample(sample, attempt.process_sample_watermark ||
    (attempt.started_at ? { observed_at: attempt.started_at } : null));
}

function advanceProcessWatermark(attempt, sample) {
  for (const candidate of [attempt.health, sample]) {
    if (candidate.sample_id && newerSample(candidate, attempt.process_sample_watermark)) {
      attempt.process_sample_watermark = { sample_id: candidate.sample_id, observed_at: candidate.observed_at };
    }
  }
}

function domainState(state) {
  const phases = copy(state.phases);
  for (const a of allAttempts({ phases })) {
    delete a.health;
    delete a.evidence.heartbeat;
    delete a.evidence.checkpoint;
  }
  return canonicalJson({ phases, runtime_status: state.runtime_status,
    process_error: state.process_diagnostic?.error || null });
}

function artifactPaths(workspace, identity) {
  W.validateWorkspace(workspace);
  if (!ID_FIELDS.filter((key) => key !== 'review_iteration').every((key) => safeId(identity[key])) ||
      !Number.isSafeInteger(identity.review_iteration) || identity.review_iteration < 0) throw new Error('invalid artifact attempt identity');
  const directory = path.join(workspace.root, 'docs', 'orchestration', 'runs', identity.run_id,
    'phases', identity.phase_id, identity.role, String(identity.review_iteration), identity.attempt_id);
  return {
    directory, prompt: path.join(directory, `${identity.role}-prompt.md`),
    ...Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, path.join(directory, `${kind}.json`)])),
  };
}

function readAttemptArtifact(state, attempt, kind) {
  if (!ARTIFACT_KINDS.includes(kind)) throw new Error('unknown attempt artifact kind');
  const expected = artifactPaths(state.workspace, attempt)[kind];
  if (expected !== attempt.artifacts[kind]) throw new Error('persisted artifact path disagrees with attempt identity');
  assertArtifactPath(state.workspace.root, expected);
  let fd;
  try { fd = fs.openSync(expected, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read ${kind} artifact: ${error.message}`);
  }
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return { rejected: 'artifact exceeds bounded regular-file contract' };
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_ARTIFACT_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) return { rejected: 'artifact changed size during bounded read' };
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  const text = bytes.toString('utf8');
  let data;
  try {
    if (text.startsWith('---')) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!match) return { rejected: `invalid ${kind} artifact: incomplete artifact frontmatter` };
      data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    } else data = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof yaml.YAMLException)) throw error;
    return { rejected: `invalid ${kind} artifact: ${error.message}`.slice(0, 1024) };
  }
  if (!isObject(data) || data.schema_version !== 2 || data.kind !== kind || !sameIdentity(data, attempt)) {
    return { rejected: 'artifact provenance does not match active attempt' };
  }
  if (typeof data.observed_at !== 'string' || !Number.isFinite(Date.parse(data.observed_at))) {
    return { rejected: 'artifact observed_at is required' };
  }
  return { data, provenance: {
    ...identityOf(attempt), kind, path: expected, sha256: createHash('sha256').update(bytes).digest('hex'),
    observed_at: data.observed_at, source: 'worker_report',
  } };
}

function validateFixtureAdapter(adapter) {
  if (adapter === undefined) return;
  if (!adapter || adapter.kind !== 'fixture' || typeof adapter.launch !== 'function' ||
      (adapter.reconcile !== undefined && typeof adapter.reconcile !== 'function') ||
      !adapter.capabilities || !Array.isArray(adapter.capabilities.engines) ||
      adapter.capabilities.engines.length === 0 ||
      !adapter.capabilities.engines.every((engine) => ['claude', 'agency-claude', 'agency-copilot'].includes(engine)) ||
      typeof adapter.capabilities.read_only_enforced !== 'boolean' || typeof adapter.capabilities.tracks_descendants !== 'boolean') {
    throw new Error('explicit fixture adapter and strict capabilities are required; production V2 dispatch is disabled');
  }
}

function agentFor(state, phase, role) {
  return phase.agents.find((agent) => agent.role === role) || {
    role, engine: state.accepted.manifest.defaults.engine, access: 'mutating',
    workdir: state.accepted.workdir, workspace: state.workspace,
    model: state.accepted.manifest.defaults.model || null,
  };
}

function processRecord(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.hostname !== 'string' ||
      (value.creation_time !== null && !Number.isFinite(Date.parse(value.creation_time))) ||
      (value.host_boot_id !== null && typeof value.host_boot_id !== 'string')) throw new Error('invalid adapter process identity');
  return { pid: value.pid, creation_time: value.creation_time, hostname: value.hostname, host_boot_id: value.host_boot_id };
}

function acceptArtifacts(state, attempt, kinds) {
  for (const kind of kinds) {
    if (attempt.evidence[kind] && !isProgress(kind)) continue;
    const artifact = readAttemptArtifact(state, attempt, kind);
    if (!artifact) continue;
    if (artifact.rejected) { attempt.diagnostics[kind] = artifact.rejected; continue; }
    const { data, provenance } = artifact;
    if (attempt.evidence[kind]?.sha256 === provenance.sha256) {
      delete attempt.diagnostics[kind];
      continue;
    }
    let valid = true;
    if (kind === 'completion') {
      valid = ['complete', 'partial', 'blocked'].includes(data.status);
      if (valid) attempt.reported_status = data.status;
    } else if (kind === 'release') {
      valid = data.released === true && data.no_further_writes === true;
    } else if (kind === 'verdict') {
      valid = attempt.role === 'qa' && ['pass', 'fail'].includes(data.verdict) &&
        Array.isArray(data.verification) && data.verification.length <= 64 &&
        data.verification.every(isObject) &&
        attempt.intent.required_verification.every((id) => data.verification.some((row) =>
          row.id === id && ['pass', 'fail'].includes(row.status) &&
          typeof row.evidence === 'string' && row.evidence.trim()));
      if (valid && data.verdict === 'pass') {
        valid = attempt.intent.required_verification.every((id) =>
          data.verification.filter((row) => row.id === id).length === 1 &&
          data.verification.find((row) => row.id === id).status === 'pass');
      }
      if (valid) attempt.qa_verdict = data.verdict;
    }
    if (!valid) { attempt.diagnostics[kind] = `invalid ${kind} report or missing required verification`; continue; }
    if (!isProgress(kind)) {
      if (attempt.evidence_history.filter((e) => !isProgress(e.kind)).length >= MAX_OBSERVATIONS) {
        attempt.diagnostics[kind] = 'attempt terminal evidence history limit reached; intervention required';
        continue;
      }
      attempt.evidence_history.push(provenance);
    }
    attempt.evidence[kind] = provenance;
    delete attempt.diagnostics[kind];
  }
}

function descendantHost(attempt) {
  return [attempt.engine_process, attempt.launch_process].find((process) =>
    process?.host_boot_id && sameHostname(process.hostname, attempt.launch_host.hostname)) || attempt.launch_host;
}

function addDescendants(attempt, sample, host) {
  if (sample.complete !== true || sample.error ||
      !sample.processes.every((row) => Number.isSafeInteger(row?.pid) && row.pid >= 0)) return false;
  if (!sameHostname(sample.hostname, host.hostname) ||
      !sample.host_boot_id || sample.host_boot_id !== host.host_boot_id) return false;
  // A child can first appear in the scan that observes its parent gone.
  // A reused parent PID may over-reserve; it must never under-reserve.
  let parents = [attempt.engine_process, attempt.launch_process, ...attempt.descendants].filter(Boolean);
  while (parents.length) {
    const found = [];
    for (const row of sample.processes) {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !parents.some((p) => row.parent_pid === p.pid)) continue;
      const process = { pid: row.pid, creation_time: row.creation_time ?? null, hostname: sample.hostname, host_boot_id: sample.host_boot_id };
      if ([attempt.engine_process, attempt.launch_process, ...attempt.descendants].filter(Boolean)
        .some((p) => sameProcess(p, process))) continue;
      if (attempt.descendants.length >= MAX_OBSERVATIONS) throw new Error('descendant tracking limit reached; intervention required');
      attempt.descendants.push(process);
      found.push(process);
    }
    parents = found;
  }
  return true;
}

function reconcileAttempt(state, attempt, sample, closureOnly = false) {
  if (attempt.status === 'queued' || (attempt.outcome && attempt.reservation.state === 'released')) return;
  acceptArtifacts(state, attempt, closureOnly ? ['release'] : ARTIFACT_KINDS);
  const fresh = newerSample(sample, attempt.health.observed_at ? attempt.health : null);
  const negativeEligible = afterProcessWatermark(attempt, sample);
  let engine = attempt.health.engine || { state: 'unknown', reason: 'no process observation yet' };
  let closed = false;
  if (fresh) {
    const host = descendantHost(attempt);
    const scanned = negativeEligible && addDescendants(attempt, sample, host);
    engine = observeProcessIdentity(attempt.engine_process || attempt.launch_host, sample);
    if (!negativeEligible && engine.state === 'dead') {
      engine = { state: 'unknown', reason: 'awaiting a process sample after dispatch or correlation' };
    }
    const rebooted = negativeEligible && engine.state !== 'live' && sample.complete === true && !sample.error &&
      sameHostname(host.hostname, sample.hostname) && host.host_boot_id &&
      sample.host_boot_id && host.host_boot_id !== sample.host_boot_id;
    if (rebooted) engine = { state: 'dead', reason: 'host reboot' };
    closed = Boolean(rebooted || (scanned && engine.state === 'dead' && attempt.descendant_tracking_complete &&
      attempt.descendants.every((p) => observeProcessIdentity(p, sample).state === 'dead')));
    attempt.health = {
      sample_id: sample.sample_id, observed_at: sample.observed_at, engine,
      unknown_samples: engine.state === 'unknown' ? attempt.health.unknown_samples + 1 : 0,
    };
  }
  if (!closureOnly && !attempt.outcome) {
    if (Object.keys(attempt.diagnostics).length) {
      attempt.status = 'needs_operator';
      attempt.reason = 'worker artifact rejected; correct the reported diagnostics';
    } else if (attempt.evidence.completion) {
      if (attempt.reported_status === 'complete' && (attempt.role !== 'qa' || attempt.qa_verdict === 'pass')) {
        attempt.outcome = { type: 'completed', at: sample.observed_at, assurance: 'worker_reported' };
        attempt.status = 'completed';
      } else if (attempt.role === 'qa' && attempt.qa_verdict === 'fail') {
        attempt.outcome = { type: 'qa_failed', at: sample.observed_at, assurance: 'worker_reported' };
        attempt.status = 'completed';
      } else {
        attempt.status = 'needs_operator';
        attempt.reason = attempt.reported_status === 'complete'
          ? 'QA completion requires a valid verdict with all required verification'
          : 'worker reported incomplete or blocked work';
      }
    } else if (((fresh && engine.state === 'dead') || attempt.adapter_closure) && attempt.status !== 'queued') {
      const category = attempt.submission?.acknowledged ? 'execution' : 'launch';
      attempt.outcome = { type: 'failed', category, at: sample.observed_at, reason: attempt.adapter_closure ? 'adapter confirmed closure' : engine.reason };
      attempt.status = 'failed';
    } else if (attempt.status !== 'queued') {
      const timedOut = Date.parse(sample.observed_at) - Date.parse(attempt.started_at) >= attempt.intent.timeout_minutes * 60000;
      if (!attempt.submission?.acknowledged || !attempt.engine_process || engine.state !== 'live' || timedOut) {
        attempt.status = 'needs_operator';
        attempt.reason = timedOut ? 'live or uncertain attempt exceeded deadline' : 'launch delivery or process ownership is uncertain';
      } else if (!attempt.reported_status || attempt.reported_status === 'complete') {
        attempt.status = 'running';
        delete attempt.reason;
      }
    }
  }
  if (attempt.reservation.state !== 'released' && (attempt.evidence.release || closed || attempt.no_external_effect || attempt.adapter_closure)) {
    const type = attempt.evidence.release ? 'cooperative_release' : attempt.no_external_effect ? 'no_external_effect'
      : attempt.adapter_closure ? 'adapter_closure' : 'process_closure';
    attempt.reservation = { state: 'released', closure: {
      type,
      at: sample.observed_at, sample_id: sample.sample_id,
      ...(type === 'process_closure' ? { process_evidence: { ...copy(attempt.health), descendants_closed: true } } : {}),
    } };
  }
}

function retryCategory(entry, iteration) {
  const attempt = currentAttempt(entry);
  if (!attempt) return 'initial';
  if (attempt.review_iteration < iteration) return 'review';
  if (attempt.status === 'queued') return attempt.retry_category;
  if (attempt.outcome?.type === 'failed' && attempt.reservation.state === 'released') return attempt.outcome.category;
  return null;
}

function aggregatePhase(state, phase, runtime) {
  if (runtime.blocker && runtime.blocker.category !== 'dependency') { runtime.status = 'blocked'; return; }
  if (phase.depends_on.some((id) => state.phases[id].status !== 'completed')) {
    runtime.blocker = { category: 'dependency', reason: 'waiting for accepted upstream completion' };
    runtime.status = 'blocked';
    return;
  }
  delete runtime.blocker;
  const impl = currentAttempt(runtime.roles.impl || { attempts: [] });
  const qa = currentAttempt(runtime.roles.qa || { attempts: [] });
  if (phase.review_loop.enabled) {
    if (runtime.review_stage === 'impl' && impl?.review_iteration === runtime.review_iteration && impl.outcome?.type === 'completed') {
      runtime.review_stage = 'qa';
    }
    if (runtime.review_stage === 'qa' && qa?.review_iteration === runtime.review_iteration && qa.outcome) {
      if (['completed', 'qa_failed'].includes(qa.outcome.type)) {
        runtime.review_history ||= [];
        if (!runtime.review_history.some((entry) => entry.attempt_id === qa.attempt_id)) {
          runtime.review_history.push({ ...identityOf(qa), verdict: qa.qa_verdict, evidence: qa.evidence.verdict });
        }
      }
      if (qa.outcome.type === 'completed') { runtime.status = 'completed'; return; }
      if (qa.outcome.type === 'qa_failed') {
        if (runtime.review_iteration + 1 >= phase.review_loop.max_iterations) {
          runtime.status = 'failed';
          runtime.failure = 'QA review budget exhausted';
          return;
        }
        if (qa.reservation.state === 'released') { runtime.review_iteration++; runtime.review_stage = 'impl'; }
      }
    }
  }
  const roles = phase.review_loop.enabled ? [runtime.review_stage] : Object.keys(runtime.roles);
  const entries = roles.map((role) => runtime.roles[role]);
  if (!phase.review_loop.enabled && entries.every((entry) => currentAttempt(entry)?.outcome?.type === 'completed')) {
    runtime.status = 'completed';
  } else if (!phase.review_loop.enabled && entries.some((entry) => currentAttempt(entry)?.outcome?.type === 'qa_failed')) {
    runtime.status = 'failed';
    runtime.failure = 'QA verification failed';
  } else if (entries.some((entry) => {
    const a = currentAttempt(entry);
    return a?.outcome?.type === 'failed' && (entry.budgets?.[a.outcome.category] || 0) >= RETRY_LIMITS[a.outcome.category];
  })) {
    runtime.status = 'failed';
    runtime.failure = 'attempt retry budget exhausted';
  } else if (entries.some((entry) => currentAttempt(entry)?.status === 'needs_operator')) runtime.status = 'needs_operator';
  else runtime.status = entries.some((entry) => currentAttempt(entry)) ? 'running' : 'pending';
}

// Terminal outcomes win over an execution blocker; otherwise it keeps the phase visibly blocked.
function aggregate(state) {
  for (const phase of state.accepted.phases) {
    const runtime = state.phases[phase.id];
    const execution = runtime.blocker?.category === 'execution' ? runtime.blocker : null;
    if (execution) delete runtime.blocker;
    aggregatePhase(state, phase, runtime);
    if (execution && !runtime.blocker && !['completed', 'failed'].includes(runtime.status)) {
      runtime.blocker = execution;
      runtime.status = 'blocked';
    }
  }
}

async function createAttemptLifecycle({ owner, store, manifestPath, _runtimeRoot, _fixtureAdapter, _engineAdapters, _lifecycleFault, _hostEvidence,
  _preflightTimeoutMs = PREFLIGHT_TIMEOUT_MS, _executionRecheckMs = EXECUTION_RECHECK_MS }) {
  if (_fixtureAdapter !== undefined && _engineAdapters !== undefined) {
    throw new Error('fixture and engine adapters cannot be combined; production V2 dispatch is disabled');
  }
  if (!Number.isSafeInteger(_preflightTimeoutMs) || _preflightTimeoutMs <= 0 ||
      !Number.isSafeInteger(_executionRecheckMs) || _executionRecheckMs < 0) {
    throw new Error('engine preflight timeout and execution recheck interval must be bounded integers');
  }
  validateFixtureAdapter(_fixtureAdapter);
  const fixture = _fixtureAdapter;
  const engines = validateEngineAdapters(_engineAdapters);
  const dispatching = Boolean(fixture) || engines.size > 0;
  // In-memory only, so a controller restart always rechecks immediately.
  const executionFailures = new Map();
  const primary = store.read().workspace;
  const context = { manifest_path: path.resolve(manifestPath), run_id: store.read().run_id };
  const owners = new Map([[primary.key, owner]]);
  let busy = false;
  let closed = false;
  const fault = (point) => { if (_lifecycleFault) _lifecycleFault(point); };
  function commit(operation, mutate) {
    const state = store.read();
    const next = copy(state);
    mutate(next);
    if (canonicalJson(next) === canonicalJson(state)) return state;
    const events = domainState(next) === domainState(state) ? [] : [{ type: 'attempt_lifecycle', payload: { operation } }];
    store.transactInternal({
      expectedRevision: state.revision,
      mutate(draft) {
        for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key];
        Object.assign(draft, next);
        return { result: { operation }, events };
      },
    });
    return store.read();
  }
  async function ensureOwner(workspace) {
    if (W.resolveWorkspace(workspace.root).key !== workspace.key) throw new Error('reserved checkout identity changed');
    const workdirs = store.read().accepted.phases.flatMap((phase) => phase.agents)
      .filter((agent) => agent.workspace.key === workspace.key).map((agent) => agent.workdir);
    if (!owners.has(workspace.key)) owners.set(workspace.key, await W.acquireWorkspaceOwner(workspace, {
      _runtimeRoot, reservationContext: context,
      legacyLockPaths: [workspace.root, ...workdirs]
        .map((directory) => path.join(directory, 'docs', 'orchestration', '.orchestrator.lock')),
    }));
    const held = owners.get(workspace.key);
    W.assertOwnership(held, workspace);
    return held;
  }
  async function syncReservations() {
    const state = store.read();
    const attempts = allAttempts(state);
    if (attempts.some((a) => a.lifecycle_version !== 1)) throw new Error('attempt closure cannot be inferred from unsupported lifecycle records');
    for (const a of attempts.filter((attempt) => attempt.access === 'mutating' &&
      (unreleased(attempt) || !attempt.reservation_cleared))) await ensureOwner(a.workspace);
    for (const held of owners.values()) {
      const record = W.readCheckoutReservation(held);
      if (record) {
        const a = attempts.find((item) => sameIdentity(item, record) && item.workspace.key === held.workspace.key);
        if (!a) throw new Error('unresolved private reservation has no matching canonical attempt');
        if (a.reservation.state === 'released') W.releaseCheckout(held, a);
      }
    }
    for (const a of attempts.filter(unreleased)) {
      W.reserveCheckout(owners.get(a.workspace.key), { ...identityOf(a), manifest_path: context.manifest_path });
    }
    const cleared = attempts.filter((a) => a.access === 'mutating' && a.reservation.state === 'released' && !a.reservation_cleared);
    if (cleared.length) commit('reservation_cleared', (draft) => {
      for (const a of cleared) find(draft, a.attempt_id).reservation_cleared = true;
    });
  }
  const find = (state, id) => allAttempts(state).find((a) => a.attempt_id === id);
  // Engine-bound attempts only ever use their engine's adapter; fixture intents never reach an engine adapter.
  const adapterFor = (attempt) => (attempt.execution === undefined ? fixture : engines.get(attempt.engine)) || null;
  const tracksDescendants = (state, attempt) => (attempt.execution === undefined
    ? fixture?.capabilities.tracks_descendants
    : state.execution_bindings[attempt.engine].capabilities.tracks_descendants) === true;
  function dispatchRefusal(attempt) {
    if (!dispatching) return 'production V2 dispatch is disabled';
    return attempt.execution === undefined
      ? 'fixture intent has no execution binding and cannot dispatch through an engine adapter'
      : 'engine-bound attempt cannot dispatch without its trusted engine adapter';
  }
  function recordObservation(a, observation, sample) {
    if (!observation || !sameIdentity(a, observation) || !safeId(observation.id)) throw new Error('adapter observation identity mismatch');
    const hash = fingerprint(observation);
    commit(`observe_${observation.kind}`, (state) => {
      const attempt = find(state, a.attempt_id);
      const prior = attempt.observations[observation.id];
      if (prior) {
        if (prior.sha256 !== hash) throw new Error('observation ID reused with different evidence');
        return;
      }
      if (attempt.status === 'queued' || (attempt.outcome &&
        (attempt.reservation.state === 'released' || !['descendants', 'closure'].includes(observation.kind)))) {
        throw new Error('new observations require an active attempt or terminal closure accounting');
      }
      if (Object.keys(attempt.observations).length >= MAX_OBSERVATIONS) throw new Error('attempt observation limit reached');
      switch (observation.kind) {
        case 'launch_process':
          if (attempt.launch_process) throw new Error('launch process identity is immutable');
          attempt.launch_process = processRecord(observation.process);
          advanceProcessWatermark(attempt, sample);
          break;
        case 'session':
          if (attempt.engine_process || typeof observation.session_id !== 'string' || !observation.session_id) throw new Error('invalid or replaced session identity');
          attempt.engine_process = processRecord(observation.process);
          attempt.session_id = observation.session_id;
          advanceProcessWatermark(attempt, sample);
          break;
        case 'submission':
          if (attempt.submission || observation.acknowledged !== true) throw new Error('submission observation must explicitly acknowledge delivery once');
          attempt.submission = { acknowledged: true, observation_id: observation.id, at: sample.observed_at };
          break;
        case 'descendants':
          if (!tracksDescendants(state, attempt) || !Array.isArray(observation.processes) ||
              observation.processes.length > MAX_OBSERVATIONS || observation.complete !== true) throw new Error('descendant closure capability is required');
          for (const process of observation.processes.map(processRecord)) {
            if (!attempt.descendants.some((p) => sameProcess(p, process))) {
              attempt.descendants.push(process);
              advanceProcessWatermark(attempt, sample);
            }
          }
          attempt.descendant_tracking_complete = true;
          break;
        case 'closure':
          if (!tracksDescendants(state, attempt) || observation.launch_settled !== true || observation.engine_closed !== true ||
              observation.descendants_closed !== true) throw new Error('adapter closure must cover the settled launch, engine and all descendants');
          if (afterProcessWatermark(attempt, sample) && newerSample(sample, attempt.health.observed_at ? attempt.health : null) &&
              [attempt.engine_process, attempt.launch_process, ...attempt.descendants]
                .some((p) => observeProcessIdentity(p, sample).state === 'live')) throw new Error('adapter closure contradicts live process evidence');
          attempt.adapter_closure = { observation_id: observation.id, at: sample.observed_at };
          break;
        case 'launch_failed':
          if (observation.no_external_effect !== true || attempt.launch_process || attempt.engine_process || attempt.submission ||
              typeof observation.reason !== 'string' || !observation.reason) throw new Error('launch failure has no proof of no external effect');
          attempt.no_external_effect = true;
          attempt.status = 'failed';
          attempt.outcome = { type: 'failed', category: 'launch', at: sample.observed_at, reason: observation.reason };
          break;
        default: throw new Error('unsupported fixture lifecycle observation');
      }
      attempt.observations[observation.id] = { sha256: hash, kind: observation.kind, at: sample.observed_at };
    });
  }
  async function invokeAdapter(method, a, sample) {
    const selected = adapterFor(a);
    let accepting = true;
    const context = { observe: async (observation) => {
      if (!accepting) throw new Error('observation arrived outside the adapter call');
      recordObservation(a, observation, sample);
      if (method === 'launch') fault(`after_${observation.kind}`);
    } };
    if (a.execution !== undefined) context.binding = copy(store.read().execution_bindings[a.engine]);
    try {
      await selected[method](copy(a), context);
    } finally { accepting = false; }
  }
  async function dispatch(attemptId, sample, binding) {
    let a = find(store.read(), attemptId);
    if (!adapterFor(a)) throw new Error(dispatchRefusal(a));
    const state = store.read();
    if (a.status !== 'queued' || state.operator.paused || state.projection?.status === 'degraded' || !hasDispatchCapacity(state)) return;
    if (a.execution !== undefined && (binding?.binding_id !== a.execution.binding_id ||
        binding?.binding_sha256 !== a.execution.binding_sha256)) {
      throw new Error('engine dispatch requires the verified execution binding of this attempt');
    }
    assertCapabilities(a, binding);
    if (W.resolveWorkspace(a.workdir).key !== a.workspace.key || W.canonicalPath(a.workdir) !== a.workdir) {
      throw new Error('attempt working directory identity changed');
    }
    if (a.access === 'mutating') {
      const held = await ensureOwner(a.workspace);
      W.reserveCheckout(held, { ...identityOf(a), manifest_path: context.manifest_path });
    }
    commit('reservation_acquired', (state) => { find(state, attemptId).reservation.state = 'held'; });
    fault('after_reservation');
    assertArtifactPath(primary.root, a.artifacts.prompt);
    fs.mkdirSync(a.artifacts.directory, { recursive: true });
    atomicWrite(a.artifacts.prompt, a.intent.prompt_text);
    if (store.read().operator.paused) return;
    commit('dispatch_started', (state) => {
      const attempt = find(state, attemptId);
      attempt.status = 'launching';
      attempt.started_at = sample.observed_at;
      attempt.launch_host = launchHost(sample);
      advanceProcessWatermark(attempt, sample);
    });
    fault('before_launch');
    a = find(store.read(), attemptId);
    await invokeAdapter('launch', a, sample);
    commit('dispatch_observed', (state) => {
      const attempt = find(state, attemptId);
      if (!attempt.outcome) {
        attempt.status = attempt.engine_process && attempt.submission?.acknowledged ? 'running' : 'needs_operator';
        if (attempt.status === 'needs_operator') attempt.reason = 'task delivery is ambiguous; automatic replay denied';
      }
    });
  }

  function assertCapabilities(agent, binding = null) {
    if (fixture) {
      validateFixtureAdapter(fixture);
      if (!fixture.capabilities.engines.includes(agent.engine) ||
          (agent.access === 'read-only' && !fixture.capabilities.read_only_enforced)) {
        throw new Error('fixture adapter cannot enforce the accepted engine/access capability');
      }
      return;
    }
    if (!engines.has(agent.engine) || binding?.engine !== agent.engine ||
        (agent.access === 'read-only' && !binding.capabilities.read_only_enforced)) {
      throw new Error('engine adapter binding cannot enforce the accepted engine/access capability');
    }
  }

  // Resolves once per run and engine, then only verifies: drift fails closed and never re-resolves.
  async function verifyExecution(engine) {
    const adapter = engines.get(engine);
    if (!adapter) return { failure: executionFailure('adapter_unavailable', engine) };
    const state = store.read();
    const existing = state.execution_bindings?.[engine] || null;
    const request = executionRequest(state, engine);
    const preflight = () => runPreflight(adapter, copy({ run_id: state.run_id, engine, ...request }), _preflightTimeoutMs);
    if (existing) {
      let evidence;
      try { evidence = await preflight(); } catch (error) {
        return { failure: executionFailure('binding_unverified', error) };
      }
      const changed = evidenceDrift(existing, evidence);
      if (changed.length) return { failure: executionFailure('binding_drift', `changed ${changed.join(', ')}`) };
      try { verifyPinnedFiles(existing); } catch (error) {
        // A missing pinned file is drift; other OS errors (locks, access) only leave the binding unverified.
        const drift = error instanceof ExecutionCheckError || ['ENOENT', 'ENOTDIR'].includes(error?.code);
        return { failure: executionFailure(drift ? 'binding_drift' : 'binding_unverified', error) };
      }
      return { binding: existing };
    }
    let candidate;
    try {
      const evidence = await preflight();
      verifyPinnedFiles(evidence);
      candidate = sealExecutionBinding({
        binding_version: EXECUTION_BINDING_VERSION, binding_id: randomUUID(), run_id: state.run_id, engine,
        adapter_kind: 'engine', request, executable: evidence.executable, package: evidence.package,
        capabilities: evidence.capabilities, evidence: executionEvidence(engine, evidence.capabilities),
        bound_at: new Date().toISOString(),
      });
      validateExecutionBinding(candidate, state);
    } catch (error) {
      return { failure: executionFailure('preflight_failed', error) };
    }
    // Persistence failures propagate: no intent or launch may proceed without the durable binding.
    fault('before_binding');
    store.bindExecution({ expectedRevision: store.read().revision, binding: candidate });
    fault('after_binding');
    return { binding: store.read().execution_bindings[engine] };
  }

  function setExecutionBlocker(phaseId, failure) {
    const blocker = store.read().phases[phaseId].blocker;
    if (failure) {
      const next = { category: 'execution', ...failure };
      if (canonicalJson(blocker ?? null) !== canonicalJson(next)) {
        commit('execution_blocked', (draft) => {
          draft.phases[phaseId].blocker = next;
          draft.phases[phaseId].status = 'blocked';
        });
      }
    } else if (blocker?.category === 'execution') {
      commit('execution_unblocked', (draft) => { delete draft.phases[phaseId].blocker; });
    }
  }

  function launchHost(sample) {
    const host = _hostEvidence || W.ownerHostEvidence(owner);
    return {
      hostname: sample.hostname || host.hostname,
      host_boot_id: sample.host_boot_id || null,
    };
  }

  function createIntent(state, phase, role, sample, binding = null) {
    const runtime = state.phases[phase.id];
    const entry = runtime.roles[role];
    const previous = currentAttempt(entry);
    const category = retryCategory(entry, runtime.review_iteration);
    const agent = agentFor(state, phase, role);
    assertCapabilities(agent, binding);
    if (entry.attempts.length >= MAX_ATTEMPTS_PER_ROLE) throw new Error('immutable attempt history limit reached; intervention required');
    const identity = { run_id: state.run_id, phase_id: phase.id, role, review_iteration: runtime.review_iteration, attempt_id: randomUUID() };
    const artifacts = artifactPaths(state.workspace, identity);
    const raw = state.accepted.manifest.phases.find((p) => p.id === phase.id);
    const recovery = category === 'execution';
    const priorArtifacts = phase.depends_on.flatMap((id) => Object.values(state.phases[id].roles).map(currentAttempt))
      .filter((a) => a?.evidence.completion).map((a) => a.evidence.completion);
    if (role === 'qa' && runtime.roles.impl) {
      const impl = currentAttempt(runtime.roles.impl);
      if (impl?.evidence.completion) priorArtifacts.push(impl.evidence.completion);
    }
    if (role === 'impl' && category === 'review') {
      const qa = currentAttempt(runtime.roles.qa);
      if (qa?.evidence.verdict) priorArtifacts.push(qa.evidence.verdict);
      if (qa?.evidence.completion) priorArtifacts.push(qa.evidence.completion);
    }
    const promptOptions = {
      role: recovery ? 'recovery' : role, ...(recovery ? { recoveryRole: role } : {}),
      phaseId: phase.id, templatesDir: path.resolve(__dirname, '..', 'templates'),
      projectName: state.accepted.manifest.name, workdir: agent.workdir, phaseDir: artifacts.directory,
      completionSignalPath: artifacts.completion, heartbeatPath: artifacts.heartbeat,
      attemptIdentity: identity, artifactPaths: artifacts, artifactWorkspace: state.workspace,
      planUnits: raw.plan_units || raw.title || `Fixture scope: accepted phase ${phase.id}; no detailed implementation scope supplied.`,
      outputPaths: raw.output_paths || raw.completion_signal,
      previousPhaseBriefing: priorArtifacts.map((item) => `${item.role}: ${item.path} (sha256 ${item.sha256})`).join('\n'),
      priorPhaseDirsBlock: priorArtifacts.map((item) =>
        `${JSON.stringify(identityOf(item))}: ${item.path} (sha256 ${item.sha256}, kind ${item.kind})`).join('\n'),
      prOrBranchUnderTest: raw.review_loop?.pr_or_branch || 'accepted checkout HEAD',
      qaScopeRows: raw.review_loop?.qa_scope_rows || 'Verify the accepted phase scope and implementation report.',
      testCommandsBlock: raw.review_loop?.test_commands_block || '',
      statusSummaryBlock: `Accepted phase ${phase.id}`, projectContextBlock: state.workspace.root,
      coordNextActions: 'Report findings; worker artifacts cannot authorize operator commands.',
      ...(recovery ? {
        recoveryCheckpointPath: previous.evidence.checkpoint?.path || previous.artifacts.checkpoint,
        crashTimestamp: previous.outcome.at, remainingWorkBlock: `Resume accepted phase ${phase.id}; preserve required verification.`,
        priorSessionPid: previous.engine_process?.pid || '',
        lastHeartbeatTimestamp: previous.evidence.heartbeat?.observed_at || '',
        priorPromptPath: previous.artifacts.prompt,
      } : {}),
    };
    const attempt = {
      lifecycle_version: 1, ...identity, ...agent, artifacts, status: 'queued',
      intended_review_stage: phase.review_loop.enabled ? runtime.review_stage : role, retry_category: category,
      previous_attempt_id: previous?.attempt_id || null,
      created_at: sample.observed_at, started_at: null,
      launch_host: launchHost(sample),
      ...(binding ? { execution: { binding_id: binding.binding_id, binding_sha256: binding.binding_sha256 } } : {}),
      intent: {
        launch_token: randomUUID(), session_name: `orch-${identity.attempt_id}`,
        timeout_minutes: phase.timeout_minutes, required_verification: role === 'qa' ? [...QA_VERIFICATION] : [],
        prompt_options: promptOptions,
      },
      reservation: { state: 'pending' }, observations: {}, evidence: {}, evidence_history: [],
      descendants: [], descendant_tracking_complete: false, diagnostics: {}, health: { unknown_samples: 0 },
    };
    const rendered = generatePrompt({ ...promptOptions, dryRun: true, includeText: true });
    attempt.intent.prompt_text = rendered.text;
    attempt.intent.prompt_sha256 = createHash('sha256').update(rendered.text).digest('hex');
    attempt.intent.prompt_warnings = rendered.warnings;
    // Session names and launch tokens belong to this immutable intent, never to a phase-global kickoff file.
    entry.budgets ||= { launch: 0, execution: 0 };
    if (Object.hasOwn(RETRY_LIMITS, category)) entry.budgets[category]++;
    entry.current_attempt_id = attempt.attempt_id;
    entry.attempts.push(attempt);
    return attempt.attempt_id;
  }

  async function close() {
    if (closed) return;
    if (busy) throw new Error('cannot close checkout claims during lifecycle reconciliation');
    closed = true;
    const results = await Promise.allSettled([...owners.values()].filter((held) => held !== owner).map((held) => held.release()));
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errors.length) throw new AggregateError(errors, 'checkout claim cleanup failed');
  }
  try { await syncReservations(); } catch (error) { await close(); throw error; }
  return Object.freeze({
    close,
    async tick({ sample } = {}) {
      if (busy || closed) throw new Error('lifecycle reconciliation is closed or already running');
      W.assertOwnership(owner, primary);
      busy = true;
      try {
        await syncReservations();
        let state = store.read();
        if (!allAttempts(state).length && !dispatching) return state;
        sample ||= observeProcessTable();
        if (!safeId(sample.sample_id) || !Number.isFinite(Date.parse(sample.observed_at)) || !Array.isArray(sample.processes)) {
          throw new Error('health sample identity, timestamp and process table are required');
        }
        for (const a of allAttempts(state).filter((attempt) => attempt.status !== 'queued' &&
          (!attempt.outcome || attempt.reservation.state !== 'released'))) {
          if (adapterFor(a)?.reconcile) await invokeAdapter('reconcile', a, sample);
        }
        state = commit('reconcile', (draft) => {
          if (sample.complete !== true || sample.error) {
            draft.process_diagnostic = { sample_id: sample.sample_id, observed_at: sample.observed_at,
              error: sample.error || 'incomplete OS process table' };
            draft.runtime_status = 'process_observation_failed';
          } else {
            delete draft.process_diagnostic;
            draft.runtime_status = 'live_dispatch_disabled';
          }
          for (const phase of Object.values(draft.phases)) {
            for (const entry of Object.values(phase.roles)) {
              for (const attempt of entry.attempts) {
                const isCurrent = attempt.attempt_id === entry.current_attempt_id;
                if (isCurrent || (attempt.outcome && attempt.reservation.state !== 'released')) {
                  reconcileAttempt(draft, attempt, sample, !isCurrent);
                }
              }
            }
          }
          aggregate(draft);
        });
        fault('after_reconcile');
        await syncReservations();
        if (!dispatching || state.operator.paused || state.projection?.status === 'degraded') return store.read();
        const now = performance.now();
        for (const phaseId of state.accepted.execution_order) {
          const phase = state.accepted.phases.find((p) => p.id === phaseId);
          const latest = store.read();
          const runtime = latest.phases[phase.id];
          // Execution blockers are re-verified here; every other blocker category stays sticky.
          const recheck = engines.size > 0 && runtime.blocker?.category === 'execution';
          if (latest.operator.paused || (runtime.blocker && !recheck) || ['completed', 'failed'].includes(runtime.status)) continue;
          const roles = phase.review_loop.enabled ? [runtime.review_stage] : Object.keys(runtime.roles);
          const failures = [];
          let unverified = false;
          for (const role of roles) {
            const admission = store.read();
            if (admission.operator.paused || !hasDispatchCapacity(admission)) { unverified = true; break; }
            const entry = store.read().phases[phase.id].roles[role];
            const category = retryCategory(entry, runtime.review_iteration);
            const previous = currentAttempt(entry);
            if (!category || (previous?.status !== 'queued' && Object.hasOwn(RETRY_LIMITS, category) &&
              (entry.budgets?.[category] || 0) >= RETRY_LIMITS[category])) continue;
            const agent = agentFor(latest, phase, role);
            if (allAttempts(store.read()).some((a) => unreleased(a) && a.workspace.key === agent.workspace.key &&
                a.attempt_id !== (previous?.status === 'queued' ? previous.attempt_id : null)) && agent.access === 'mutating') {
              unverified = true;
              continue;
            }
            const queued = previous?.status === 'queued' ? previous : null;
            // Kind mismatches are trust errors; a missing adapter for a bound intent is a durable blocker below.
            if (queued && (engines.size ? queued.execution === undefined : queued.execution !== undefined)) {
              throw new Error(dispatchRefusal(queued));
            }
            let binding = null;
            if (engines.size) {
              // Successes are never reused: each dispatch re-verifies, because a prior launch may have changed files.
              const cached = executionFailures.get(agent.engine);
              const outcome = cached && now < cached.retry_at ? cached : await verifyExecution(agent.engine);
              if (outcome.failure) {
                if (outcome !== cached) executionFailures.set(agent.engine, { ...outcome, retry_at: now + _executionRecheckMs });
                failures.push(outcome.failure);
                continue;
              }
              executionFailures.delete(agent.engine);
              binding = outcome.binding;
            }
            let id = queued?.attempt_id || null;
            if (!id) {
              commit('dispatch_intent', (draft) => { id = createIntent(draft, phase, role, sample, binding); });
              fault('after_intent');
            }
            await dispatch(id, sample, binding);
          }
          if (engines.size && (failures.length || !unverified)) setExecutionBlocker(phase.id, failures[0] || null);
        }
        return commit('aggregate', aggregate);
      } finally { busy = false; }
    },
  });
}

module.exports = {
  MAX_ARTIFACT_BYTES, MAX_ATTEMPTS_PER_ROLE, MAX_OBSERVATIONS, RETRY_LIMITS, QA_VERIFICATION,
  artifactPaths, identityOf, readAttemptArtifact, createAttemptLifecycle,
};
