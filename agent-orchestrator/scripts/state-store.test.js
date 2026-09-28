'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const P = require('./parse-manifest');
const W = require('./workspace-owner');
const S = require('./state-store');

async function setup(t) {
  const fx = runtimeFixture(t);
  const accepted = P.prepareV2Manifest(fx.manifest, fx.manifestPath);
  const owner = await W.acquireWorkspaceOwner(accepted.workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  const store = S.createStateStore({ manifestPath: fx.manifestPath, owner });
  return { ...fx, accepted, owner, store };
}

test('U4 only the dedicated live-owned projection can acknowledge pending events', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  for (const field of ['outbox', 'next_event_sequence', 'projection']) {
    assert.throws(() => fx.store.transactInternal({
      expectedRevision: first.revision,
      mutate(draft) {
        draft[field] = field === 'outbox' ? [] : field === 'projection' ? { status: 'healthy' } : 100;
        return { result: {}, events: [] };
      },
    }), /immutable/);
  }
  assert.throws(() => fx.store.projectOutbox({ expectedRevision: 0 }), /revision/);
  await fx.owner.release();
  assert.throws(() => fx.store.projectOutbox({ expectedRevision: first.revision }), /owner|ownership/);
  assert.deepEqual(fx.store.read(), first);
});

test('U4 projection acknowledgement preserves canonical identities and rerun revision continuity', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const projected = fx.store.projectOutbox({ expectedRevision: first.revision });
  assert.deepEqual(projected.accepted, first.accepted);
  assert.deepEqual(projected.phases, first.phases);
  assert.deepEqual(projected.command_results, first.command_results);
  const next = fx.store.rerun({ expectedRevision: projected.revision, accepted: fx.accepted });
  assert.equal(next.revision, projected.revision + 1);
  assert.equal(next.outbox[0].sequence, 1);
  assert.notEqual(next.run_id, projected.run_id);
  const beforeHistory = next.history;
  const after = fx.store.projectOutbox({ expectedRevision: next.revision });
  assert.deepEqual(after.history, beforeHistory);
});

test('U4 rerun refuses undrained projection without archiving pending events', async (t) => {
  const fx = await setup(t);
  const state = fx.store.initialize(fx.accepted);
  assert.throws(() => fx.store.rerun({ expectedRevision: state.revision, accepted: fx.accepted }), /projection/);
  assert.deepEqual(fx.store.read(), state);
});

test('U4 retention intent survives a crash after trimming and append acknowledgements survive trim failures', async (t) => {
  const E = require('./event-log');
  for (const fault of ['after_retention', 'rename']) {
    const fx = await setup(t);
    fx.store.initialize(fx.accepted);
    const faulty = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
      _projectionFault: (point) => { if (fault === point) throw new Error('retention crash'); },
      _eventFs: fault === 'rename' ? {
        renameSync() { throw Object.assign(new Error('retention file busy'), { code: 'EBUSY' }); },
      } : {},
    });
    for (let i = 0; i < 2; i++) {
      fx.store.transactInternal({ expectedRevision: fx.store.read().revision,
        mutate: () => ({ result: {}, events: Array.from({ length: 255 }, () => ({ type: 'event', payload: {} })) }) });
      fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
    }
    fx.store.transactInternal({ expectedRevision: fx.store.read().revision,
      mutate: () => ({ result: {}, events: Array.from({ length: 3 }, () => ({ type: 'event', payload: {} })) }) });
    if (fault === 'after_retention') assert.throws(() => faulty.projectOutbox({ expectedRevision: fx.store.read().revision }), /retention crash/);
    else {
      const degraded = faulty.projectOutbox({ expectedRevision: fx.store.read().revision });
      assert.equal(degraded.projection.status, 'degraded');
      assert.equal(degraded.projection.diagnostic.code, 'EBUSY');
      assert.deepEqual(faulty.projectOutbox({ expectedRevision: degraded.revision }), degraded);
    }
    const persisted = fx.store.read();
    assert.equal(persisted.outbox.length, 0, 'flushed append remains acknowledged even if retention fails');
    assert.equal(persisted.projection.retained_through, 2);
    const recovered = fx.store.projectOutbox({ expectedRevision: persisted.revision });
    assert.equal(E.readEvents({ state: recovered }).history.gaps[0].reason, 'retention');
    assert.equal(recovered.projection.status, 'healthy');
  }
});

