'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const O = require('./orchestrate');
const W = require('./workspace-owner');

const HOST = { hostname: 'fixture-host', host_boot_id: 'boot-1' };
const TIME = '2026-09-17T12:00:00.000Z';
const identity = (a) => Object.fromEntries(['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'].map((k) => [k, a[k]]));
const processIdentity = (pid) => ({ ...HOST, pid, creation_time: TIME });

async function fixture(t, { phases, review = false, launch, readOnly = false, fault, stateFs, hostEvidence = HOST } = {}) {
  const fx = runtimeFixture(t);
  fx.manifest.phases = phases || [{
    id: 'p1', agent: { role: 'impl' }, completion_signal: 'ignored-v1.md',
    ...(review ? { review_loop: { enabled: true, max_iterations: 2 } } : {}),
  }];
  fs.writeFileSync(fx.manifestPath, yaml.dump(fx.manifest));
  const calls = [];
  let nextPid = 1000;
  const adapter = {
    kind: 'fixture',
    capabilities: { engines: ['agency-copilot'], read_only_enforced: readOnly, tracks_descendants: true },
    async launch(attempt, { observe }) {
      calls.push(attempt);
      assert.equal(fx.runtime.store.read().phases[attempt.phase_id].roles[attempt.role].current_attempt_id, attempt.attempt_id);
      assert.equal(attempt.status, 'launching');
      if (launch) return launch(attempt, observe, calls);
      const engine = processIdentity(nextPid++);
      await observe({ ...identity(attempt), id: 'launcher', kind: 'launch_process', process: processIdentity(nextPid++) });
      await observe({ ...identity(attempt), id: 'session', kind: 'session', session_id: `s-${engine.pid}`, process: engine });
      await observe({ ...identity(attempt), id: 'descendants', kind: 'descendants', processes: [], complete: true });
      await observe({ ...identity(attempt), id: 'submission', kind: 'submission', acknowledged: true });
    },
  };
  let sampleId = 0;
  let clock = Date.parse(TIME);
  const options = () => ({
    manifestPath: fx.manifestPath, _runtimeRoot: fx.runtimeRoot, _fixtureAdapter: adapter,
    _lifecycleFault: fault, _hostEvidence: hostEvidence, _stateFs: stateFs, logger: () => {},
  });
  fx.open = async () => {
    fx.runtime = await O.startV2Foundation(options());
    assert.ok(fx.runtime.lifecycle, 'startup must expose the active lifecycle');
  };
  fx.close = async () => {
    if (fx.runtime) {
      await fx.runtime.lifecycle?.close();
      await fx.runtime.owner.release();
      fx.runtime = null;
    }
  };
  t.after(() => fx.close());
  fx.reopen = async () => { await fx.close(); await fx.open(); };
  fx.current = (phase = 'p1', role = 'impl') => {
    const entry = fx.runtime.store.read().phases[phase].roles[role];
    return entry.attempts.find((a) => a.attempt_id === entry.current_attempt_id);
  };
  fx.sample = (processes, extra = {}) => {
    clock = Math.max(clock + 1000, Date.parse(extra.observed_at) || 0);
    return {
      ...HOST, sample_id: `sample-${++sampleId}`, complete: true,
      processes: processes || calls.flatMap((a) => {
        const entry = fx.runtime.store.read().phases[a.phase_id].roles[a.role].attempts.find((b) => b.attempt_id === a.attempt_id);
        return entry?.engine_process ? [entry.engine_process, ...(entry.descendants || [])] : [];
      }), ...extra, observed_at: new Date(clock).toISOString(),
    };
  };
  fx.tick = (sample = fx.sample()) => fx.runtime.lifecycle.tick({ sample });
  fx.artifact = (a, kind, data = {}) => {
    fs.mkdirSync(path.dirname(a.artifacts[kind]), { recursive: true });
    fs.writeFileSync(a.artifacts[kind], JSON.stringify({
      schema_version: 2, ...identity(a), kind, observed_at: TIME, ...data,
    }));
  };
  fx.complete = (a, release = true) => {
    fx.artifact(a, 'completion', { status: 'complete' });
    if (a.role === 'qa') fx.artifact(a, 'verdict', {
      verdict: 'pass', verification: a.intent.required_verification.map((id) => ({ id, status: 'pass', evidence: 'fixture output' })),
    });
    if (release) fx.artifact(a, 'release', { released: true, no_further_writes: true });
  };
  fx.pause = (paused) => {
    const state = fx.runtime.store.read();
    fx.runtime.store.transact({
      expectedRevision: state.revision, command: { id: `pause-${state.revision}`, payload: { paused } },
      mutate(draft) { draft.operator.paused = paused; return { result: {}, events: [] }; },
    });
  };
  fx.calls = calls;
  fx.adapter = adapter;
  await fx.open();
  return fx;
}

