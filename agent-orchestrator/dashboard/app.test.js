'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { runtimeFixture } = require('../scripts/test-support/runtime-fixture');
const { prepareV2Manifest, statusPathFor } = require('../scripts/parse-manifest');
const { validateState } = require('../scripts/state-store');
const { createSnapshot } = require('../scripts/read-model');
const { artifactPaths, QA_VERIFICATION } = require('../scripts/attempt-lifecycle');
const { eventLogPath } = require('../scripts/event-log');
const contract = require('../scripts/test-support/dashboard-contract.json');
const UI = require('./app');

const TIME = '2026-09-21T12:00:00.000Z';
const NOW = Date.parse(TIME);

function fixture(t) {
  const fx = runtimeFixture(t);
  fx.manifest.phases[0].review_loop = { enabled: true, max_iterations: 2 };
  fx.manifest.phases.push({ id: 'p2', depends_on: ['p1'], agent: { role: 'impl' }, completion_signal: 'next.md' });
  fs.writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
  const accepted = { ...prepareV2Manifest(fx.manifest, fx.manifestPath), revision: 1 };
  fx.state = {
    schema_version: 2, revision: 1, run_id: randomUUID(), workspace: accepted.workspace, accepted,
    operator: { paused: false }, runtime_status: 'live_dispatch_disabled', live_dispatch_enabled: false,
    phases: Object.fromEntries(accepted.phases.map((phase) => [phase.id, {
      status: 'pending', review_iteration: 0, review_stage: 'impl',
      roles: Object.fromEntries((phase.id === 'p1' ? ['impl', 'qa'] : ['impl']).map((role) =>
        [role, { current_attempt_id: null, attempts: [] }])),
    }])),
    command_results: {}, outbox: [], next_event_sequence: 1, created_at: TIME, updated_at: TIME,
    history: [], legacy_history: [],
    projection: { status: 'healthy', acknowledged_sequence: 0, retained_through: 0, updated_at: TIME, diagnostic: null },
  };
  fx.write = () => {
    validateState(fx.state);
    fs.writeFileSync(statusPathFor(fx.manifestPath), JSON.stringify(fx.state));
  };
  fx.envelope = (runId = null) => ({
    schema_version: 1, service_id: 'fixture-service',
    snapshot: createSnapshot({ manifestPath: fx.manifestPath, runId, now: TIME }),
    stream: { run_id: runId || fx.state.run_id, after: null },
    controller_service: { status: 'running', observed_at: TIME, service_id: 'controller-fixture' },
  });
  fx.event = (projected = true) => {
    const sequence = fx.state.next_event_sequence++;
    const event = { run_id: fx.state.run_id, event_id: `${fx.state.run_id}:${sequence}`,
      sequence, revision: ++fx.state.revision, type: sequence === 1 ? 'run_created' : 'paused', payload: {} };
    if (projected) {
      fs.mkdirSync(path.dirname(eventLogPath(fx.state)), { recursive: true });
      fs.appendFileSync(eventLogPath(fx.state), JSON.stringify(event) + '\n');
      fx.state.projection.acknowledged_sequence = sequence;
    } else fx.state.outbox.push(event);
    fx.write();
    return event;
  };
  fx.attempt = (role = 'impl') => {
    const identity = { run_id: fx.state.run_id, phase_id: 'p1', role, review_iteration: 0, attempt_id: randomUUID() };
    const artifacts = artifactPaths(accepted.workspace, identity);
    const content = contract.fixtures.inert_artifact_content;
    const attempt = {
      ...identity, ...accepted.phases[0].agents[0], role, artifacts, lifecycle_version: 1, status: 'completed',
      intended_review_stage: role, retry_category: 'initial', previous_attempt_id: null,
      created_at: TIME, started_at: TIME, launch_host: { hostname: 'fixture', host_boot_id: null },
      intent: { launch_token: randomUUID(), session_name: 'fixture', timeout_minutes: accepted.phases[0].timeout_minutes,
        required_verification: role === 'qa' ? [...QA_VERIFICATION] : [], prompt_options: { phaseDir: artifacts.directory, phaseId: 'p1',
          completionSignalPath: artifacts.completion, heartbeatPath: artifacts.heartbeat, attemptIdentity: identity },
        prompt_text: 'fixture', prompt_sha256: createHash('sha256').update('fixture').digest('hex') },
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
    if (role === 'qa') {
      const verdict = { ...provenance, kind: 'verdict', path: artifacts.verdict };
      attempt.evidence.verdict = verdict;
      attempt.evidence_history.push(verdict);
      attempt.qa_verdict = 'pass';
    }
    fx.state.phases.p1.roles[role] = { current_attempt_id: identity.attempt_id, attempts: [attempt], budgets: { launch: 0, execution: 0 } };
    fx.state.phases.p1.status = 'completed';
    fx.state.revision++;
    fx.write();
    return attempt;
  };
  fx.write();
  return fx;
}

function page(runId, events, extra = {}) {
  return { schema_version: 1, service_id: 'fixture-service', run_id: runId, revision: 1, events,
    cursor: events.at(-1)?.event_id || null, latest_cursor: `${runId}:999`, has_more: false,
    reset_required: false, history: { status: 'complete', gaps: [], diagnostic: null }, ...extra };
}

function clientFixture(envelopes) {
  const requests = [];
  const streams = [];
  const queue = [...envelopes];
  class Source {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
    emit(name, data) { this.listeners[name]?.({ data: data === undefined ? undefined : JSON.stringify(data) }); }
  }
  const model = UI.createModel();
  const client = UI.createClient({
    model, EventSource: Source,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/session') return { ok: true, status: 200, json: async () => ({ service_id: 'fixture-service' }) };
      const value = queue.shift();
      if (value instanceof Error) throw value;
      return { ok: !value?.error, status: value?.error ? 401 : 200, json: async () => value };
    },
    onChange() {},
  });
  return { model, client, requests, streams, queue };
}

