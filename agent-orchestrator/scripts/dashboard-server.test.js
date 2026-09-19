'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const contract = require('./test-support/dashboard-contract.json');
const { prepareV2Manifest, statusPathFor } = require('./parse-manifest');
const { validateState } = require('./state-store');
const { createSnapshot } = require('./read-model');
const { artifactPaths } = require('./attempt-lifecycle');
const { eventLogPath } = require('./event-log');
const W = require('./workspace-owner');
const D = require('./dashboard-server');

const TIME = '2026-09-17T12:00:00.000Z';

function fixture(t) {
  const cleanup = [];
  const fx = runtimeFixture({ after: (action) => cleanup.push(action) });
  fx.services = [];
  t.after(async () => {
    try { for (const stop of fx.services) await stop(); }
    finally { for (const action of cleanup) await action(); }
  });
  const accepted = { ...prepareV2Manifest(fx.manifest, fx.manifestPath), revision: 1 };
  const runId = randomUUID();
  fx.state = {
    schema_version: 2, revision: 1, run_id: runId, workspace: accepted.workspace, accepted,
    operator: { paused: false }, runtime_status: 'live_dispatch_disabled', live_dispatch_enabled: false,
    phases: { p1: { status: 'pending', review_iteration: 0, review_stage: 'impl',
      roles: { impl: { current_attempt_id: null, attempts: [] } } } },
    command_results: {}, outbox: [], next_event_sequence: 1, created_at: TIME, updated_at: TIME,
    history: [], legacy_history: [],
    projection: { status: 'healthy', acknowledged_sequence: 0, retained_through: 0, updated_at: TIME, diagnostic: null },
  };
  fx.write = () => {
    validateState(fx.state);
    const target = statusPathFor(fx.manifestPath);
    fs.writeFileSync(`${target}.test-tmp`, JSON.stringify(fx.state));
    fs.renameSync(`${target}.test-tmp`, target);
  };
  fx.event = (projected = true) => {
    const state = fx.state;
    const sequence = state.next_event_sequence++;
    const event = { sequence, event_id: `${state.run_id}:${sequence}`, run_id: state.run_id,
      revision: ++state.revision, type: sequence === 1 ? 'run_created' : 'paused', payload: {} };
    if (projected) {
      fs.mkdirSync(path.dirname(eventLogPath(state)), { recursive: true });
      fs.appendFileSync(eventLogPath(state), JSON.stringify(event) + '\n');
      state.projection.acknowledged_sequence = sequence;
    } else state.outbox.push(event);
    fx.write();
    return event;
  };
  fx.project = () => {
    const state = fx.state;
    fs.mkdirSync(path.dirname(eventLogPath(state)), { recursive: true });
    for (const event of state.outbox) fs.appendFileSync(eventLogPath(state), JSON.stringify(event) + '\n');
    state.projection.acknowledged_sequence = state.next_event_sequence - 1;
    state.outbox = [];
    state.revision++;
    fx.write();
  };
  fx.attempt = () => {
    const identity = { run_id: runId, phase_id: 'p1', role: 'impl', review_iteration: 0, attempt_id: randomUUID() };
    const artifacts = artifactPaths(accepted.workspace, identity);
    const content = contract.fixtures.inert_artifact_content;
    const attempt = {
      ...identity, ...accepted.phases[0].agents[0], artifacts, lifecycle_version: 1, status: 'completed',
      intended_review_stage: 'impl', retry_category: 'initial', previous_attempt_id: null,
      created_at: TIME, started_at: TIME, launch_host: { hostname: 'fixture', host_boot_id: null },
      intent: { launch_token: randomUUID(), session_name: 'fixture', timeout_minutes: accepted.phases[0].timeout_minutes,
        required_verification: [], prompt_options: { phaseDir: artifacts.directory, phaseId: 'p1',
          completionSignalPath: artifacts.completion, heartbeatPath: artifacts.heartbeat, attemptIdentity: identity },
        prompt_text: 'private prompt', prompt_sha256: createHash('sha256').update('private prompt').digest('hex') },
      reservation: { state: 'held' }, observations: {}, evidence: {}, evidence_history: [],
      diagnostics: {}, descendants: [], descendant_tracking_complete: false, health: { unknown_samples: 0 },
      reported_status: 'complete',
    };
    fs.mkdirSync(artifacts.directory, { recursive: true });
    fs.writeFileSync(artifacts.completion, content);
    const provenance = { ...identity, kind: 'completion', source: 'worker_report', path: artifacts.completion,
      sha256: createHash('sha256').update(content).digest('hex'), observed_at: TIME };
    attempt.evidence.completion = provenance;
    attempt.evidence_history.push(provenance);
    fx.state.phases.p1.roles.impl = { current_attempt_id: identity.attempt_id, attempts: [attempt],
      budgets: { launch: 0, execution: 0 } };
    fx.write();
    return attempt;
  };
  const staticRoot = path.join(fx.root, 'backend-static-fixture');
  fs.mkdirSync(staticRoot);
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Backend test fixture, not the dashboard UI</title>');
  fs.writeFileSync(path.join(staticRoot, 'app.js'), '"use strict";');
  fs.writeFileSync(path.join(staticRoot, 'styles.css'), 'body { color: black; }');
  fx.options = { manifestPath: fx.manifestPath, _runtimeRoot: fx.runtimeRoot, _staticRoot: staticRoot };
  fx.write();
  return fx;
}

