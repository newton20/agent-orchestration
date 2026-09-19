'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const yaml = require('js-yaml');
const { readState, validateState, assertRerunEligible } = require('./state-store');
const { statusPathFor, prepareV2Manifest } = require('./parse-manifest');
const { artifactPaths, readAttemptArtifact, QA_VERIFICATION } = require('./attempt-lifecycle');
const { createSnapshot, SNAPSHOT_SCHEMA_VERSION } = require('./read-model');
const { runtimeFixture } = require('./test-support/runtime-fixture');

const TIME = '2026-09-17T12:00:00.000Z';
const NOW = '2026-09-18T12:00:00.000Z';
const HOST = { hostname: 'snapshot-fixture', host_boot_id: 'snapshot-boot' };
const identity = (attempt) => Object.fromEntries(
  ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'].map((key) => [key, attempt[key]]));
const phaseOf = (snapshot, id = 'p1') => snapshot.phases.find((phase) => phase.phase_id === id);
const roleOf = (snapshot, role = 'impl') => phaseOf(snapshot).roles.find((entry) => entry.role === role);

function diskFixture(t) {
  const fx = runtimeFixture(t);
  const { manifestPath } = fx;
  fx.snapshot = (options = {}) => createSnapshot({ manifestPath, now: NOW, ...options });
  fx.writeState = (state) => {
    if (state.schema_version === 2) validateState(state);
    fs.writeFileSync(statusPathFor(manifestPath), JSON.stringify(state));
  };
  return fx;
}

function canonicalRun(accepted, revision = 1, history = [], legacyHistory = []) {
  const runId = randomUUID();
  return {
    schema_version: 2, revision, run_id: runId, workspace: accepted.workspace, accepted,
    operator: { paused: false }, runtime_status: 'live_dispatch_disabled', live_dispatch_enabled: false,
    created_at: TIME, updated_at: TIME, command_results: {}, next_event_sequence: 2,
    outbox: [{ sequence: 1, event_id: `${runId}:1`, run_id: runId, revision, type: 'run_created', payload: { accepted_revision: 1 } }],
    history, legacy_history: legacyHistory,
    phases: Object.fromEntries(accepted.phases.map((phase) => {
      const roles = new Set(phase.agents.map((agent) => agent.role));
      if (phase.review_loop.enabled) { roles.add('impl'); roles.add('qa'); }
      return [phase.id, {
        status: 'pending', review_iteration: 0, review_stage: 'impl',
        roles: Object.fromEntries([...roles].map((role) => [role, { current_attempt_id: null, attempts: [] }])),
      }];
    })),
  };
}

function fixture(t, { review = false, phases, legacyHistory = [] } = {}) {
  const fx = diskFixture(t);
  if (phases) fx.manifest.phases = phases;
  if (review) fx.manifest.phases[0].review_loop = { enabled: true, max_iterations: 2 };
  fs.writeFileSync(fx.manifestPath, yaml.dump(fx.manifest));
  const accepted = { ...prepareV2Manifest(fx.manifest, fx.manifestPath), revision: 1 };
  fx.writeState(canonicalRun(accepted, 1, [], legacyHistory));
  fx.read = () => readState(fx.manifestPath);
  fx.mutate = (mutate) => {
    const state = fx.read();
    mutate(state);
    state.revision++;
    fx.writeState(state);
  };
  fx.current = (role = 'impl') => {
    const entry = fx.read().phases.p1.roles[role];
    return entry.attempts.find((attempt) => attempt.attempt_id === entry.current_attempt_id);
  };
  fx.addAttempt = (role = 'impl', { observed = true, category = 'initial' } = {}) => {
    fx.mutate((state) => {
      const phase = state.phases.p1;
      const entry = phase.roles[role];
      const agent = accepted.phases[0].agents.find((item) => item.role === role) || {
        engine: accepted.manifest.defaults.engine, access: 'mutating', workdir: accepted.workdir, workspace: accepted.workspace,
      };
      const attemptIdentity = { run_id: state.run_id, phase_id: 'p1', role, review_iteration: phase.review_iteration, attempt_id: randomUUID() };
      const artifacts = artifactPaths(state.workspace, attemptIdentity);
      const prompt = 'snapshot-fixture-raw-prompt';
      const attempt = {
        lifecycle_version: 1, ...attemptIdentity, ...agent, artifacts, status: observed ? 'running' : 'needs_operator',
        intended_review_stage: role, retry_category: category, previous_attempt_id: entry.current_attempt_id,
        created_at: TIME, started_at: TIME, launch_host: HOST,
        intent: {
          launch_token: randomUUID(), session_name: 'fixture-session-name', timeout_minutes: accepted.phases[0].timeout_minutes,
          required_verification: role === 'qa' ? [...QA_VERIFICATION] : [],
          prompt_options: { phaseDir: artifacts.directory, phaseId: 'p1', completionSignalPath: artifacts.completion,
            heartbeatPath: artifacts.heartbeat, attemptIdentity },
          prompt_text: prompt, prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
        },
        reservation: { state: 'held' }, observations: {}, evidence: {}, evidence_history: [], diagnostics: {},
        descendants: [], descendant_tracking_complete: false, health: { unknown_samples: 0 },
      };
      if (observed) {
        attempt.engine_process = { ...HOST, pid: 845001, creation_time: TIME };
        attempt.session_id = 'fixture-session';
        attempt.submission = { acknowledged: true, observation_id: 'submission', at: TIME };
        attempt.observations = Object.fromEntries(['session', 'submission'].map((kind) =>
          [kind, { kind, at: TIME, sha256: 'a'.repeat(64) }]));
        attempt.health = { unknown_samples: 0, sample_id: 'sample-1', observed_at: TIME, engine: { state: 'live' } };
      }
      entry.attempts.push(attempt);
      entry.current_attempt_id = attempt.attempt_id;
      entry.budgets = { launch: entry.attempts.filter((item) => item.retry_category === 'launch').length,
        execution: entry.attempts.filter((item) => item.retry_category === 'execution').length };
      phase.status = attempt.status;
    });
    return fx.current(role);
  };
  fx.artifact = (attempt, kind, data = {}) => {
    fs.mkdirSync(attempt.artifacts.directory, { recursive: true });
    fs.writeFileSync(attempt.artifacts[kind], JSON.stringify({
      schema_version: 2, ...identity(attempt), kind, observed_at: TIME, ...data,
    }));
  };
  fx.complete = (attempt, verdict = 'pass') => {
    fx.artifact(attempt, 'completion', { status: 'complete' });
    fx.artifact(attempt, 'release', { released: true, no_further_writes: true });
    if (attempt.role === 'qa') fx.artifact(attempt, 'verdict', {
      verdict, verification: attempt.intent.required_verification.map((id) => ({ id, status: verdict, evidence: 'fixture evidence' })),
    });
  };
  fx.acceptReports = (target) => {
    fx.mutate((state) => {
      const attempt = state.phases.p1.roles[target.role].attempts.find((item) => item.attempt_id === target.attempt_id);
      for (const kind of ['completion', 'verdict', 'release', 'heartbeat']) {
        const artifact = readAttemptArtifact(state, attempt, kind);
        if (!artifact || artifact.rejected) continue;
        attempt.evidence[kind] = artifact.provenance;
        attempt.evidence_history.push(artifact.provenance);
        if (kind === 'completion') attempt.reported_status = artifact.data.status;
        if (kind === 'verdict') attempt.qa_verdict = artifact.data.verdict;
      }
      if (attempt.reported_status === 'complete') {
        attempt.status = 'completed';
        attempt.outcome = { type: attempt.qa_verdict === 'fail' ? 'qa_failed' : 'completed', at: TIME, assurance: 'worker_reported' };
        state.phases.p1.status = 'completed';
      }
      if (attempt.evidence.release) {
        attempt.reservation = { state: 'released', closure: { type: 'cooperative_release', at: TIME, sample_id: 'sample-1' } };
        attempt.reservation_cleared = true;
      }
    });
  };
  fx.rerun = () => {
    const state = fx.read();
    assertRerunEligible(state);
    const { history, ...prior } = state;
    const next = canonicalRun(accepted, state.revision + 1, [...history, prior], state.legacy_history);
    fx.writeState(next);
    return next;
  };
  return fx;
}

function inventory(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(root, entry.name);
    return entry.isDirectory() ? inventory(filename) : [[filename, fs.readFileSync(filename).toString('base64')]];
  });
}

