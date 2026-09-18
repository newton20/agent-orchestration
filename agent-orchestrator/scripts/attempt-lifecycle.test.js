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

test('U4 restart drains a full outbox before reservation cleanup can append', async (t) => {
  let interrupt = false;
  const fx = await fixture(t, { fault(point) {
    if (interrupt && point === 'after_reconcile') throw new Error('closure stop');
  } });
  await fx.tick();
  fx.complete(fx.current());
  interrupt = true;
  await assert.rejects(fx.tick(), /closure stop/);
  const state = fx.runtime.store.read();
  const count = require('./event-log').MAX_OUTBOX_EVENTS - state.outbox.length;
  fx.runtime.store.transactInternal({ expectedRevision: state.revision,
    mutate: () => ({ result: {}, events: Array.from({ length: count }, () => ({ type: 'event', payload: {} })) }) });
  await fx.reopen();
  assert.equal(fx.current().reservation_cleared, true);
  assert.equal(fx.runtime.store.read().outbox.length, 0);
  assert.equal(fx.calls.length, 1);
});

test('U4 degraded projection observes current work but leaves new and queued dispatch untouched', async (t) => {
  let failIntent = true;
  const fx = await fixture(t, { fault(point) {
    if (failIntent && point === 'after_intent') throw new Error('queued stop');
  } });
  await assert.rejects(fx.tick(), /queued stop/);
  failIntent = false;
  const queued = fx.current();
  const E = require('./event-log');
  fs.appendFileSync(E.eventLogPath(fx.runtime.store.read()), '{bad}\n');
  fx.runtime.store.projectOutbox({ expectedRevision: fx.runtime.store.read().revision });
  await fx.tick();
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.current().status, 'queued');
  assert.equal(fx.current().reservation.state, queued.reservation.state);
  assert.equal(fs.existsSync(queued.artifacts.prompt), false);
});

test('U4 a real session observation with incomplete process identity keeps liveness unknown', async (t) => {
  const fx = await fixture(t, { launch: async (a, observe) => {
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'partial-process',
      process: { ...processIdentity(8991), creation_time: null, host_boot_id: null } });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick();
  const snapshot = require('./read-model').createSnapshot({ manifestPath: fx.manifestPath });
  const attempt = snapshot.phases[0].roles[0].current_attempt;
  assert.equal(attempt.session.status, 'observed');
  assert.equal(attempt.engine_observation.status, 'unknown');
  assert.equal(attempt.submission.status, 'acknowledged');
});

test('U4 dispatch admission reserves outbox capacity before any launch effect', async (t) => {
  const fx = await fixture(t);
  fx.runtime.store.transactInternal({ expectedRevision: fx.runtime.store.read().revision,
    mutate: () => ({ result: {}, events: Array.from({ length: 240 }, () => ({ type: 'event', payload: {} })) }) });
  await fx.tick();
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.runtime.store.read().phases.p1.roles.impl.attempts.length, 0);
  fx.runtime.store.projectOutbox({ expectedRevision: fx.runtime.store.read().revision });
  await fx.tick();
  assert.equal(fx.calls.length, 1);
});

test('round3 process closure evidence survives report repair and permits rerun', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const attempt = fx.current();
  fs.writeFileSync(attempt.artifacts.completion, '{');
  await fx.tick(fx.sample([]));
  assert.equal(fx.current().reservation.state, 'released');
  assert.equal(fx.current().status, 'needs_operator');
  const closure = fx.current().reservation.closure;
  fx.artifact(attempt, 'completion', { status: 'complete' });
  await fx.tick(fx.sample([]));
  assert.equal(fx.current().status, 'completed');
  assert.deepEqual(fx.current().reservation.closure, closure);
  await fx.reopen();
  const prior = fx.runtime.store.read();
  const next = fx.runtime.store.rerun({ expectedRevision: prior.revision, accepted: prior.accepted });
  assert.notEqual(next.run_id, prior.run_id);
  assert.deepEqual(next.history.at(-1).phases.p1.roles.impl.attempts, prior.phases.p1.roles.impl.attempts);
});

test('round3 launcher-only boot evidence allows one fenced retry after reboot', async (t) => {
  const fx = await fixture(t, { launch: async (attempt, observe) => {
    await observe({ ...identity(attempt), id: 'launcher', kind: 'launch_process', process: processIdentity(1800) });
  } });
  await fx.tick(fx.sample([], { complete: false, host_boot_id: null, error: 'boot unavailable' }));
  const first = fx.current();
  assert.equal(first.launch_host.host_boot_id, null);
  await fx.reopen();
  const reboot = fx.sample([], { host_boot_id: 'boot-2' });
  await fx.tick(reboot);
  assert.equal(fx.calls.length, 2);
  assert.notEqual(fx.current().attempt_id, first.attempt_id);
  const prior = fx.runtime.store.read().phases.p1.roles.impl.attempts[0];
  assert.equal(prior.outcome.reason, 'host reboot');
  assert.equal(prior.reservation.state, 'released');
  await fx.tick(reboot);
  assert.equal(fx.calls.length, 2, 'replaying the reboot sample must not kill its replacement');
});