async function start(t, fx, extra = {}) {
  const service = await D.serveDashboard({ ...fx.options, ...extra });
  fx.services.push(() => service.stop());
  return service;
}

async function login(fx, service) {
  const access = await D.accessDashboard({ ...fx.options, interactive: true });
  assert.equal(access.url, service.url);
  const response = await bootstrap(service, access.code);
  assert.equal(response.status, 204);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return { headers: { Cookie: cookie.split(';')[0] }, code: access.code };
}

function bootstrap(service, code) {
  return fetch(`${service.url}/api/bootstrap`, {
    method: 'POST', headers: { Origin: service.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

async function stream(t, url, headers) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url, { headers, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = '';
  const frames = [];
  return {
    frames,
    async next(type) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          frames.push(frame);
          if (frame.includes(`event: ${type}\n`)) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            return { frame, data: JSON.parse(data.slice(6)) };
          }
          continue;
        }
        const timer = setTimeout(() => abort.abort(), Math.max(1, deadline - Date.now()));
        try {
          const part = await reader.read();
          if (part.done) throw new Error('SSE ended before expected frame');
          buffer += Buffer.from(part.value).toString('utf8');
        } finally { clearTimeout(timer); }
      }
      throw new Error(`missing SSE ${type}`);
    },
    async ended({ timeout = 2500, allowReset = false } = {}) {
      let timer;
      try {
        assert.equal(buffer, '', 'no frames may follow the terminal error');
        await Promise.race([
          (async () => {
            while (true) {
              let part;
              try { part = await reader.read(); } catch (error) {
                if (!allowReset) throw error;
                assert.equal(error.cause?.code, 'UND_ERR_SOCKET');
                return;
              }
              if (part.done) return;
              assert.equal(part.value.length, 0, 'the server must not send data after its terminal frame');
            }
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('server did not end SSE within the deadline')), timeout);
          }),
        ]);
        assert.equal(abort.signal.aborted, false, 'the server must close SSE before client abort or teardown');
      } finally { clearTimeout(timer); }
    },
    close: () => abort.abort(),
  };
}

function backpressureObservations(t, service, onObservation) {
  const write = http.ServerResponse.prototype.write;
  const frames = [];
  t.mock.method(http.ServerResponse.prototype, 'write', function (chunk, ...args) {
    const result = write.call(this, chunk, ...args);
    if (this.getHeader('X-Dashboard-Service') !== service.serviceId || typeof chunk !== 'string') return result;
    frames.push(chunk);
    if (!chunk.includes('event: observation\n')) return result;
    return onObservation(this) ? false : result;
  });
  return frames;
}

test('U5 backpressured observations deliver event pages before another observation', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const frames = backpressureObservations(t, service, (response) => {
    setTimeout(() => response.emit('drain'), 25);
    return true;
  });
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  const received = await s.next('events');
  assert.deepEqual(received.data.events.map((event) => event.event_id), [first.event_id]);
  assert.match(received.frame, new RegExp(`^id: ${first.event_id}\\n`));
  assert.equal(frames.filter((frame) => frame.includes('event: observation\n')).length, 1);
  const second = fx.event();
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id), [second.event_id]);
});

test('U5 backpressured observations deliver resets before advancing their cursor', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const pending = fx.event(false);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const frames = backpressureObservations(t, service, (response) => {
    setTimeout(() => response.emit('drain'), 25);
    return true;
  });
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}&after=${pending.event_id}`, auth.headers);
  const reset = await s.next('reset');
  assert.match(reset.frame, /^id:\n/);
  assert.equal(reset.data.resume_after, null);
  assert.equal(reset.data.history.gaps[0].reason, 'pending_projection');
  assert.equal(frames.filter((frame) => frame.includes('event: observation\n')).length, 1);
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id), [first.event_id]);
  fx.project();
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id), [pending.event_id]);
});

test('U5 stalled observation closes within five seconds and reconnect resumes the last received ID', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  let stalled = false;
  const frames = backpressureObservations(t, service, () => stalled);
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  const received = await s.next('events');
  const lastId = received.frame.split('\n').find((line) => line.startsWith('id: ')).slice(4);
  assert.equal(lastId, first.event_id);
  stalled = true;
  const second = fx.event();
  await s.next('observation');
  const observedFrames = frames.length;
  const started = Date.now();
  await s.ended({ timeout: 6500, allowReset: true });
  assert.ok(Date.now() - started >= 4500, 'the drain deadline, not the client, must close the stream');
  assert.equal(frames.length, observedFrames, 'stalled streams must not queue additional frames');
  stalled = false;
  const reconnect = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`,
    { ...auth.headers, 'Last-Event-ID': lastId });
  assert.deepEqual((await reconnect.next('events')).data.events.map((event) => event.event_id), [second.event_id]);
});

