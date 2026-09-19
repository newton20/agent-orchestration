'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { canonicalJson } = require('./state-store');
const { assertOwnership } = require('./workspace-owner');
const { assertArtifactPath } = require('./artifact-path');

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_OUTBOX_EVENTS = 256;
const MAX_OUTBOX_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const RETAIN_LOG_BYTES = 2 * 1024 * 1024;
const RETAIN_LOG_EVENTS = 512;
const MAX_READ_EVENTS = 256;
const MAX_READ_BYTES = 256 * 1024;
const PROJECTION_IO_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE',
  'ENFILE', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EBUSY']);

class EventLogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isProjectionIOError(error) {
  return PROJECTION_IO_CODES.has(error?.code);
}

function projectionIO(io) {
  return Object.fromEntries(['openSync', 'fstatSync', 'readSync', 'writeSync', 'writeFileSync',
    'fsyncSync', 'ftruncateSync', 'closeSync', 'mkdirSync', 'renameSync', 'unlinkSync'].map((method) => [
    method, (...args) => {
      try { return io[method](...args); } catch (error) {
        if (error instanceof EventLogError || !isProjectionIOError(error)) throw error;
        throw new EventLogError(error.code, error.message);
      }
    },
  ]));
}

function eventLogPath(state) {
  if (typeof state.run_id !== 'string' || !/^(?!\.+$)[A-Za-z0-9._-]+$/.test(state.run_id)) {
    throw new Error('invalid event run identity');
  }
  return path.join(state.workspace.root, 'docs', 'orchestration', 'runs', state.run_id, 'logs', 'events.jsonl');
}

function eventLine(event) {
  const line = canonicalJson(event) + '\n';
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new EventLogError('EVENT_LIMIT', 'event exceeds byte limit');
  return line;
}

function validateEvent(event, runId) {
  if (!event || event.run_id !== runId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      event.event_id !== `${runId}:${event.sequence}` || !Number.isSafeInteger(event.revision) || event.revision < 1 ||
      typeof event.type !== 'string' || !event.type || !Object.hasOwn(event, 'payload')) {
    throw new EventLogError('EVENT_CORRUPTION', 'event identity or shape is invalid');
  }
  try { eventLine(event); } catch (error) {
    if (error instanceof EventLogError) throw error;
    throw new EventLogError('EVENT_CORRUPTION', `invalid event JSON data: ${error.message}`);
  }
}

function readLogBytes(file, io) {
  let fd;
  try {
    try { fd = io.openSync(file, 'r'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = io.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw new EventLogError('LOG_LIMIT', 'event log exceeds bounded regular-file contract');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new EventLogError('LOG_CHANGED', 'event log changed during read');
        offset += count;
      }
      return bytes;
    } finally { io.closeSync(fd); }
  } catch (error) {
    if (!isProjectionIOError(error)) throw error;
    throw new EventLogError(error.code, error.message);
  }
}

function isPendingPrefix(state, fragment, previous, revision) {
  return state.outbox.some((event) => {
    validateEvent(event, state.run_id);
    if (event.sequence <= previous || event.revision < revision) return false;
    return [eventLine(event), JSON.stringify(event) + '\n'].some((line) => {
      const bytes = Buffer.from(line);
      return fragment.length < bytes.length && bytes.subarray(0, fragment.length).equals(fragment);
    });
  });
}

function loadLog(state, io = fs) {
  const file = eventLogPath(state);
  // Artifact-boundary failures must never become projection IO diagnostics.
  assertArtifactPath(state.workspace.root, file);
  const bytes = readLogBytes(file, io);
  if (bytes === null) return { events: [], bytes: 0, truncate_at: null, newline: false };
  const events = [];
  let start = 0;
  let previous = 0;
  let revision = 0;
  let newline = false;
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start);
    const trailing = end === -1;
    const line = bytes.subarray(start, trailing ? bytes.length : end);
    if (line.length > MAX_EVENT_BYTES) throw new EventLogError('EVENT_LIMIT', 'event exceeds byte limit');
    let event;
    try { event = JSON.parse(line.toString('utf8')); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (trailing && isPendingPrefix(state, line, previous, revision)) {
        return { events, bytes: bytes.length, truncate_at: start, newline: false };
      }
      throw new EventLogError('LOG_CORRUPTION', `malformed event at byte ${start}`);
    }
    validateEvent(event, state.run_id);
    if (event.sequence <= previous || event.revision < revision) {
      throw new EventLogError('LOG_CORRUPTION', `event ordering is invalid at byte ${start}`);
    }
    previous = event.sequence;
    revision = event.revision;
    events.push(event);
    if (trailing) { newline = true; break; }
    start = end + 1;
  }
  return { events, bytes: bytes.length, truncate_at: null, newline };
}

