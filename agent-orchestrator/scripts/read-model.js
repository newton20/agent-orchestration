'use strict';

const path = require('node:path');
const { readState } = require('./state-store');
const { readEvents } = require('./event-log');

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_PHASES = 256;
const MAX_HISTORY = 64;
const ARTIFACT_KINDS = ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release'];
const ID_FIELDS = ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'];
const STATUSES = ['pending', 'queued', 'launching', 'running', 'needs_operator', 'blocked', 'completed', 'failed', 'cancelled'];
const CONTROLLER_STATUSES = ['unknown', 'running', 'stopped', 'stale', 'unavailable'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const text = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : null;
const timestamp = (value) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
const id = (value) => typeof value === 'string' && value.length <= 256 &&
  /^(?!\.+$)[A-Za-z0-9._-]+$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : null;
const choice = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const count = (total, shown) => ({ total, shown, truncated: total > shown });
const verification = () => ({ status: 'unknown', evidence: [] });
const identity = (attempt) => Object.fromEntries(ID_FIELDS.map((key) => [key, attempt[key]]));
const sameIdentity = (left, right) => isObject(left) && ID_FIELDS.every((key) => left[key] === right[key]);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function controllerObservation(controller, now) {
  if (controller === null) return null;
  if (!isObject(controller) || !CONTROLLER_STATUSES.includes(controller.status) ||
      !id(controller.run_id) || !timestamp(controller.observed_at) ||
      Date.parse(controller.observed_at) > Date.parse(now)) {
    throw new Error('invalid controller observation: status, run_id and non-future observed_at are required');
  }
  return { status: controller.status, observed_at: controller.observed_at, run_id: controller.run_id };
}

function controllerFor(observation, runId) {
  return observation && observation.run_id === runId
    ? { ...observation }
    : { status: 'unknown', observed_at: null, run_id: runId };
}

function artifactPath(run, attempt, kind) {
  return path.join(run.workspace.root, 'docs', 'orchestration', 'runs', run.run_id,
    'phases', attempt.phase_id, attempt.role, String(attempt.review_iteration), attempt.attempt_id, `${kind}.json`);
}

function provenance(run, attempt, kind, evidence) {
  if (attempt.lifecycle_version !== 1 || !ARTIFACT_KINDS.includes(kind) ||
      !sameIdentity(evidence, attempt) || evidence.kind !== kind || evidence.source !== 'worker_report' ||
      typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
      !timestamp(evidence.observed_at)) return null;
  const expected = artifactPath(run, attempt, kind);
  if (evidence.path !== expected || attempt.artifacts?.[kind] !== expected) return null;
  return {
    ...identity(attempt), kind, source: 'worker_report', path: expected,
    sha256: evidence.sha256, observed_at: evidence.observed_at,
  };
}

function sameProvenance(left, right) {
  return sameIdentity(left, right) && ['kind', 'source', 'path', 'sha256', 'observed_at']
    .every((key) => left[key] === right[key]);
}

function acceptedProvenance(run, attempt, kind) {
  const accepted = provenance(run, attempt, kind, attempt.evidence?.[kind]);
  if (!accepted || ['heartbeat', 'checkpoint'].includes(kind)) return accepted;
  return list(attempt.evidence_history).some((row) => sameProvenance(row, accepted)) ? accepted : null;
}

function metadataObservation(attempt, kind, observationId = null) {
  if (attempt.lifecycle_version !== 1 || !isObject(attempt.observations)) return null;
  const entries = observationId === null ? Object.entries(attempt.observations)
    : [[observationId, attempt.observations[observationId]]];
  const found = entries.find(([key, row]) => id(key) && isObject(row) && row.kind === kind &&
    typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256) && timestamp(row.at));
  return found ? { observed_at: found[1].at } : null;
}