test('U2.1 interrupted dispatch boundaries persist intent and never replay a possible kickoff after reopening', async (t) => {
  for (const boundary of ['after_intent', 'after_reservation', 'before_launch', 'after_launch_process', 'after_session', 'after_submission']) {
    await t.test(boundary, async (t) => {
      let interrupted = false;
      const fx = await fixture(t, { fault(point) {
        if (point === boundary && !interrupted) { interrupted = true; throw new Error(`interrupt ${point}`); }
      } });
      await assert.rejects(fx.tick(), /interrupt/);
      const before = fx.current();
      assert.ok(before.intent.prompt_options);
      assert.ok(before.intent.launch_token);
      assert.equal(before.intended_review_stage, 'impl');
      assert.ok(before.intent.prompt_text.includes(before.attempt_id));
      await fx.reopen();
      await fx.tick(fx.sample([], { complete: false, error: 'unavailable' }));
      await fx.tick(fx.sample([], { complete: false, error: 'unavailable' }));
      assert.equal(fx.current().attempt_id, before.attempt_id);
      assert.equal(fx.calls.length, ['after_intent', 'after_reservation'].includes(boundary) ? 1 : boundary === 'before_launch' ? 0 : 1);
      assert.equal(fx.current().status, 'needs_operator');
    });
  }
  await t.test('possible kickoff before acknowledgement', async (t) => {
    const fx = await fixture(t, { launch: async () => { throw new Error('crash after possible kickoff'); } });
    await assert.rejects(fx.tick(), /possible kickoff/);
    const id = fx.current().attempt_id;
    await fx.reopen();
    await fx.tick(fx.sample([]));
    await fx.tick(fx.sample([]));
    assert.equal(fx.current().attempt_id, id);
    assert.equal(fx.current().status, 'needs_operator');
    assert.equal(fx.calls.length, 1);
  });
});

test('U2.2 old or sibling artifacts never advance replacement; accepted evidence is idempotent', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const old = fx.current();
  await fx.tick(fx.sample([]));
  const active = fx.current();
  assert.notEqual(active.attempt_id, old.attempt_id);
  for (const kind of ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release']) {
    fx.artifact(active, kind, { ...identity(old), status: 'complete', verdict: 'pass', released: true, no_further_writes: true });
  }
  await fx.tick();
  assert.equal(fx.current().status, 'running');
  assert.equal(fx.current().reservation.state, 'held');
  assert.deepEqual(fx.current().evidence, {});
  fx.complete(active);
  await fx.tick();
  const saved = fx.current();
  await fx.reopen();
  await fx.tick();
  assert.deepEqual(fx.current(), saved);
});

test('U2.3 both sibling orders reconcile every role before recovery and preserve per-role outcomes', async (t) => {
  for (const roles of [['impl', 'qa'], ['qa', 'impl']]) {
    await t.test(roles.join('-'), async (t) => {
      const fx = await fixture(t, { readOnly: true, phases: [{
        id: 'p1', agents: roles.map((role) => ({ role, access: 'read-only' })), completion_signal: 'ignored.md',
      }] });
      await fx.tick();
      const dead = fx.current('p1', roles[0]);
      const live = fx.current('p1', roles[1]);
      await fx.reopen();
      await fx.tick(fx.sample([live.engine_process]));
      assert.equal(fx.current('p1', roles[1]).attempt_id, live.attempt_id);
      assert.notEqual(fx.current('p1', roles[0]).attempt_id, dead.attempt_id);
      assert.equal(fx.calls.length, 3);
      assert.equal(fx.runtime.store.read().phases.p1.status, 'running');
    });
  }
});

