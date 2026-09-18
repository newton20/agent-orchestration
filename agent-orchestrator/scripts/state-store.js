'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { randomUUID, createHash } = require('node:crypto');
const { assertOwnership, validateWorkspace, readCheckoutReservation } = require('./workspace-owner');
const { statusPathFor, validate, normalizePhases, findDanglingDeps, V2_ENGINES, V2_ACCESS } = require('./parse-manifest');

const STATE_SCHEMA_VERSION = 2;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && SAFE_ID.test(value) && !RESERVED.has(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

function requireShape(condition, message) {
  if (!condition) throw new Error(`invalid state: ${message}`);
}

function canonicalJson(value) {
  const seen = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!isObject(item) && !Array.isArray(item)) throw new Error('state and command payloads must be JSON data');
    if (seen.has(item)) throw new Error('state and command payloads cannot contain cycles');
    seen.add(item);
    let serialized;
    if (Array.isArray(item)) {
      serialized = `[${Array.from(item, visit).join(',')}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('state requires plain JSON objects');
      const keys = Object.keys(item).sort();
      if (keys.some((key) => RESERVED.has(key))) throw new Error('state contains a reserved object key');
      serialized = `{${keys.map((key) => `${JSON.stringify(key)}:${visit(item[key])}`).join(',')}}`;
    }
    seen.delete(item);
    return serialized;
  }
  return visit(value);
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function fingerprint(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function validateAccepted(accepted) {
  requireShape(isObject(accepted) && positive(accepted.revision), 'accepted revision is required');
  requireShape(isObject(accepted.manifest) && accepted.manifest.schema_version === 2, 'accepted manifest must activate V2');
  const result = validate(accepted.manifest);
  requireShape(result.valid && findDanglingDeps(accepted.manifest.phases).length === 0, 'accepted manifest validation failed');
  requireShape(isObject(accepted.manifest.terminal) && isObject(accepted.manifest.limits), 'accepted terminal and timeout cap are required');
  requireShape(positive(accepted.manifest.defaults.phase_timeout_minutes) && positive(accepted.manifest.defaults.heartbeat_timeout_minutes),
    'accepted effective timeout defaults are required');
  requireShape(typeof accepted.source_path === 'string' && path.isAbsolute(accepted.source_path), 'accepted source_path must be absolute');
  requireShape(/^[a-f0-9]{64}$/.test(accepted.source_sha256), 'accepted source fingerprint is required');
  requireShape(typeof accepted.workdir === 'string' && path.isAbsolute(accepted.workdir), 'accepted workdir must be absolute');
  validateWorkspace(accepted.workspace);
  requireShape(canonicalJson(accepted.execution_order) === canonicalJson(result.executionOrder), 'accepted dependency order mismatch');
  const normalized = normalizePhases(accepted.manifest);
  requireShape(Array.isArray(accepted.phases) && accepted.phases.length === normalized.length, 'accepted phases mismatch');
  normalized.forEach((phase, i) => {
    const actual = accepted.phases[i];
    requireShape(isObject(actual) && Array.isArray(actual.agents) && actual.agents.length === phase.agents.length, 'accepted agents mismatch');
    const { agents, ...fields } = phase;
    const { agents: actualAgents, ...actualFields } = actual;
    requireShape(canonicalJson(fields) === canonicalJson(actualFields), 'accepted normalized phase mismatch');
    actualAgents.forEach((agent, j) => {
      const { workdir, workspace, ...rest } = agent;
      const { workdir: declaration, ...expected } = agents[j];
      requireShape(canonicalJson(rest) === canonicalJson(expected), 'accepted agent configuration mismatch');
      requireShape(typeof workdir === 'string' && path.isAbsolute(workdir), 'accepted agent workdir must be absolute');
      validateWorkspace(workspace);
    });
  });
}

function validateLegacyCompleted(record) {
  requireShape(isObject(record) && (record.schema_version === undefined || record.schema_version === 1), 'unsupported legacy schema');
  requireShape(isObject(record.phases) && Object.keys(record.phases).length > 0, 'legacy V1 history requires completed phases');
  for (const [id, phase] of Object.entries(record.phases)) {
    requireShape(isId(id) && isObject(phase) && phase.status === 'completed',
      'active or uncorrelated V1 history cannot activate V2; drain and reconcile it explicitly');
  }
}

function validateLifecycleAttempt(attempt, record) {
  requireShape(attempt.lifecycle_version === 1, 'unsupported attempt lifecycle version');
  requireShape(['queued', 'launching', 'running', 'needs_operator', 'completed', 'failed', 'cancelled'].includes(attempt.status),
    'invalid attempt lifecycle status');
  requireShape(['initial', 'launch', 'execution', 'review'].includes(attempt.retry_category) &&
    typeof attempt.intended_review_stage === 'string' && isObject(attempt.intent) &&
    isId(attempt.intent.launch_token) && isId(attempt.intent.session_name) &&
    positive(attempt.intent.timeout_minutes) && Array.isArray(attempt.intent.required_verification) &&
    isObject(attempt.intent.prompt_options) && typeof attempt.intent.prompt_text === 'string' &&
    attempt.intent.prompt_sha256 === createHash('sha256').update(attempt.intent.prompt_text).digest('hex'),
    'complete immutable dispatch intent is required');
  requireShape(isObject(attempt.launch_host) && typeof attempt.launch_host.hostname === 'string' &&
    !Object.hasOwn(attempt.launch_host, 'pid') && !Object.hasOwn(attempt.launch_host, 'creation_time') &&
    (attempt.launch_host.host_boot_id === null || typeof attempt.launch_host.host_boot_id === 'string'), 'attempt launch host is required and cannot identify the controller as the engine');
  requireShape(isObject(attempt.reservation) && ['pending', 'held', 'released'].includes(attempt.reservation.state),
    'attempt reservation is required');
  if (attempt.reservation.state === 'released') requireShape(isObject(attempt.reservation.closure), 'released attempt needs concrete closure');
  if (attempt.reservation_cleared !== undefined) requireShape(
    typeof attempt.reservation_cleared === 'boolean' && attempt.reservation.state === 'released',
    'reservation cleanup acknowledgement requires release');
  requireShape(isObject(attempt.observations) && Object.keys(attempt.observations).length <= 64 &&
    isObject(attempt.evidence) && Array.isArray(attempt.evidence_history) &&
    attempt.evidence_history.filter((e) => ['heartbeat', 'checkpoint'].includes(e?.kind)).length <= 64 &&
    attempt.evidence_history.filter((e) => !['heartbeat', 'checkpoint'].includes(e?.kind)).length <= 64 &&
    Array.isArray(attempt.descendants) && attempt.descendants.length <= 64 &&
    typeof attempt.descendant_tracking_complete === 'boolean' &&
    isObject(attempt.health) && nonnegative(attempt.health.unknown_samples), 'bounded observations and health identity are required');
  if (attempt.process_sample_watermark !== undefined) requireShape(
    isObject(attempt.process_sample_watermark) && isId(attempt.process_sample_watermark.sample_id) &&
    typeof attempt.process_sample_watermark.observed_at === 'string' &&
    Number.isFinite(Date.parse(attempt.process_sample_watermark.observed_at)), 'invalid process sample watermark');
  const phase = record.accepted.phases.find((p) => p.id === attempt.phase_id);
  const agent = phase.agents.find((a) => a.role === attempt.role) || {
    engine: record.accepted.manifest.defaults.engine, access: 'mutating',
    workdir: record.accepted.workdir, workspace: record.workspace,
  };
  requireShape(['engine', 'access', 'workdir'].every((key) => attempt[key] === agent[key]) &&
    canonicalJson(attempt.workspace) === canonicalJson(agent.workspace) &&
    attempt.intent.timeout_minutes === phase.timeout_minutes, 'attempt differs from accepted execution configuration');
  requireShape(canonicalJson(attempt.intent.required_verification) ===
    canonicalJson(attempt.role === 'qa' ? ['scope', 'P1', 'P2', 'P3', 'P4', 'P6'] : []), 'required verification cannot be weakened');
  requireShape(isObject(attempt.artifacts), 'attempt artifact paths are required');
  const directory = path.join(record.workspace.root, 'docs', 'orchestration', 'runs', attempt.run_id,
    'phases', attempt.phase_id, attempt.role, String(attempt.review_iteration), attempt.attempt_id);
  requireShape(attempt.artifacts.directory === directory &&
    attempt.artifacts.prompt === path.join(directory, `${attempt.role}-prompt.md`), 'attempt prompt path mismatch');
  for (const kind of ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release']) {
    requireShape(attempt.artifacts[kind] === path.join(directory, `${kind}.json`), 'attempt artifact path mismatch');
  }
  const options = attempt.intent.prompt_options;
  requireShape(options.phaseDir === directory && options.phaseId === attempt.phase_id &&
    options.completionSignalPath === attempt.artifacts.completion && options.heartbeatPath === attempt.artifacts.heartbeat &&
    isObject(options.attemptIdentity) &&
    ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'].every((key) => options.attemptIdentity[key] === attempt[key]),
  'prompt intent identity mismatch');
}

function preserveLifecycle(previous, next) {
  for (const [phaseId, phase] of Object.entries(previous.phases)) {
    const updated = next.phases[phaseId];
    requireShape(updated.review_iteration >= phase.review_iteration, 'review iteration cannot be reset');
    for (const [role, entry] of Object.entries(phase.roles)) {
      const later = updated.roles[role];
      for (const attempt of entry.attempts.filter((a) => a.lifecycle_version === 1)) {
        const current = later.attempts.find((a) => a.attempt_id === attempt.attempt_id);
        requireShape(Boolean(current), 'historical attempts cannot be removed');
        for (const field of ['lifecycle_version', 'attempt_id', 'run_id', 'phase_id', 'role', 'review_iteration', 'engine', 'access',
          'workdir', 'workspace', 'intent', 'artifacts', 'created_at', 'intended_review_stage', 'retry_category', 'previous_attempt_id']) {
          requireShape(canonicalJson(attempt[field]) === canonicalJson(current[field]), `immutable attempt field ${field}`);
        }
        if (attempt.status !== 'queued' || attempt.started_at ||
            !['queued', 'launching'].includes(current.status)) {
          requireShape(canonicalJson(attempt.launch_host) === canonicalJson(current.launch_host), 'immutable attempt field launch_host');
        }
        if (attempt.process_sample_watermark) {
          const before = attempt.process_sample_watermark;
          const after = current.process_sample_watermark;
          requireShape(after && (canonicalJson(before) === canonicalJson(after) ||
            Date.parse(after.observed_at) > Date.parse(before.observed_at)), 'process sample watermark cannot move backward');
        }
        for (const field of ['outcome', 'launch_process', 'engine_process', 'session_id', 'submission', 'adapter_closure']) {
          if (Object.hasOwn(attempt, field)) requireShape(canonicalJson(attempt[field]) === canonicalJson(current[field]), `immutable attempt observation ${field}`);
        }
        for (const [id, observation] of Object.entries(attempt.observations)) {
          requireShape(canonicalJson(observation) === canonicalJson(current.observations[id]), 'historical observation cannot change');
        }
        requireShape(canonicalJson(attempt.evidence_history) === canonicalJson(current.evidence_history.slice(0, attempt.evidence_history.length)),
          'historical artifact evidence cannot change');
        requireShape(attempt.descendants.every((process) => current.descendants.some((p) => canonicalJson(p) === canonicalJson(process))),
          'tracked descendants cannot be discarded');
        if (attempt.started_at) requireShape(attempt.started_at === current.started_at, 'attempt start clock cannot change');
        if (attempt.reservation.state === 'released') requireShape(canonicalJson(attempt.reservation) === canonicalJson(current.reservation),
          'released reservation cannot be reacquired by the old attempt');
        if (attempt.reservation_cleared === true) requireShape(current.reservation_cleared === true,
          'reservation cleanup acknowledgement cannot be reset');
      }
      for (const category of ['launch', 'execution']) {
        requireShape((later.budgets?.[category] || 0) >= (entry.budgets?.[category] || 0), 'retry budgets cannot reset');
      }
    }
    if (phase.review_history) requireShape(canonicalJson(phase.review_history) ===
      canonicalJson(updated.review_history?.slice(0, phase.review_history.length)), 'review history cannot change');
  }
}

function validateRun(record) {
  requireShape(isObject(record) && record.schema_version === STATE_SCHEMA_VERSION, `unsupported state schema_version ${record?.schema_version}`);
  canonicalJson(record);
  requireShape(positive(record.revision) && isId(record.run_id), 'revision and run_id are required');
  validateWorkspace(record.workspace);
  validateAccepted(record.accepted);
  requireShape(record.workspace.key === record.accepted.workspace.key, 'workspace and accepted snapshot disagree');
  requireShape(isObject(record.operator) && typeof record.operator.paused === 'boolean', 'operator.paused must be boolean');
  requireShape(typeof record.runtime_status === 'string' && record.runtime_status.length > 0, 'runtime_status is required');
  requireShape(record.live_dispatch_enabled === false, 'live V2 dispatch is disabled until adapter acceptance');
  requireShape(typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at)) &&
    typeof record.updated_at === 'string' && Number.isFinite(Date.parse(record.updated_at)), 'state timestamps are required');
  requireShape(isObject(record.phases), 'phases must be a map');
  const phaseIds = record.accepted.phases.map((phase) => phase.id).sort();
  requireShape(canonicalJson(Object.keys(record.phases).sort()) === canonicalJson(phaseIds), 'runtime phases disagree with accepted phases');
  const attempts = new Set();
  for (const [phaseId, phase] of Object.entries(record.phases)) {
    requireShape(isObject(phase) && typeof phase.status === 'string' && nonnegative(phase.review_iteration) &&
      typeof phase.review_stage === 'string' && isObject(phase.roles), `invalid phase ${phaseId}`);
    const declared = record.accepted.phases.find((p) => p.id === phaseId);
    const requiredRoles = new Set(declared.agents.map((agent) => agent.role));
    if (declared.review_loop.enabled) { requiredRoles.add('impl'); requiredRoles.add('qa'); }
    for (const role of requiredRoles) requireShape(Object.hasOwn(phase.roles, role), `missing role ${phaseId}/${role}`);
    for (const [role, entry] of Object.entries(phase.roles)) {
      requireShape(isId(role) && isObject(entry) && Array.isArray(entry.attempts), 'roles require attempt arrays');
      requireShape(entry.attempts.length <= 64, 'role attempt history limit exceeded');
      if (entry.budgets) requireShape(nonnegative(entry.budgets.launch) && nonnegative(entry.budgets.execution), 'invalid role retry budgets');
      requireShape(entry.current_attempt_id === null || isId(entry.current_attempt_id), 'invalid current_attempt_id');
      for (const attempt of entry.attempts) {
        requireShape(isObject(attempt) && isId(attempt.attempt_id) && !attempts.has(attempt.attempt_id), 'invalid or duplicate attempt_id');
        requireShape(attempt.run_id === record.run_id && attempt.phase_id === phaseId && attempt.role === role &&
          nonnegative(attempt.review_iteration), 'attempt identity mismatch');
        requireShape(V2_ENGINES.includes(attempt.engine) && V2_ACCESS.includes(attempt.access), 'invalid attempt engine/access');
        requireShape(typeof attempt.workdir === 'string' && path.isAbsolute(attempt.workdir), 'attempt workdir must be absolute');
        validateWorkspace(attempt.workspace);
        if (attempt.lifecycle_version !== undefined) validateLifecycleAttempt(attempt, record);
        attempts.add(attempt.attempt_id);
      }
      requireShape(entry.current_attempt_id === null || entry.attempts.some((attempt) => attempt.attempt_id === entry.current_attempt_id),
        'current attempt is missing');
      if (entry.attempts.some((a) => a.lifecycle_version === 1)) {
        requireShape(entry.current_attempt_id === entry.attempts.at(-1).attempt_id, 'current lifecycle attempt must be the latest historical attempt');
        requireShape(entry.budgets && ['launch', 'execution'].every((category) =>
          entry.budgets[category] === entry.attempts.filter((a) => a.retry_category === category).length), 'retry budgets disagree with immutable attempts');
      }
    }
  }
  requireShape(isObject(record.command_results), 'command_results must be a map');
  for (const [id, command] of Object.entries(record.command_results)) {
    requireShape(isId(id) && isObject(command) && /^[a-f0-9]{64}$/.test(command.fingerprint) &&
      isObject(command.response) && positive(command.response.revision) && command.response.revision <= record.revision &&
      Object.hasOwn(command.response, 'result'), 'invalid command dedup result');
  }
  requireShape(positive(record.next_event_sequence) && Array.isArray(record.outbox), 'invalid pending event outbox');
  let previousSequence = 0;
  for (const event of record.outbox) {
    requireShape(isObject(event) && positive(event.sequence) && event.sequence > previousSequence &&
      event.sequence < record.next_event_sequence && event.run_id === record.run_id &&
      event.event_id === `${record.run_id}:${event.sequence}` && positive(event.revision) && event.revision <= record.revision &&
      typeof event.type === 'string' && event.type.length > 0 && Object.hasOwn(event, 'payload'), 'invalid event identity or ordering');
    previousSequence = event.sequence;
  }
  requireShape(Array.isArray(record.legacy_history), 'legacy_history must be an array');
  record.legacy_history.forEach(validateLegacyCompleted);
}

function validateState(record) {
  validateRun(record);
  requireShape(Array.isArray(record.history), 'history must be an array');
  const ids = new Set([record.run_id]);
  let priorRevision = 0;
  for (const prior of record.history) {
    requireShape(!Object.hasOwn(prior, 'history') && !ids.has(prior.run_id), 'recursive or duplicate run history');
    validateRun(prior);
    requireShape(prior.workspace.key === record.workspace.key && prior.revision > priorRevision && prior.revision < record.revision,
      'invalid historical workspace or revision');
    ids.add(prior.run_id);
    priorRevision = prior.revision;
  }
  return record;
}

function readRecord(manifestPath) {
  const statusPath = statusPathFor(path.resolve(manifestPath));
  let fd;
  try { fd = fs.openSync(statusPath, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return { state: null, bytes: null };
    throw new Error(`cannot read canonical state ${statusPath}: ${error.message}`);
  }
  let bytes;
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_STATE_BYTES) throw new Error('canonical state exceeds size limit');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > size) throw new Error('canonical state changed size during read');
    bytes = buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
  let state;
  try { state = yaml.load(bytes, { schema: yaml.JSON_SCHEMA }); } catch (error) {
    throw new Error(`corrupt canonical state ${statusPath}: ${error.message}`);
  }
  requireShape(isObject(state), 'canonical state must be an object');
  if (state.schema_version !== undefined && state.schema_version !== 1) validateState(state);
  return { state, bytes };
}

function readState(manifestPath) {
  return readRecord(manifestPath).state;
}

function appendEvents(draft, events) {
  requireShape(Array.isArray(events), 'transaction events must be an array');
  for (const event of events) {
    requireShape(isObject(event) && typeof event.type === 'string' && event.type && Object.hasOwn(event, 'payload'), 'invalid transaction event');
    const sequence = draft.next_event_sequence++;
    draft.outbox.push({
      sequence, event_id: `${draft.run_id}:${sequence}`, run_id: draft.run_id,
      revision: draft.revision, type: event.type, payload: clone(event.payload),
    });
  }
}

function newRun(accepted, revision, history = [], legacyHistory = []) {
  const snapshot = { ...clone(accepted), revision: 1 };
  validateAccepted(snapshot);
  const phases = {};
  for (const phase of snapshot.phases) {
    const roles = new Set(phase.agents.map((agent) => agent.role));
    if (phase.review_loop.enabled) { roles.add('impl'); roles.add('qa'); }
    phases[phase.id] = {
      status: 'pending', review_iteration: 0, review_stage: 'impl',
      roles: Object.fromEntries([...roles].map((role) => [role, { current_attempt_id: null, attempts: [] }])),
    };
  }
  const now = new Date().toISOString();
  const state = {
    schema_version: STATE_SCHEMA_VERSION, revision, run_id: randomUUID(),
    workspace: clone(snapshot.workspace), accepted: snapshot, operator: { paused: false },
    runtime_status: 'live_dispatch_disabled', live_dispatch_enabled: false,
    phases, command_results: {}, outbox: [], next_event_sequence: 1,
    created_at: now, updated_at: now, history: clone(history), legacy_history: clone(legacyHistory),
  };
  appendEvents(state, [{ type: 'run_created', payload: { accepted_revision: 1, status: 'live_dispatch_disabled' } }]);
  return state;
}

function assertRerunEligible(state, { allowUnclearedReservations = false } = {}) {
  requireShape(state?.schema_version === 2, 'explicit rerun requires an existing V2 run');
  const phases = Object.values(state.phases);
  const attempts = phases.flatMap((phase) => Object.values(phase.roles).flatMap((role) => role.attempts));
  if (!attempts.length && phases.every((phase) => phase.status === 'pending')) return;
  if (phases.some((phase) => {
    const unstarted = Object.values(phase.roles).every((role) => role.attempts.length === 0);
    if (unstarted && (phase.status === 'pending' ||
        (phase.status === 'blocked' && phase.blocker?.category === 'dependency'))) return false;
    return !['completed', 'failed'].includes(phase.status);
  })) {
    throw new Error('rerun requires terminal started phases without active work');
  }
  for (const attempt of attempts) {
    const outcome = attempt.outcome;
    const terminal = attempt.lifecycle_version === 1 && Number.isFinite(Date.parse(outcome?.at)) &&
      ((attempt.status === 'completed' && (outcome.type === 'completed' || (attempt.role === 'qa' && outcome.type === 'qa_failed'))) ||
        (attempt.status === 'failed' && outcome.type === 'failed' && ['launch', 'execution'].includes(outcome.category)));
    const closure = attempt.reservation?.closure;
    const processProof = closure?.process_evidence;
    const concrete = attempt.reservation?.state === 'released' && isObject(closure) &&
      Number.isFinite(Date.parse(closure.at)) && isId(closure.sample_id) &&
      ((closure.type === 'cooperative_release' && attempt.evidence?.release?.kind === 'release') ||
        (closure.type === 'no_external_effect' && attempt.no_external_effect === true) ||
        (closure.type === 'adapter_closure' && attempt.adapter_closure &&
          attempt.observations?.[attempt.adapter_closure.observation_id]?.kind === 'closure') ||
        (closure.type === 'process_closure' && (processProof
          ? processProof.sample_id === closure.sample_id && processProof.observed_at === closure.at &&
            processProof.engine?.state === 'dead' && processProof.descendants_closed === true
          : attempt.health?.sample_id === closure.sample_id && attempt.health.observed_at === closure.at)));
    if (!terminal || !concrete || (!allowUnclearedReservations &&
        attempt.access === 'mutating' && attempt.reservation_cleared !== true)) {
      throw new Error('rerun requires terminal attempt outcomes, concrete closure and cleared mutating reservations');
    }
  }
}

function createStateStore({ manifestPath, owner, _fs = {} }) {
  const statusPath = statusPathFor(path.resolve(manifestPath));
  const io = { ...fs, ..._fs };
  let mutating = false;
  function owned(workspace) {
    assertOwnership(owner, workspace);
    if (mutating) throw new Error('state transactions cannot be nested');
  }
  function publish(state, previousBytes) {
    validateState(state);
    const bytes = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error('canonical state exceeds size limit; refusing publication');
    const temp = `${statusPath}.tmp-${randomUUID()}`;
    let fd;
    try {
      fd = io.openSync(temp, 'wx', 0o600);
      io.writeFileSync(fd, bytes, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      assertOwnership(owner, state.workspace);
      if (readRecord(manifestPath).bytes !== previousBytes) throw new Error('state revision fencing failed before publication');
      io.renameSync(temp, statusPath);
    } catch (error) {
      if (fd !== undefined) {
        try { io.closeSync(fd); } catch (closeError) { error.message += `; close failed: ${closeError.message}`; }
      }
      try { io.unlinkSync(temp); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.message += `; temporary cleanup failed: ${cleanupError.message}`;
      }
      throw new Error(`failed to publish canonical state: ${error.message}`);
    }
    return clone(state);
  }
  function transact({ expectedRevision, command, mutate }, internal = false) {
    const current = readRecord(manifestPath);
    requireShape(current.state?.schema_version === 2, 'initialize a V2 run before transacting');
    owned(current.state.workspace);
    let hash;
    if (internal) {
      requireShape(command === undefined, 'internal transactions do not accept commands');
    } else {
      requireShape(isObject(command) && isId(command.id) && Object.hasOwn(command, 'payload'), 'command id and payload are required');
      hash = fingerprint(command.payload);
      const prior = current.state.command_results[command.id];
      if (prior) {
        if (prior.fingerprint !== hash) throw new Error('command ID reuse with differing payload fingerprint is rejected');
        return clone(prior.response);
      }
    }
    if (!positive(expectedRevision) || expectedRevision !== current.state.revision) throw new Error('state revision conflict');
    if (typeof mutate !== 'function') throw new Error('synchronous transaction callback is required');
    const draft = clone(current.state);
    mutating = true;
    try {
      const outcome = mutate(draft);
      if (outcome && typeof outcome.then === 'function') throw new Error('transaction callback must be synchronous, not async');
      requireShape(isObject(outcome) && Object.hasOwn(outcome, 'result'), 'transaction result is required');
      for (const field of ['schema_version', 'run_id', 'workspace', 'history', 'legacy_history', 'created_at', 'command_results', 'outbox', 'next_event_sequence', 'revision']) {
        if (canonicalJson(draft[field]) !== canonicalJson(current.state[field])) throw new Error(`immutable transaction field: ${field}`);
      }
      // Structural acceptance belongs to the later human-command contract.
      if (canonicalJson(draft.accepted) !== canonicalJson(current.state.accepted)) throw new Error('accepted snapshot is immutable in foundation transactions');
      preserveLifecycle(current.state, draft);
      draft.revision++;
      draft.updated_at = new Date().toISOString();
      const response = { revision: draft.revision, result: clone(outcome.result) };
      if (!internal) draft.command_results[command.id] = { fingerprint: hash, response };
      appendEvents(draft, outcome.events);
      publish(draft, current.bytes);
      return clone(response);
    } finally { mutating = false; }
  }
  return Object.freeze({
    read: () => readState(manifestPath),
    initialize(accepted) {
      const current = readRecord(manifestPath);
      owned(current.state?.schema_version === 2 ? current.state.workspace : accepted.workspace);
      if (current.state?.schema_version === 2) return clone(current.state);
      if (current.state) validateLegacyCompleted(current.state);
      const state = newRun(accepted, 1, [], current.state ? [current.state] : []);
      return publish(state, current.bytes);
    },
    transact: (options) => transact(options),
    transactInternal: (options) => transact(options, true),
    rerun({ expectedRevision, accepted }) {
      const current = readRecord(manifestPath);
      requireShape(current.state?.schema_version === 2, 'explicit rerun requires an existing V2 run');
      owned(current.state.workspace);
      if (expectedRevision !== current.state.revision) throw new Error('state revision conflict');
      if (accepted.workspace.key !== current.state.workspace.key) throw new Error('rerun cannot change workspace identity');
      assertRerunEligible(current.state);
      if (readCheckoutReservation(owner)) throw new Error('rerun requires private reservation cleanup under the old run owner');
      const { history, ...prior } = current.state;
      const next = newRun(accepted, current.state.revision + 1, [...history, prior], current.state.legacy_history);
      return publish(next, current.bytes);
    },
  });
}

module.exports = {
  STATE_SCHEMA_VERSION, MAX_STATE_BYTES, canonicalJson, fingerprint,
  validateAccepted, validateState, readState, createStateStore,
  assertRerunEligible,
};