test('U4 stable projection errors do not churn revisions because temporary paths change', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const faulty = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _eventFs: { openSync() { throw Object.assign(new Error(`failure tmp-${Math.random()}`), { code: 'EACCES' }); } } });
  const degraded = faulty.projectOutbox({ expectedRevision: first.revision });
  assert.deepEqual(faulty.projectOutbox({ expectedRevision: degraded.revision }), degraded);
});

test('U4 physical retention recovery can succeed without a canonical revision change', async (t) => {
  const E = require('./event-log');
  const fx = await setup(t);
  fx.store.initialize(fx.accepted);
  for (let i = 0; i < 2; i++) {
    fx.store.transactInternal({ expectedRevision: fx.store.read().revision,
      mutate: () => ({ result: {}, events: Array.from({ length: 255 }, () => ({ type: 'event', payload: {} })) }) });
    fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  }
  fx.store.transactInternal({ expectedRevision: fx.store.read().revision,
    mutate: () => ({ result: {}, events: Array.from({ length: 3 }, () => ({ type: 'event', payload: {} })) }) });
  const interrupted = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _projectionFault(point) { if (point === 'before_retention') throw new Error('retention interrupted'); } });
  assert.throws(() => interrupted.projectOutbox({ expectedRevision: fx.store.read().revision }), /retention interrupted/);
  const before = fx.store.read();
  const file = E.eventLogPath(before);
  const bytes = fs.statSync(file).size;
  assert.equal(before.outbox.length, 0);
  assert.ok(before.projection.retained_through > 0);
  const after = fx.store.projectOutbox({ expectedRevision: before.revision });
  assert.ok(fs.statSync(file).size < bytes);
  assert.deepEqual(after, before, 'physical compaction is not guaranteed to publish a new state revision');
});

test('U4 recovered retention can drain pending events after the hard log cap is reached', async (t) => {
  const E = require('./event-log');
  const fx = await setup(t);
  fx.store.initialize(fx.accepted);
  const blocked = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _eventFs: { renameSync() { throw Object.assign(new Error('retention busy'), { code: 'EBUSY' }); } } });
  for (let i = 0; i < 5; i++) {
    fx.store.transactInternal({ expectedRevision: fx.store.read().revision, mutate: () => ({
      result: {}, events: Array.from({ length: 60 }, () => ({ type: 'event', payload: { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) } })),
    }) });
    blocked.projectOutbox({ expectedRevision: fx.store.read().revision });
  }
  assert.ok(fx.store.read().outbox.length > 0);
  const stalled = blocked.projectOutbox({ expectedRevision: fx.store.read().revision });
  assert.deepEqual(blocked.projectOutbox({ expectedRevision: stalled.revision }), stalled);
  for (let i = 0; i < 2; i++) fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  const recovered = fx.store.read();
  assert.equal(recovered.outbox.length, 0);
  assert.equal(recovered.projection.status, 'healthy');
  assert.ok(fs.statSync(E.eventLogPath(recovered)).size <= E.RETAIN_LOG_BYTES);
});