test('U5 deferred events recheck session expiry when observation drain resumes', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  fx.event();
  let now = Date.now();
  const service = await start(t, fx, { _now: () => now });
  const auth = await login(fx, service);
  let blockedResponse;
  const frames = backpressureObservations(t, service, (response) => {
    blockedResponse = response;
    return true;
  });
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  await s.next('observation');
  now += 901000;
  blockedResponse.emit('drain');
  assert.equal((await s.next('error')).data.error.code, 'AUTH_EXPIRED');
  await s.ended();
  assert.equal(frames.some((frame) => frame.includes('event: events\n')), false);
});

test('U5 HTTP auth is private, one-use, bounded, same-origin, and read-only', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const before = fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8');
  const service = await start(t, fx);
  const machine = await D.accessDashboard(fx.options);
  assert.equal(machine.code, undefined);
  assert.match(machine.instructions, /terminal/i);
  const publicPage = await fetch(service.url);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${service.url}/api/snapshot`)).status, 401);
  const auth = await login(fx, service);
  const request = (route, options = {}) => fetch(`${service.url}${route}`, { ...auth, ...options });
  assert.equal((await request('/api/session')).status, 200);
  const replay = await request('/api/bootstrap', { method: 'POST',
    headers: { Origin: service.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: auth.code }) });
  assert.equal(replay.status, 401);
  for (const [headers, expected] of [
    [{ Host: 'localhost' }, 403], [{ Origin: 'https://evil.example' }, 403],
    [{ Origin: 'null' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
  ]) assert.equal(await rawRequest(`${service.url}/api/snapshot`, { ...auth.headers, ...headers }), expected, JSON.stringify(headers));
  assert.equal((await request('/api/bootstrap', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('/api/bootstrap', { method: 'POST', headers: {
    Origin: service.url, 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) })).status, 413);
  assert.equal((await request('/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await request('/api/stop', { method: 'POST' })).status, 405);
  assert.equal((await request('/api/snapshot?unexpected=1')).status, 400);
  assert.equal((await request('/api/snapshot?run_id=x&run_id=y')).status, 400);
  const snapshot = await (await request('/api/snapshot')).json();
  assert.equal(snapshot.snapshot.read_only, true);
  assert.equal(snapshot.snapshot.live_dispatch_enabled, false);
  assert.equal(snapshot.stream.after, null);
  assert.equal(fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(snapshot), /private prompt|capability|launch_token/);
});

test('U5 browser credentials and private service tokens cannot cross authentication boundaries', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const access = await D.accessDashboard({ ...fx.options, interactive: true });
  const capabilityPath = path.join(path.dirname(service.discoveryPath), 'dashboard-capability.json');
  const capability = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'));
  const pipe = `${W.pipeNameFor(fx.state.workspace, 'dashboard')}-${service.serviceId}`;
  const control = (token) => new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let input = '';
    socket.setTimeout(2500, () => socket.destroy(new Error('test control query timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify({
      type: 'status', service_id: service.serviceId, workspace_key: fx.state.workspace.key, token,
    }) + '\n'));
    socket.on('data', (chunk) => { input += chunk.toString('utf8'); });
    socket.on('end', () => {
      try { resolve(JSON.parse(input)); } catch (error) { reject(error); }
    });

  });
  const cookieToken = auth.headers.Cookie.split('=')[1];
  for (const credential of [access.code, cookieToken, auth.headers.Cookie]) {
    const rejected = await control(credential);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /authorization failed/);
    assert.equal(rejected.url, undefined);
  }
  assert.equal((await control(capability.token)).service_id, service.serviceId);
  for (const credential of [capability.token, cookieToken]) {
    const rejected = await bootstrap(service, credential);
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, 'INVALID_CODE');
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  assert.equal((await bootstrap(service, access.code)).status, 204);
});

test('U5 chunked bootstrap bodies enforce the exact byte limit with a JSON error', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  const send = (content, finish = true) => new Promise((resolve, reject) => {
    const request = http.request(`${service.url}/api/bootstrap`, { method: 'POST', headers: {
      Origin: service.url, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        request.end();
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('chunked rejection timed out')));
    request.on('error', reject);
    request.write(content.slice(0, 600));
    if (finish) request.end(content.slice(600));
    else request.write(content.slice(600));
  });
  const content = JSON.stringify({ code: 'a'.repeat(43) }).padEnd(D.LIMITS.request_bytes, ' ');
  assert.equal(Buffer.byteLength(content), D.LIMITS.request_bytes);
  assert.equal((await send(content)).status, 401);
  const over = await send(content + ' ', false);
  assert.equal(over.status, 413);
  assert.equal(over.body.error.code, 'REQUEST_TOO_LARGE');
});

test('U5 pending projection resets an ahead cursor without losing canonical progress; SSE recovers and reconnects', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const pending = fx.event(false);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const snapshot = await (await fetch(`${service.url}/api/snapshot`, auth)).json();
  assert.equal(snapshot.snapshot.event_cursor, pending.event_id);
  assert.equal(snapshot.stream.after, null);
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}&after=${pending.event_id}`, auth.headers);
  const reset = await s.next('reset');
  assert.match(reset.frame, /(^|\n)id:\n/);
  assert.equal(reset.data.resume_after, null);
  assert.equal(reset.data.history.gaps[0].reason, 'pending_projection');
  const available = await s.next('events');
  assert.deepEqual(available.data.events.map((row) => row.event_id), [first.event_id]);
  fx.project();
  const later = await s.next('events');
  assert.deepEqual(later.data.events.map((row) => row.event_id), [pending.event_id]);
  s.close();
  const third = fx.event();
  const reconnect = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}&after=${first.event_id}`,
    { ...auth.headers, 'Last-Event-ID': pending.event_id });
  assert.deepEqual((await reconnect.next('events')).data.events.map((row) => row.event_id), [third.event_id]);
  const wrong = await (await fetch(`${service.url}/api/events?run_id=${fx.state.run_id}&after=other:1`, auth)).json();
  assert.equal(wrong.reset_required, true);
  fs.unlinkSync(eventLogPath(fx.state));
  const missing = await (await fetch(`${service.url}/api/events?run_id=${fx.state.run_id}&after=${third.event_id}`, auth)).json();
  assert.equal(missing.reset_required, true);
  assert.equal(missing.history.gaps[0].reason, 'missing_history');
});

test('U5 observer polls permanently, retains separate timestamps, and reports stopped controller', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  const initial = (await s.next('observation')).data;
  const next = (await s.next('observation')).data;
  assert.ok(Date.parse(next.reader_observed_at) > Date.parse(initial.reader_observed_at));
  assert.equal(next.updated_at, TIME);
  assert.equal(next.controller_service.status, 'stopped');
  assert.equal(next.controller.status, 'stopped');
  fx.state.operator.paused = true;
  fx.state.revision++;
  fx.write();
  const update = (await s.next('observation')).data;
  assert.equal(update.revision, fx.state.revision);
  const canonical = fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8');
  await delay(1100);
  assert.equal(fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8'), canonical);
});

test('U5 expiry, service rotation, stale discovery, duplicate starts and targeted stop', { timeout: 60000 }, async (t) => {
  const fx = fixture(t);
  let now = Date.now();
  const service = await start(t, fx, { _now: () => now });
  const access = await D.accessDashboard({ ...fx.options, interactive: true });
  now += 61000;
  const expiredCode = await fetch(`${service.url}/api/bootstrap`, { method: 'POST',
    headers: { Origin: service.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: access.code }) });
  assert.equal(expiredCode.status, 401);
  const auth = await login(fx, service);
  now += 901000;
  assert.equal((await fetch(`${service.url}/api/snapshot`, auth)).status, 401);
  const live = await D.statusDashboard(fx.options);
  assert.equal(live.service_id, service.serviceId);
  const same = await D.startDashboard(fx.options);
  assert.equal(same.service_id, service.serviceId);
  await assert.rejects(D.stopDashboard({ ...fx.options, serviceId: randomUUID() }), /instance/i);
  const discovery = JSON.parse(fs.readFileSync(service.discoveryPath, 'utf8'));
  fs.writeFileSync(service.discoveryPath, JSON.stringify({ ...discovery, url: 'http://127.0.0.1:1' }));
  await assert.rejects(D.statusDashboard(fx.options), /discovery/i);
  fs.writeFileSync(service.discoveryPath, JSON.stringify(discovery));
  await D.stopDashboard({ ...fx.options, serviceId: service.serviceId });
  assert.equal((await D.statusDashboard(fx.options)).status, 'stopped');
  assert.equal(fs.existsSync(service.discoveryPath), false);
  const replacement = await start(t, fx);
  assert.notEqual(replacement.serviceId, service.serviceId);
  assert.equal((await fetch(`${replacement.url}/api/snapshot`, auth)).status, 401);
  await assert.rejects(D.stopDashboard({ ...fx.options, serviceId: service.serviceId }), /instance/i);
});

test('U5 startup retries owner readiness timeouts in initial and waiting discovery', { timeout: 60000 }, async (t) => {
  for (const initial of ['timeout', 'starting']) await t.test(initial, async (t) => {
    const fx = fixture(t);
    const service = await start(t, fx);
    const queryOwner = W.queryOwner;
    let queries = 0;
    t.mock.method(W, 'queryOwner', async (workspace, options) => {
      if (options?.namespace === 'dashboard') {
        queries++;
        if (queries === 1 && initial === 'starting') return { status: 'starting', service_id: service.serviceId };
        if (queries <= 2) throw new Error('owner readiness query timed out');
      }
      return queryOwner(workspace, options);
    });
    const found = await D.startDashboard(fx.options);
    assert.equal(found.service_id, service.serviceId);
    assert.equal(found.pid, process.pid, 'discovery must retain the live owner instead of replacing its claim');
    assert.equal(queries, 3);
    assert.equal((await fetch(found.url)).status, 200);
  });
});

test('U5 startup keeps identity conflicts and private-record errors fatal', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  const original = fs.readFileSync(service.discoveryPath, 'utf8');
  const record = JSON.parse(original);
  try {
    for (const changed of [
      { workspace_key: 'wrong-workspace' }, { manifest_path: `${record.manifest_path}.other` }, { service_id: randomUUID() },
    ]) {
      fs.writeFileSync(service.discoveryPath, JSON.stringify({ ...record, ...changed }));
      await assert.rejects(D.startDashboard(fx.options), /discovery identity or manifest conflict/);
    }
    fs.writeFileSync(service.discoveryPath, '{');
    await assert.rejects(D.startDashboard(fx.options), /invalid private dashboard discovery record/);
  } finally { fs.writeFileSync(service.discoveryPath, original); }
  const capabilityPath = path.join(path.dirname(service.discoveryPath), 'dashboard-capability.json');
  const capability = fs.readFileSync(capabilityPath, 'utf8');
  try {
    fs.writeFileSync(capabilityPath, JSON.stringify({ service_id: service.serviceId, token: 'invalid' }));
    await assert.rejects(D.startDashboard(fx.options), /discovery identity or manifest conflict/);
  } finally { fs.writeFileSync(capabilityPath, capability); }
  const queryOwner = W.queryOwner;
  let failure;
  const mock = t.mock.method(W, 'queryOwner', (workspace, options) => options?.namespace === 'dashboard'
    ? Promise.reject(failure) : queryOwner(workspace, options));
  for (failure of [
    new Error('owner readiness full-key mismatch or rejected query'),
    new Error('unrelated query timed out'),
    Object.assign(new Error('owner readiness query timed out'), { code: 'EACCES' }),
  ]) await assert.rejects(D.startDashboard(fx.options), (error) => error === failure);
  mock.mock.restore();
  assert.equal((await D.statusDashboard(fx.options)).service_id, service.serviceId);
});

test('U5 artifacts are bounded inert text selected by identity, and redirected paths fail closed', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const attempt = fx.attempt();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const query = new URLSearchParams(Object.fromEntries(
    ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'].map((key) => [key, String(attempt[key])])));
  query.set('kind', 'completion');
  const url = `${service.url}/api/artifact?${query}`;
  const response = await fetch(url, auth);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.content, contract.fixtures.inert_artifact_content);
  assert.equal(body.matches_accepted, true);
  const snap = await (await fetch(`${service.url}/api/snapshot`, auth)).json();
  const shown = snap.snapshot.phases[0].roles[0].current_attempt;
  assert.equal(shown.completion.status, 'reported_complete');
  assert.equal(shown.independent_verification.status, 'unknown');
  query.set('kind', 'prompt');
  assert.equal((await fetch(`${service.url}/api/artifact?${query}`, auth)).status, 400);
  query.set('kind', 'completion');
  query.set('attempt_id', '..\\..\\secret');
  assert.equal((await fetch(`${service.url}/api/artifact?${query}`, auth)).status, 400);
  const linked = path.join(fx.root, 'linked-completion.json');
  fs.linkSync(attempt.artifacts.completion, linked);
  const hardLinked = await fetch(url, auth);
  assert.equal(hardLinked.status, 403);
  const denied = await hardLinked.json();
  assert.equal(denied.error.code, 'UNSAFE_PATH');
  assert.equal(denied.content, undefined);
  assert.doesNotMatch(JSON.stringify(denied), /script|img|onerror/);
  fs.unlinkSync(linked);
  assert.equal((await fetch(url, auth)).status, 200);
  fs.writeFileSync(attempt.artifacts.completion, 'a'.repeat(D.LIMITS.artifact_bytes + 1));
  assert.equal((await fetch(url, auth)).status, 413);
  fs.unlinkSync(attempt.artifacts.completion);
  fs.rmdirSync(attempt.artifacts.directory);
  const outside = path.join(fx.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'completion.json'), 'not in workspace');
  fs.symlinkSync(outside, attempt.artifacts.directory, 'junction');
  assert.equal((await fetch(url, auth)).status, 403);
  assert.equal((await fetch(`${service.url}/%2e%2e%5csecret`, auth)).status, 400);
});

test('U5 legacy/no-run/error states and historical identity remain explicit', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  fx.event();
  const prior = structuredClone(fx.state);
  delete prior.history;
  fx.state.history = [prior];
  fx.state.run_id = randomUUID();
  fx.state.next_event_sequence = 1;
  fx.state.projection.acknowledged_sequence = 0;
  fx.state.revision++;
  fx.write();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const response = await fetch(`${service.url}/api/snapshot?run_id=${prior.run_id}`, auth);
  const historical = await response.json();
  assert.equal(historical.snapshot.run_id, prior.run_id);
  assert.equal(historical.snapshot.current_run_id, fx.state.run_id);
  assert.equal(historical.snapshot.is_current_run, false);
  assert.equal(historical.snapshot.controller.status, 'unknown');
  assert.equal((await fetch(`${service.url}/api/snapshot?run_id=absent`, auth)).status, 404);
  const file = statusPathFor(fx.manifestPath);
  fs.writeFileSync(file, 'malformed: [');
  const failed = await fetch(`${service.url}/api/snapshot`, auth);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /YAML|stack|canonical|\\checkout/);
  fs.writeFileSync(file, '{"phases":{"p1":{"status":"completed"}}}');
  assert.equal((await (await fetch(`${service.url}/api/snapshot`, auth)).json()).snapshot.status, 'legacy');
  fs.unlinkSync(file);
  assert.equal((await (await fetch(`${service.url}/api/snapshot`, auth)).json()).snapshot.status, 'no_run');
});

test('U5 detached process readiness and stop work without acquiring controller authority', { timeout: 60000 }, async (t) => {
  const fx = fixture(t);
  fx.services.push(async () => {
    const status = await D.statusDashboard(fx.options);
    if (status.status === 'running') await D.stopDashboard({ ...fx.options, serviceId: status.service_id });
  });
  const { started, launcherPid } = await new Promise((resolve, reject) => {
    const launcher = execFile(process.execPath, ['-e', `
      require(process.argv[1]).startDashboard(JSON.parse(process.argv[2])).then(
        (status) => console.log(JSON.stringify(status)),
        (error) => { console.error(error); process.exitCode = 1; });
    `, require.resolve('./dashboard-server'), JSON.stringify(fx.options)],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve({ started: JSON.parse(stdout), launcherPid: launcher.pid }); } catch (error) { reject(error); }
    });
  });
  assert.equal(started.status, 'running');
  assert.notEqual(started.pid, process.pid);
  assert.notEqual(started.pid, launcherPid);
  assert.equal((await fetch(started.url)).status, 200);
  await assert.rejects(W.queryOwner(fx.state.workspace), /ENOENT|ECONNREFUSED/);
  assert.equal((await D.statusDashboard(fx.options)).service_id, started.service_id);
  await assert.rejects(D.stopDashboard({ ...fx.options, serviceId: randomUUID() }), /instance/i);
  assert.equal((await fetch(started.url)).status, 200);
  await D.stopDashboard({ ...fx.options, serviceId: started.service_id });
  assert.equal((await D.statusDashboard(fx.options)).status, 'stopped');
});

test('U5 SSE state and persistent log failures recover without invented observations or replayed events', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const delivered = Array.from({ length: 101 }, () => fx.event());
  let now = Date.now();
  const service = await start(t, fx, { _now: () => now, _quiet: true });
  const auth = await login(fx, service);
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  const initial = (await s.next('observation')).data;
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id),
    delivered.slice(0, 100).map((event) => event.event_id));
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id), [delivered.at(-1).event_id]);
  const observations = s.frames.filter((frame) => frame.includes('event: observation\n')).length;
  fs.writeFileSync(statusPathFor(fx.manifestPath), 'invalid: [');
  now += 1000;
  for (let i = 0; i < 2; i++) {
    const error = (await s.next('error')).data;
    assert.equal(error.error.code, 'STATE_UNAVAILABLE');
    assert.equal(error.reader_observed_at, undefined);
  }
  assert.equal(s.frames.filter((frame) => frame.includes('event: observation\n')).length, observations);
  fx.state.operator.paused = true;
  fx.state.revision++;
  fx.write();
  const recovered = (await s.next('observation')).data;
  assert.equal(recovered.revision, fx.state.revision);
  assert.equal(recovered.reader_observed_at, new Date(now).toISOString());
  assert.notEqual(recovered.reader_observed_at, initial.reader_observed_at);
  assert.equal(recovered.updated_at, TIME);
  const file = eventLogPath(fx.state);
  const log = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'corrupt private log text\n');
  for (let i = 0; i < 2; i++) {
    const observation = (await s.next('observation')).data;
    assert.equal(observation.history.status, 'degraded');
    assert.equal(observation.history.diagnostic.code, 'LOG_CORRUPTION');
    const reset = (await s.next('reset')).data;
    assert.equal(reset.history.diagnostic.code, 'LOG_CORRUPTION');
    assert.equal(reset.resume_after, null);
    assert.doesNotMatch(JSON.stringify([observation, reset]), /private log text|malformed event|byte \d/);
  }
  fs.writeFileSync(file, log);
  assert.equal((await s.next('observation')).data.history.status, 'complete');
  const next = fx.event();
  assert.deepEqual((await s.next('events')).data.events.map((event) => event.event_id), [next.event_id]);
  assert.equal(s.frames.filter((frame) => frame.includes('event: events\n')).length, 3);
});

test('U5 an open SSE selection becomes historical when the current run changes', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const s = await stream(t, `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers);
  const initial = (await s.next('observation')).data;
  assert.equal(initial.run_id, initial.current_run_id);
  await s.next('events');
  const prior = structuredClone(fx.state);
  delete prior.history;
  fx.state.history = [prior];
  fx.state.run_id = randomUUID();
  fx.state.next_event_sequence = 1;
  fx.state.projection.acknowledged_sequence = 0;
  fx.state.revision++;
  fx.event();
  for (let i = 0; i < 2; i++) {
    const historical = (await s.next('observation')).data;
    assert.equal(historical.run_id, prior.run_id);
    assert.equal(historical.current_run_id, fx.state.run_id);
    assert.equal(historical.revision, prior.revision);
    assert.equal(historical.event_cursor, first.event_id);
    assert.equal(historical.controller.status, 'unknown');
  }
  assert.equal(s.frames.filter((frame) => frame.includes('event: events\n')).length, 1);
});