test('U5 complete U4 snapshots drive progress; pending projection never becomes a delivered cursor', (t) => {
  const fx = fixture(t);
  const first = fx.event();
  fx.attempt();
  fx.event(false);
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  assert.equal(model.snapshot.phases[0].status, 'completed');
  assert.equal(model.snapshot.history.status, 'gap');
  assert.equal(model.deliveredCursor, null);
  UI.applyEvents(model, page(fx.state.run_id, [first]));
  UI.applyEvents(model, page(fx.state.run_id, [first]));
  assert.equal(model.timeline.length, 1);
  assert.equal(model.deliveredCursor, first.event_id);
  assert.equal(model.snapshot.phases[0].status, 'completed');
});

test('U5 reset preserves progress and deduplicates replay; old revisions and wrong-run pages cannot roll it back', (t) => {
  const fx = fixture(t);
  const old = fx.envelope();
  const event = fx.event();
  fx.attempt();
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  UI.applyEvents(model, page(fx.state.run_id, [event]));
  UI.resetTimeline(model);
  assert.equal(model.deliveredCursor, null);
  assert.equal(model.timeline.length, 1);
  UI.applySnapshot(model, old);
  UI.applyEvents(model, page('another-run', [{ ...event, run_id: 'another-run' }]));
  UI.applyEvents(model, page(fx.state.run_id, [event]));
  assert.equal(model.timeline.length, 1);
  assert.equal(model.snapshot.phases[0].status, 'completed');
});

test('U5 reset replay cursor follows newly delivered history even when retained timeline has newer items', (t) => {
  const fx = fixture(t);
  const first = fx.event();
  const second = fx.event();
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  UI.applyEvents(model, page(fx.state.run_id, [first, second]));
  UI.resetTimeline(model);
  UI.applyEvents(model, page(fx.state.run_id, [first]));
  assert.equal(model.deliveredCursor, first.event_id);
  assert.equal(model.timeline.length, 2);
});

