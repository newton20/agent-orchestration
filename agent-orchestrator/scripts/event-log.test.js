'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const P = require('./parse-manifest');
const W = require('./workspace-owner');
const S = require('./state-store');
const E = require('./event-log');

async function setup(t, options = {}) {
  const fx = runtimeFixture(t);
  const accepted = P.prepareV2Manifest(fx.manifest, fx.manifestPath);
  const owner = await W.acquireWorkspaceOwner(accepted.workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  const store = S.createStateStore({ manifestPath: fx.manifestPath, owner, ...options });
  const state = store.initialize(accepted);
  const file = E.eventLogPath(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { ...fx, accepted, owner, store, state, file };
}

function append(store, count = 1, payload = {}) {
  return store.transactInternal({
    expectedRevision: store.read().revision,
    mutate: () => ({ result: {}, events: Array.from({ length: count }, () => ({ type: 'paused', payload })) }),
  });
}

function logFixture(t, count = 1, payload = {}) {
  const fx = runtimeFixture(t);
  const { workspace } = P.prepareV2Manifest(fx.manifest, fx.manifestPath);
  const runId = 'event-fixture';
  const events = Array.from({ length: count }, (_, index) => ({
    run_id: runId, event_id: `${runId}:${index + 1}`, sequence: index + 1,
    revision: 1, type: 'paused', payload,
  }));
  const state = {
    run_id: runId, workspace, revision: 1, next_event_sequence: count + 1, outbox: events,
    projection: { acknowledged_sequence: 0, retained_through: 0 },
  };
  const file = E.eventLogPath(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { ...fx, state, events, file };
}

function acknowledge(state) {
  return { ...state, outbox: [], projection: {
    ...state.projection, acknowledged_sequence: state.next_event_sequence - 1,
  } };
}

test('U4 projects only committed events, acknowledges once and reconnects by stable cursor', async (t) => {
  const fx = await setup(t);
  append(fx.store, 2);
  const before = fx.store.read();
  const state = fx.store.projectOutbox({ expectedRevision: before.revision });
  assert.equal(state.outbox.length, 0);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.projection.status, 'healthy');
  const page = E.readEvents({ state, limit: 2 });
  assert.deepEqual(page.events, before.outbox.slice(0, 2));
  assert.equal(page.has_more, true);
  const tail = E.readEvents({ state, after: page.cursor });
  assert.deepEqual(tail.events, before.outbox.slice(2));
  assert.equal(tail.cursor, `${state.run_id}:3`);
  assert.equal(tail.history.status, 'complete');
  assert.deepEqual(fx.store.projectOutbox({ expectedRevision: state.revision }), state);
});

for (const point of ['before_append', 'after_append', 'before_acknowledge']) {
  test(`U4 crash ${point} replays committed intent exactly once`, async (t) => {
    const fx = await setup(t, { _projectionFault: (at) => { if (at === point) throw new Error(`crash ${at}`); } });
    append(fx.store);
    const before = fx.store.read();
    assert.throws(() => fx.store.projectOutbox({ expectedRevision: before.revision }), /crash/);
    assert.deepEqual(fx.store.read(), before);
    const resumed = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner });
    const state = resumed.projectOutbox({ expectedRevision: before.revision });
    assert.deepEqual(E.readEvents({ state }).events, before.outbox);
    assert.equal(fs.readFileSync(fx.file, 'utf8').trim().split('\n').length, 2);
  });
}

test('U4 repairs only a pending event prefix; complete or interior corruption remains untouched', async (t) => {
  const fx = await setup(t);
  append(fx.store);
  const pending = fx.store.read();
  const line = JSON.stringify(pending.outbox[0]) + '\n';
  fs.writeFileSync(fx.file, line + JSON.stringify(pending.outbox[1]).slice(0, -5));
  const projected = fx.store.projectOutbox({ expectedRevision: pending.revision });
  assert.deepEqual(E.readEvents({ state: projected }).events, pending.outbox);
  assert.equal(projected.projection.status, 'healthy');
  for (const corrupt of [line + '{bad}', line + '{bad}\n', '{bad}\n' + line, line + '{"sequence":2}', line + '{"sequence":']) {
    fs.writeFileSync(fx.file, corrupt);
    const state = fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
    assert.equal(state.projection.status, 'degraded');
    assert.equal(fs.readFileSync(fx.file, 'utf8'), corrupt);
    const page = E.readEvents({ state });
    assert.equal(page.history.status, 'degraded');
    assert.equal(page.reset_required, true);
    assert.deepEqual(page.events, []);
  }
});