test('U4 a failed flush near the cap acknowledges its on-disk prefix before draining the rest', async (t) => {
  const E = require('./event-log');
  const fx = await setup(t);
  fx.store.initialize(fx.accepted);
  const append = (count) => fx.store.transactInternal({ expectedRevision: fx.store.read().revision,
    mutate: () => ({ result: {}, events: Array.from({ length: count }, () => ({
      type: 'event', payload: { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) },
    })) }) });
  const busy = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _eventFs: { renameSync() { throw Object.assign(new Error('retention busy'), { code: 'EBUSY' }); } } });
  for (let i = 0; i < 4; i++) {
    append(60);
    busy.projectOutbox({ expectedRevision: fx.store.read().revision });
  }
  append(20);
  const unflushed = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _eventFs: { fsyncSync() { throw Object.assign(new Error('flush failed'), { code: 'EIO' }); } } });
  unflushed.projectOutbox({ expectedRevision: fx.store.read().revision });
  append(20);
  const before = fx.store.read();
  assert.equal(before.outbox.length, 40);
  const prefix = fx.store.projectOutbox({ expectedRevision: before.revision });
  assert.equal(prefix.outbox.length, 20);
  assert.equal(prefix.projection.acknowledged_sequence, before.outbox[19].sequence);
  const recovered = fx.store.projectOutbox({ expectedRevision: prefix.revision });
  assert.equal(recovered.projection.status, 'healthy');
  assert.equal(recovered.outbox.length, 0);
  const events = [];
  let after = `${recovered.run_id}:${before.outbox[0].sequence - 1}`;
  for (;;) {
    const page = E.readEvents({ state: recovered, after, limit: E.MAX_READ_EVENTS });
    assert.equal(page.reset_required, false);
    events.push(...page.events);
    if (!page.has_more) break;
    after = page.cursor;
  }
  assert.deepEqual(events.map(S.fingerprint), before.outbox.map(S.fingerprint));
});

for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
  test(`U4 owner projection preserves artifact-boundary ${code} as a fatal error`, async (t) => {
    const fx = await setup(t);
    const state = fx.store.initialize(fx.accepted);
    const inspect = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
      if (file === require('node:path').join(state.workspace.root, 'docs')) {
        throw Object.assign(new Error('artifact boundary unavailable'), { code });
      }
      return inspect(file, ...args);
    });
    assert.throws(() => fx.store.projectOutbox({ expectedRevision: state.revision }), { code });
    assert.deepEqual(fx.store.read(), state);
  });
}

test('U1 state initializes, resumes without replacing accepted state, and reruns with immutable history', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  assert.equal(first.schema_version, 2);
  assert.equal(first.revision, 1);
  assert.equal(first.accepted.revision, 1);
  assert.equal(first.runtime_status, 'live_dispatch_disabled');
  assert.equal(first.operator.paused, false);
  assert.deepEqual(first.phases.p1.roles.impl, { current_attempt_id: null, attempts: [] });
  assert.equal(first.outbox[0].sequence, 1);
  assert.equal(first.outbox[0].event_id, `${first.run_id}:1`);
  assert.deepEqual(fx.store.initialize({ ...fx.accepted, manifest: { invalid: true } }), first);
  const projected = fx.store.projectOutbox({ expectedRevision: first.revision });
  const next = fx.store.rerun({ expectedRevision: projected.revision, accepted: fx.accepted });
  assert.notEqual(next.run_id, first.run_id);
  assert.equal(next.revision, projected.revision + 1);
  const { history, ...historical } = projected;
  assert.deepEqual(next.history[0], historical);
});

test('U1 command result, pause state and outbox publish together; dedup precedes revision fencing', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const command = { id: 'pause-1', payload: { type: 'pause', reason: 'operator' } };
  const mutate = (draft) => {
    draft.operator.paused = true;
    return { result: { ok: true }, events: [{ type: 'paused', payload: { reason: 'operator' } }] };
  };
  const response = fx.store.transact({ expectedRevision: 1, command, mutate });
  const state = fx.store.read();
  assert.equal(state.operator.paused, true);
  assert.equal(state.revision, 2);
  assert.deepEqual(state.command_results['pause-1'].response, response);
  assert.equal(state.outbox[1].revision, 2);
  assert.equal(state.outbox[1].event_id, `${first.run_id}:2`);
  assert.deepEqual(fx.store.transact({ expectedRevision: 1, command, mutate: () => assert.fail('duplicate executed') }), response);
  assert.throws(() => fx.store.transact({ expectedRevision: 2, command: { ...command, payload: { type: 'resume' } }, mutate }), /fingerprint|payload|reuse/i);
  assert.throws(() => fx.store.transact({ expectedRevision: 1, command: { ...command, id: 'other' }, mutate }), /revision/i);
  assert.equal(fx.store.read().revision, 2);
});