function retainedEvents(events) {
  let bytes = 0;
  let start = events.length;
  while (start > 0 && events.length - start < RETAIN_LOG_EVENTS) {
    const length = Buffer.byteLength(eventLine(events[start - 1]));
    if (bytes + length > RETAIN_LOG_BYTES) break;
    bytes += length;
    start--;
  }
  return events.slice(start);
}

function replaceLog(state, events, owner, io) {
  io = projectionIO(io);
  const file = eventLogPath(state);
  const temp = `${file}.tmp-${randomUUID()}`;
  let fd;
  try {
    assertOwnership(owner, state.workspace);
    assertArtifactPath(state.workspace.root, file);
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, events.map(eventLine).join(''), 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    assertOwnership(owner, state.workspace);
    assertArtifactPath(state.workspace.root, file);
    io.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (closeError) { error.message += `; close failed: ${closeError.message}`; }
    }
    try { io.unlinkSync(temp); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.message += `; cleanup failed: ${cleanupError.message}`;
    }
    throw error;
  }
}

function assertAcknowledged(state, events) {
  const acknowledged = state.projection?.acknowledged_sequence;
  if (!Number.isSafeInteger(acknowledged) || acknowledged < 0 || acknowledged >= state.next_event_sequence ||
      events.some((event) => event.sequence > acknowledged)) {
    throw new EventLogError('RETENTION_PENDING', 'retention requires acknowledged log records');
  }
}

function assertCommittedEvents(state, events) {
  if (events.some((event) => event.sequence >= state.next_event_sequence || event.revision > state.revision)) {
    throw new EventLogError('LOG_AHEAD', 'projection contains events ahead of committed state');
  }
}

function assertPendingMatches(state, events) {
  const existing = new Map(events.map((event) => [event.sequence, event]));
  for (const event of state.outbox) {
    validateEvent(event, state.run_id);
    const prior = existing.get(event.sequence);
    if (prior && canonicalJson(prior) !== canonicalJson(event)) {
      throw new EventLogError('EVENT_CONFLICT', 'projected event differs from committed outbox');
    }
  }
  return existing;
}

function planRetention({ state, io = fs }) {
  const log = loadLog(state, io);
  assertAcknowledged(state, log.events);
  assertCommittedEvents(state, log.events);
  const floor = state.projection?.retained_through || 0;
  const events = retainedEvents(log.events.filter((event) => event.sequence > floor));
  const removed = log.events.length - events.length;
  return {
    retained_through: Math.max(floor, removed ? log.events[removed - 1].sequence : 0),
    events,
    needed: removed > 0 || log.newline,
  };
}

function compactEvents({ state, owner, io = fs, events }) {
  assertAcknowledged(state, events);
  replaceLog(state, events, owner, io);
}