test('final advisory: a matching live engine prevents contradictory reboot release', async (t) => {
  const fx = await fixture(t, { launch: async (attempt, observe) => {
    await observe({ ...identity(attempt), id: 'session', kind: 'session', session_id: 'late-current-boot',
      process: { ...processIdentity(1801), host_boot_id: 'boot-2' } });
    await observe({ ...identity(attempt), id: 'descendants', kind: 'descendants', processes: [], complete: true });
    await observe({ ...identity(attempt), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick();
  const attempt = fx.current();
  await fx.tick(fx.sample([attempt.engine_process], { host_boot_id: 'boot-2' }));
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.current().health.engine.state, 'live');
  assert.equal(fx.current().reservation.state, 'held');
  const child = { ...processIdentity(1802), host_boot_id: 'boot-2', parent_pid: 1801 };
  await fx.tick(fx.sample([attempt.engine_process, child], { host_boot_id: 'boot-2' }));
  assert.equal(fx.current().descendants.length, 1);
  await fx.tick(fx.sample([child], { host_boot_id: 'boot-2' }));
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.current().reservation.state, 'held');
  await fx.tick(fx.sample([], { host_boot_id: 'boot-2' }));
  assert.equal(fx.calls.length, 2);
});

test('final advisory: reservation cleanup acknowledgement requires release and cannot regress', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const transact = (value) => {
    const state = fx.runtime.store.read();
    return fx.runtime.store.transactInternal({
      expectedRevision: state.revision,
      mutate(draft) {
        draft.phases.p1.roles.impl.attempts[0].reservation_cleared = value;
        return { result: {}, events: [] };
      },
    });
  };
  assert.throws(() => transact(true), /reservation/);
  fx.complete(fx.current());
  await fx.tick();
  assert.equal(fx.current().reservation_cleared, true);
  assert.throws(() => transact(false), /reservation/);
  assert.equal(fx.current().reservation_cleared, true);
});

async function fixture(t, { phases, review = false, launch, onLaunch, readOnly = false, fault, stateFs, hostEvidence = HOST } = {}) {
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
      if (onLaunch) onLaunch(attempt, calls);
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
  fx.options = options;
  fx.open = async (extra = {}) => {
    fx.runtime = await O.startV2Foundation({ ...options(), ...extra });
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
  const fx = await fixture(t, { phases: [{ id: 'p1', agent: { role: 'qa' }, completion_signal: 'done.md' }] });
  await fx.tick();
  const old = fx.current('p1', 'qa');
  await fx.tick(fx.sample([]));
  const active = fx.current('p1', 'qa');
  assert.notEqual(active.attempt_id, old.attempt_id);
  for (const kind of ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release']) {
    fx.artifact(active, kind, { ...identity(old), status: 'complete', verdict: 'pass', released: true, no_further_writes: true });
  }
  await fx.tick();
  assert.equal(fx.current('p1', 'qa').status, 'needs_operator');
  assert.equal(fx.current('p1', 'qa').reservation.state, 'held');
  assert.deepEqual(fx.current('p1', 'qa').evidence, {});
  fx.complete(active);
  fx.artifact(active, 'heartbeat');
  fx.artifact(active, 'checkpoint');
  await fx.tick();
  const saved = fx.current('p1', 'qa');
  assert.equal(saved.status, 'completed');
  await fx.reopen();
  await fx.tick();
  assert.deepEqual(fx.current('p1', 'qa'), saved);
});

test('U2.3 both sibling orders reconcile every role before recovery and preserve per-role outcomes', async (t) => {
  for (const roles of [['impl', 'qa'], ['qa', 'impl']]) {
    for (const completed of [false, true]) await t.test(`${roles.join('-')}-${completed ? 'completed' : 'live'}`, async (t) => {
      let resumed;
      const fx = await fixture(t, { readOnly: true, phases: [{
        id: 'p1', agents: roles.map((role) => ({ role, access: 'read-only' })), completion_signal: 'ignored.md',
      }], onLaunch(a, calls) {
        if (calls.length !== 3) return;
        const survivor = fx.current('p1', roles[1]);
        assert.equal(survivor.health.sample_id, resumed.sample_id, 'survivor sample must be durable before retry launch');
        assert.equal(survivor.health.engine.state, 'live');
        if (completed) {
          assert.equal(survivor.outcome.type, 'completed');
          assert.ok(survivor.evidence.completion);
        }
      } });
      await fx.tick();
      const dead = fx.current('p1', roles[0]);
      const live = fx.current('p1', roles[1]);
      if (completed) fx.complete(live);
      await fx.reopen();
      resumed = fx.sample([live.engine_process]);
      await fx.tick(resumed);
      assert.equal(fx.current('p1', roles[1]).attempt_id, live.attempt_id);
      assert.notEqual(fx.current('p1', roles[0]).attempt_id, dead.attempt_id);
      assert.equal(fx.calls.length, 3);
      assert.equal(fx.runtime.store.read().phases.p1.status, 'running');
    });
  }
});

test('round2 failed process probes clear diagnostics without health-only event or command growth', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  await fx.tick(fx.sample([], { complete: false, error: 'probe unavailable' }));
  assert.equal(fx.runtime.store.read().process_diagnostic.error, 'probe unavailable');
  await fx.tick();
  const healthy = fx.runtime.store.read();
  assert.equal(Object.hasOwn(healthy, 'process_diagnostic'), false);
  assert.equal(healthy.runtime_status, 'live_dispatch_disabled');
  const sample = fx.sample();
  await fx.tick(sample);
  const fresh = fx.runtime.store.read();
  assert.equal(fresh.revision, healthy.revision + 1);
  assert.deepEqual(fresh.outbox, healthy.outbox);
  assert.deepEqual(fresh.command_results, healthy.command_results);
  await fx.tick(sample);
  assert.deepEqual(fx.runtime.store.read(), fresh);
});

test('round2 missing dispatch boot uses correlated identity and retains a surviving child', async (t) => {
  for (const complete of [false, true]) await t.test(`dispatch-complete-${complete}`, async (t) => {
    const fx = await fixture(t);
    await fx.tick(fx.sample([], { complete, host_boot_id: null, ...(complete ? {} : { error: 'failed probe' }) }));
    const first = fx.current();
    assert.equal(first.launch_host.host_boot_id, null);
    await fx.tick(fx.sample([first.engine_process]));
    const child = { ...processIdentity(8901), parent_pid: first.engine_process.pid };
    await fx.tick(fx.sample([first.engine_process, child]));
    await fx.reopen();
    await fx.tick(fx.sample([child]));
    assert.equal(fx.current().attempt_id, first.attempt_id);
    assert.equal(fx.current().descendants.length, 1);
    assert.equal(fx.current().reservation.state, 'held');
    assert.equal(W.readCheckoutReservation(fx.runtime.owner).attempt_id, first.attempt_id);
    assert.equal(fx.calls.length, 1);
    await fx.tick(fx.sample([]));
    assert.equal(fx.calls.length, 2);
    assert.notEqual(fx.current().attempt_id, first.attempt_id);
  });
});

test('round2 skipped descendant scans cannot authorize process-only closure with unknown boot', async (t) => {
  const fx = await fixture(t, { launch: async (a, observe) => {
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'unknown-boot',
      process: { ...processIdentity(8902), host_boot_id: null } });
    await observe({ ...identity(a), id: 'descendants', kind: 'descendants', processes: [], complete: true });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick(fx.sample([], { host_boot_id: null }));
  for (const extra of [{}, { hostname: 'other-host' }, { complete: false }, {}]) {
    await fx.tick(fx.sample([], extra));
    assert.equal(fx.current().reservation.state, 'held', 'unavailable launch boot must not borrow owner boot');
    assert.equal(fx.calls.length, 1);
  }
  await fx.reopen();
  await fx.tick(fx.sample([]));
  assert.equal(fx.calls.length, 1);
});

test('round2 a complete table outside the launch host cannot stand in for a descendant scan', async (t) => {
  const remote = { ...processIdentity(8911), hostname: 'other-host' };
  const fx = await fixture(t, { launch: async (a, observe) => {
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'mismatched-host', process: remote });
    await observe({ ...identity(a), id: 'descendants', kind: 'descendants', processes: [], complete: true });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick(fx.sample([], { host_boot_id: null }));
  await fx.tick(fx.sample([], { hostname: remote.hostname }));
  assert.equal(fx.current().health.engine.state, 'dead');
  assert.equal(fx.current().reservation.state, 'held');
  assert.equal(fx.calls.length, 1);
});

test('round2 non-review QA failures terminate without retries and still reconcile release after restart', async (t) => {
  for (const roles of [['qa'], ['impl', 'qa'], ['qa', 'impl']]) await t.test(roles.join('-'), async (t) => {
    const fx = await fixture(t, { readOnly: true, phases: [{
      id: 'p1', agents: roles.map((role) => ({ role, access: roles.length === 1 ? 'mutating' : 'read-only' })), completion_signal: 'done.md',
    }] });
    await fx.tick();
    if (roles.includes('impl')) fx.complete(fx.current());
    const qa = fx.current('p1', 'qa');
    fx.artifact(qa, 'completion', { status: 'blocked' });
    fx.artifact(qa, 'verdict', { verdict: 'fail',
      verification: qa.intent.required_verification.map((id) => ({ id, status: 'fail', evidence: 'verified failure' })) });
    await fx.tick();
    assert.equal(fx.runtime.store.read().phases.p1.status, 'failed');
    const failed = fx.current('p1', 'qa');
    assert.equal(failed.outcome.type, 'qa_failed');
    assert.equal(failed.reservation.state, 'held');
    await fx.reopen();
    fx.artifact(qa, 'release', { released: true, no_further_writes: true });
    await fx.tick();
    await fx.reopen();
    await fx.tick();
    const phase = fx.runtime.store.read().phases.p1;
    assert.equal(phase.status, 'failed');
    assert.deepEqual(fx.current('p1', 'qa').outcome, failed.outcome);
    assert.deepEqual(fx.current('p1', 'qa').evidence.verdict, failed.evidence.verdict);
    assert.equal(fx.current('p1', 'qa').reservation.state, 'released');
    if (roles.length === 1) assert.equal(fx.current('p1', 'qa').reservation_cleared, true);
    assert.equal(fx.calls.length, roles.length);
    for (const entry of Object.values(phase.roles)) assert.deepEqual(entry.budgets, { launch: 0, execution: 0 });
  });
});

test('round2 descendant identity normalizes timestamps but preserves submillisecond reuse and unknowns', async (t) => {
  const child = { ...processIdentity(8910), creation_time: '2026-09-17T12:00:00.1234000Z' };
  const fx = await fixture(t, { launch: async (a, observe) => {
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'engine', process: processIdentity(8909) });
    await observe({ ...identity(a), id: 'descendants', kind: 'descendants', processes: [child], complete: true });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick();
  await fx.tick(fx.sample([fx.current().engine_process,
    { ...child, creation_time: '2026-09-17T14:00:00.1234+02:00', parent_pid: 8909 }]));
  assert.equal(fx.current().descendants.length, 1);
  for (const creation_time of ['2026-09-17T12:00:00.1234001Z', null]) {
    await fx.tick(fx.sample([fx.current().engine_process, { ...child, creation_time, parent_pid: 8909 }]));
  }
  assert.equal(fx.current().descendants.length, 3);
});

test('round2 safely closed completed and failed runs rerun with immutable history and a new identity', async (t) => {
  for (const failed of [false, true]) await t.test(failed ? 'failed' : 'completed', async (t) => {
    const fx = await fixture(t);
    await fx.tick();
    if (failed) {
      for (let i = 0; i < 3; i++) await fx.tick(fx.sample([]));
    } else {
      fx.complete(fx.current());
      await fx.tick();
    }
    const prior = fx.runtime.store.projectOutbox({ expectedRevision: fx.runtime.store.read().revision });
    assert.equal(prior.phases.p1.status, failed ? 'failed' : 'completed');
    await fx.close();
    await fx.open({ rerun: true });
    const next = fx.runtime.store.read();
    assert.notEqual(next.run_id, prior.run_id);
    const { history, ...historical } = prior;
    assert.deepEqual(next.history, [...history, historical]);
    assert.deepEqual(next.phases.p1.roles.impl.attempts, []);
    assert.equal(next.live_dispatch_enabled, false);
    assert.equal(fx.calls.length, failed ? 3 : 1, 'rerun startup cannot dispatch the old or new adapter');
  });
});

test('round2 rerun accepts canonical reboot closure even when engine identity remains unknown', async (t) => {
  const fx = await fixture(t, { launch: async (a, observe) => {
    await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'unknown-engine-boot',
      process: { ...processIdentity(8920), host_boot_id: null } });
    await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
  } });
  await fx.tick();
  fx.complete(fx.current(), false);
  await fx.tick(fx.sample([], { host_boot_id: 'boot-2' }));
  const prior = fx.runtime.store.read();
  assert.equal(fx.current().health.engine.state, 'dead');
  assert.equal(fx.current().health.engine.reason, 'host reboot');
  assert.equal(fx.current().reservation.closure.type, 'process_closure');
  assert.equal(fx.current().reservation_cleared, true);
  await fx.close();
  await fx.open({ rerun: true });
  assert.notEqual(fx.runtime.state.run_id, prior.run_id);
  assert.deepEqual(fx.runtime.state.history[0].phases, prior.phases);
});

test('round2 rerun publication failure preserves the old run after cleanup and releases all handles', async (t) => {
  const other = runtimeFixture(t);
  let interrupt = false;
  const fx = await fixture(t, {
    phases: [{ id: 'p1', agent: { role: 'impl', workdir: other.workdir }, completion_signal: 'done.md' }],
    fault(point) { if (interrupt && point === 'after_reconcile') throw new Error('closure stop'); },
  });
  await fx.tick();
  fx.complete(fx.current());
  interrupt = true;
  await assert.rejects(fx.tick(), /closure stop/);
  const prior = fx.runtime.store.read();
  await fx.close();
  await assert.rejects(fx.open({ rerun: true, _stateFs: {
    renameSync(from, to) {
      if (JSON.parse(fs.readFileSync(from, 'utf8')).run_id !== prior.run_id) throw new Error('rerun publication EIO');
      fs.renameSync(from, to);
    },
  } }), /rerun publication EIO/);
  const saved = require('./state-store').readState(fx.manifestPath);
  assert.equal(saved.run_id, prior.run_id);
  assert.equal(saved.phases.p1.roles.impl.attempts[0].reservation_cleared, true);
  const owner = await W.acquireWorkspaceOwner(W.resolveWorkspace(other.workdir), { _runtimeRoot: fx.runtimeRoot });
  try { assert.equal(W.readCheckoutReservation(owner), null); } finally { await owner.release(); }
  await fx.open({ rerun: true });
  assert.notEqual(fx.runtime.state.run_id, prior.run_id);
  assert.equal(fx.calls.length, 1);
});

test('round2 rerun rejects live unknown and queued active work without changing identity', async (t) => {
  for (const mode of ['live', 'unknown', 'queued']) await t.test(mode, async (t) => {
    const fx = await fixture(t, {
      fault(point) { if (mode === 'queued' && point === 'after_intent') throw new Error('queued stop'); },
    });
    if (mode === 'queued') await assert.rejects(fx.tick(), /queued stop/);
    else await fx.tick();
    if (mode === 'unknown') await fx.tick(fx.sample([], { complete: false, host_boot_id: null }));
    const prior = fx.runtime.store.read();
    await fx.close();
    await assert.rejects(fx.open({ rerun: true }), /closure|terminal|active/);
    assert.deepEqual(require('./state-store').readState(fx.manifestPath), prior);
  });
});

test('round4 rerun permits never-started dependants and pending phases after writer closure', async (t) => {
  for (const failed of [true, false]) await t.test(failed ? 'dependency-blocked' : 'pending', async (t) => {
    const fx = await fixture(t, { phases: [
      { id: 'p1', agent: { role: 'impl' }, completion_signal: 'a.md' },
      { id: 'p2', ...(failed ? { depends_on: ['p1'] } : {}), agent: { role: 'impl' }, completion_signal: 'b.md' },
    ] });
    await fx.tick();
    if (failed) {
      for (let i = 0; i < 3; i++) await fx.tick(fx.sample([]));
    } else {
      fx.pause(true);
      fx.complete(fx.current());
      await fx.tick();
    }
    const prior = fx.runtime.store.read();
    assert.equal(prior.phases.p1.status, failed ? 'failed' : 'completed');
    assert.equal(prior.phases.p2.status, failed ? 'blocked' : 'pending');
    assert.equal(prior.phases.p2.roles.impl.attempts.length, 0);
    const dispatches = fx.calls.length;
    await fx.close();
    await fx.open({ rerun: true });
    assert.notEqual(fx.runtime.state.run_id, prior.run_id);
    assert.deepEqual(fx.runtime.state.history.at(-1).phases, prior.phases);
    assert.equal(fx.calls.length, dispatches);
  });
});

test('round4 secondary checkout checks legacy locks at its declared subdirectory', async (t) => {
  const other = runtimeFixture(t);
  const subdir = path.join(other.workdir, 'nested');
  const legacyDir = path.join(subdir, 'docs', 'orchestration');
  fs.mkdirSync(legacyDir, { recursive: true });
  const fx = await fixture(t, { phases: [
    { id: 'p1', agent: { role: 'impl', workdir: subdir }, completion_signal: 'done.md' },
  ] });
  const host = W.getHostEvidence();
  fs.writeFileSync(path.join(legacyDir, '.orchestrator.lock'), JSON.stringify(host));
  await assert.rejects(fx.tick(), /legacy owner is live/);
  assert.equal(fx.calls.length, 0);
});

test('round2 rerun requires concrete proof and cleared reservations for every historical attempt', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  await fx.tick(fx.sample([]));
  fx.complete(fx.current());
  await fx.tick();
  const prior = fx.runtime.store.read();
  const statusPath = require('./parse-manifest').statusPathFor(fx.manifestPath);
  const bytes = fs.readFileSync(statusPath, 'utf8');
  for (const corrupt of [
    (a) => { delete a.lifecycle_version; },
    (a) => { delete a.outcome; },
    (a) => { a.status = 'needs_operator'; },
    (a) => { a.reservation = { state: 'pending' }; },
    (a) => { a.reservation.closure = {}; },
    (a) => { a.reservation.closure.type = 'unverified'; },
    (a) => { a.reservation.closure.sample_id = 'different-sample'; },
    (a) => { a.reservation_cleared = false; },
  ]) {
    const state = structuredClone(prior);
    corrupt(state.phases.p1.roles.impl.attempts[0]);
    fs.writeFileSync(statusPath, JSON.stringify(state));
    assert.throws(() => fx.runtime.store.rerun({ expectedRevision: state.revision, accepted: state.accepted }), /closure|terminal|reservation/);
    assert.equal(fs.readFileSync(statusPath, 'utf8'), JSON.stringify(state));
  }
  fs.writeFileSync(statusPath, bytes);
  W.reserveCheckout(fx.runtime.owner, { ...identity(fx.current()), manifest_path: fx.manifestPath });
  assert.throws(() => fx.runtime.store.rerun({ expectedRevision: prior.revision, accepted: prior.accepted }), /private reservation cleanup/);
  W.releaseCheckout(fx.runtime.owner, fx.current());
});

test('round2 rerun reconciles crash-window reservations under the old run and releases secondary ownership', async (t) => {
  const other = runtimeFixture(t);
  let interrupt = false;
  const fx = await fixture(t, { phases: [
    { id: 'p1', agent: { role: 'impl' }, completion_signal: 'a.md' },
    { id: 'p2', agent: { role: 'impl', workdir: other.workdir }, completion_signal: 'b.md' },
  ], fault(point) { if (interrupt && point === 'after_reconcile') throw new Error('closure stop'); } });
  await fx.tick();
  fx.complete(fx.current());
  fx.complete(fx.current('p2'));
  interrupt = true;
  await assert.rejects(fx.tick(), /closure stop/);
  const prior = fx.runtime.store.read();
  assert.equal(fx.current().reservation_cleared, undefined);
  assert.equal(W.readCheckoutReservation(fx.runtime.owner).run_id, prior.run_id);
  await fx.close();
  await fx.open({ rerun: true });
  const next = fx.runtime.store.read();
  assert.notEqual(next.run_id, prior.run_id);
  assert.equal(W.readCheckoutReservation(fx.runtime.owner), null);
  assert.equal(next.history[0].run_id, prior.run_id);
  for (const phase of Object.values(next.history[0].phases)) assert.equal(phase.roles.impl.attempts[0].reservation_cleared, true);
  assert.equal(fx.calls.length, 2);
  const owner = await W.acquireWorkspaceOwner(W.resolveWorkspace(other.workdir), { _runtimeRoot: fx.runtimeRoot });
  try { assert.equal(W.readCheckoutReservation(owner), null); } finally { await owner.release(); }
});

test('round2 zero-tick runner returns the revision committed by startup reservation cleanup', async (t) => {
  let interrupt = false;
  const fx = await fixture(t, { fault(point) {
    if (interrupt && point === 'after_reconcile') throw new Error('closure stop');
  } });
  await fx.tick();
  fx.complete(fx.current());
  interrupt = true;
  await assert.rejects(fx.tick(), /closure stop/);
  const prior = fx.runtime.store.read();
  await fx.close();
  const result = await O.runOrchestrator({ ...fx.options(), maxTicks: 0 });
  const saved = require('./state-store').readState(fx.manifestPath);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(saved.revision, prior.revision + 3, 'drain, reservation cleanup and cleanup-event acknowledgement each commit');
  assert.equal(saved.outbox.length, 0);
  assert.equal(saved.projection.acknowledged_sequence, saved.next_event_sequence - 1);
  assert.equal(result.revision, saved.revision);
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
    (entry) => { entry.attempts[0].process_sample_watermark.observed_at = TIME; },
  ]) {
    const state = fx.runtime.store.read();
    assert.throws(() => fx.runtime.store.transact({
      expectedRevision: state.revision, command: { id: 'tamper', payload: {} },
      mutate(draft) { change(draft.phases.p1.roles.impl); return { result: {}, events: [] }; },
    }), /historical|immutable|invalid state/);
  }
  assert.equal(fx.current().attempt_id, a.attempt_id);
});