test('round4 rerun keeps imported V1 history in the current read contract', async (t) => {
  const fx = await setup(t);
  const legacy = { phases: { p1: { status: 'completed' } } };
  fs.writeFileSync(P.statusPathFor(fx.manifestPath), JSON.stringify(legacy));
  const first = fx.store.initialize(fx.accepted);
  const projected = fx.store.projectOutbox({ expectedRevision: first.revision });
  const next = fx.store.rerun({ expectedRevision: projected.revision, accepted: first.accepted });
  assert.deepEqual(next.legacy_history, [legacy]);
  assert.deepEqual(next.history[0].legacy_history, [legacy]);
});

for (const failure of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`U1 ${failure} failure leaves the complete previous record and no acknowledgement`, async (t) => {
    const fx = await setup(t);
    fx.store.initialize(fx.accepted);
    const bytes = fs.readFileSync(P.statusPathFor(fx.manifestPath), 'utf8');
    const store = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner, _fs: {
      [failure]: () => { throw new Error('injected ENOSPC'); },
    } });
    assert.throws(() => store.transact({
      expectedRevision: 1, command: { id: 'failing', payload: { type: 'pause' } },
      mutate: (draft) => { draft.operator.paused = true; return { result: { ok: true }, events: [{ type: 'paused', payload: {} }] }; },
    }), /ENOSPC/);
    assert.equal(fs.readFileSync(P.statusPathFor(fx.manifestPath), 'utf8'), bytes);
    assert.equal(fx.store.read().command_results.failing, undefined);
  });
}

test('U1 mutations need actual live ownership, reject async callbacks and protect immutable identities', async (t) => {
  const fx = await setup(t);
  fx.store.initialize(fx.accepted);
  assert.throws(() => S.createStateStore({ manifestPath: fx.manifestPath, owner: { ...fx.owner } }).initialize(fx.accepted), /owner|ownership/i);
  const transaction = { expectedRevision: 1, command: { id: 'bad', payload: {} } };
  assert.throws(() => fx.store.transact({ ...transaction, mutate: async () => ({ result: {}, events: [] }) }), /synchronous|async/i);
  assert.throws(() => fx.store.transact({ ...transaction, mutate: (draft) => {
    draft.run_id = 'replacement'; return { result: {}, events: [] };
  } }), /immutable|run_id/i);
  await fx.owner.release();
  assert.throws(() => fx.store.transact({ ...transaction, mutate: () => ({ result: {}, events: [] }) }), /owner|ownership/i);
});

test('U1 completed V1 imports read-only, active or malformed history and newer states fail without rewriting', async (t) => {
  const fx = await setup(t);
  const statusPath = P.statusPathFor(fx.manifestPath);
  for (const raw of ['{broken', '[]', 'null', 'schema_version: 3\nphases: {}', 'schema_version: 2\nphases: {}',
    'phases:\n  p1:\n    status: running\n', 'phases: {}']) {
    fs.writeFileSync(statusPath, raw);
    assert.throws(() => fx.store.initialize(fx.accepted), /state|schema|legacy|V1|corrupt|active/i);
    assert.equal(fs.readFileSync(statusPath, 'utf8'), raw);
  }
  const completed = { phases: { p1: { status: 'completed', pid: 7 } } };
  fs.writeFileSync(statusPath, yaml.dump(completed));
  const imported = fx.store.initialize(fx.accepted);
  assert.deepEqual(imported.legacy_history[0], completed);
  assert.equal(imported.phases.p1.status, 'pending');
  const bytes = fs.readFileSync(statusPath, 'utf8');
  const update = P.runUpdate(fx.manifestPath, 'p1', { status: 'running' }, { _loadedManifest: { ...fx.manifest, schema_version: 1 }, _loadedStatus: null });
  assert.equal(update.ok, false);
  assert.equal(fs.readFileSync(statusPath, 'utf8'), bytes);
});

test('U1 deep state corruption fails closed at both readers without rewriting', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const corruptions = [
    (record) => { record.operator.paused = 'yes'; },
    (record) => { record.accepted.revision = 0; },
    (record) => { record.accepted.phases[0].agents[0].engine = 'wrapper'; },
    (record) => { record.phases.p1.roles.impl.current_attempt_id = 'missing'; },
    (record) => { record.outbox[0].event_id = 'wrong'; },
    (record) => { record.outbox.push(record.outbox[0]); },
    (record) => { record.revision = Number.MAX_SAFE_INTEGER + 1; },
    (record) => { record.live_dispatch_enabled = true; },
  ];
  for (const corrupt of corruptions) {
    const record = structuredClone(first);
    corrupt(record);
    const bytes = JSON.stringify(record);
    fs.writeFileSync(P.statusPathFor(fx.manifestPath), bytes);
    assert.throws(() => fx.store.read(), /state|identity|workspace/i);
    assert.equal(P.loadStatus(fx.manifestPath).ok, false);
    assert.equal(fs.readFileSync(P.statusPathFor(fx.manifestPath), 'utf8'), bytes);
  }
});