test('U4 a complete JSON record without its final newline survives repair', async (t) => {
  const fx = await setup(t);
  fs.writeFileSync(fx.file, JSON.stringify(fx.state.outbox[0]));
  const state = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  assert.deepEqual(E.readEvents({ state }).events, fx.state.outbox);
  assert.ok(fs.readFileSync(fx.file, 'utf8').endsWith('\n'));
});

test('U4 deleting drained history yields a gap, never reconstruction or state rollback', async (t) => {
  const fx = await setup(t);
  let state = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  fs.unlinkSync(fx.file);
  state = fx.store.projectOutbox({ expectedRevision: state.revision });
  assert.equal(state.next_event_sequence, 2);
  assert.equal(state.outbox.length, 0);
  const page = E.readEvents({ state, after: `${state.run_id}:1` });
  assert.equal(page.history.status, 'gap');
  assert.equal(page.reset_required, true);
  assert.deepEqual(page.events, []);
  assert.equal(fs.existsSync(fx.file) ? fs.readFileSync(fx.file, 'utf8') : '', '');
  append(fx.store);
  state = fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  assert.deepEqual(E.readEvents({ state }).events.map((e) => e.sequence), [2]);
  assert.deepEqual(E.readEvents({ state }).history.gaps.map(({ from, to }) => [from, to]), [[1, 1]]);
});

test('U4 projection errors persist degraded status and retain the bounded pending outbox', async (t) => {
  const fx = await setup(t, { _eventFs: {
    openSync: (file, flags, ...args) => {
      if (flags === 'a') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.openSync(file, flags, ...args);
    },
  } });
  const state = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  assert.equal(state.projection.status, 'degraded');
  assert.equal(state.projection.diagnostic.code, 'ENOSPC');
  assert.deepEqual(state.outbox, fx.state.outbox);
  append(fx.store, E.MAX_OUTBOX_EVENTS - 1);
  const full = fx.store.read();
  assert.throws(() => append(fx.store), /outbox|backpressure/i);
  assert.deepEqual(fx.store.read(), full);
});

test('U4 event and outbox byte limits reject a whole transition before publication', async (t) => {
  const fx = await setup(t);
  assert.throws(() => append(fx.store, 1, { text: 'x'.repeat(E.MAX_EVENT_BYTES) }), /event.*limit/i);
  const before = fx.store.read();
  const payload = { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) };
  assert.throws(() => append(fx.store, Math.ceil(E.MAX_OUTBOX_BYTES / (E.MAX_EVENT_BYTES - 1024)), payload), /outbox|backpressure/i);
  assert.deepEqual(fx.store.read(), before);
});