test('U2.4 interrupted QA launch keeps completed impl, QA stage and distinct durable budgets', async (t) => {
  let failQa = true;
  const fx = await fixture(t, { review: true, launch: async (a, observe) => {
    if (a.role === 'qa' && failQa) {
      failQa = false;
      await observe({ ...identity(a), id: 'failed', kind: 'launch_failed', no_external_effect: true, reason: 'fixture delivery rejected' });
      return;
    }
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: a.attempt_id, process: processIdentity(1200) });
    await observe({ ...identity(a), id: 'descendants', kind: 'descendants', processes: [], complete: true });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick();
  const impl = fx.current();
  fx.complete(impl);
  await fx.tick();
  const failed = fx.current('p1', 'qa');
  assert.equal(failed.status, 'failed');
  await fx.reopen();
  await fx.tick();
  const qa = fx.current('p1', 'qa');
  assert.notEqual(qa.attempt_id, failed.attempt_id);
  assert.equal(qa.retry_category, 'launch');
  assert.equal(qa.review_iteration, 0);
  assert.equal(fx.current().attempt_id, impl.attempt_id);
  assert.equal(fx.current().status, 'completed');
  assert.equal(fx.runtime.store.read().phases.p1.review_stage, 'qa');
  assert.deepEqual(fx.runtime.store.read().phases.p1.roles.qa.budgets, { launch: 1, execution: 0 });
  fx.complete(qa);
  fx.artifact(qa, 'verdict', { verdict: 'pass', verification: [], role_label: 'operator' });
  await fx.tick();
  assert.notEqual(fx.runtime.store.read().phases.p1.status, 'completed', 'QA cannot omit required verification');
});

test('U2.5 live timeout and unknown observations do not compete; death retries once per sample within budget', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const first = fx.current();
  const unknown = fx.sample([], { complete: false, error: 'access denied', observed_at: '2026-09-18T12:00:00Z' });
  await fx.tick(unknown);
  await fx.tick(unknown);
  assert.equal(fx.current().health.unknown_samples, 1);
  assert.equal(fx.calls.length, 1);
  await fx.tick(fx.sample([first.engine_process], { observed_at: '2026-09-18T12:00:01Z' }));
  assert.equal(fx.current().status, 'needs_operator');
  assert.equal(fx.calls.length, 1);
  for (let i = 0; i < 4; i++) await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 3, 'two execution retries, no reset on subsequent ticks');
  await fx.reopen();
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 3);
  assert.equal(fx.runtime.store.read().phases.p1.status, 'failed');
});

test('U2.6 canonical checkout serialization includes QA; enforced read-only and separate checkouts can run concurrently', async (t) => {
  const other = runtimeFixture(t);
  const fx = await fixture(t, { readOnly: true, phases: [
    { id: 'a', agent: { role: 'impl' }, completion_signal: 'a.md' },
    { id: 'b', agent: { role: 'qa' }, completion_signal: 'b.md' },
    { id: 'c', agent: { role: 'impl', access: 'read-only' }, completion_signal: 'c.md' },
    { id: 'd', agent: { role: 'impl', workdir: other.workdir }, completion_signal: 'd.md' },
  ] });
  await fx.tick();
  assert.deepEqual(fx.calls.map((a) => a.phase_id), ['a', 'c', 'd']);
  const result = await O.runOrchestrator({ manifestPath: other.manifestPath, _runtimeRoot: fx.runtimeRoot, maxTicks: 1, logger: () => {} });
  assert.equal(result.summary, 'lock_contention', 'additional checkout owns the same kernel claim as a primary controller');
  await fx.reopen();
  await fx.tick();
  assert.equal(fx.calls.length, 3);
});

test('U2.7 completion or idle alone retains ownership across controllers, manifests and V1', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  const impl = fx.current();
  fx.complete(impl, false);
  await fx.tick();
  assert.equal(fx.current().status, 'completed');
  assert.equal(fx.calls.length, 1);
  assert.ok(W.readCheckoutReservation(fx.runtime.owner));
  await fx.close();
  const alternative = path.join(fx.workdir, 'alternative.yaml');
  for (const version of [1, 2]) {
    fs.writeFileSync(alternative, yaml.dump({ ...fx.manifest, schema_version: version }));
    const result = await O.runOrchestrator({ manifestPath: alternative, _runtimeRoot: fx.runtimeRoot, maxTicks: 1, logger: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.error || JSON.stringify(result), /reservation|unresolved/i);
  }
  await fx.open();
  await fx.tick();
  assert.equal(fx.calls.length, 1);
});

test('U2.8 persisted pause accepts outcomes but suppresses QA, recovery and independent work', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  fx.pause(true);
  fx.complete(fx.current());
  await fx.reopen();
  await fx.tick();
  assert.equal(fx.current().status, 'completed');
  assert.equal(fx.calls.length, 1);
  fx.pause(false);
  await fx.tick();
  assert.equal(fx.calls.length, 2);
  fx.pause(true);
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 2);
});