test('U4 no-run snapshot is explicit, versioned, and does not create runtime files', (t) => {
  const fx = diskFixture(t);
  const before = inventory(fx.root);
  const snapshot = fx.snapshot();
  assert.equal(SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.status, 'no_run');
  assert.equal(snapshot.run_id, null);
  assert.equal(snapshot.revision, null);
  assert.equal(snapshot.event_cursor, null);
  assert.equal(snapshot.live_dispatch_enabled, false);
  assert.equal(snapshot.read_only, true);
  assert.deepEqual(snapshot.phases, []);
  assert.deepEqual(snapshot.controller, { status: 'unknown', observed_at: null, run_id: null });
  assert.equal(snapshot.reader_observed_at, NOW);
  assert.deepEqual(inventory(fx.root), before);
  assert.throws(() => fx.snapshot({ runId: 'absent' }), /unknown run/i);
});

test('U4 validates selection and reader/controller observations without a silent default', async (t) => {
  const fx = await fixture(t);
  assert.throws(() => createSnapshot({ manifestPath: '' }), /manifestPath/);
  assert.throws(() => fx.snapshot({ now: 'not-a-date' }), /now/);
  assert.throws(() => fx.snapshot({ runId: '../other' }), /runId/);
  assert.throws(() => fx.snapshot({ runId: 'absent' }), /unknown run/i);
  assert.throws(() => fx.snapshot({ controller: { status: 'running' } }), /controller/);
  assert.throws(() => fx.snapshot({ controller: {
    status: 'running', observed_at: 'bad', run_id: fx.read().run_id,
  } }), /controller/);
  assert.throws(() => fx.snapshot({ controller: {
    status: 'running', observed_at: '2027-01-01T00:00:00Z', run_id: fx.read().run_id,
  } }), /controller/);
});

