#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { fork, execFileSync } = require('node:child_process');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { loadManifest } = require('./parse-manifest');
const { readState } = require('./state-store');
const { createSnapshot } = require('./read-model');
const { readEvents, MAX_READ_EVENTS, MAX_READ_BYTES } = require('./event-log');
const { assertArtifactPath } = require('./artifact-path');
const W = require('./workspace-owner');

const LIMITS = Object.freeze({
  poll_ms: 1000, snapshot_bytes: 2 * 1024 * 1024, artifact_bytes: 64 * 1024,
  static_bytes: 256 * 1024, request_bytes: 1024, event_limit: MAX_READ_EVENTS,
  event_page_bytes: MAX_READ_BYTES, streams: 8, sessions: 64, bootstrap_codes: 8,
});
const CODE_TTL = 60_000;
const SESSION_TTL = 900_000;
const ID = /^(?!\.+$)[A-Za-z0-9._-]{1,256}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KINDS = ['completion', 'heartbeat', 'verdict', 'checkpoint', 'release'];
const token = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fileKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const absentOwner = (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code);
let defaultRuntimeRoot;

class DashboardError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new DashboardError(status, code, message); }

function runtimeRoot(options) {
  if (options._runtimeRoot) return path.resolve(options._runtimeRoot);
  if (!defaultRuntimeRoot) {
    const root = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetFolderPath('LocalApplicationData')"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!root || !path.isAbsolute(root)) throw new Error('private LocalApplicationData is unavailable');
    defaultRuntimeRoot = path.join(root, 'agent-orchestrator', 'runtime');
  }
  return defaultRuntimeRoot;
}

function contextFor(options) {
  if (typeof options.manifestPath !== 'string' || !options.manifestPath.trim()) throw new Error('manifestPath is required');
  const manifestPath = fileKey(options.manifestPath);
  if (options.workspaceRoot) {
    return { manifestPath, workspace: W.resolveWorkspace(options.workspaceRoot), runtimeRoot: runtimeRoot(options) };
  }
  const state = readState(manifestPath);
  let workspace;
  if (state?.schema_version === 2) workspace = state.workspace;
  else {
    const manifest = loadManifest(manifestPath);
    if (!manifest.ok) throw new Error(manifest.error);
    workspace = W.resolveWorkspace(path.resolve(path.dirname(manifestPath), manifest.manifest.workdir || '.'));
  }
  W.validateWorkspace(workspace);
  if (W.resolveWorkspace(workspace.root).key !== workspace.key) throw new Error('dashboard workspace identity changed');
  return { manifestPath, workspace, runtimeRoot: runtimeRoot(options) };
}

function instancePaths(context, serviceId) {
  if (!UUID.test(serviceId)) throw new Error('invalid dashboard service instance');
  const directory = path.join(context.runtimeRoot, digest(context.workspace.key), 'dashboard', serviceId);
  return {
    discovery: path.join(directory, 'dashboard.json'),
    capability: path.join(directory, 'dashboard-capability.json'),
    control: `${W.pipeNameFor(context.workspace, 'dashboard')}-${serviceId}`,
  };
}

function readBounded(file, max, root = null) {
  if (root) {
    try { assertArtifactPath(root, file); } catch (_) { fail(403, 'UNSAFE_PATH', 'Redirected or outside paths are not readable.'); }
  }
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail(403, 'UNSAFE_PATH', 'Only regular files without hard links are readable.');
    if (stat.size > max) fail(413, 'ARTIFACT_TOO_LARGE', 'The requested file exceeds its read limit.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) fail(503, 'STATE_UNAVAILABLE', 'The requested data changed during the read.');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function readPrivate(file) {
  const bytes = readBounded(file, 64 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); } catch (_) { throw new Error('invalid private dashboard discovery record'); }
}