test('U4 retention is bounded and leaves visible gaps and unavailable-cursor fallback', async (t) => {
  const fx = await setup(t);
  let state;
  for (let i = 0; i < 4; i++) {
    append(fx.store, E.MAX_OUTBOX_EVENTS - 1);
    state = fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  }
  assert.ok(fs.statSync(fx.file).size <= E.RETAIN_LOG_BYTES);
  const all = fs.readFileSync(fx.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(all.length, E.RETAIN_LOG_EVENTS);
  const page = E.readEvents({ state, after: `${state.run_id}:1` });
  assert.equal(page.reset_required, true);
  assert.equal(page.history.status, 'gap');
  assert.deepEqual(page.events, []);
  const tail = E.readEvents({ state, after: all.at(-2).event_id });
  assert.deepEqual(tail.events, [all.at(-1)]);
  assert.equal(tail.reset_required, false);
  for (const after of ['bad', 'other:1', `${state.run_id}:999999`]) {
    assert.equal(E.readEvents({ state, after }).reset_required, true);
  }
  assert.throws(() => E.readEvents({ state, limit: E.MAX_READ_EVENTS + 1 }), /limit/);
});

test('U4 rejects conflicting replay, oversized logs and redirected files without repair', async (t) => {
  const fx = await setup(t);
  const different = { ...fx.state.outbox[0], payload: { forged: true } };
  fs.writeFileSync(fx.file, JSON.stringify(different) + '\n');
  let state = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  assert.equal(state.projection.status, 'degraded');
  assert.equal(state.outbox.length, 1);
  const conflict = E.readEvents({ state });
  assert.equal(conflict.history.diagnostic.code, 'EVENT_CONFLICT');
  assert.equal(conflict.reset_required, true);
  assert.deepEqual(conflict.events, []);
  fs.writeFileSync(fx.file, 'x'.repeat(E.MAX_LOG_BYTES + 1));
  assert.equal(E.readEvents({ state }).history.status, 'degraded');
  fs.unlinkSync(fx.file);
  const outside = path.join(fx.root, 'outside.jsonl');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, fx.file, 'file');
  assert.throws(() => E.readEvents({ state }), /redirected/);
  assert.throws(() => fx.store.projectOutbox({ expectedRevision: state.revision }), /redirected/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('U4 snapshot revision bounds an event read while a newer commit is projected', async (t) => {
  const fx = await setup(t);
  const older = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  append(fx.store);
  fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  const page = E.readEvents({ state: older });
  assert.equal(page.history.status, 'complete');
  assert.deepEqual(page.events.map((e) => e.sequence), [1]);
  assert.equal(page.latest_cursor, `${older.run_id}:1`);
});

test('U4 partial append and flush failures retry without acknowledging or duplicating events', async (t) => {
  for (const failure of ['partial_write', 'flush']) {
    const fx = await setup(t);
    append(fx.store, 2);
    const before = fx.store.read();
    const faulty = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner, _eventFs: {
      ...(failure === 'partial_write' ? {
        writeFileSync(fd, bytes) {
          fs.writeSync(fd, bytes.slice(0, bytes.indexOf('\n') + 10));
          throw Object.assign(new Error('interrupted append'), { code: 'EIO' });
        },
      } : { fsyncSync() { throw Object.assign(new Error('flush failed'), { code: 'EIO' }); } }),
    } });
    const degraded = faulty.projectOutbox({ expectedRevision: before.revision });
    assert.equal(degraded.projection.status, 'degraded');
    assert.deepEqual(degraded.outbox, before.outbox);
    const recovered = fx.store.projectOutbox({ expectedRevision: degraded.revision });
    assert.deepEqual(E.readEvents({ state: recovered }).events, before.outbox);
    assert.equal(fs.readFileSync(fx.file, 'utf8').trim().split('\n').length, 3);
  }
});

test('U4 failed acknowledgement leaves committed outbox recoverable from the flushed log', async (t) => {
  const fx = await setup(t);
  const faulty = S.createStateStore({ manifestPath: fx.manifestPath, owner: fx.owner,
    _fs: { renameSync() { throw new Error('ack publication failed'); } } });
  assert.throws(() => faulty.projectOutbox({ expectedRevision: fx.state.revision }), /ack publication failed/);
  assert.deepEqual(fx.store.read(), fx.state);
  const recovered = fx.store.projectOutbox({ expectedRevision: fx.state.revision });
  assert.deepEqual(E.readEvents({ state: recovered }).events, fx.state.outbox);
});

test('U4 missing history after a retained cursor requires snapshot fallback', async (t) => {
  const fx = await setup(t);
  append(fx.store, 2);
  const state = fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  const events = E.readEvents({ state }).events;
  fs.writeFileSync(fx.file, JSON.stringify(events[0]) + '\n');
  const page = E.readEvents({ state, after: events[0].event_id });
  assert.equal(page.reset_required, true);
  assert.equal(page.history.status, 'gap');
  assert.deepEqual(page.events, []);
});

test('U4 retained bytes and event response bytes have independent bounds', async (t) => {
  const fx = await setup(t);
  const payload = { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) };
  for (let i = 0; i < 5; i++) {
    append(fx.store, 60, payload);
    fx.store.projectOutbox({ expectedRevision: fx.store.read().revision });
  }
  const state = fx.store.read();
  const page = E.readEvents({ state, limit: E.MAX_READ_EVENTS });
  assert.ok(fs.statSync(fx.file).size <= E.RETAIN_LOG_BYTES);
  assert.ok(page.events.length < E.MAX_READ_EVENTS);
  assert.ok(Buffer.byteLength(page.events.map(E.eventLine).join('')) <= E.MAX_READ_BYTES);
  assert.equal(page.has_more, true);
  assert.equal(page.history.status, 'gap');
});