test('U4 initial V2 snapshot uses accepted dependencies, revision, and committed cursor', async (t) => {
  const fx = await fixture(t, { phases: [
    { id: 'p1', agent: { role: 'impl' }, completion_signal: 'done.md' },
    { id: 'p2', depends_on: ['p1'], agent: { role: 'qa' }, completion_signal: 'checked.md' },
  ] });
  const state = fx.read();
  fs.writeFileSync(fx.manifestPath, 'invalid authoring: [');
  const snapshot = fx.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.source_schema_version, 2);
  assert.equal(snapshot.run_id, state.run_id);
  assert.equal(snapshot.current_run_id, state.run_id);
  assert.equal(snapshot.revision, state.revision);
  assert.equal(snapshot.accepted_revision, state.accepted.revision);
  assert.equal(snapshot.event_cursor, `${state.run_id}:${state.next_event_sequence - 1}`);
  assert.deepEqual(phaseOf(snapshot, 'p2').depends_on, ['p1']);
  assert.equal(roleOf(snapshot).current_attempt, null);
  assert.deepEqual(roleOf(snapshot).historical_attempts, []);
  assert.equal(snapshot.controller.status, 'unknown');
});

test('U4 legacy incomplete and completed records remain readable but uncorrelated', (t) => {
  const fx = diskFixture(t);
  for (const schema of [undefined, 1]) {
    fx.writeState({
      ...(schema ? { schema_version: schema } : {}),
      updated_at: TIME, pid: 845001, raw_prompt: 'legacy-secret',
      phases: {
        p1: { status: 'running', session_id: 'untrusted', pid: 845001, completion: { verified: true } },
        p2: { status: 'completed', completion_signal: 'legacy-secret', attempts: [{ status: 'completed' }] },
        incomplete: null,
      },
    });
    const snapshot = fx.snapshot();
    assert.equal(snapshot.status, 'legacy');
    assert.equal(snapshot.source_schema_version, 1);
    assert.equal(snapshot.run_id, null);
    assert.equal(snapshot.accepted_revision, null);
    assert.equal(snapshot.event_cursor, null);
    assert.equal(snapshot.read_only, true);
    assert.equal(snapshot.controller.status, 'unknown');
    assert.equal(phaseOf(snapshot).recorded_status, 'running');
    assert.equal(phaseOf(snapshot).status, 'uncorrelated');
    assert.equal(phaseOf(snapshot, 'p2').recorded_status, 'completed');
    assert.deepEqual(phaseOf(snapshot).roles, []);
    assert.equal(phaseOf(snapshot).independent_verification.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(snapshot), /legacy-secret|845001|untrusted/);
    assert.throws(() => fx.snapshot({ runId: 'legacy' }), /unknown run/i);
  }
});