test('U2 correction: valid QA failure followed by pass preserves review history and waits for release', async (t) => {
  const fx = await fixture(t, { phases: [
    { id: 'p1', agent: { role: 'impl' }, completion_signal: 'p1.md', review_loop: { enabled: true, max_iterations: 2 } },
    { id: 'p2', depends_on: ['p1'], agent: { role: 'impl' }, completion_signal: 'p2.md' },
  ] });
  await fx.tick();
  fx.complete(fx.current());
  await fx.tick();
  const failed = fx.current('p1', 'qa');
  fx.artifact(failed, 'completion', { status: 'blocked' });
  fx.artifact(failed, 'verdict', { verdict: 'fail',
    verification: failed.intent.required_verification.map((id) => ({ id, status: 'fail', evidence: 'observed failure' })) });
  fx.artifact(failed, 'release', { released: true, no_further_writes: true });
  await fx.tick();
  assert.equal(fx.current().retry_category, 'review');
  fx.complete(fx.current());
  await fx.tick();
  const qa = fx.current('p1', 'qa');
  fx.complete(qa, false);
  await fx.reopen();
  await fx.tick();
  assert.equal(fx.runtime.store.read().phases.p1.status, 'completed');
  assert.equal(fx.current('p2'), undefined, 'downstream writer must wait for final QA release');
  fx.artifact(qa, 'release', { released: true, no_further_writes: true });
  await fx.tick();
  assert.ok(fx.current('p2'));
  const phase = fx.runtime.store.read().phases.p1;
  assert.deepEqual(phase.review_history.map((row) => row.verdict), ['fail', 'pass']);
  assert.deepEqual(phase.roles.qa.budgets, { launch: 0, execution: 0 });
  assert.deepEqual(phase.roles.impl.budgets, { launch: 0, execution: 0 });
});