function equalSecret(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function controlRequest(pipe, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let input = '';
    socket.setTimeout(2500, () => socket.destroy(new Error('dashboard control timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 64 * 1024) socket.destroy(new Error('oversized dashboard control response'));
    });
    socket.on('end', () => {
      try {
        const response = JSON.parse(input);
        if (!response.ok) throw new Error(response.error || 'dashboard control rejected');
        if (response.service_id !== request.service_id || response.workspace_key !== request.workspace_key) {
          throw new Error('dashboard control instance mismatch');
        }
        resolve(response);
      } catch (error) { reject(error); }
    });
  });
}

async function discover(context) {
  let owner;
  try { owner = await W.queryOwner(context.workspace, { namespace: 'dashboard' }); } catch (error) {
    if (absentOwner(error)) return null;
    if (error.code === undefined && error.message === 'owner readiness query timed out') {
      throw Object.assign(new Error('dashboard owner readiness is still pending; retry discovery', { cause: error }),
        { code: 'DASHBOARD_STARTING' });
    }
    throw error;
  }
  if (owner.status !== 'ready') throw Object.assign(new Error('dashboard is starting or unavailable; retry discovery'),
    { code: 'DASHBOARD_STARTING' });
  const paths = instancePaths(context, owner.service_id);
  const discovery = readPrivate(paths.discovery);
  const capability = readPrivate(paths.capability);
  if (discovery.service_id !== owner.service_id || discovery.workspace_key !== context.workspace.key ||
      discovery.manifest_path !== context.manifestPath || capability.service_id !== owner.service_id ||
      !/^[A-Za-z0-9_-]{43}$/.test(capability.token)) throw new Error('dashboard discovery identity or manifest conflict');
  const status = await controlRequest(paths.control, {
    type: 'status', service_id: owner.service_id, workspace_key: context.workspace.key, token: capability.token,
  });
  if (status.url !== discovery.url || status.manifest_path !== discovery.manifest_path ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(status.url)) throw new Error('dashboard discovery address mismatch');
  return { status, paths, capability };
}

async function statusDashboard(options) {
  const context = contextFor(options);
  const found = await discover(context);
  return found ? found.status : { status: 'stopped', service_id: null, url: null };
}

async function accessDashboard(options) {
  const context = contextFor(options);
  const found = await discover(context);
  if (!found) throw new Error('dashboard is stopped');
  const instructions = 'Run dashboard-server.js access in an interactive human terminal, then enter the code on the local page.';
  if (!options.interactive) return { ...found.status, instructions };
  return { ...await controlRequest(found.paths.control, {
    type: 'access', service_id: found.status.service_id, workspace_key: context.workspace.key, token: found.capability.token,
  }), instructions };
}

async function stopDashboard(options) {
  const context = contextFor(options);
  const found = await discover(context);
  if (!found) return { status: 'stopped', service_id: options.serviceId || null };
  if (options.serviceId && options.serviceId !== found.status.service_id) throw new Error('dashboard service instance changed; refusing stop');
  const serviceId = found.status.service_id;
  await controlRequest(found.paths.control, {
    type: 'stop', service_id: serviceId, workspace_key: context.workspace.key, token: found.capability.token,
  });
  for (let i = 0; i < 100; i++) {
    try {
      const owner = await W.queryOwner(context.workspace, { namespace: 'dashboard' });
      if (owner.service_id !== serviceId) return { status: 'stopped', service_id: serviceId };
    } catch (error) {
      if (absentOwner(error)) return { status: 'stopped', service_id: serviceId };
      if (!(error instanceof SyntaxError) && error.code !== 'ECONNRESET') throw error;
    }
    await delay(50);
  }
  throw new Error('dashboard stop acknowledgement timed out');
}

function safeHistory(history) {
  return { ...history, diagnostic: history.diagnostic
    ? { code: history.diagnostic.code, message: 'Event history requires controller attention.' } : null };
}

function errorBody(error, serviceId) {
  const known = error instanceof DashboardError;
  return {
    schema_version: 1, service_id: serviceId,
    error: { code: known ? error.code : 'STATE_UNAVAILABLE',
      message: known ? error.message : 'Dashboard state is temporarily unavailable.' },
  };
}