test('U5 HTTP reads remain responsive while controller readiness stalls', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  let queries = 0;
  const service = await start(t, fx, { _queryController: () => {
    queries++;
    return delay(2500).then(() => { throw new Error('slow controller'); });
  } });
  const auth = await login(fx, service);
  const startTime = Date.now();
  assert.equal((await fetch(`${service.url}/api/snapshot`, auth)).status, 200);
  assert.ok(Date.now() - startTime < 1000);
  await delay(1100);
  assert.equal(queries, 1, 'controller probes must not overlap');
  assert.equal((await fetch(`${service.url}/api/snapshot`, auth)).status, 200);
});

test('U5 event page, stream and bootstrap limits are explicit', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  for (let i = 0; i < 260; i++) fx.event();
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const page = await (await fetch(`${service.url}/api/events?run_id=${fx.state.run_id}&limit=256`, auth)).json();
  assert.equal(page.events.length, 256);
  assert.equal(page.has_more, true);
  for (const limit of ['257', '0', '-1', '1.5', 'junk']) {
    assert.equal((await fetch(`${service.url}/api/events?run_id=${fx.state.run_id}&limit=${limit}`, auth)).status, 400);
  }
  const streams = [];
  for (let i = 0; i < D.LIMITS.streams; i++) streams.push(await stream(t,
    `${service.url}/api/stream?run_id=${fx.state.run_id}`, auth.headers));
  assert.equal((await fetch(`${service.url}/api/stream?run_id=${fx.state.run_id}`, auth)).status, 429);
  streams.forEach((entry) => entry.close());
  for (let i = 0; i < D.LIMITS.bootstrap_codes; i++) await D.accessDashboard({ ...fx.options, interactive: true });
  await assert.rejects(D.accessDashboard({ ...fx.options, interactive: true }), /CODE_LIMIT/);
});