test('superseded read-only attempts reconcile only closure across restart without changing review progress', async (t) => {
  for (const evidence of ['late-release', 'process-death', 'adapter-closure', 'early-release']) {
    await t.test(evidence, async (t) => {
      const fx = await fixture(t, { readOnly: true, phases: [{
        id: 'p1', agents: [{ role: 'impl', access: 'read-only' }, { role: 'qa' }],
        completion_signal: 'done.md', review_loop: { enabled: true, max_iterations: 2 },
      }] });
      await fx.tick();
      const original = fx.current();
      fx.complete(original, evidence === 'early-release');
      await fx.tick();
      const firstQa = fx.current('p1', 'qa');
      fx.artifact(firstQa, 'completion', { status: 'blocked' });
      fx.artifact(firstQa, 'verdict', { verdict: 'fail',
        verification: firstQa.intent.required_verification.map((id) =>
          ({ id, status: 'fail', evidence: 'requires implementation changes' })) });
      fx.artifact(firstQa, 'release', { released: true, no_further_writes: true });
      await fx.tick();
      assert.notEqual(fx.current().attempt_id, original.attempt_id);
      assert.equal(fx.current().retry_category, 'review');
      await fx.reopen();
      fx.complete(fx.current());
      await fx.tick();
      fx.complete(fx.current('p1', 'qa'));
      await fx.tick();

      if (evidence !== 'early-release') {
        await fx.tick(fx.sample([], { complete: false, error: 'historical process probe failed' }));
        const unresolved = fx.runtime.store.read().phases.p1.roles.impl.attempts[0];
        assert.equal(unresolved.reservation.state, 'held', 'unknown evidence cannot close a historical attempt');
        assert.equal(unresolved.health.engine.state, 'unknown');
      }
      const before = fx.runtime.store.read();
      const { roles: beforeRoles, ...beforeProgress } = before.phases.p1;
      assert.equal(beforeProgress.status, 'completed');
      assert.deepEqual(beforeProgress.review_history.map((row) => row.verdict), ['fail', 'pass']);
      assert.equal(fx.calls.length, 4);
      const historical = beforeRoles.impl.attempts[0];
      assert.equal(historical.reservation.state, evidence === 'early-release' ? 'released' : 'held');
      if (evidence !== 'early-release') {
        assert.throws(() => fx.runtime.store.rerun({
          expectedRevision: before.revision, accepted: before.accepted,
        }), /closure/);
      }

      fs.writeFileSync(original.artifacts.heartbeat, '{');
      fs.writeFileSync(original.artifacts.checkpoint, '{');
      let sample = fx.sample();
      let adapterClosures = 0;
      if (evidence === 'late-release') {
        fx.artifact(original, 'release', { released: true, no_further_writes: true });
      } else if (evidence === 'process-death') {
        sample = fx.sample(sample.processes.filter((process) => process.pid !== historical.engine_process.pid));
      } else if (evidence === 'adapter-closure') {
        sample = fx.sample([], { complete: false, error: 'fixture process table unavailable' });
        fx.adapter.reconcile = async (attempt, { observe }) => {
          assert.equal(attempt.attempt_id, original.attempt_id);
          adapterClosures++;
          await observe({ ...identity(attempt), id: 'historical-closure', kind: 'closure',
            launch_settled: true, engine_closed: true, descendants_closed: true });
        };
      }
      await fx.reopen();
      await fx.tick(sample);
      const after = fx.runtime.store.projectOutbox({ expectedRevision: fx.runtime.store.read().revision });
      const { roles: afterRoles, ...afterProgress } = after.phases.p1;
      const released = afterRoles.impl.attempts[0];
      assert.equal(released.reservation.state, 'released');
      assert.equal(released.reservation.closure.type, evidence === 'process-death' ? 'process_closure'
        : evidence === 'adapter-closure' ? 'adapter_closure' : 'cooperative_release');
      assert.deepEqual(afterProgress, beforeProgress);
      for (const [role, previous] of Object.entries(beforeRoles)) {
        const current = afterRoles[role];
        assert.equal(current.current_attempt_id, previous.current_attempt_id);
        assert.deepEqual(current.budgets, previous.budgets);
        assert.deepEqual(current.attempts.map((attempt) => [attempt.attempt_id, attempt.status, attempt.outcome]),
          previous.attempts.map((attempt) => [attempt.attempt_id, attempt.status, attempt.outcome]));
        assert.deepEqual(current.attempts.at(-1), previous.attempts.at(-1));
      }
      for (const kind of ['completion', 'verdict', 'heartbeat', 'checkpoint']) {
        assert.deepEqual(released.evidence[kind], historical.evidence[kind]);
      }
      assert.deepEqual(released.diagnostics, historical.diagnostics);
      assert.equal(released.reported_status, historical.reported_status);
      assert.equal(adapterClosures, evidence === 'adapter-closure' ? 1 : 0);
      assert.equal(fx.calls.length, 4);
      await fx.reopen();
      await fx.tick(sample);
      assert.deepEqual(fx.runtime.store.read(), after, 'replayed closure remains idempotent after restart');
      assert.equal(adapterClosures, evidence === 'adapter-closure' ? 1 : 0);
      await fx.close();
      await fx.open({ rerun: true });
      assert.notEqual(fx.runtime.state.run_id, before.run_id);
      assert.deepEqual(fx.runtime.state.history.at(-1).phases, after.phases);
      assert.equal(fx.calls.length, 4);
    });
  }
});