test('event module preserves malformed and unprovable unterminated tails', (t) => {
  const fx = logFixture(t);
  for (const tail of ['{bad}', '{"sequence":', '{"sequence":2}', 'null', '[]']) {
    fs.writeFileSync(fx.file, tail);
    const page = E.readEvents({ state: fx.state });
    assert.equal(page.history.status, 'degraded', tail);
    assert.notEqual(page.history.diagnostic.code, 'INCOMPLETE_TAIL', tail);
    assert.equal(page.reset_required, true);
    assert.deepEqual(page.events, []);
    assert.equal(fs.readFileSync(fx.file, 'utf8'), tail);
  }
  const acknowledged = acknowledge(fx.state);
  const partial = E.eventLine(fx.events[0]).slice(0, -5);
  fs.writeFileSync(fx.file, partial);
  const page = E.readEvents({ state: acknowledged });
  assert.equal(page.history.diagnostic.code, 'LOG_CORRUPTION');
  assert.deepEqual(page.history.gaps, [{ from: 1, to: 1, reason: 'missing_history' }]);
  assert.equal(fs.readFileSync(fx.file, 'utf8'), partial);
});

test('event module recognizes pending prefixes in canonical and fixture encoding at byte boundaries', (t) => {
  const fx = logFixture(t, 2, { text: 'café' });
  for (const serialize of [E.eventLine, (event) => JSON.stringify(event) + '\n']) {
    const complete = Buffer.from(serialize(fx.events[0]));
    const pending = Buffer.from(serialize(fx.events[1]));
    const end = pending.indexOf(Buffer.from('é')) + 1;
    fs.writeFileSync(fx.file, Buffer.concat([complete, pending.subarray(0, end)]));
    const page = E.readEvents({ state: fx.state });
    assert.equal(page.history.diagnostic.code, 'INCOMPLETE_TAIL');
    assert.equal(page.reset_required, true);
    assert.deepEqual(page.events, []);
  }
  fs.writeFileSync(fx.file, E.eventLine(fx.events[0]).slice(0, -5) + '\n' + E.eventLine(fx.events[1]));
  assert.equal(E.readEvents({ state: fx.state }).history.diagnostic.code, 'LOG_CORRUPTION');
});

test('event module never serves a conflicting pending payload and compares canonical content', (t) => {
  const fx = logFixture(t);
  fs.writeFileSync(fx.file, E.eventLine({ ...fx.events[0], payload: { forged: true } }));
  const page = E.readEvents({ state: fx.state });
  assert.equal(page.history.diagnostic.code, 'EVENT_CONFLICT');
  assert.equal(page.reset_required, true);
  assert.deepEqual(page.events, []);
  fs.writeFileSync(fx.file, JSON.stringify(Object.fromEntries(Object.entries(fx.events[0]).reverse())) + '\n');
  assert.deepEqual(E.readEvents({ state: fx.state }).events, fx.events);
});

const projectionIOCodes = ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE',
  'ENFILE', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EBUSY'];

test('event module exports the exact ordinary projection IO error allowlist', () => {
  for (const code of projectionIOCodes) assert.equal(E.isProjectionIOError({ code }), true, code);
  for (const error of [null, undefined, {}, new Error('bug'), { code: 'EINVAL' }, { code: 'ELOOP' },
    new E.EventLogError('LOG_CORRUPTION', 'invalid')]) {
    assert.equal(E.isProjectionIOError(error), false);
  }
});

for (const code of projectionIOCodes.filter((code) => code !== 'ENOENT')) {
  test(`event module degrades actual log open ${code} without losing snapshot fallback`, (t) => {
    const fx = logFixture(t);
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (file, flags, ...args) => {
      if (file === fx.file && flags === 'r') throw Object.assign(new Error('log read unavailable'), { code });
      return open(file, flags, ...args);
    });
    const page = E.readEvents({ state: fx.state });
    assert.equal(page.history.status, 'degraded');
    assert.equal(page.history.diagnostic.code, code);
    assert.equal(page.reset_required, true);
    assert.deepEqual(page.events, []);
    assert.equal(page.revision, fx.state.revision);
  });
}