test('U1 same-payload key order deduplicates and independent-store reentrancy is revision fenced', async (t) => {
  const fx = await setup(t);
  fx.store.initialize(fx.accepted);
  const other = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner });
  const mutate = () => ({ result: { ok: true }, events: [] });
  const command = { id: 'stable', payload: { type: 'pause', reason: 'operator' } };
  const response = fx.store.transact({ expectedRevision: 1, command, mutate });
  assert.deepEqual(other.transact({ expectedRevision: 1, command: { ...command, payload: { reason: 'operator', type: 'pause' } }, mutate }), response);
  assert.throws(() => fx.store.transact({
    expectedRevision: 2, command: { id: 'outer', payload: {} },
    mutate: () => {
      other.transact({ expectedRevision: 2, command: { id: 'inner', payload: {} }, mutate });
      return { result: { ok: true }, events: [] };
    },
  }), /fenc|revision/i);
  assert.ok(fx.store.read().command_results.inner);
  assert.equal(fx.store.read().command_results.outer, undefined);
});

test('U2 internal transactions retain atomicity and ownership without command dedup records', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const mutate = (draft) => {
    draft.process_diagnostic = { error: 'fixture unavailable' };
    return { result: {}, events: [] };
  };
  const result = fx.store.transactInternal({ expectedRevision: 1, mutate });
  assert.equal(result.revision, 2);
  assert.deepEqual(fx.store.read().command_results, {});
  assert.deepEqual(fx.store.read().outbox, first.outbox);
  assert.throws(() => fx.store.transactInternal({ expectedRevision: 1, mutate }), /revision/);
  assert.throws(() => fx.store.transactInternal({ expectedRevision: 2, mutate: async () => ({ result: {}, events: [] }) }), /synchronous/);
  const failing = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner, _fs: {
    renameSync() { throw new Error('internal EIO'); },
  } });
  assert.throws(() => failing.transactInternal({ expectedRevision: 2, mutate }), /internal EIO/);
  assert.equal(fx.store.read().revision, 2);
  await fx.owner.release();
  assert.throws(() => fx.store.transactInternal({ expectedRevision: 2, mutate }), /ownership|owner/);
});

function sealedBinding(state, { engine = 'agency-copilot', capabilities = {}, fields = {} } = {}) {
  const caps = {
    engine_version: 'copilot 1.2.3', agency_version: engine === 'claude' ? null : 'agency 2.0.0',
    help_sha256: 'a'.repeat(64), read_only_enforced: false, tracks_descendants: false, ...capabilities,
  };
  return S.sealExecutionBinding({
    binding_version: 1, binding_id: require('node:crypto').randomUUID(), run_id: state.run_id, engine,
    adapter_kind: 'engine', request: S.executionRequest(state, engine),
    executable: { path: 'C:\\Tools\\agency.exe', sha256: 'b'.repeat(64) },
    package: { root: 'C:\\Plugins\\agent-orchestrator', inventory_sha256: 'c'.repeat(64) },
    capabilities: caps, evidence: S.executionEvidence(engine, caps), bound_at: '2026-09-17T12:00:00.000Z',
    ...fields,
  });
}