test('U2 bounded artifacts reject oversized data and path redirection without dispatch or authority escalation', async (t) => {
  const fx = await fixture(t, { review: true });
  await fx.tick();
  const a = fx.current();
  fs.writeFileSync(a.artifacts.completion, 'x'.repeat(require('./attempt-lifecycle').MAX_ARTIFACT_BYTES + 1));
  await fx.tick();
  assert.equal(fx.current().status, 'needs_operator');
  assert.match(fx.current().diagnostics.completion, /bounded/);
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

test('U2 correction: dispatch and late correlation fence negative samples across restart', async (t) => {
  const fx = await fixture(t);
  const beforeLaunch = fx.sample([]);
  await fx.tick(beforeLaunch);
  const first = fx.current();
  for (const reopen of [false, true]) {
    if (reopen) await fx.reopen();
    await fx.tick(beforeLaunch);
    assert.equal(fx.current().attempt_id, first.attempt_id);
    assert.equal(fx.current().reservation.state, 'held');
    assert.equal(fx.calls.length, 1);
  }
  const death = fx.sample([]);
  await fx.tick(death);
  const replacement = fx.current();
  assert.notEqual(replacement.attempt_id, first.attempt_id);
  await fx.reopen();
  await fx.tick(death);
  assert.equal(fx.current().attempt_id, replacement.attempt_id);
  assert.equal(fx.current().reservation.state, 'held');
  assert.equal(fx.calls.length, 2);

  const late = await fixture(t, { launch: async () => {} });
  await late.tick();
  const old = late.sample([]);
  const engine = { ...processIdentity(4567), creation_time: old.observed_at };
  late.adapter.reconcile = async (a, { observe }) => {
    await observe({ ...identity(a), id: 'late-session', kind: 'session', session_id: 'late', process: engine });
    await observe({ ...identity(a), id: 'late-submission', kind: 'submission', acknowledged: true });
    await observe({ ...identity(a), id: 'late-descendants', kind: 'descendants', processes: [], complete: true });
  };
  await late.tick(old);
  const correlated = late.current();
  assert.equal(correlated.reservation.state, 'held');
  assert.equal(correlated.outcome, undefined);
  await late.reopen();
  await late.tick(old);
  assert.equal(late.calls.length, 1);
  assert.equal(late.current().attempt_id, correlated.attempt_id);
  await late.tick(late.sample([engine]));
  assert.equal(late.current().status, 'running');
});

test('U2 correction: final admitted launch and execution retries resume without another charge', async (t) => {
  for (const category of ['launch', 'execution']) {
    for (const boundary of ['after_intent', 'after_reservation']) {
      await t.test(`${category}-${boundary}`, async (t) => {
        let interrupt = false;
        const fx = await fixture(t, {
          ...(category === 'launch' ? { launch: async (a, observe) => observe({
            ...identity(a), id: 'failed', kind: 'launch_failed', no_external_effect: true, reason: 'rejected',
          }) } : {}),
          fault(point) { if (interrupt && point === boundary) { interrupt = false; throw new Error('final retry interruption'); } },
        });
        await fx.tick();
        await fx.tick(fx.sample([]));
        interrupt = true;
        await assert.rejects(fx.tick(fx.sample([])), /final retry/);
        const queued = fx.current();
        assert.equal(queued.status, 'queued');
        assert.equal(fx.runtime.store.read().phases.p1.roles.impl.budgets[category], 2);
        await fx.reopen();
        await fx.tick(fx.sample([]));
        assert.equal(fx.current().attempt_id, queued.attempt_id);
        assert.equal(fx.calls.length, 3);
        assert.notEqual(fx.current().status, 'queued');
        for (let i = 0; i < 2; i++) await fx.tick(fx.sample([]));
        assert.equal(fx.calls.length, 3);
        assert.equal(fx.runtime.store.read().phases.p1.roles.impl.budgets[category], 2);
      });
    }
  }
});

test('U2 correction: terminal outcomes accept only additive closure accounting until release', async (t) => {
  for (const completed of [true, false]) {
    for (const kind of ['closure', 'descendants']) {
      await t.test(`${completed}-${kind}`, async (t) => {
        const fx = await fixture(t, { launch: async (a, observe) => {
          await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'session', process: processIdentity(4321) });
          await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
        } });
        await fx.tick();
        fx.pause(true);
        if (completed) fx.complete(fx.current(), false);
        await fx.tick(completed ? fx.sample() : fx.sample([]));
        const terminal = fx.current();
        assert.ok(terminal.outcome);
        assert.equal(terminal.reservation.state, 'held');
        await fx.reopen();
        fx.adapter.reconcile = async (a, { observe }) => observe({
          ...identity(a), id: 'too-late-submission', kind: 'submission', acknowledged: true,
        });
        await assert.rejects(fx.tick(fx.sample([])), /terminal|closure|active/);
        fx.adapter.reconcile = async (a, { observe }) => observe({
          ...identity(a), id: 'closed', kind,
          ...(kind === 'closure' ? { launch_settled: true, engine_closed: true, descendants_closed: true } : { processes: [], complete: true }),
        });
        await fx.tick(fx.sample([]));
        assert.equal(fx.current().reservation.state, 'released');
        assert.deepEqual(fx.current().outcome, terminal.outcome);
        assert.deepEqual(fx.current().engine_process, terminal.engine_process);
        assert.deepEqual(fx.current().submission, terminal.submission);
        assert.equal(fx.calls.length, 1);
      });
    }
  }
});