test('U5 session quota reclaims expired sessions without consuming the rejected bootstrap code', { timeout: 60000 }, async (t) => {
  const fx = fixture(t);
  let now = Date.now();
  const service = await start(t, fx, { _now: () => now });
  assert.equal(D.LIMITS.sessions, 64);
  let oldAuth;
  for (let i = 0; i < 64; i++) oldAuth = await login(fx, service);
  now += 899000;
  const access = await D.accessDashboard({ ...fx.options, interactive: true });
  const rejected = await bootstrap(service, access.code);
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, 'SESSION_LIMIT');
  assert.equal(rejected.headers.get('set-cookie'), null);
  now += 2000;
  assert.ok(now < Date.parse(access.expires_at));
  const accepted = await bootstrap(service, access.code);
  assert.equal(accepted.status, 204);
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.equal((await fetch(`${service.url}/api/session`, { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  assert.equal((await fetch(`${service.url}/api/session`, oldAuth)).status, 401);
  assert.equal((await bootstrap(service, access.code)).status, 401);
});

test('U5 concurrent starts converge, and crashed service discovery cannot redirect a replacement', { timeout: 60000 }, async (t) => {
  const fx = fixture(t);
  fx.services.push(async () => {
    const status = await D.statusDashboard(fx.options);
    if (status.status === 'running') await D.stopDashboard({ ...fx.options, serviceId: status.service_id });
  });
  const services = await Promise.all([D.startDashboard(fx.options), D.startDashboard(fx.options)]);
  assert.equal(services[0].service_id, services[1].service_id);
  const first = services[0];
  process.kill(first.pid);
  for (let i = 0; i < 60; i++) {
    if ((await D.statusDashboard(fx.options)).status === 'stopped') break;
    await delay(50);
  }
  assert.equal((await D.statusDashboard(fx.options)).status, 'stopped');
  const second = await D.startDashboard(fx.options);
  assert.notEqual(first.service_id, second.service_id);
  await assert.rejects(D.stopDashboard({ ...fx.options, serviceId: first.service_id }), /instance/i);
  assert.equal((await fetch(second.url)).status, 200);
});

test('U5 invalid canonical state is explicit; service stop remains available', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  fs.writeFileSync(statusPathFor(fx.manifestPath), 'invalid: [');
  assert.equal((await fetch(`${service.url}/api/snapshot`, auth)).status, 503);
  await D.stopDashboard({ ...fx.options, workspaceRoot: fx.workdir, serviceId: service.serviceId });
});

test('U5 exact snapshot response limit is enforced without truncating canonical progress', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const original = fx.attempt();
  const entry = fx.state.phases.p1.roles.impl;
  entry.attempts = Array.from({ length: 64 }, () => {
    const attempt = structuredClone(original);
    attempt.attempt_id = randomUUID();
    attempt.artifacts = artifactPaths(fx.state.workspace, attempt);
    attempt.intent.prompt_options = { ...attempt.intent.prompt_options, phaseDir: attempt.artifacts.directory,
      completionSignalPath: attempt.artifacts.completion, heartbeatPath: attempt.artifacts.heartbeat,
      attemptIdentity: { ...attempt.intent.prompt_options.attemptIdentity, attempt_id: attempt.attempt_id } };
    attempt.evidence.completion = { ...attempt.evidence.completion, attempt_id: attempt.attempt_id,
      path: attempt.artifacts.completion };
    attempt.evidence_history = Array.from({ length: 64 }, () => ({ ...attempt.evidence.completion }));
    return attempt;
  });
  entry.current_attempt_id = entry.attempts.at(-1).attempt_id;
  fx.write();
  assert.ok(Buffer.byteLength(JSON.stringify(createSnapshot({ manifestPath: fx.manifestPath }))) > D.LIMITS.snapshot_bytes);
  const service = await start(t, fx);
  const auth = await login(fx, service);
  const response = await fetch(`${service.url}/api/snapshot`, auth);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'SNAPSHOT_TOO_LARGE');
});