function projectEvents({ state, owner, io = fs, fault = () => {} }) {
  assertOwnership(owner, state.workspace);
  io = projectionIO(io);
  const file = eventLogPath(state);
  const log = loadLog(state, io);
  assertCommittedEvents(state, log.events);
  const existing = assertPendingMatches(state, log.events);
  const missing = [];
  for (const event of state.outbox) {
    const prior = existing.get(event.sequence);
    if (!prior) {
      if (event.sequence <= (log.events.at(-1)?.sequence || 0)) {
        throw new EventLogError('LOG_CORRUPTION', 'pending event is missing inside the projection');
      }
      missing.push(event);
    }
  }
  let addition = missing.map(eventLine).join('');
  let acknowledged = state.outbox.at(-1)?.sequence || state.projection?.acknowledged_sequence || 0;
  const repairedBytes = (log.truncate_at ?? log.bytes) + (log.newline ? 1 : 0);
  if (repairedBytes + Buffer.byteLength(addition) > MAX_LOG_BYTES) {
    const prefix = state.outbox.filter((event) => existing.has(event.sequence));
    if (!prefix.length) throw new EventLogError('LOG_LIMIT', 'event append exceeds bounded log byte limit');
    // Flush the matching prefix so it can be acknowledged and compacted before retrying the rest.
    acknowledged = prefix.at(-1).sequence;
    addition = '';
  }
  fault('before_append');
  assertOwnership(owner, state.workspace);
  assertArtifactPath(state.workspace.root, file);
  io.mkdirSync(path.dirname(file), { recursive: true });
  if (log.truncate_at !== null || log.newline) {
    const fd = io.openSync(file, 'r+');
    try {
      if (log.truncate_at !== null) io.ftruncateSync(fd, log.truncate_at);
      else io.writeSync(fd, Buffer.from('\n'), 0, 1, log.bytes);
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
  }
  if (missing.length || state.outbox.length) {
    assertOwnership(owner, state.workspace);
    const fd = io.openSync(file, 'a', 0o600);
    try {
      if (addition) io.writeFileSync(fd, addition, 'utf8');
      // A replay must also flush an append whose previous fsync failed.
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
  }
  fault('after_append');
  return {
    acknowledged_sequence: Math.max(state.projection?.acknowledged_sequence || 0, acknowledged),
    retained_through: state.projection?.retained_through || 0,
  };
}

function historyFor(state, events, diagnostic) {
  const gaps = [];
  const pendingStart = state.outbox[0]?.sequence || state.next_event_sequence;
  let next = 1;
  function gap(from, to) {
    if (from > to) return;
    const retained = Math.min(to, state.projection?.retained_through || 0);
    if (from <= retained) { gaps.push({ from, to: retained, reason: 'retention' }); from = retained + 1; }
    const missing = Math.min(to, pendingStart - 1);
    if (from <= missing) { gaps.push({ from, to: missing, reason: 'missing_history' }); from = missing + 1; }
    if (from <= to) gaps.push({ from, to, reason: 'pending_projection' });
  }
  for (const event of events) { gap(next, event.sequence - 1); next = event.sequence + 1; }
  gap(next, state.next_event_sequence - 1);
  return { status: diagnostic ? 'degraded' : gaps.length ? 'gap' : 'complete', gaps, diagnostic };
}

function readEvents({ state, after = null, limit = 100 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_EVENTS) throw new Error('event read limit is out of bounds');
  let events;
  let diagnostic = null;
  try {
    const log = loadLog(state);
    events = log.events.filter((event) => event.sequence < state.next_event_sequence && event.revision <= state.revision);
    assertPendingMatches(state, events);
    if (log.truncate_at !== null || log.newline) diagnostic = { code: 'INCOMPLETE_TAIL', message: 'event append awaits owner reconciliation' };
  } catch (error) {
    if (!(error instanceof EventLogError)) throw error;
    events = [];
    diagnostic = { code: error.code, message: error.message };
  }
  const history = historyFor(state, events, diagnostic);
  const latest = state.next_event_sequence - 1;
  const latestCursor = latest ? `${state.run_id}:${latest}` : null;
  const index = after === null ? -1 : events.findIndex((event) => event.event_id === after);
  const reset = Boolean(diagnostic) || (after !== null && (index < 0 ||
    history.gaps.some((gap) => gap.reason !== 'pending_projection' && gap.to > events[index].sequence)));
  const result = [];
  let bytes = 0;
  if (!reset) {
    for (const event of events.slice(index + 1)) {
      const length = Buffer.byteLength(eventLine(event));
      if (result.length === limit || bytes + length > MAX_READ_BYTES) break;
      // A cursor may not silently jump over missing acknowledged history.
      if (result.length && event.sequence !== result.at(-1).sequence + 1) break;
      if (!result.length && index >= 0 && event.sequence !== events[index].sequence + 1) break;
      result.push(event);
      bytes += length;
    }
  }
  const gapAfterCursor = !reset && index >= 0 && index + 1 < events.length &&
    events[index + 1].sequence !== events[index].sequence + 1;
  return {
    run_id: state.run_id, revision: state.revision, events: result,
    cursor: result.at(-1)?.event_id || (reset ? null : after), latest_cursor: latestCursor,
    has_more: !reset && !gapAfterCursor && index + 1 + result.length < events.length,
    reset_required: reset || gapAfterCursor, history,
  };
}

module.exports = {
  MAX_EVENT_BYTES, MAX_OUTBOX_EVENTS, MAX_OUTBOX_BYTES, MAX_LOG_BYTES, RETAIN_LOG_BYTES,
  RETAIN_LOG_EVENTS, MAX_READ_EVENTS, MAX_READ_BYTES, EventLogError,
  eventLogPath, eventLine, projectEvents, readEvents, isProjectionIOError, planRetention, compactEvents,
};