test('event module reports a missing log as a gap and a directory log as degraded', (t) => {
  const fx = logFixture(t);
  assert.equal(E.readEvents({ state: fx.state }).history.status, 'gap');
  fs.mkdirSync(fx.file);
  const page = E.readEvents({ state: fx.state });
  assert.equal(page.history.status, 'degraded');
  assert.equal(page.reset_required, true);
  assert.deepEqual(page.events, []);
});

for (const code of ['EACCES', 'ENOTDIR', 'EIO']) {
  test(`event module does not translate artifact boundary ${code}`, (t) => {
    const fx = logFixture(t);
    const lstat = fs.lstatSync;
    const failure = Object.assign(new Error('artifact inspection failed'), { code });
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
      if (file === fx.file) throw failure;
      return lstat(file, ...args);
    });
    assert.throws(() => E.readEvents({ state: fx.state }), (error) => error === failure);
  });
}

for (const operation of ['fstatSync', 'readSync', 'closeSync']) {
  test(`event module degrades actual log ${operation} IO errors`, (t) => {
    const fx = logFixture(t);
    fs.writeFileSync(fx.file, E.eventLine(fx.events[0]));
    const open = fs.openSync;
    const original = fs[operation];
    let logFd;
    t.mock.method(fs, 'openSync', (file, flags, ...args) => {
      const fd = open(file, flags, ...args);
      if (file === fx.file && flags === 'r') logFd = fd;
      return fd;
    });
    t.mock.method(fs, operation, (fd, ...args) => {
      if (fd === logFd) {
        if (operation === 'closeSync') original(fd, ...args);
        throw Object.assign(new Error('log IO failed'), { code: 'EIO' });
      }
      return original(fd, ...args);
    });
    const page = E.readEvents({ state: fx.state });
    assert.equal(page.history.diagnostic.code, 'EIO');
    assert.equal(page.reset_required, true);
    assert.deepEqual(page.events, []);
  });
}

test('event module rethrows unrecognized log errors', (t) => {
  const fx = logFixture(t);
  const open = fs.openSync;
  const failure = Object.assign(new Error('unexpected IO contract'), { code: 'EINVAL' });
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === fx.file && flags === 'r') throw failure;
    return open(file, flags, ...args);
  });
  assert.throws(() => E.readEvents({ state: fx.state }), (error) => error === failure);
});