test('U2.9 only exact cooperative release permits handoff while the terminal remains live', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  const impl = fx.current();
  fx.complete(impl, false);
  fx.artifact(impl, 'release', { released: true, no_further_writes: true, attempt_id: 'sibling', role_label: 'operator' });
  await fx.tick();
  assert.equal(fx.calls.length, 1);
  fx.artifact(impl, 'release', { released: true, no_further_writes: true });
  await fx.tick();
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.current().reservation.state, 'released');
  assert.deepEqual(fx.current().engine_process, impl.engine_process);
});

test('U2.10 missing creation evidence is unknown; recovery QA prompt retains the new identity and one launch token', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  fx.complete(fx.current());
  await fx.tick();
  const qa = fx.current('p1', 'qa');
  await fx.tick(fx.sample([{ ...qa.engine_process, creation_time: null }]));
  assert.equal(fx.calls.length, 2);
  await fx.tick(fx.sample([]));
  const recovery = fx.current('p1', 'qa');
  assert.equal(recovery.retry_category, 'execution');
  const prompt = fs.readFileSync(recovery.artifacts.prompt, 'utf8');
  assert.ok(prompt.includes(recovery.attempt_id));
  assert.ok(prompt.includes(recovery.run_id));
  assert.ok(prompt.includes('QA playbook'));
  assert.ok(!prompt.includes('{{attempt_id}}'));
  await fx.reopen();
  await fx.tick();
  assert.equal(fx.calls.length, 3);
});

test('U2.11 complete scans prove absence/reuse, incomplete scans do not; surviving descendants retain reservations', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const a = fx.current();
  const child = { ...processIdentity(9000), parent_pid: a.engine_process.pid };
  await fx.tick(fx.sample([a.engine_process, child]));
  await fx.tick(fx.sample([{ ...a.engine_process, creation_time: '2026-09-18T00:00:00Z' }, child]));
  assert.equal(fx.current().status, 'failed');
  assert.equal(fx.current().reservation.state, 'held');
  assert.equal(fx.calls.length, 1);
  await fx.reopen();
  await fx.tick(fx.sample([child], { complete: false }));
  assert.equal(fx.calls.length, 1);
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 2);
});

test('U2.12 missing session-name match cannot replay an unacked launch; host reboot permits bounded recovery', async (t) => {
  const fx = await fixture(t, { launch: async () => {}, hostEvidence: processIdentity(7777) });
  await fx.tick();
  const before = fx.current();
  assert.equal(before.launch_host.pid, undefined, 'controller process identity is not engine identity');
  await fx.reopen();
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.current().status, 'needs_operator');
  await fx.tick(fx.sample([], { host_boot_id: 'boot-2' }));
  assert.equal(fx.calls.length, 2);
  assert.notEqual(fx.current().attempt_id, before.attempt_id);
});

test('U2.13 upstream retry completion recomputes dependency-only blockers without clearing operator/config blocks', async (t) => {
  const fx = await fixture(t, { phases: [
    { id: 'a', agent: { role: 'impl' }, completion_signal: 'a.md' },
    ...['b', 'c', 'd'].map((id) => ({ id, depends_on: ['a'], agent: { role: 'impl' }, completion_signal: `${id}.md` })),
  ] });
  await fx.tick();
  const state = fx.runtime.store.read();
  fx.runtime.store.transact({
    expectedRevision: state.revision, command: { id: 'fixture-blocks', payload: {} },
    mutate(draft) {
      draft.phases.c.blocker = { category: 'operator', reason: 'hold' };
      draft.phases.d.blocker = { category: 'configuration', reason: 'repair required' };
      return { result: {}, events: [] };
    },
  });
  await fx.tick(fx.sample([]));
  fx.complete(fx.current('a'));
  await fx.reopen();
  await fx.tick();
  assert.deepEqual(fx.calls.map((a) => a.phase_id), ['a', 'a', 'b']);
  assert.equal(fx.runtime.store.read().phases.c.blocker.category, 'operator');
  assert.equal(fx.runtime.store.read().phases.d.blocker.category, 'configuration');
});