test('U2 correction: queued dispatch revalidates capabilities before publishing prompts or launching', async (t) => {
  for (const capability of ['engines', 'read_only_enforced']) {
    await t.test(capability, async (t) => {
      let interrupt = true;
      const fx = await fixture(t, {
        readOnly: true,
        phases: [{ id: 'p1', agent: { role: 'impl', access: 'read-only' }, completion_signal: 'done.md' }],
        fault(point) { if (interrupt && point === 'after_intent') { interrupt = false; throw new Error('queued interruption'); } },
      });
      await assert.rejects(fx.tick(), /queued interruption/);
      const queued = fx.current();
      fx.adapter.capabilities[capability] = capability === 'engines' ? ['claude'] : false;
      await fx.reopen();
      await assert.rejects(fx.tick(), /cannot enforce/);
      assert.equal(fx.calls.length, 0);
      assert.equal(fs.existsSync(queued.artifacts.prompt), false);
      assert.equal(fx.current().status, 'queued');
    });
  }
});

test('U2 correction: queued intents refresh boot identity only at the launch boundary', async (t) => {
  for (const boundary of ['after_intent', 'after_reservation']) {
    await t.test(boundary, async (t) => {
      let interrupt = true;
      const boot = { hostname: HOST.hostname.toUpperCase(), host_boot_id: 'boot-2' };
      const engine = { ...processIdentity(4567), ...boot };
      const fx = await fixture(t, { launch: async (a, observe) => {
        await observe({ ...identity(a), id: 'session', kind: 'session', session_id: 'new-boot', process: engine });
        await observe({ ...identity(a), id: 'submission', kind: 'submission', acknowledged: true });
        await observe({ ...identity(a), id: 'descendants', kind: 'descendants', processes: [], complete: true });
      }, fault(point) {
        if (interrupt && point === boundary) { interrupt = false; throw new Error('queued reboot'); }
      } });
      await assert.rejects(fx.tick(), /queued reboot/);
      const queued = fx.current();
      await fx.reopen();
      await fx.tick(fx.sample([], boot));
      assert.equal(fx.current().attempt_id, queued.attempt_id);
      assert.equal(fx.current().launch_host.host_boot_id, 'boot-2');
      assert.equal(fx.current().reservation.state, 'held');
      assert.equal(fx.calls.length, 1);
      const child = { ...processIdentity(4568), ...boot, hostname: HOST.hostname, parent_pid: engine.pid };
      await fx.tick(fx.sample([engine, child], { ...boot, hostname: HOST.hostname }));
      assert.equal(fx.current().status, 'running');
      assert.equal(fx.current().descendants.length, 1);
      assert.equal(fx.current().reservation.state, 'held');
      await fx.reopen();
      await fx.tick(fx.sample([engine, child], boot));
      assert.equal(fx.calls.length, 1);
      assert.equal(fx.current().descendants.length, 1, 'hostname casing cannot duplicate a tracked child');
      const state = fx.runtime.store.read();
      assert.throws(() => fx.runtime.store.transact({
        expectedRevision: state.revision, command: { id: 'change-boot', payload: {} },
        mutate(draft) { draft.phases.p1.roles.impl.attempts[0].launch_host.host_boot_id = 'boot-3'; return { result: {}, events: [] }; },
      }), /immutable/);
    });

  }
});