test('event module rejects redirected logs and unowned mutation', (t) => {
  const fx = logFixture(t);
  const outside = path.join(fx.root, 'outside.jsonl');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, fx.file, 'file');
  assert.throws(() => E.readEvents({ state: fx.state }), /redirected/);
  assert.throws(() => E.projectEvents({ state: fx.state, owner: {} }), /ownership/);
  assert.throws(() => E.compactEvents({ state: acknowledge(fx.state), owner: {}, events: [] }), /ownership/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('event module plans retention without trimming and honors persisted retention intent', (t) => {
  const fx = logFixture(t, E.RETAIN_LOG_EVENTS + 3);
  const state = acknowledge(fx.state);
  const bytes = fx.events.map(E.eventLine).join('');
  fs.writeFileSync(fx.file, bytes);
  const plan = E.planRetention({ state });
  assert.equal(plan.needed, true);
  assert.equal(plan.retained_through, 3);
  assert.deepEqual(plan.events, fx.events.slice(3));
  assert.equal(fs.readFileSync(fx.file, 'utf8'), bytes);
  state.projection.retained_through = 10;
  const retry = E.planRetention({ state });
  assert.equal(retry.retained_through, 10);
  assert.deepEqual(retry.events, fx.events.slice(10));
  assert.equal(retry.needed, true);
  assert.deepEqual(E.readEvents({ state, limit: 1 }).history.gaps, []);
  fs.writeFileSync(fx.file, retry.events.map(E.eventLine).join(''));
  const done = E.planRetention({ state });
  assert.equal(done.needed, false);
  assert.equal(done.retained_through, 10);
  assert.deepEqual(E.readEvents({ state }).history.gaps, [{ from: 1, to: 10, reason: 'retention' }]);
});

test('event module bounds retention bytes and refuses planning unacknowledged or oversized logs', (t) => {
  const fx = logFixture(t, 150, { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) });
  const state = acknowledge(fx.state);
  fs.writeFileSync(fx.file, fx.events.map(E.eventLine).join(''));
  assert.throws(() => E.planRetention({ state: fx.state }), /acknowledged/i);
  const plan = E.planRetention({ state });
  assert.equal(plan.needed, true);
  assert.ok(Buffer.byteLength(plan.events.map(E.eventLine).join('')) <= E.RETAIN_LOG_BYTES);
  assert.equal(plan.retained_through, plan.events[0].sequence - 1);
  fs.writeFileSync(fx.file, 'x'.repeat(E.MAX_LOG_BYTES + 1));
  assert.throws(() => E.planRetention({ state }), { code: 'LOG_LIMIT' });
});

test('event module retention preserves an honest gap after a crash or missing history', (t) => {
  const fx = logFixture(t, 10);
  const state = acknowledge(fx.state);
  state.projection.retained_through = 3;
  fs.writeFileSync(fx.file, fx.events.slice(5).map(E.eventLine).join(''));
  const plan = E.planRetention({ state });
  assert.deepEqual(plan, { retained_through: 3, events: fx.events.slice(5), needed: false });
  assert.deepEqual(E.readEvents({ state }).history.gaps, [
    { from: 1, to: 3, reason: 'retention' }, { from: 4, to: 5, reason: 'missing_history' },
  ]);
  fs.unlinkSync(fx.file);
  assert.deepEqual(E.planRetention({ state }), { retained_through: 3, events: [], needed: false });
});

test('event module append only returns the existing retention watermark', async (t) => {
  const fx = await setup(t);
  const events = Array.from({ length: E.RETAIN_LOG_EVENTS + 1 }, (_, index) => ({
    ...fx.state.outbox[0], sequence: index + 1, event_id: `${fx.state.run_id}:${index + 1}`,
  }));
  const state = { ...fx.state, next_event_sequence: events.length + 1, outbox: [events.at(-1)],
    projection: { ...fx.state.projection, acknowledged_sequence: events.length - 1, retained_through: 7 } };
  fs.writeFileSync(fx.file, events.slice(0, -1).map(E.eventLine).join(''));
  const result = E.projectEvents({ state, owner: fx.owner,
    io: { ...fs, renameSync() { assert.fail('append must not compact'); } } });
  assert.deepEqual(result, { acknowledged_sequence: events.length, retained_through: 7 });
  assert.deepEqual(fs.readFileSync(fx.file, 'utf8').trim().split('\n').map(JSON.parse), events);
  const acknowledged = acknowledge(state);
  const plan = E.planRetention({ state: acknowledged });
  acknowledged.projection.retained_through = plan.retained_through;
  E.compactEvents({ state: acknowledged, owner: fx.owner, events: plan.events });
  assert.deepEqual(fs.readFileSync(fx.file, 'utf8').trim().split('\n').map(JSON.parse), plan.events);
});

test('event module rejects append beyond the hard byte cap without compacting or changing the log', async (t) => {
  const fx = await setup(t);
  const events = [];
  let bytes = '';
  while (true) {
    const sequence = events.length + 1;
    const event = { ...fx.state.outbox[0], sequence, event_id: `${fx.state.run_id}:${sequence}`,
      payload: { text: 'x'.repeat(E.MAX_EVENT_BYTES - 1024) } };
    const line = E.eventLine(event);
    events.push(event);
    if (Buffer.byteLength(bytes + line) > E.MAX_LOG_BYTES) break;
    bytes += line;
  }
  fs.writeFileSync(fx.file, bytes);
  const state = { ...fx.state, next_event_sequence: events.length + 1, outbox: [events.at(-1)] };
  assert.throws(() => E.projectEvents({ state, owner: fx.owner }), { code: 'LOG_LIMIT' });
  assert.equal(fs.readFileSync(fx.file, 'utf8'), bytes);
});