test('U2 active runner reconciles accepted state despite invalid/drifted authoring; no adapter ever dispatches', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const a = fx.current();
  fx.complete(a);
  await fx.close();
  fs.writeFileSync(fx.manifestPath, 'invalid: [');
  const result = await O.runOrchestrator({
    manifestPath: fx.manifestPath, _runtimeRoot: fx.runtimeRoot, maxTicks: 2, activeIntervalMs: 1,
    _healthSample: () => ({ ...HOST, sample_id: 'runner-sample', observed_at: '2026-09-17T13:00:00Z', complete: true, processes: [a.engine_process] }),
    _spawnSession: () => assert.fail('legacy launch reached'), logger: () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authoring.status, 'invalid');
  const saved = require('./state-store').readState(fx.manifestPath);
  assert.equal(saved.phases.p1.status, 'completed');
  assert.equal(saved.live_dispatch_enabled, false);
  assert.equal(fx.calls.length, 1);
  fs.writeFileSync(fx.manifestPath, yaml.dump({ ...fx.manifest, name: 'changed' }));
  await fx.open();
  assert.equal(fx.runtime.authoring.status, 'drifted');
  await fx.tick();
  assert.equal(fx.current().attempt_id, a.attempt_id);
});

test('U2 publication failure cannot launch; retry budgets, outcomes and intent cannot be rewritten', async (t) => {
  let fail = false;
  const fx = await fixture(t, { stateFs: { renameSync(from, to) {
    if (fail) throw new Error('fixture storage failure');
    fs.renameSync(from, to);
  } } });
  fail = true;
  await assert.rejects(fx.tick(), /storage failure/);
  assert.equal(fx.calls.length, 0);
  fail = false;
  await fx.tick();
  const a = fx.current();
  fx.complete(a);
  await fx.tick();
  for (const change of [
    (entry) => { entry.attempts = []; entry.current_attempt_id = null; },
    (entry) => { entry.attempts[0].intent.launch_token = 'replacement'; },
    (entry) => { entry.attempts[0].outcome.type = 'failed'; },
    (entry) => { entry.attempts[0].evidence_history = []; },
  ]) {
    const state = fx.runtime.store.read();
    assert.throws(() => fx.runtime.store.transact({
      expectedRevision: state.revision, command: { id: 'tamper', payload: {} },
      mutate(draft) { change(draft.phases.p1.roles.impl); return { result: {}, events: [] }; },
    }), /historical|immutable|invalid state/);
  }
  assert.equal(fx.current().attempt_id, a.attempt_id);
});

test('U2 bounded artifacts reject oversized data and path redirection without dispatch or authority escalation', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  const a = fx.current();
  fs.writeFileSync(a.artifacts.completion, 'x'.repeat(require('./attempt-lifecycle').MAX_ARTIFACT_BYTES + 1));
  await assert.rejects(fx.tick(), /bounded/);
  assert.equal(fx.calls.length, 1);
  fs.unlinkSync(a.artifacts.completion);
  const external = path.join(fx.root, 'redirect');
  fs.mkdirSync(external);
  const phaseDirectory = path.dirname(a.artifacts.directory);
  fs.renameSync(a.artifacts.directory, path.join(external, 'original'));
  fs.symlinkSync(external, a.artifacts.directory, 'junction');
  await assert.rejects(fx.tick(), /redirected/);
  assert.equal(fx.calls.length, 1);
  fs.rmdirSync(a.artifacts.directory);
  fs.renameSync(path.join(external, 'original'), a.artifacts.directory);
  assert.equal(path.dirname(a.artifacts.directory), phaseDirectory);
  fx.complete(a);
  await fx.tick();
  assert.equal(fx.calls.length, 2);
});

test('U2 review failures consume only review rounds and cannot bypass the final QA gate after restart', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  for (let iteration = 0; iteration < 2; iteration++) {
    fx.complete(fx.current());
    await fx.tick();
    const qa = fx.current('p1', 'qa');
    assert.equal(qa.review_iteration, iteration);
    fx.artifact(qa, 'completion', { status: 'blocked' });
    fx.artifact(qa, 'verdict', { verdict: 'fail',
      verification: qa.intent.required_verification.map((id) => ({ id, status: id === 'scope' ? 'fail' : 'pass', evidence: 'fixture failure' })) });
    fx.artifact(qa, 'release', { released: true, no_further_writes: true });
    await fx.reopen();
    await fx.tick();
  }
  const phase = fx.runtime.store.read().phases.p1;
  assert.equal(phase.status, 'failed');
  assert.equal(phase.review_history.length, 2);
  assert.equal(fx.calls.length, 4);
  assert.deepEqual(phase.roles.impl.budgets, { launch: 0, execution: 0 });
  assert.deepEqual(phase.roles.qa.budgets, { launch: 0, execution: 0 });
  await fx.tick();
  assert.equal(fx.calls.length, 4);
});