async function serveDashboard(options) {
  const context = contextFor(options);
  const owner = await W.acquireWorkspaceOwner(context.workspace, { namespace: 'dashboard', _runtimeRoot: context.runtimeRoot });
  const paths = instancePaths(context, owner.serviceId);
  const now = options._now || Date.now;
  const codes = new Map();
  const sessions = new Map();
  const streams = new Set();
  const controlSockets = new Set();
  const httpSockets = new Set();
  const cookieName = `dashboard_${owner.serviceId.replace(/-/g, '')}`;
  const serviceToken = token();
  const staticRoot = fileKey(options._staticRoot || path.join(__dirname, '..', 'dashboard'));
  let controllerService = { status: 'unavailable', observed_at: null, service_id: null };
  let probing = false;
  let stopping;
  let interval;
  let url;
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) response.destroy();
      else json(response, error instanceof DashboardError ? error.status : 503, errorBody(error, owner.serviceId));
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  server.on('connection', (socket) => {
    httpSockets.add(socket);
    socket.on('close', () => httpSockets.delete(socket));
  });
  const control = net.createServer((socket) => {
    controlSockets.add(socket);
    socket.on('close', () => controlSockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      try {
        const request = JSON.parse(input.trim());
        if (request.service_id !== owner.serviceId || request.workspace_key !== context.workspace.key ||
            !equalSecret(request.token, serviceToken)) throw new Error('dashboard control authorization failed');
        let result = status();
        if (request.type === 'access') {
          expire();
          if (codes.size >= LIMITS.bootstrap_codes) throw new Error('CODE_LIMIT');
          const code = token();
          codes.set(digest(code), now() + CODE_TTL);
          result = { ...result, code, expires_at: new Date(now() + CODE_TTL).toISOString() };
        } else if (!['status', 'stop'].includes(request.type)) throw new Error('unsupported dashboard control request');
        socket.end(JSON.stringify({ ...result, ok: true }) + '\n');
        if (request.type === 'stop') setImmediate(() => stop().catch(() => {
          console.error('Dashboard cleanup failed.');
          process.exitCode = 1;
        }));
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n');
      }
    });
  });

  function status() {
    return { status: 'running', service_id: owner.serviceId, workspace_key: context.workspace.key,
      manifest_path: context.manifestPath, url, pid: process.pid };
  }

  function expire() {
    for (const [key, expiry] of codes) if (expiry <= now()) codes.delete(key);
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
  }

  function headers(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Dashboard-Service', owner.serviceId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }

  function json(response, statusCode, body) {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > LIMITS.snapshot_bytes) fail(413, 'SNAPSHOT_TOO_LARGE', 'The snapshot exceeds its response limit.');
    headers(response);
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(serialized);
  }

  function view(runId = null) {
    const state = readState(context.manifestPath);
    if (state?.schema_version === 2 && state.workspace.key !== context.workspace.key) throw new Error('workspace changed');
    const observedAt = new Date(now()).toISOString();
    const controller = state?.schema_version === 2 && (runId === null || runId === state.run_id) &&
      controllerService.status === 'stopped' ? {
        status: 'stopped', observed_at: controllerService.observed_at, run_id: state.run_id,
      } : null;
    if (runId !== null && (state?.schema_version !== 2 ||
        (runId !== state.run_id && !state.history.some((run) => run.run_id === runId)))) {
      fail(404, 'RUN_NOT_FOUND', 'The selected run is unavailable.');
    }
    const snapshot = createSnapshot({ manifestPath: context.manifestPath, runId, controller, now: observedAt });
    if (snapshot.current_run_id !== (state?.schema_version === 2 ? state.run_id : null) ||
        (snapshot.is_current_run && snapshot.revision !== state.revision)) throw new Error('state changed during snapshot read');
    return { schema_version: 1, service_id: owner.serviceId,
      snapshot: { ...snapshot, history: safeHistory(snapshot.history) },
      stream: { run_id: snapshot.run_id, after: null }, controller_service: { ...controllerService } };
  }

  function eventPage(runId, after, limit = 100) {
    const state = readState(context.manifestPath);
    if (state?.schema_version !== 2) fail(404, 'RUN_NOT_FOUND', 'The selected run is unavailable.');
    if (state.workspace.key !== context.workspace.key) throw new Error('workspace changed');
    const selected = runId === state.run_id ? state : state.history.find((run) => run.run_id === runId);
    if (!selected) fail(404, 'RUN_NOT_FOUND', 'The selected run is unavailable.');
    const page = readEvents({ state: selected, after, limit });
    return { schema_version: 1, service_id: owner.serviceId, ...page, history: safeHistory(page.history) };
  }

  function observeController() {
    if (probing || stopping) return;
    probing = true;
    const query = options._queryController || (() => W.queryOwner(context.workspace));
    Promise.resolve().then(query).then((record) => {
      controllerService = { status: 'running', observed_at: new Date(now()).toISOString(), service_id: record.service_id };
    }, (error) => {
      controllerService = { status: absentOwner(error) ? 'stopped' : 'unavailable',
        observed_at: new Date(now()).toISOString(), service_id: null };
    }).finally(() => { probing = false; });
  }

  function frame(client, event, data, id = null) {
    if (client.waitingDrain) return false;
    const text = `${id === null ? '' : `id:${id ? ` ${id}` : ''}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (Buffer.byteLength(text) > LIMITS.snapshot_bytes) {
      client.response.destroy();
      streams.delete(client);
      return false;
    }
    if (!client.response.write(text)) {
      client.waitingDrain = true;
      client.drainTimer = setTimeout(() => client.response.destroy(), 5000);
      client.response.once('drain', () => {
        clearTimeout(client.drainTimer);
        client.waitingDrain = false;
        if (client.pendingEvents) observeStream(client);
      });
    }
    return true;
  }

  function observeStream(client) {
    if (!streams.has(client)) return;
    if (!sessions.has(client.session) || sessions.get(client.session) <= now()) {
      frame(client, 'error', errorBody(new DashboardError(401, 'AUTH_EXPIRED', 'Dashboard access expired.'), owner.serviceId));
      client.response.end();
      streams.delete(client);
      return;
    }
    if (client.waitingDrain) return;
    try {
      if (!client.pendingEvents) {
        const selected = view(client.runId);
        const s = selected.snapshot;
        if (!frame(client, 'observation', {
          schema_version: 1, service_id: owner.serviceId, run_id: s.run_id, current_run_id: s.current_run_id,
          revision: s.revision, event_cursor: s.event_cursor, updated_at: s.updated_at, reader_observed_at: s.reader_observed_at,
          controller: s.controller, controller_service: selected.controller_service, projection: s.projection, history: s.history,
        })) return;
        // Resume the page before another observation, without retaining a queue of frames.
        client.pendingEvents = true;
      }
      if (client.waitingDrain) return;
      const page = eventPage(client.runId, client.after);
      if (page.reset_required) {
        if (!frame(client, 'reset', { schema_version: 1, service_id: owner.serviceId, run_id: client.runId,
          reset_required: true, resume_after: null, latest_cursor: page.latest_cursor, history: page.history }, '')) return;
        client.after = null;
      } else {
        // A reset may revisit retained history. It must not replay already delivered timeline IDs.
        const events = page.events.filter((event) => event.sequence > client.deliveredSequence);
        if (events.length) {
          if (!frame(client, 'events', { ...page, events }, events.at(-1).event_id)) return;
          client.deliveredSequence = events.at(-1).sequence;
        }
        client.after = page.cursor;
      }
      client.pendingEvents = false;
    } catch (error) {
      client.pendingEvents = false;
      frame(client, 'error', errorBody(error, owner.serviceId));
      if (error instanceof DashboardError && error.status === 404) {
        client.response.end();
        streams.delete(client);
      }
    }
  }

  function observe() {
    expire();
    observeController();
    // Observe without subscribers too; this cadence is independent of scheduler activity.
    if (!streams.size) {
      try { view(); } catch (error) {
        if (!options._quiet) console.error(errorBody(error, owner.serviceId).error.code);
      }
    }
    for (const client of streams) observeStream(client);
  }

  function sessionFor(request) {
    const matches = (request.headers.cookie || '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    if (matches.length !== 1) fail(401, 'AUTH_REQUIRED', 'Dashboard access is required.');
    const value = matches[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail(401, 'AUTH_REQUIRED', 'Dashboard access is required.');
    const key = digest(value);
    if (!sessions.has(key) || sessions.get(key) <= now()) fail(401, 'AUTH_EXPIRED', 'Dashboard access expired.');
    return key;
  }

  function params(search, allowed) {
    for (const key of search.keys()) {
      if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key).length > 256) {
        fail(400, 'INVALID_REQUEST', 'Unsupported or repeated query parameter.');
      }
    }
  }

  function identifier(search, name, required = true) {
    const value = search.get(name);
    if (value === null && !required) return null;
    if (!value || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
      fail(400, 'INVALID_REQUEST', 'A valid selection identity is required.');
    }
    return value;
  }

  async function body(request) {
    if (request.headers['content-type']?.toLowerCase() !== 'application/json') {
      fail(400, 'INVALID_REQUEST', 'Expected application/json.');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > LIMITS.request_bytes) fail(413, 'REQUEST_TOO_LARGE', 'The request exceeds its byte limit.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
      fail(400, 'INVALID_REQUEST', 'Expected a JSON object.');
    }
  }

  async function handle(request, response) {
    if (stopping) fail(503, 'STATE_UNAVAILABLE', 'Dashboard is stopping.');
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== url.slice(7) ||
        request.rawHeaders.filter((header, i) => i % 2 === 0 && header.toLowerCase() === 'host').length !== 1) {
      fail(403, 'FORBIDDEN_HOST', 'Unexpected dashboard host.');
    }
    if ((request.headers.origin !== undefined && request.headers.origin !== url) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      fail(403, 'FORBIDDEN_ORIGIN', 'Unexpected dashboard origin.');
    }
    if (!request.url.startsWith('/') || request.url.length > 4096) fail(400, 'INVALID_REQUEST', 'Invalid request target.');
    let decoded;
    try { decoded = decodeURIComponent(request.url.split('?')[0]); } catch (_) {
      fail(400, 'INVALID_REQUEST', 'Invalid request target.');
    }
    if (/[\\\0]/.test(decoded) || decoded.split('/').some((part) => ['.', '..'].includes(part))) {
      fail(400, 'INVALID_REQUEST', 'Invalid request target.');
    }
    const parsed = new URL(request.url, url);
    if (parsed.origin !== url) fail(400, 'INVALID_REQUEST', 'Invalid request target.');
    const route = parsed.pathname;
    const search = parsed.searchParams;
    if (route === '/api/bootstrap') {
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported here.');
      if (request.headers.origin !== url) fail(403, 'FORBIDDEN_ORIGIN', 'Bootstrap requires the dashboard origin.');
      params(search, []);
      if (Number(request.headers['content-length']) > LIMITS.request_bytes) {
        fail(413, 'REQUEST_TOO_LARGE', 'The request exceeds its byte limit.');
      }
      const input = await body(request);
      if (!input || typeof input.code !== 'string' || Object.keys(input).length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(input.code)) {
        fail(401, 'INVALID_CODE', 'The bootstrap code is invalid or expired.');
      }
      expire();
      const key = digest(input.code);
      if (!codes.has(key)) fail(401, 'INVALID_CODE', 'The bootstrap code is invalid or expired.');
      if (sessions.size >= LIMITS.sessions) fail(429, 'SESSION_LIMIT', 'Dashboard session limit reached.');
      codes.delete(key);
      const value = token();
      sessions.set(digest(value), now() + SESSION_TTL);
      headers(response);
      response.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Workflow endpoints are read-only.');
    const staticFile = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] }[route];
    if (staticFile) {
      params(search, []);
      let bytes;
      try { bytes = readBounded(path.join(staticRoot, staticFile[0]), LIMITS.static_bytes, staticRoot); } catch (error) {
        if (error.code === 'ENOENT' || !fs.existsSync(staticRoot)) fail(503, 'UI_UNAVAILABLE', 'Dashboard UI is not installed.');
        throw error;
      }
      headers(response);
      response.writeHead(200, { 'Content-Type': `${staticFile[1]}; charset=utf-8` });
      response.end(bytes);
      return;
    }
    const session = sessionFor(request);
    if (route === '/api/session') {
      params(search, []);
      json(response, 200, { schema_version: 1, service_id: owner.serviceId,
        expires_at: new Date(sessions.get(session)).toISOString(), read_only: true });
    } else if (route === '/api/snapshot') {
      params(search, ['run_id']);
      json(response, 200, view(identifier(search, 'run_id', false)));
    } else if (route === '/api/events' || route === '/api/stream') {
      params(search, route === '/api/events' ? ['run_id', 'after', 'limit'] : ['run_id', 'after']);
      const runId = identifier(search, 'run_id');
      const after = (route === '/api/stream' ? request.headers['last-event-id'] : null) || search.get('after') || null;
      if (after !== null && (typeof after !== 'string' || after.length > 256)) fail(400, 'INVALID_REQUEST', 'Invalid event cursor.');
      const limit = search.has('limit') ? Number(search.get('limit')) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.event_limit) fail(400, 'INVALID_REQUEST', 'Invalid event page limit.');
      if (route === '/api/events') json(response, 200, eventPage(runId, after, limit));
      else {
        view(runId);
        if (streams.size >= LIMITS.streams) fail(429, 'STREAM_LIMIT', 'Dashboard stream limit reached.');
        headers(response);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        response.flushHeaders();
        const client = { response, session, runId, after, deliveredSequence: 0, pendingEvents: false };
        streams.add(client);
        response.on('close', () => { clearTimeout(client.drainTimer); streams.delete(client); });
        observeStream(client);
      }
    } else if (route === '/api/artifact') {
      params(search, ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id', 'kind']);
      const runId = identifier(search, 'run_id');
      const phaseId = identifier(search, 'phase_id');
      const role = identifier(search, 'role');
      const attemptId = identifier(search, 'attempt_id');
      const iteration = search.get('review_iteration');
      const kind = search.get('kind');
      if (!/^(0|[1-9][0-9]{0,8})$/.test(iteration) || !KINDS.includes(kind)) fail(400, 'INVALID_REQUEST', 'Invalid artifact selection.');
      const snapshot = view(runId).snapshot;
      const entry = snapshot.phases.find((phase) => phase.phase_id === phaseId)?.roles.find((item) => item.role === role);
      const attempt = entry && [entry.current_attempt, ...entry.historical_attempts].find((item) =>
        item?.attempt_id === attemptId && item.review_iteration === Number(iteration));
      const artifact = attempt?.artifacts.find((item) => item.kind === kind);
      if (!artifact?.path) fail(404, 'ARTIFACT_NOT_FOUND', 'The selected artifact is unavailable.');
      let bytes;
      try { bytes = readBounded(artifact.path, LIMITS.artifact_bytes, context.workspace.root); } catch (error) {
        if (error.code === 'ENOENT') fail(404, 'ARTIFACT_NOT_FOUND', 'The selected artifact is unavailable.');
        throw error;
      }
      const sha256 = digest(bytes);
      json(response, 200, { schema_version: 1, service_id: owner.serviceId, run_id: runId, phase_id: phaseId,
        role, review_iteration: Number(iteration), attempt_id: attemptId, kind, content: bytes.toString('utf8'),
        sha256, accepted_sha256: artifact.provenance?.sha256 || null, matches_accepted: sha256 === artifact.provenance?.sha256 });
    } else fail(404, 'NOT_FOUND', 'The requested endpoint does not exist.');
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(interval);
      codes.clear();
      sessions.clear();
      streams.clear();
      for (const socket of httpSockets) socket.destroy();
      for (const socket of controlSockets) socket.destroy();
      await Promise.all([server, control].filter((listener) => listener.listening)
        .map((listener) => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))));
      try {
        for (const file of [paths.discovery, paths.capability]) {
          try {
            if (readPrivate(file).service_id !== owner.serviceId) throw new Error('dashboard cleanup instance mismatch');
            fs.unlinkSync(file);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      } finally { await owner.release(); }
    })();
    return stopping;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}`;
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(paths.control, resolve); });
    fs.writeFileSync(paths.capability, JSON.stringify({ service_id: owner.serviceId, token: serviceToken }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(paths.discovery, JSON.stringify(status()), { flag: 'wx', mode: 0o600 });
    owner.setReadiness('ready');
    observe();
    interval = setInterval(observe, LIMITS.poll_ms);
    return { serviceId: owner.serviceId, url, discoveryPath: paths.discovery, stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'dashboard startup and cleanup failed'); }
    throw error;
  }
}

async function startDashboard(options) {
  const context = contextFor(options);
  async function waitForService() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const found = await discover(context);
        if (found) return found;
      } catch (error) { if (error.code !== 'DASHBOARD_STARTING') throw error; }
      await delay(100);
    }
    throw new Error('dashboard startup acknowledgement timed out');
  }
  let existing;
  try { existing = await discover(context); } catch (error) {
    if (error.code !== 'DASHBOARD_STARTING') throw error;
    return (await waitForService()).status;
  }
  if (existing) return existing.status;
  const child = fork(__filename, ['--child'], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dashboard startup acknowledgement timed out')), 30000);
      const done = (callback, value) => { clearTimeout(timer); callback(value); };
      child.once('error', (error) => done(reject, error));
      child.once('exit', () => done(reject, new Error('dashboard exited before readiness')));
      child.once('message', (message) => message?.ok ? done(resolve, message)
        : done(reject, Object.assign(new Error(message?.error || 'dashboard startup failed'), { code: message?.code })));
      child.send({ manifestPath: context.manifestPath, _runtimeRoot: context.runtimeRoot, _staticRoot: options._staticRoot });
    });
    const found = await discover(context);
    if (!found || found.status.service_id !== ready.service_id) throw new Error('dashboard readiness instance mismatch');
    child.disconnect();
    child.unref();
    return found.status;
  } catch (error) {
    child.kill();
    if (error.code === 'ELOCKED') return (await waitForService()).status;
    throw error;
  }
}

async function main(args) {
  if (args[0] === '--child' && process.send) {
    process.once('message', async (options) => {
      try {
        const service = await serveDashboard(options);
        process.send({ ok: true, service_id: service.serviceId });
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.stop().catch(() => { process.exitCode = 1; }));
      } catch (error) {
        process.send({ ok: false, code: error.code, error: error.message }, () => process.disconnect());
        process.exitCode = 1;
      }
    });
    return;
  }
  const workspaceIndex = args.indexOf('--workspace');
  const workspaceRoot = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  if (workspaceIndex >= 0) {
    if (!workspaceRoot) throw new Error('--workspace requires the original Git workspace directory');
    args.splice(workspaceIndex, 2);
  }
  const [command, manifestPath, serviceId, ...rest] = args;
  if (!['start', 'serve', 'status', 'stop', 'access'].includes(command) || !manifestPath || rest.length ||
      (workspaceRoot && !['status', 'stop', 'access'].includes(command)) ||
      (serviceId && command !== 'stop')) {
    throw new Error('Usage: dashboard-server.js <start|serve|status|stop|access> <manifest-path> [stop-service-id] [--workspace directory]');
  }
  const options = { manifestPath, serviceId, workspaceRoot };
  if (command === 'serve') {
    const service = await serveDashboard(options);
    console.log(JSON.stringify({ status: 'running', service_id: service.serviceId, url: service.url }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.stop().catch(() => { process.exitCode = 1; }));
  } else if (command === 'access') {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const result = await accessDashboard({ ...options, interactive });
    if (interactive) console.log(`${result.url}\nOne-use dashboard code (expires in 60 seconds): ${result.code}`);
    else console.log(JSON.stringify(result));
  } else {
    const run = { start: startDashboard, status: statusDashboard, stop: stopDashboard }[command];
    console.log(JSON.stringify(await run(options)));
  }
}

module.exports = { LIMITS, serveDashboard, startDashboard, statusDashboard, stopDashboard, accessDashboard };
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