test('U5 permanently closed EventSource is replaced after a successful session snapshot', async (t) => {
  const fx = fixture(t);
  const ctx = clientFixture([fx.envelope(), fx.envelope()]);
  await ctx.client.start();
  ctx.streams[0].readyState = 2;
  ctx.streams[0].emit('error');
  await ctx.client.idle();
  assert.equal(ctx.streams.length, 2);
  assert.equal(ctx.streams[0].closed, true);
  ctx.client.stop();
});

test('U5 timeline is bounded, ordered and deduplicated by run plus event identity', (t) => {
  const fx = fixture(t);
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  const events = Array.from({ length: 600 }, (_, i) => ({
    event_id: `${fx.state.run_id}:${i + 1}`, run_id: fx.state.run_id, sequence: i + 1, type: 'paused', payload: {},
  }));
  UI.applyEvents(model, page(fx.state.run_id, events));
  UI.applyEvents(model, page(fx.state.run_id, events.slice(0, 200)));
  assert.equal(model.timeline.length, UI.TIMELINE_LIMIT);
  assert.equal(model.timeline.at(-1).sequence, 600);
  assert.equal(model.timelineClipped, true);
  assert.equal(model.deliveredCursor, events.at(-1).event_id);
});

test('U5 freshness separates reader, canonical time, workspace service and run controller', (t) => {
  const fx = fixture(t);
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  model.connection = 'connected';
  const fresh = UI.displayState(model, NOW);
  assert.equal(fresh.stale, false);
  assert.equal(model.snapshot.controller.status, 'unknown');
  assert.equal(model.controllerService.status, 'running');
  assert.equal(UI.displayState(model, NOW + 6000).stale, true);
  UI.applyObservation(model, { ...fx.envelope().snapshot, service_id: 'fixture-service',
    reader_observed_at: new Date(NOW + 6000).toISOString(), controller_service: model.controllerService });
  assert.equal(UI.displayState(model, NOW + 6000).stale, false);
  assert.equal(model.snapshot.updated_at, TIME);
});

test('U5 client starts from null and refreshes canonical state after reset without losing timeline', async (t) => {
  const fx = fixture(t);
  const event = fx.event();
  fx.attempt();
  const ctx = clientFixture([fx.envelope(), fx.envelope()]);
  await ctx.client.start();
  assert.match(ctx.streams[0].url, /run_id=/);
  assert.doesNotMatch(ctx.streams[0].url, /after=/);
  ctx.streams[0].emit('events', page(fx.state.run_id, [event]));
  ctx.streams[0].emit('reset', { run_id: fx.state.run_id, service_id: 'fixture-service', reset_required: true });
  await ctx.client.idle();
  assert.equal(ctx.streams[0].closed, true);
  assert.doesNotMatch(ctx.streams.at(-1).url, /after=/);
  ctx.streams.at(-1).emit('events', page(fx.state.run_id, [event]));
  assert.equal(ctx.model.timeline.length, 1);
  assert.equal(ctx.model.snapshot.phases[0].status, 'completed');
  ctx.client.stop();
});

test('U5 auth expiry closes EventSource, clears protected data and requires local access again', async (t) => {
  const fx = fixture(t);
  const ctx = clientFixture([fx.envelope()]);
  await ctx.client.start();
  ctx.streams[0].emit('error', { error: { code: 'AUTH_EXPIRED', message: 'Dashboard access expired.' } });
  assert.equal(ctx.streams[0].closed, true);
  assert.equal(ctx.model.authenticated, false);
  assert.equal(ctx.model.connection, 'access');
  assert.equal(ctx.model.snapshot, null);
  ctx.client.stop();
});