test('U2 declared read-only requires enforced fixture capability and concurrent tick calls are denied', async (t) => {
  const fx = await fixture(t, { phases: [{ id: 'p1', agent: { role: 'impl', access: 'read-only' }, completion_signal: 'done.md' }] });
  await assert.rejects(fx.tick(), /cannot enforce/);
  assert.equal(fx.calls.length, 0);
  const pending = fx.tick();
  await assert.rejects(fx.tick(), /already running/);
  await assert.rejects(pending, /cannot enforce/);
  await fx.close();
  await assert.rejects(O.startV2Foundation({
    manifestPath: fx.manifestPath, _runtimeRoot: fx.runtimeRoot, _fixtureAdapter: { launch() {} },
  }), /strict capabilities/);
});

test('U2 reopened fixture reconciliation correlates a late acknowledgement without resubmitting; observations deduplicate', async (t) => {
  const fx = await fixture(t, { launch: async () => {} });
  await fx.tick();
  const a = fx.current();
  await fx.reopen();
  const process = processIdentity(3210);
  fx.adapter.reconcile = async (attempt, { observe }) => {
    await observe({ ...identity(attempt), id: 'late-session', kind: 'session', session_id: 'late-session-id', process });
    await observe({ ...identity(attempt), id: 'late-submission', kind: 'submission', acknowledged: true });
    await observe({ ...identity(attempt), id: 'late-descendants', kind: 'descendants', processes: [], complete: true });
  };
  await fx.tick(fx.sample([process]));
  assert.equal(fx.current().status, 'running');
  assert.equal(fx.current().attempt_id, a.attempt_id);
  const observations = fx.current().observations;
  await fx.tick(fx.sample([process]));
  assert.deepEqual(fx.current().observations, observations);
  assert.equal(fx.calls.length, 1);
  fx.adapter.reconcile = async (attempt, { observe }) => {
    await observe({ ...identity(attempt), id: 'late-submission', kind: 'submission', acknowledged: false });
  };
  await assert.rejects(fx.tick(), /reused/);
  assert.equal(fx.current().submission.acknowledged, true);
});

test('U2 explicit fixture closure can settle an unidentified launch; incomplete closure and worker labels cannot', async (t) => {
  const fx = await fixture(t, { launch: async () => {} });
  await fx.tick();
  const a = fx.current();
  fx.artifact(a, 'checkpoint', { role_label: 'operator', engine_closed: true, descendants_closed: true, launch_settled: true });
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 1);
  fx.adapter.reconcile = async (attempt, { observe }) => {
    await observe({ ...identity(attempt), id: 'closure', kind: 'closure', engine_closed: true, launch_settled: true });
  };
  await assert.rejects(fx.tick(fx.sample([])), /all descendants/);
  fx.adapter.reconcile = async (attempt, { observe }) => {
    await observe({ ...identity(attempt), id: 'closure', kind: 'closure',
      engine_closed: true, launch_settled: true, descendants_closed: true });
  };
  await fx.reopen();
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.current().retry_category, 'launch');
  const historical = fx.runtime.store.read().phases.p1.roles.impl.attempts[0];
  assert.equal(historical.reservation.closure.type, 'adapter_closure');
});

test('U2 crash after durable closure reacquires and clears an additional checkout reservation before handoff', async (t) => {
  const other = runtimeFixture(t);
  let interrupt = false;
  const fx = await fixture(t, {
    phases: [
      { id: 'a', agent: { role: 'impl', workdir: other.workdir }, completion_signal: 'a.md' },
      { id: 'b', depends_on: ['a'], agent: { role: 'impl', workdir: other.workdir }, completion_signal: 'b.md' },
    ],
    fault(point) {
      if (interrupt && point === 'after_reconcile') { interrupt = false; throw new Error('closure interruption'); }
    },
  });
  await fx.tick();
  const a = fx.current('a');
  fx.complete(a);
  interrupt = true;
  await assert.rejects(fx.tick(), /closure interruption/);
  assert.equal(fx.current('a').reservation.state, 'released');
  assert.equal(fx.current('a').reservation_cleared, undefined);
  await fx.reopen();
  assert.equal(fx.current('a').reservation_cleared, true);
  await fx.tick();
  assert.deepEqual(fx.calls.map((attempt) => attempt.phase_id), ['a', 'b']);
});