function observations(attempt) {
  const session = metadataObservation(attempt, 'session');
  const submissionId = id(attempt.submission?.observation_id);
  const submission = submissionId ? metadataObservation(attempt, 'submission', submissionId) : null;
  const process = attempt.engine_process;
  const processKnown = isObject(process) && Number.isSafeInteger(process.pid) && process.pid > 0 &&
    typeof process.hostname === 'string' && (process.creation_time === null || timestamp(process.creation_time)) &&
    (process.host_boot_id === null || typeof process.host_boot_id === 'string');
  const sessionKnown = session && processKnown && typeof attempt.session_id === 'string' && attempt.session_id.length > 0;
  const submitted = submission && attempt.submission?.acknowledged === true &&
    attempt.submission.at === submission.observed_at;
  const health = attempt.health;
  const healthKnown = sessionKnown && id(health?.sample_id) &&
    timestamp(health?.observed_at);
  return {
    session: { status: sessionKnown ? 'observed' : 'unknown', observed_at: sessionKnown ? session.observed_at : null },
    submission: { status: submitted ? 'acknowledged' : 'unknown', observed_at: submitted ? submission.observed_at : null },
    engine_observation: {
      status: healthKnown ? choice(health.engine?.state, ['live', 'dead', 'unknown']) : 'unknown',
      observed_at: healthKnown ? health.observed_at : null, sample_id: healthKnown ? health.sample_id : null,
    },
  };
}

function attemptSnapshot(run, attempt, current) {
  const supported = attempt.lifecycle_version === 1;
  const diagnostics = [];
  const artifacts = ARTIFACT_KINDS.map((kind) => {
    const accepted = acceptedProvenance(run, attempt, kind);
    if (attempt.evidence?.[kind] && !accepted) diagnostics.push({ kind, code: 'invalid_provenance' });
    if (Object.hasOwn(attempt.diagnostics || {}, kind)) diagnostics.push({ kind, code: 'report_rejected' });
    const expected = artifactPath(run, attempt, kind);
    return { kind, path: supported && attempt.artifacts?.[kind] === expected ? expected : null, provenance: accepted };
  });
  const evidenceFor = (kind) => artifacts.find((artifact) => artifact.kind === kind).provenance;
  const completion = evidenceFor('completion');
  const reported = supported && completion ? choice(attempt.reported_status, ['complete', 'partial', 'blocked']) : 'unknown';
  const verdict = attempt.role === 'qa' ? evidenceFor('verdict') : null;
  const evidenceHistory = list(attempt.evidence_history);
  const evidence = evidenceHistory.slice(-MAX_HISTORY).flatMap((row) => {
    const accepted = provenance(run, attempt, row?.kind, row);
    return accepted ? [accepted] : [];
  });
  const outcome = supported && isObject(attempt.outcome) ? {
    type: choice(attempt.outcome.type, ['completed', 'qa_failed', 'failed', 'cancelled']),
    category: choice(attempt.outcome.category, ['launch', 'execution'], null),
    at: timestamp(attempt.outcome.at),
    assurance: reported !== 'unknown' ? 'worker_reported' : 'unknown',
  } : null;
  return {
    ...identity(attempt), lifecycle_supported: supported, eligible_for_current_progress: current,
    engine: choice(attempt.engine, ['claude', 'agency-claude', 'agency-copilot']),
    access: choice(attempt.access, ['mutating', 'read-only']),
    status: supported ? choice(attempt.status, STATUSES) : 'unknown',
    created_at: timestamp(attempt.created_at), started_at: timestamp(attempt.started_at),
    retry_category: choice(attempt.retry_category, ['initial', 'launch', 'execution', 'review'], null),
    previous_attempt_id: id(attempt.previous_attempt_id),
    outcome, ...observations(attempt),
    completion: { status: reported === 'unknown' ? 'unknown' : `reported_${reported}`, provenance: completion },
    qa_verdict: { status: verdict ? choice(attempt.qa_verdict, ['pass', 'fail']) : 'unknown', provenance: verdict },
    // The lifecycle accepts worker reports; it has no independent-verifier evidence contract.
    independent_verification: verification(),
    reservation: { state: supported ? choice(attempt.reservation?.state, ['pending', 'held', 'released']) : 'unknown' },
    artifacts, evidence_history: evidence,
    evidence_history_limits: {
      total: evidenceHistory.length, shown: evidence.length, truncated: evidenceHistory.length > MAX_HISTORY,
      rejected: Math.min(evidenceHistory.length, MAX_HISTORY) - evidence.length,
    },
    diagnostics,
  };
}