test('U4 missing session, submission and engine observations stay unknown after dispatch', async (t) => {
  const fx = await fixture(t);
  fx.addAttempt('impl', { observed: false });
  const attempt = roleOf(fx.snapshot()).current_attempt;
  assert.equal(attempt.status, 'needs_operator');
  assert.equal(attempt.session.status, 'unknown');
  assert.equal(attempt.submission.status, 'unknown');
  assert.equal(attempt.engine_observation.status, 'unknown');
  assert.equal(attempt.completion.status, 'unknown');
  assert.equal(attempt.independent_verification.status, 'unknown');
});

test('U4 only controller-accepted artifacts produce reported completion, never verification', async (t) => {
  const fx = await fixture(t);
  const attempt = fx.addAttempt();
  fx.complete(attempt);
  assert.equal(roleOf(fx.snapshot()).current_attempt.completion.status, 'unknown', 'reader must not accept fresh worker files');
  fx.acceptReports(attempt);
  const snapshot = fx.snapshot();
  const current = roleOf(snapshot).current_attempt;
  assert.equal(current.session.status, 'observed');
  assert.equal(current.submission.status, 'acknowledged');
  assert.equal(current.engine_observation.status, 'live');
  assert.equal(current.completion.status, 'reported_complete');
  assert.equal(current.completion.provenance.attempt_id, attempt.attempt_id);
  assert.equal(current.completion.provenance.source, 'worker_report');
  assert.equal(current.independent_verification.status, 'unknown');
  assert.deepEqual(current.independent_verification.evidence, []);
  assert.ok(current.artifacts.some((artifact) => artifact.kind === 'completion' && artifact.provenance));
  assert.ok(current.evidence_history.some((evidence) => evidence.kind === 'completion'));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(current), true);
});

test('U4 AE3 replacement progress does not inherit old attempt evidence', async (t) => {
  const fx = await fixture(t);
  const old = fx.addAttempt();
  fx.artifact(old, 'heartbeat');
  fx.acceptReports(old);
  fx.mutate((state) => {
    const attempt = state.phases.p1.roles.impl.attempts[0];
    attempt.status = 'failed';
    attempt.outcome = { type: 'failed', category: 'execution', at: TIME };
  });
  const replacement = fx.addAttempt('impl', { category: 'execution' });
  assert.notEqual(replacement.attempt_id, old.attempt_id);
  fx.complete(old);
  const role = roleOf(fx.snapshot());
  assert.equal(role.current_attempt.attempt_id, replacement.attempt_id);
  assert.equal(role.current_attempt.completion.status, 'unknown');
  assert.equal(role.current_attempt.artifacts.find((artifact) => artifact.kind === 'heartbeat').provenance, null);
  assert.equal(role.historical_attempts[0].attempt_id, old.attempt_id);
  assert.ok(role.historical_attempts[0].artifacts.find((artifact) => artifact.kind === 'heartbeat').provenance);
  assert.equal(role.historical_attempts[0].eligible_for_current_progress, false);
});

test('U4 review iteration separates prior QA evidence from current progress', async (t) => {
  const fx = await fixture(t, { review: true });
  const impl = fx.addAttempt();
  fx.complete(impl);
  fx.acceptReports(impl);
  const qaAttempt = fx.addAttempt('qa');
  fx.complete(qaAttempt, 'fail');
  fx.acceptReports(qaAttempt);
  fx.mutate((state) => {
    const phase = state.phases.p1;
    const qa = phase.roles.qa.attempts[0];
    phase.review_history = [{ ...identity(qa), verdict: 'fail', evidence: qa.evidence.verdict }];
    phase.review_iteration = 1;
    phase.review_stage = 'impl';
  });
  fx.addAttempt('impl', { category: 'review' });
  const snapshot = fx.snapshot();
  const phase = phaseOf(snapshot);
  const qa = roleOf(snapshot, 'qa');
  assert.equal(phase.review.iteration, 1);
  assert.equal(phase.review.history.length, 1);
  assert.equal(phase.review.history[0].verdict, 'fail');
  assert.equal(phase.review.history[0].evidence.source, 'worker_report');
  assert.equal(qa.current_attempt, null);
  assert.equal(qa.current_attempt_id, null);
  assert.equal(qa.historical_attempts.length, 1);
  assert.equal(qa.historical_attempts[0].qa_verdict.status, 'fail');
  assert.equal(qa.historical_attempts[0].independent_verification.status, 'unknown');
  assert.equal(roleOf(snapshot).current_attempt.completion.status, 'unknown');
});