test('U2 correction: worker artifact EIO stays an explicit infrastructure failure', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const a = fx.current();
  const original = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === a.artifacts.completion) throw Object.assign(new Error('artifact storage EIO'), { code: 'EIO' });
    return original(file, ...args);
  });
  try { await assert.rejects(fx.tick(), /artifact storage EIO/); }
  finally { open.mock.restore(); }
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.current().reservation.state, 'held');
});

test('U2 correction: malformed worker reports isolate attempts and repaired reports can reconcile', async (t) => {
  const fx = await fixture(t, { readOnly: true, phases: [
    { id: 'p1', agent: { role: 'impl', access: 'read-only' }, completion_signal: 'a.md' },
    { id: 'p2', agent: { role: 'impl', access: 'read-only' }, completion_signal: 'b.md' },
  ] });
  await fx.tick();
  const a = fx.current();
  fx.complete(fx.current('p2'));
  for (const text of ['{"schema_version":', '---\nstatus: [\n---\n', '---\nstatus: complete\n',
    'x'.repeat(require('./attempt-lifecycle').MAX_ARTIFACT_BYTES + 1),
    JSON.stringify({ schema_version: 2, ...identity(a), kind: 'completion', observed_at: { toString: null }, status: 'complete' })]) {
    fs.writeFileSync(a.artifacts.completion, text);
    await fx.tick(fx.sample([]));
    assert.equal(fx.current().status, 'needs_operator');
    assert.ok(fx.current().diagnostics.completion);
    assert.equal(fx.current().outcome, undefined);
    assert.equal(fx.runtime.store.read().phases.p2.status, 'completed');
    assert.equal(fx.calls.length, 2);
  }
  await fx.reopen();
  fx.complete(a);
  await fx.tick(fx.sample([]));
  assert.equal(fx.current().status, 'completed');
  assert.equal(fx.current().diagnostics.completion, undefined);
});