function roleSnapshot(run, phase, role, entry) {
  const latest = entry.attempts.find((attempt) => attempt.attempt_id === entry.current_attempt_id);
  // A latest role attempt from the previous review iteration is historical, not current proof.
  const current = latest?.review_iteration === phase.review_iteration ? latest : null;
  const historical = entry.attempts.filter((attempt) => attempt !== current);
  return {
    role, latest_attempt_id: entry.current_attempt_id, current_attempt_id: current?.attempt_id || null,
    current_attempt: current ? attemptSnapshot(run, current, true) : null,
    historical_attempts: historical.map((attempt) => attemptSnapshot(run, attempt, false)),
    retry_budgets: {
      launch: Number.isSafeInteger(entry.budgets?.launch) ? entry.budgets.launch : null,
      execution: Number.isSafeInteger(entry.budgets?.execution) ? entry.budgets.execution : null,
    },
  };
}

function reviewHistory(run, phase) {
  return list(phase.review_history).slice(-MAX_HISTORY).map((row) => {
    const attempt = phase.roles.qa?.attempts.find((item) => sameIdentity(row, item));
    const accepted = attempt ? acceptedProvenance(run, attempt, 'verdict') : null;
    const evidence = accepted && sameProvenance(row.evidence, accepted) ? accepted : null;
    return {
      run_id: id(row?.run_id), phase_id: id(row?.phase_id), role: row?.role === 'qa' ? 'qa' : null,
      attempt_id: id(row?.attempt_id),
      review_iteration: Number.isSafeInteger(row?.review_iteration) && row.review_iteration >= 0 ? row.review_iteration : null,
      verdict: evidence && row.verdict === attempt.qa_verdict ? choice(row.verdict, ['pass', 'fail']) : 'unknown',
      evidence, independent_verification: verification(),
    };
  });
}

function phaseSnapshot(run, accepted) {
  const phase = run.phases[accepted.id];
  const roles = Object.entries(phase.roles);
  const blockers = [];
  if (phase.blocker) {
    const category = choice(phase.blocker.category, ['dependency', 'workspace', 'operator', 'verification', 'retry_budget'], 'controller');
    blockers.push({ category, message: category === 'dependency' ? 'Waiting for accepted upstream completion.' : 'Controller intervention is required.' });
  }
  if (phase.status === 'needs_operator') blockers.push({ category: 'operator', message: 'Attempt observation or delivery requires intervention.' });
  if (phase.status === 'failed') blockers.push({ category: 'failure', message: 'The controller recorded a phase failure.' });
  return {
    phase_id: accepted.id, status: choice(phase.status, STATUSES),
    depends_on: accepted.depends_on.slice(0, MAX_PHASES),
    review: {
      enabled: accepted.review_loop.enabled, iteration: phase.review_iteration,
      stage: choice(phase.review_stage, ['impl', 'qa']), history: reviewHistory(run, phase),
      history_limits: count(list(phase.review_history).length, Math.min(list(phase.review_history).length, MAX_HISTORY)),
    },
    roles: roles.slice(0, MAX_HISTORY).map(([role, entry]) => roleSnapshot(run, phase, role, entry)),
    blockers, independent_verification: verification(),
    limits: {
      roles: count(roles.length, Math.min(roles.length, MAX_HISTORY)),
      dependencies: count(accepted.depends_on.length, Math.min(accepted.depends_on.length, MAX_PHASES)),
    },
  };
}

function legacyPhases(record) {
  const entries = isObject(record.phases) ? Object.entries(record.phases) : [];
  return {
    phases: entries.slice(0, MAX_PHASES).map(([phaseId, phase]) => ({
      phase_id: text(phaseId), status: 'uncorrelated', recorded_status: choice(phase?.status, STATUSES),
      depends_on: [], dependencies_known: false, roles: [], independent_verification: verification(),
    })),
    limit: count(entries.length, Math.min(entries.length, MAX_PHASES)),
  };
}

function legacySummary(record) {
  const { phases, limit } = legacyPhases(record);
  return {
    source_schema_version: 1, read_only: true, correlation: 'unavailable',
    updated_at: timestamp(record.updated_at), phases, limits: { phases: limit },
  };
}

function runSummary(run) {
  const totals = { pending: 0, running: 0, completed: 0, failed: 0, other: 0 };
  for (const phase of Object.values(run.phases)) {
    const key = Object.hasOwn(totals, phase.status) ? phase.status : 'other';
    totals[key]++;
  }
  return {
    run_id: run.run_id, revision: run.revision, accepted_revision: run.accepted.revision,
    created_at: timestamp(run.created_at), updated_at: timestamp(run.updated_at),
    read_only: true, phase_counts: totals, independent_verification: verification(),
  };
}