test('U4 completed QA is still a worker report rather than independent success', async (t) => {
  const fx = await fixture(t, { phases: [{ id: 'p1', agent: { role: 'qa' }, completion_signal: 'done.md' }] });
  const qa = fx.addAttempt('qa');
  fx.complete(qa);
  fx.acceptReports(qa);
  const attempt = roleOf(fx.snapshot(), 'qa').current_attempt;
  assert.equal(attempt.qa_verdict.status, 'pass');
  assert.equal(attempt.completion.status, 'reported_complete');
  assert.equal(attempt.independent_verification.status, 'unknown');
});

test('U4 malformed and foreign provenance cannot endorse a recorded completed status', async (t) => {
  const fx = await fixture(t);
  const attempt = fx.addAttempt();
  fx.complete(attempt);
  fx.acceptReports(attempt);
  const baseline = fx.read();
  const provenance = baseline.phases.p1.roles.impl.attempts[0].evidence.completion;
  for (const changes of [
    { attempt_id: 'superseded' }, { run_id: 'another-run' }, { role: 'qa' },
    { review_iteration: 99 }, { kind: 'verdict' }, { sha256: 'bad' },
    { source: 'independent_verifier' }, { observed_at: null }, { path: path.join(fx.root, 'outside.json') },
  ]) {
    const state = structuredClone(baseline);
    const attempt = state.phases.p1.roles.impl.attempts[0];
    attempt.evidence.completion = { ...provenance, ...changes };
    attempt.evidence_history = [attempt.evidence.completion];
    attempt.independent_verification = { status: 'passed', role: 'operator' };
    fx.writeState(state);
    const projected = roleOf(fx.snapshot()).current_attempt;
    assert.equal(projected.completion.status, 'unknown');
    assert.equal(projected.completion.provenance, null);
    assert.equal(projected.independent_verification.status, 'unknown');
    assert.deepEqual(projected.evidence_history, []);
    assert.deepEqual(projected.evidence_history_limits, { total: 1, shown: 0, truncated: false, rejected: 1 });
    assert.ok(projected.diagnostics.some((diagnostic) => diagnostic.code === 'invalid_provenance'));
  }
});

test('U4 prior V2 runs preserve attempt evidence and cannot validate the new run', async (t) => {
  const fx = await fixture(t);
  const attempt = fx.addAttempt();
  fx.complete(attempt);
  fx.acceptReports(attempt);
  const before = fx.snapshot();
  const prior = fx.read();
  const next = fx.rerun();
  const current = fx.snapshot();
  const historical = fx.snapshot({ runId: prior.run_id,
    controller: { status: 'running', run_id: next.run_id, observed_at: TIME } });
  assert.equal(current.prior_runs[0].run_id, prior.run_id);
  assert.equal(roleOf(current).current_attempt, null);
  assert.equal(historical.run_id, prior.run_id);
  assert.equal(historical.current_run_id, next.run_id);
  assert.equal(historical.is_current_run, false);
  assert.equal(historical.controller.status, 'unknown');
  assert.equal(historical.revision, prior.revision);
  assert.equal(historical.event_cursor, before.event_cursor);
  assert.deepEqual(historical.phases, before.phases);
});

test('U4 carried V1 history exposes only read-only uncorrelated summaries', async (t) => {
  const fx = await fixture(t, { legacyHistory: [{ phases: { old: { status: 'completed', prompt: 'legacy-secret' } } }] });
  const snapshot = fx.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.legacy_history.length, 1);
  assert.equal(snapshot.legacy_history[0].read_only, true);
  assert.equal(snapshot.legacy_history[0].correlation, 'unavailable');
  assert.doesNotMatch(JSON.stringify(snapshot), /legacy-secret/);
});