test('U5 static redirects and oversized static files fail closed', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  const service = await start(t, fx);
  fs.writeFileSync(path.join(fx.options._staticRoot, 'app.js'), 'a'.repeat(D.LIMITS.static_bytes + 1));
  assert.equal((await fetch(`${service.url}/app.js`)).status, 413);
  const moved = `${fx.options._staticRoot}-moved`;
  fs.renameSync(fx.options._staticRoot, moved);
  fs.symlinkSync(moved, fx.options._staticRoot, 'junction');
  assert.equal((await fetch(service.url)).status, 403);
});

test('U5 session expiry closes SSE and cleared history preserves explicit degradation', { timeout: 30000 }, async (t) => {
  const fx = fixture(t);
  fx.event();
  fx.state.projection.status = 'degraded';
  fx.state.projection.diagnostic = { code: 'ENOSPC', message: 'private filesystem text' };
  fx.write();
  let now = Date.now();
  const service = await start(t, fx, { _now: () => now });
  const auth = await login(fx, service);
  const url = `${service.url}/api/stream?run_id=${fx.state.run_id}`;
  const streams = [];
  assert.equal(D.LIMITS.streams, 8);
  for (let i = 0; i < 8; i++) {
    const s = await stream(t, url, auth.headers);
    assert.equal((await s.next('observation')).data.projection.status, 'degraded');
    streams.push(s);
  }
  now += 901000;
  await Promise.all(streams.map(async (s) => {
    assert.equal((await s.next('error')).data.error.code, 'AUTH_EXPIRED');
    await s.ended();
  }));
  const renewed = await login(fx, service);
  for (let i = 0; i < 8; i++) await stream(t, url, renewed.headers);
  const full = await fetch(url, renewed);
  assert.equal(full.status, 429);
  assert.equal((await full.json()).error.code, 'STREAM_LIMIT');
});
