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
  const next = fx.store.rerun({ expectedRevision: first.revision, accepted: fx.accepted });
  assert.notEqual(next.run_id, first.run_id);
  assert.equal(next.revision, 2);
  const { history, ...historical } = first;
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