test('U2 correction: progress churn reserves terminal history and bounds health-only persistence', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const initial = fx.runtime.store.read();
  const a = fx.current();
  for (let i = 0; i < 70; i++) {
    fx.artifact(a, 'heartbeat', { message: `heartbeat-${i}` });
    fx.artifact(a, 'checkpoint', { message: `checkpoint-${i}` });
    await fx.tick();
  }
  const progress = fx.runtime.store.read();
  assert.equal(fx.current().evidence_history.length, 0);
  assert.ok(fx.current().evidence.heartbeat);
  assert.ok(fx.current().evidence.checkpoint);
  assert.deepEqual(progress.command_results, initial.command_results);
  assert.equal(progress.next_event_sequence, initial.next_event_sequence);
  const legacy = Array.from({ length: 64 }, (_, index) => ({
    ...fx.current().evidence.heartbeat,
    sha256: require('node:crypto').createHash('sha256').update(`legacy-progress-${index}`).digest('hex'),
  }));
  fx.runtime.store.transactInternal({
    expectedRevision: progress.revision,
    mutate(draft) {
      draft.phases.p1.roles.impl.attempts[0].evidence_history.push(...legacy);
      return { result: {}, events: [] };
    },
  });
  await fx.reopen();
  fx.complete(a);
  await fx.tick();
  assert.equal(fx.current().status, 'completed');
  assert.equal(fx.current().reservation.state, 'released');
  assert.deepEqual(fx.current().evidence_history.slice(0, 64), legacy, 'pre-upgrade progress history remains immutable');
  assert.deepEqual(fx.current().evidence_history.slice(64).map((e) => e.kind), ['completion', 'release']);
  const terminal = fx.current();
  await fx.reopen();
  await fx.tick();
  assert.deepEqual(fx.current(), terminal);
  assert.ok(fx.runtime.store.read().next_event_sequence > progress.next_event_sequence);
  assert.equal(fx.runtime.store.read().outbox.length, 0);
});

test('U2 correction: incomplete QA and invalid verification rows never trigger automatic recovery', async (t) => {
  for (const status of ['partial', 'blocked', 'complete']) {
    for (const verification of [undefined, [null], ['invalid'], []]) {
      await t.test(`${status}-${JSON.stringify(verification)}`, async (t) => {
        const fx = await fixture(t, { review: true });
        await fx.tick();
        fx.complete(fx.current());
        await fx.tick();
        const qa = fx.current('p1', 'qa');
        fx.artifact(qa, 'completion', { status });
        if (verification) fx.artifact(qa, 'verdict', { verdict: 'pass', verification });
        await fx.tick();
        assert.equal(fx.current('p1', 'qa').status, 'needs_operator');
        await fx.reopen();
        await fx.tick(fx.sample([]));
        assert.equal(fx.current('p1', 'qa').status, 'needs_operator');
        assert.equal(fx.current('p1', 'qa').outcome, undefined);
        assert.equal(fx.calls.length, 2);
        assert.deepEqual(fx.runtime.store.read().phases.p1.roles.qa.budgets, { launch: 0, execution: 0 });
        assert.equal(fx.runtime.store.read().phases.p1.review_iteration, 0);
        if (status === 'complete') {
          fx.complete(qa);
          await fx.tick(fx.sample([]));
          assert.equal(fx.current('p1', 'qa').status, 'completed', 'corrected verdicts reconcile without a new attempt');
          assert.equal(fx.calls.length, 2);
        }
      });
    }
  }
});

test('U2 correction: coordinator receives accepted upstream identity, path and hash in persisted prompt', async (t) => {
  const fx = await fixture(t, { phases: [
    { id: 'a', agent: { role: 'impl' }, completion_signal: 'a.md' },
    { id: 'b', depends_on: ['a'], agent: { role: 'coord' }, completion_signal: 'b.md' },
  ] });
  await fx.tick();
  const upstream = fx.current('a');
  fx.complete(upstream);
  await fx.tick();
  const evidence = fx.current('a').evidence.completion;
  const coord = fx.current('b', 'coord');
  for (const value of [evidence.path, evidence.sha256, upstream.attempt_id]) assert.ok(coord.intent.prompt_text.includes(value), value);
  assert.equal(fs.readFileSync(coord.artifacts.prompt, 'utf8'), coord.intent.prompt_text);
  await fx.reopen();
  await fx.tick();
  assert.equal(fx.current('b', 'coord').intent.prompt_text, coord.intent.prompt_text);
  assert.equal(fx.calls.length, 2);
});

test('U2 correction: a stale live table does not contradict later adapter closure', async (t) => {
  const fx = await fixture(t);
  await fx.tick();
  const live = fx.sample();
  await fx.tick(live);
  fx.pause(true);
  fx.adapter.reconcile = async (a, { observe }) => observe({
    ...identity(a), id: 'closure', kind: 'closure',
    launch_settled: true, engine_closed: true, descendants_closed: true,
  });
  await fx.tick(live);
  assert.equal(fx.current().reservation.state, 'released');
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
  assert.deepEqual(fx.runtime.state, fx.runtime.store.read());
  await fx.tick();
  assert.deepEqual(fx.calls.map((attempt) => attempt.phase_id), ['a', 'b']);
});