test('U3 binding: the dedicated owner operation seals one immutable binding per engine and replays idempotently', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const binding = sealedBinding(first);
  assert.deepEqual(binding.request, { models: [], access: ['mutating'], permission_mode: 'default', shell: 'powershell' });
  assert.deepEqual(binding.evidence, {
    executable: 'known', package: 'known', engine_version: 'known', agency_version: 'known', capability_help: 'known',
    read_only_enforcement: 'missing', descendant_tracking: 'missing', live_acceptance: 'missing',
  });
  const response = fx.store.bindExecution({ expectedRevision: first.revision, binding });
  assert.deepEqual(response, { revision: first.revision + 1, result: { binding_id: binding.binding_id, replayed: false } });
  const bound = fx.store.read();
  assert.deepEqual(bound.execution_bindings, { 'agency-copilot': binding });
  const event = bound.outbox.at(-1);
  assert.equal(event.type, 'execution_bound');
  assert.deepEqual(event.payload, { engine: 'agency-copilot', binding_id: binding.binding_id, binding_sha256: binding.binding_sha256 });
  assert.equal(JSON.stringify(bound.outbox).includes('agency.exe'), false, 'events carry identity, not executable paths');
  assert.deepEqual(fx.store.bindExecution({ expectedRevision: 1, binding: structuredClone(binding) }),
    { revision: bound.revision, result: { binding_id: binding.binding_id, replayed: true } });
  assert.equal(fx.store.read().revision, bound.revision, 'an identical replay publishes nothing');
  assert.throws(() => fx.store.bindExecution({ expectedRevision: bound.revision, binding: sealedBinding(bound) }), /immutable/);
  assert.throws(() => fx.store.bindExecution({ expectedRevision: bound.revision,
    binding: sealedBinding(bound, { capabilities: { engine_version: 'copilot 9.9.9' } }) }), /immutable/);
  assert.throws(() => fx.store.bindExecution({ expectedRevision: 1, binding: sealedBinding(bound, { engine: 'agency-claude' }) }), /revision/);
  await fx.owner.release();
  assert.throws(() => fx.store.bindExecution({ expectedRevision: bound.revision, binding }), /owner/);
  assert.deepEqual(fx.store.read(), bound);
});

test('U3 binding: generic transactions cannot create, change, or remove execution bindings', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const attempt = (mutate) => [
    () => fx.store.transactInternal({ expectedRevision: fx.store.read().revision, mutate(draft) { mutate(draft); return { result: {}, events: [] }; } }),
    () => fx.store.transact({ expectedRevision: fx.store.read().revision, command: { id: `c-${Math.random()}`.replace('.', ''), payload: {} },
      mutate(draft) { mutate(draft); return { result: {}, events: [] }; } }),
  ];
  for (const run of attempt((draft) => { draft.execution_bindings = { 'agency-copilot': sealedBinding(first) }; })) {
    assert.throws(run, /immutable/);
  }
  fx.store.bindExecution({ expectedRevision: first.revision, binding: sealedBinding(first) });
  const bound = fx.store.read();
  for (const mutate of [
    (draft) => { draft.execution_bindings['agency-copilot'].executable.sha256 = 'd'.repeat(64); },
    (draft) => { delete draft.execution_bindings['agency-copilot']; },
    (draft) => { delete draft.execution_bindings; },
    (draft) => { draft.execution_bindings['agency-claude'] = sealedBinding(bound, { engine: 'agency-claude' }); },
  ]) {
    for (const run of attempt(mutate)) assert.throws(run, /immutable/);
  }
  assert.deepEqual(fx.store.read(), bound);
});