function eventHistory(history) {
  return {
    status: history.status,
    gaps: history.gaps.slice(0, MAX_PHASES).map((gap) => ({ from: gap.from, to: gap.to, reason: text(gap.reason, 128) })),
    diagnostic: history.diagnostic ? { code: text(history.diagnostic.code, 128), message: text(history.diagnostic.message, 256) } : null,
    limits: count(history.gaps.length, Math.min(history.gaps.length, MAX_PHASES)),
  };
}

function projectionSnapshot(projection) {
  return {
    status: projection?.status || 'unknown',
    acknowledged_sequence: projection?.acknowledged_sequence ?? null,
    retained_through: projection?.retained_through ?? null,
    updated_at: timestamp(projection?.updated_at),
    diagnostic: projection?.diagnostic ? {
      code: text(projection.diagnostic.code, 128), message: 'Event projection requires controller attention.',
    } : null,
  };
}

/**
 * Read an immutable, allowlisted snapshot of the selected run; never reconcile or
 * read worker files. Caller-supplied controller observations require run_id,
 * status (unknown/running/stopped/stale/unavailable), and observed_at.
 */
function createSnapshot({ manifestPath, runId = null, controller = null, now = new Date().toISOString() } = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) throw new Error('manifestPath is required');
  if (runId !== null && !id(runId)) throw new Error('invalid runId');
  if (!timestamp(now)) throw new Error('invalid reader observation now');
  const observedController = controllerObservation(controller, now);
  const state = readState(manifestPath);
  const base = {
    schema_version: SNAPSHOT_SCHEMA_VERSION, source_schema_version: state ? state.schema_version || 1 : null,
    read_only: true, live_dispatch_enabled: false, run_id: null, current_run_id: null, is_current_run: false,
    revision: null, accepted_revision: null, event_cursor: null, reader_observed_at: now,
    created_at: null, updated_at: null, controller: controllerFor(null, null),
    phases: [], prior_runs: [], legacy_history: [],
    history: { status: 'unavailable', gaps: [], diagnostic: null },
    projection: projectionSnapshot(null),
    limits: { phases: count(0, 0), prior_runs: count(0, 0), legacy_history: count(0, 0) },
  };
  if (!state || state.schema_version !== 2) {
    if (runId !== null) throw new Error(`unknown run: ${runId}`);
    if (!state) return freeze({ ...base, status: 'no_run' });
    const legacy = legacySummary(state);
    return freeze({ ...base, status: 'legacy', source_schema_version: 1, updated_at: legacy.updated_at,
      phases: legacy.phases, limits: { ...base.limits, phases: legacy.limits.phases } });
  }
  const run = runId === null || runId === state.run_id ? state : state.history.find((prior) => prior.run_id === runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  const events = readEvents({ state: run, limit: 1 });
  const phases = run.accepted.phases.slice(0, MAX_PHASES).map((phase) => phaseSnapshot(run, phase));
  const priorRuns = state.history.slice(-MAX_HISTORY).map(runSummary);
  const legacyHistory = run.legacy_history.slice(-MAX_HISTORY).map(legacySummary);
  return freeze({
    ...base, status: 'ready', source_schema_version: 2, run_id: run.run_id, current_run_id: state.run_id,
    is_current_run: run.run_id === state.run_id, revision: run.revision, accepted_revision: run.accepted.revision,
    created_at: run.created_at, updated_at: run.updated_at, controller: controllerFor(observedController, run.run_id),
    runtime_status: choice(run.runtime_status, ['live_dispatch_disabled', 'process_observation_failed']),
    paused: run.operator.paused, event_cursor: events.latest_cursor, history: eventHistory(events.history),
    projection: projectionSnapshot(run.projection),
    phases, prior_runs: priorRuns, legacy_history: legacyHistory,
    limits: {
      phases: count(run.accepted.phases.length, phases.length),
      prior_runs: count(state.history.length, priorRuns.length),
      legacy_history: count(run.legacy_history.length, legacyHistory.length),
    },
  });
}

module.exports = { SNAPSHOT_SCHEMA_VERSION, createSnapshot };