test('U4 controller observation time, persisted update time and reader time remain distinct', async (t) => {
  const fx = await fixture(t);
  const state = fx.read();
  const observedAt = '2026-09-17T15:00:00.000Z';
  const snapshot = fx.snapshot({ controller: {
    status: 'stopped', run_id: state.run_id, observed_at: observedAt, pid: 845001, capability: 'never-expose',
  } });
  assert.equal(snapshot.updated_at, state.updated_at);
  assert.equal(snapshot.reader_observed_at, NOW);
  assert.deepEqual(snapshot.controller, { status: 'stopped', run_id: state.run_id, observed_at: observedAt });
  assert.equal(fx.snapshot({ controller: {
    status: 'running', run_id: state.run_id, observed_at: observedAt,
  } }).controller.status, 'running');
  assert.equal(fx.snapshot({ now: '2030-01-01T00:00:00.000Z' }).controller.status, 'unknown');
  assert.equal(fx.snapshot({ now: '2030-01-01T00:00:00.000Z' }).updated_at, state.updated_at);
});

test('U4 event-log gaps and degraded history are surfaced without fabricating events', async (t) => {
  const fx = await fixture(t);
  const state = fx.read();
  state.outbox = [];
  fx.writeState(state);
  const log = path.join(state.workspace.root, 'docs', 'orchestration', 'runs', state.run_id, 'logs', 'events.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.rmSync(log, { force: true });
  const before = inventory(fx.root);
  const missing = fx.snapshot();
  assert.equal(missing.history.status, 'gap');
  assert.ok(missing.history.gaps.length);
  assert.equal(missing.event_cursor, `${state.run_id}:${state.next_event_sequence - 1}`);
  assert.deepEqual(inventory(fx.root), before);
  fs.writeFileSync(log, '{"transcript":"secret-malformed-log",invalid}\n');
  const degraded = fx.snapshot();
  assert.equal(degraded.history.status, 'degraded');
  assert.ok(degraded.history.diagnostic);
  assert.doesNotMatch(JSON.stringify(degraded), /secret-malformed-log/);
});

test('U4 projection matches committed disk history without exposing event payloads', async (t) => {
  const fx = await fixture(t);
  const state = fx.read();
  const events = state.outbox.map((event) => ({ ...event, payload: { raw_prompt: 'event-secret' } }));
  const log = path.join(state.workspace.root, 'docs', 'orchestration', 'runs', state.run_id, 'logs', 'events.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  state.outbox = [];
  fx.writeState(state);
  const before = inventory(fx.root);
  const snapshot = fx.snapshot();
  assert.equal(snapshot.history.status, 'complete');
  assert.equal(snapshot.event_cursor, events.at(-1).event_id);
  assert.doesNotMatch(JSON.stringify(snapshot), /event-secret|raw_prompt/);
  assert.deepEqual(inventory(fx.root), before);
});

test('U4 allowlists suppress prompts, diagnostics contents, credentials, capabilities and PIDs', async (t) => {
  const fx = await fixture(t);
  const current = fx.addAttempt();
  fx.complete(current);
  fx.acceptReports(current);
  const state = fx.read();
  const secret = 'snapshot-secret-marker';
  const attempt = state.phases.p1.roles.impl.attempts[0];
  attempt.prompt = secret;
  attempt.transcript = secret;
  attempt.credentials = { api_key: secret };
  attempt.capabilities = { controller: secret };
  attempt.diagnostics = { completion: secret, arbitrary: secret };
  attempt.evidence.completion.transcript = secret;
  attempt.evidence.completion.capability = secret;
  attempt.session_id = secret;
  attempt.reason = secret;
  state.phases.p1.blocker = { category: 'dependency', reason: secret, credential: secret };
  state.operator.credentials = secret;
  state.process_diagnostic = { error: secret };
  fx.writeState(state);
  const before = inventory(fx.root);
  const snapshot = fx.snapshot();
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /snapshot-secret-marker|snapshot-fixture-raw-prompt|fixture-session-name|845001|"pid"|"credentials"|"capabilities"|"prompt"|"transcript"|"intent"/);
  assert.ok(phaseOf(snapshot).blockers.length);
  assert.equal(roleOf(snapshot).current_attempt.completion.status, 'reported_complete');
  assert.deepEqual(inventory(fx.root), before);
  assert.deepEqual(readState(fx.manifestPath), state);
});

test('U4 bounded legacy collections announce truncation rather than silently inventing completeness', (t) => {
  const fx = diskFixture(t);
  fx.writeState({ phases: Object.fromEntries(Array.from({ length: 300 }, (_, i) =>
    [`p${i}`, { status: 'completed', prompt: 'x'.repeat(4096) }])) });
  const snapshot = fx.snapshot();
  assert.equal(snapshot.phases.length, 256);
  assert.deepEqual(snapshot.limits.phases, { total: 300, shown: 256, truncated: true });
  assert.ok(JSON.stringify(snapshot).length < 200000);
});

test('U4 corrupt canonical state fails closed instead of returning no-run or stale progress', (t) => {
  const fx = diskFixture(t);
  fs.writeFileSync(statusPathFor(fx.manifestPath), 'phases: [');
  assert.throws(() => fx.snapshot(), /corrupt canonical state/);
});

test('U4 observation metadata must bind submission and process health to the attempt', (t) => {
  const fx = fixture(t);
  fx.addAttempt();
  fx.mutate((state) => {
    const attempt = state.phases.p1.roles.impl.attempts[0];
    delete attempt.submission.observation_id;
    delete attempt.observations.session;
  });
  const attempt = roleOf(fx.snapshot()).current_attempt;
  assert.equal(attempt.submission.status, 'unknown');
  assert.equal(attempt.session.status, 'unknown');
  assert.equal(attempt.engine_observation.status, 'unknown');
});

test('U4 terminal and review evidence must match the accepted immutable evidence history', (t) => {
  const fx = fixture(t, { review: true });
  const qa = fx.addAttempt('qa');
  fx.complete(qa);
  fx.acceptReports(qa);
  fx.mutate((state) => {
    const phase = state.phases.p1;
    const attempt = phase.roles.qa.attempts[0];
    phase.review_history = [{ ...identity(attempt), verdict: 'pass',
      evidence: { ...attempt.evidence.verdict, sha256: 'b'.repeat(64) } }];
    attempt.evidence.completion = { ...attempt.evidence.completion, sha256: 'c'.repeat(64) };
  });
  const snapshot = fx.snapshot();
  assert.equal(roleOf(snapshot, 'qa').current_attempt.completion.status, 'unknown');
  assert.equal(phaseOf(snapshot).review.history[0].verdict, 'unknown');
  assert.equal(phaseOf(snapshot).review.history[0].evidence, null);
});

test('U4 incomplete older V2 attempts remain read-only without correlated lifecycle evidence', (t) => {
  const fx = fixture(t);
  const attempt = fx.addAttempt();
  fx.complete(attempt);
  fx.acceptReports(attempt);
  fx.mutate((state) => { delete state.phases.p1.roles.impl.attempts[0].lifecycle_version; });
  const snapshot = fx.snapshot();
  const projected = roleOf(snapshot).current_attempt;
  assert.equal(snapshot.read_only, true);
  assert.equal(projected.lifecycle_supported, false);
  assert.equal(projected.status, 'unknown');
  assert.equal(projected.completion.status, 'unknown');
  assert.equal(projected.session.status, 'unknown');
  assert.equal(projected.submission.status, 'unknown');
  assert.equal(projected.engine_observation.status, 'unknown');
  assert.equal(projected.independent_verification.status, 'unknown');
});

test('U4 invalid review history is bounded and cannot supply a verdict', (t) => {
  const fx = fixture(t, { review: true });
  fx.mutate((state) => {
    state.phases.p1.review_history = Array.from({ length: 80 }, () => ({ verdict: 'pass', evidence: { source: 'operator' } }));
  });
  const review = phaseOf(fx.snapshot()).review;
  assert.equal(review.history.length, 64);
  assert.deepEqual(review.history_limits, { total: 80, shown: 64, truncated: true });
  assert.ok(review.history.every((entry) => entry.verdict === 'unknown' && entry.evidence === null));
});

test('U4 event-log path redirection fails closed and is never downgraded to a history gap', (t) => {
  const fx = fixture(t);
  const state = fx.read();
  const runDirectory = path.join(state.workspace.root, 'docs', 'orchestration', 'runs', state.run_id);
  const outside = path.join(fx.root, 'redirected-logs');
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'events.jsonl'), '');
  fs.symlinkSync(outside, path.join(runDirectory, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => fx.snapshot(), /redirected|artifact.*path/i);
});

test('U4 a validated run without committed events has a null event cursor', (t) => {
  const fx = fixture(t);
  const state = fx.read();
  state.outbox = [];
  state.next_event_sequence = 1;
  fx.writeState(state);
  const snapshot = fx.snapshot();
  assert.equal(snapshot.event_cursor, null);
  assert.equal(snapshot.history.status, 'complete');
  assert.deepEqual(snapshot.history.gaps, []);
});