test('U3 binding: strict schema rejects credentials, live claims, forged policy, unpinned paths, and unsealed records', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const reseal = (record) => { const { binding_sha256: _ignored, ...rest } = record; return S.sealExecutionBinding(rest); };
  const variants = [
    ['credential field', (b) => reseal({ ...b, environment: { AGENT_ORCHESTRATOR_TOKEN: 'secret' } })],
    ['credential in capabilities', (b) => reseal({ ...b, capabilities: { ...b.capabilities, token: 'secret' } })],
    ['live claim', (b) => reseal({ ...b, evidence: { ...b.evidence, live_acceptance: 'known' } })],
    ['inconsistent evidence', (b) => reseal({ ...b, evidence: { ...b.evidence, read_only_enforcement: 'known' } })],
    ['forged model policy', (b) => reseal({ ...b, request: { ...b.request, models: ['gpt-5'] } })],
    ['forged permission policy', (b) => reseal({ ...b, request: { ...b.request, permission_mode: 'bypassPermissions' } })],
    ['relative executable', (b) => reseal({ ...b, executable: { ...b.executable, path: 'agency.exe' } })],
    ['shell shim executable', (b) => reseal({ ...b, executable: { ...b.executable, path: 'C:\\Tools\\agency.cmd' } })],
    ['multi-line version', (b) => reseal({ ...b, capabilities: { ...b.capabilities, engine_version: 'copilot 1\nTOKEN=x' } })],
    ['missing Agency version', (b) => reseal({ ...b, capabilities: { ...b.capabilities, agency_version: null } })],
    ['wrong run', (b) => reseal({ ...b, run_id: 'other-run' })],
    ['wrong adapter kind', (b) => reseal({ ...b, adapter_kind: 'fixture' })],
    ['unsealed tamper', (b) => ({ ...b, package: { ...b.package, inventory_sha256: 'e'.repeat(64) } })],
    ['unselected engine', () => sealedBinding(first, { engine: 'claude' })],
  ];
  for (const [label, forge] of variants) {
    assert.throws(() => fx.store.bindExecution({ expectedRevision: first.revision, binding: forge(sealedBinding(first)) }),
      /invalid state/, label);
  }
  assert.deepEqual(fx.store.read(), first);
});

test('U3 binding: read-only policy requires enforced capability and a tampered persisted binding fails closed', async (t) => {
  const fx = await setup(t);
  fx.manifest.phases[0].agent.access = 'read-only';
  fs.writeFileSync(fx.manifestPath, yaml.dump(fx.manifest));
  const accepted = P.prepareV2Manifest(fx.manifest, fx.manifestPath);
  const first = fx.store.initialize(accepted);
  assert.deepEqual(S.executionRequest(first, 'agency-copilot').access, ['read-only']);
  assert.throws(() => fx.store.bindExecution({ expectedRevision: first.revision, binding: sealedBinding(first) }), /read-only/);
  const binding = sealedBinding(first, { capabilities: { read_only_enforced: true } });
  assert.equal(binding.evidence.read_only_enforcement, 'known');
  fx.store.bindExecution({ expectedRevision: first.revision, binding });
  const record = fx.store.read();
  const tampered = structuredClone(record);
  tampered.execution_bindings['agency-copilot'].executable.path = 'C:\\Other\\agency.exe';
  fs.writeFileSync(P.statusPathFor(fx.manifestPath), JSON.stringify(tampered));
  assert.throws(() => fx.store.read(), /invalid state/);
  fs.writeFileSync(P.statusPathFor(fx.manifestPath), JSON.stringify(record));
  assert.deepEqual(fx.store.read(), record);
});

test('U3 binding: failed publication and degraded projection return no binding', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const failing = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _fs: { renameSync() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  assert.throws(() => failing.bindExecution({ expectedRevision: first.revision, binding: sealedBinding(first) }), /publish/);
  assert.deepEqual(fx.store.read(), first);
  const E = require('./event-log');
  const projected = fx.store.projectOutbox({ expectedRevision: first.revision });
  fs.appendFileSync(E.eventLogPath(projected), '{bad}\n');
  const degraded = fx.store.projectOutbox({ expectedRevision: projected.revision });
  assert.equal(degraded.projection.status, 'degraded');
  assert.throws(() => fx.store.bindExecution({ expectedRevision: degraded.revision, binding: sealedBinding(degraded) }), /projection/);
  assert.equal(fx.store.read().execution_bindings, undefined);
});

test('U3 binding: rerun starts unbound while history keeps the prior run binding', async (t) => {
  const fx = await setup(t);
  const first = fx.store.initialize(fx.accepted);
  const binding = sealedBinding(first);
  fx.store.bindExecution({ expectedRevision: first.revision, binding });
  const projected = fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  const next = fx.store.rerun({ expectedRevision: projected.revision, accepted: fx.accepted });
  assert.equal(next.execution_bindings, undefined, 'an explicit new run must preflight and bind again');
  assert.deepEqual(next.history.at(-1).execution_bindings, { 'agency-copilot': binding });
  assert.throws(() => fx.store.bindExecution({ expectedRevision: next.revision, binding }), /invalid state/,
    'a prior run binding cannot be replayed into the new run');
});