test('U5 current-run observation intentionally switches streams; pinned run stays selected', async (t) => {
  const fx = fixture(t);
  const original = fx.envelope();
  const next = structuredClone(original);
  next.snapshot.run_id = next.snapshot.current_run_id = randomUUID();
  next.stream.run_id = next.snapshot.run_id;
  next.snapshot.revision++;
  const ctx = clientFixture([original, next, original]);
  await ctx.client.start();
  ctx.streams[0].emit('observation', { ...original.snapshot, service_id: 'fixture-service',
    current_run_id: next.snapshot.run_id });
  await ctx.client.idle();
  assert.equal(ctx.streams[0].closed, true);
  assert.equal(ctx.model.snapshot.run_id, next.snapshot.run_id);
  await ctx.client.selectRun(original.snapshot.run_id);
  ctx.streams.at(-1).emit('observation', { ...original.snapshot, service_id: 'fixture-service',
    current_run_id: next.snapshot.run_id });
  await ctx.client.idle();
  assert.equal(ctx.model.snapshot.run_id, original.snapshot.run_id);
  assert.match(ctx.requests.at(-1).url, new RegExp(original.snapshot.run_id));
  ctx.client.stop();
});

test('U5 loading, no-run, partial evidence, terminal and disconnected states have explicit labels', (t) => {
  const fx = fixture(t);
  const model = UI.createModel();
  assert.match(UI.displayState(model, NOW).message, /loading/i);
  fs.unlinkSync(statusPathFor(fx.manifestPath));
  UI.applySnapshot(model, fx.envelope());
  model.connection = 'connected';
  assert.match(UI.displayState(model, NOW).message, /no run/i);
  fx.attempt();
  fx.state.phases.p2.status = 'completed';
  fx.write();
  UI.applySnapshot(model, fx.envelope());
  assert.match(UI.displayState(model, NOW).message, /terminal/i);
  model.connection = 'disconnected';
  assert.match(UI.displayState(model, NOW).message, /disconnected/i);
});

class TextNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.value = ''; }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(' '); }
  set innerHTML(_) { throw new Error('HTML injection is forbidden'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
}

function documentFixture() {
  const roots = new Map(['access', 'dashboard', 'access-error', 'notice', 'freshness', 'identity', 'phases', 'attempt', 'timeline']
    .map((id) => [id, new TextNode('section')]));
  return { createElement: (tag) => new TextNode(tag), getElementById: (id) => roots.get(id), activeElement: null, roots };
}

test('U5 full U4 render preserves identities, QA provenance, partial evidence and inert artifact text', (t) => {
  const fx = fixture(t);
  fx.attempt();
  const qa = fx.attempt('qa');
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  model.authenticated = true;
  model.connection = 'connected';
  const document = documentFixture();
  UI.renderDashboard(document, model, NOW);
  assert.match(document.getElementById('phases').textContent, /Depends on: p1/);
  assert.match(document.getElementById('attempt').textContent, /reported complete/);
  assert.match(document.getElementById('attempt').textContent, /Partial evidence/);
  model.selectedAttempt = UI.identityKey(qa);
  model.artifact = { kind: 'completion', status: 'ready', data: {
    content: contract.fixtures.inert_artifact_content, matches_accepted: false, sha256: 'a'.repeat(64),
  } };
  UI.renderDashboard(document, model, NOW);
  const detail = document.getElementById('attempt');
  assert.match(detail.textContent, /pass \(worker report\)/);
  assert.match(detail.textContent, /Unknown \/ no independent verification evidence/);
  assert.match(detail.textContent, /do not match accepted evidence/);
  assert.ok(detail.textContent.includes(contract.fixtures.inert_artifact_content));
  assert.equal(detail.querySelectorAll().some((node) => ['script', 'img'].includes(node.tag)), false);
  assert.ok(detail.textContent.includes(qa.attempt_id));
});

test('U5 unchanged observation preserves interactive phase nodes and historical attempts stay historical', (t) => {
  const fx = fixture(t);
  fx.attempt();
  fx.state.phases.p1.review_iteration = 1;
  fx.write();
  const model = UI.createModel();
  UI.applySnapshot(model, fx.envelope());
  model.authenticated = true;
  model.connection = 'connected';
  const document = documentFixture();
  UI.renderDashboard(document, model, NOW);
  const table = document.getElementById('phases').children[0];
  UI.renderDashboard(document, model, NOW + 1000);
  assert.equal(document.getElementById('phases').children[0], table);
  assert.match(document.getElementById('attempt').textContent, /Historical attempt/);
  assert.match(document.getElementById('phases').textContent, /No current attempt/);
});

test('U5 late snapshots after run selection cannot overwrite the newly selected run', async (t) => {
  const fx = fixture(t);
  const envelope = fx.envelope();
  const other = structuredClone(envelope);
  other.snapshot.run_id = other.snapshot.current_run_id = randomUUID();
  let resolveOld;
  let snapshotCalls = 0;
  const model = UI.createModel();
  const client = UI.createClient({
    model, onChange() {}, EventSource: class { addEventListener() {} close() {} },
    fetch: async (url) => {
      if (url === '/api/session') return { ok: true, json: async () => ({ service_id: 'fixture-service' }) };
      if (++snapshotCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return { ok: true, json: async () => other };
    },
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  await client.selectRun(other.snapshot.run_id);
  resolveOld({ ok: true, json: async () => envelope });
  await starting;
  assert.equal(model.snapshot.run_id, other.snapshot.run_id);
  client.stop();
});

test('U5 HTTP expiry also closes the stream; unavailable state retains the last snapshot', async (t) => {
  const fx = fixture(t);
  const ctx = clientFixture([fx.envelope(), new Error('offline'), {
    error: { code: 'AUTH_EXPIRED', message: 'Dashboard access expired.' },
  }]);
  await ctx.client.start();
  await ctx.client.refresh();
  assert.equal(ctx.model.snapshot.run_id, fx.state.run_id);
  assert.equal(ctx.model.connection, 'disconnected');
  await ctx.client.refresh();
  assert.equal(ctx.model.snapshot, null);
  assert.equal(ctx.streams[0].closed, true);
  assert.equal(ctx.model.connection, 'access');
  ctx.client.stop();
});

test('U5 bootstrap sends a code only in a POST body; invalid code is a visible access error', async () => {
  const ctx = clientFixture([{ error: { code: 'INVALID_CODE', message: 'The bootstrap code is invalid or expired.' } }]);
  await ctx.client.login('disposable-fixture-code');
  assert.equal(ctx.requests[0].url, '/api/bootstrap');
  assert.equal(ctx.requests[0].options.method, 'POST');
  assert.equal(ctx.requests[0].options.body, '{"code":"disposable-fixture-code"}');
  assert.match(ctx.model.error, /invalid or expired/);
  assert.equal(ctx.model.authenticated, false);
  ctx.client.stop();
});

test('U5 integrated backend serves actual UI and snapshot without changing canonical state', async (t) => {
  const { serveDashboard, accessDashboard } = require('../scripts/dashboard-server');
  const fx = fixture(t);
  fx.attempt();
  const before = fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8');
  const options = { manifestPath: fx.manifestPath, _runtimeRoot: fx.runtimeRoot, _quiet: true };
  const service = await serveDashboard(options);
  try {
    const index = await fetch(service.url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Run observer/);
    for (const asset of ['app.js', 'styles.css']) assert.equal((await fetch(`${service.url}/${asset}`)).status, 200);
    const { code } = await accessDashboard({ ...options, interactive: true });
    const login = await fetch(`${service.url}/api/bootstrap`, { method: 'POST',
      headers: { Origin: service.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(login.status, 204);
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const envelope = await (await fetch(`${service.url}/api/snapshot`, { headers })).json();
    const model = UI.createModel();
    UI.applySnapshot(model, envelope);
    model.authenticated = true;
    const document = documentFixture();
    UI.renderDashboard(document, model);
    assert.match(document.getElementById('attempt').textContent, /reported complete/);
    assert.equal(fs.readFileSync(statusPathFor(fx.manifestPath), 'utf8'), before);
    assert.equal((await fetch(`${service.url}/api/snapshot`, { method: 'POST', headers })).status, 405);
  } finally { await service.stop(); }
});
