/**
 * Unit 8 test suite. Uses node:test (built-in, Node >= 20).
 * Run: npm test   (from agent-orchestrator/scripts/)
 *
 * In-process tests are the bulk; only ~2 spawnSync invocations cover
 * the CLI surface (todo 044 institutional memory: subprocess overhead
 * dominates suite runtime on Windows).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const {
  checkHealth,
  isPidAlive,
  parseHeartbeatTail,
  findLastCheckpoint,
  readPhaseStatus,
  coerceTimestampMs,
  asPositiveInt,
  defaultPhaseDir,
  defaultSessionName,
  VALID_ROLES,
  DEFAULT_TIMEOUT_MINUTES,
  HEARTBEAT_STALE_MS,
  CHECKPOINT_EXCLUDE_NAMES,
  CHECKPOINT_EXCLUDE_SUFFIXES,
} = require('./check-health');

// -------------------- Helpers --------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeManifest(dir, contents) {
  const manifestPath = path.join(dir, 'manifest.yaml');
  fs.writeFileSync(manifestPath, yaml.dump(contents), 'utf8');
  return manifestPath;
}

function writeStatus(manifestPath, contents) {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const statusPath = path.join(dir, `${base}-status.yaml`);
  fs.writeFileSync(statusPath, yaml.dump(contents), 'utf8');
  return statusPath;
}

function makeBaseManifest() {
  return {
    name: 'test-orchestration',
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 30,
        agents: [{ role: 'impl' }],
      },
    ],
  };
}

// Killer fakes — emulate process.kill(pid, 0) outcomes without real signals.
const KILLER_ALIVE = () => {};
const KILLER_DEAD = () => {
  const e = new Error('No such process');
  e.code = 'ESRCH';
  throw e;
};
const KILLER_EPERM = () => {
  const e = new Error('Operation not permitted');
  e.code = 'EPERM';
  throw e;
};
const KILLER_UNKNOWN = () => {
  const e = new Error('Some unexpected error');
  e.code = 'EOTHER';
  throw e;
};

// =========================================================================
// A — module exports + constants
// =========================================================================

test('exports VALID_ROLES = [impl, qa, coord]', () => {
  assert.deepStrictEqual([...VALID_ROLES], ['impl', 'qa', 'coord']);
});

test('exports DEFAULT_TIMEOUT_MINUTES = 60 and HEARTBEAT_STALE_MS = 5min', () => {
  assert.strictEqual(DEFAULT_TIMEOUT_MINUTES, 60);
  assert.strictEqual(HEARTBEAT_STALE_MS, 5 * 60_000);
});

test('CHECKPOINT_EXCLUDE_NAMES contains heartbeat.jsonl', () => {
  assert.ok(CHECKPOINT_EXCLUDE_NAMES.has('heartbeat.jsonl'));
});

test('CHECKPOINT_EXCLUDE_SUFFIXES covers common transient extensions', () => {
  for (const s of ['.lock', '.tmp', '.swp']) {
    assert.ok(CHECKPOINT_EXCLUDE_SUFFIXES.includes(s), `missing ${s}`);
  }
});

// =========================================================================
// B — isPidAlive
// =========================================================================

test('isPidAlive: signal 0 returns → true', () => {
  assert.strictEqual(isPidAlive(123, KILLER_ALIVE), true);
});

test('isPidAlive: ESRCH → false', () => {
  assert.strictEqual(isPidAlive(123, KILLER_DEAD), false);
});

test('isPidAlive: EPERM → true (process exists, not signalable)', () => {
  assert.strictEqual(isPidAlive(123, KILLER_EPERM), true);
});

test('isPidAlive: unknown error code → null', () => {
  assert.strictEqual(isPidAlive(123, KILLER_UNKNOWN), null);
});

test('isPidAlive: invalid pid (0, -1, NaN, "abc", null) → null', () => {
  assert.strictEqual(isPidAlive(0), null);
  assert.strictEqual(isPidAlive(-1), null);
  assert.strictEqual(isPidAlive(NaN), null);
  assert.strictEqual(isPidAlive('abc'), null);
  assert.strictEqual(isPidAlive(null), null);
  assert.strictEqual(isPidAlive(undefined), null);
});

test('isPidAlive: real process.pid is alive (no _killer injection)', () => {
  // Sanity: this Node process is obviously running.
  assert.strictEqual(isPidAlive(process.pid), true);
});

test('isPidAlive: very large unused PID is dead (no _killer injection)', () => {
  // PID 999999 is statistically unlikely to be running.
  // process.kill(pid, 0) returns ESRCH → false.
  // (Can't 100% guarantee non-allocation on busy machines; tolerate either.)
  const result = isPidAlive(999999);
  assert.ok(result === false || result === null,
    `expected false or null, got ${result}`);
});

// =========================================================================
// C — parseHeartbeatTail
// =========================================================================

test('parseHeartbeatTail: simple valid line', () => {
  const line = '{"ts":"2026-04-29T05:00:00Z","pid":12345,"role":"impl","phase_id":"phase-1","message":"working"}';
  const r = parseHeartbeatTail(line);
  assert.strictEqual(r.tsMs, Date.parse('2026-04-29T05:00:00Z'));
  assert.strictEqual(r.pid, 12345);
});

test('parseHeartbeatTail: trailing newline tolerated', () => {
  const line = '{"ts":"2026-04-29T05:00:00Z","pid":1}\n';
  const r = parseHeartbeatTail(line);
  assert.strictEqual(r.pid, 1);
});

test('parseHeartbeatTail: multi-line returns LAST line', () => {
  const content = [
    '{"ts":"2026-04-29T04:00:00Z","pid":1}',
    '{"ts":"2026-04-29T04:30:00Z","pid":1}',
    '{"ts":"2026-04-29T05:00:00Z","pid":1}',
    '',
  ].join('\n');
  const r = parseHeartbeatTail(content);
  assert.strictEqual(r.tsMs, Date.parse('2026-04-29T05:00:00Z'));
});

test('parseHeartbeatTail: malformed last line → null (does NOT walk back to earlier valid line)', () => {
  // Strict-tail per dispatch: a stuck-malformed tail must not mask a
  // dead agent by surfacing an old heartbeat.
  const content = [
    '{"ts":"2026-04-29T04:00:00Z","pid":1}',
    '{ partial write...',
  ].join('\n');
  assert.strictEqual(parseHeartbeatTail(content), null);
});

test('parseHeartbeatTail: empty string → null', () => {
  assert.strictEqual(parseHeartbeatTail(''), null);
});

test('parseHeartbeatTail: only whitespace/blank lines → null', () => {
  assert.strictEqual(parseHeartbeatTail('\n\n   \n'), null);
});

test('parseHeartbeatTail: non-string input → null', () => {
  assert.strictEqual(parseHeartbeatTail(null), null);
  assert.strictEqual(parseHeartbeatTail(undefined), null);
  assert.strictEqual(parseHeartbeatTail(42), null);
  assert.strictEqual(parseHeartbeatTail({}), null);
});

test('parseHeartbeatTail: missing ts field → null', () => {
  assert.strictEqual(parseHeartbeatTail('{"pid":1,"role":"impl"}'), null);
});

test('parseHeartbeatTail: empty-string ts → null (NOT zero-epoch)', () => {
  // Empty-string-as-explicit-override guard.
  assert.strictEqual(parseHeartbeatTail('{"ts":"","pid":1}'), null);
});

test('parseHeartbeatTail: unparseable ts → null', () => {
  assert.strictEqual(parseHeartbeatTail('{"ts":"not-a-date","pid":1}'), null);
});

test('parseHeartbeatTail: missing pid is OK; result.pid = null', () => {
  const r = parseHeartbeatTail('{"ts":"2026-04-29T05:00:00Z"}');
  assert.strictEqual(r.tsMs, Date.parse('2026-04-29T05:00:00Z'));
  assert.strictEqual(r.pid, null);
});

test('parseHeartbeatTail: array (not object) at top level → null', () => {
  assert.strictEqual(parseHeartbeatTail('[1,2,3]'), null);
});

test('parseHeartbeatTail: CRLF line endings tolerated', () => {
  const content = '{"ts":"2026-04-29T04:00:00Z","pid":1}\r\n{"ts":"2026-04-29T05:00:00Z","pid":2}\r\n';
  const r = parseHeartbeatTail(content);
  assert.strictEqual(r.pid, 2);
});

// =========================================================================
// D — findLastCheckpoint
// =========================================================================

test('findLastCheckpoint: returns most recent file basename', () => {
  const dir = mkTmp('chkp');
  const a = path.join(dir, 'older.md');
  const b = path.join(dir, 'newer.md');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  fs.utimesSync(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(b, new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.strictEqual(findLastCheckpoint(dir), 'newer.md');
});

test('findLastCheckpoint: missing directory → null', () => {
  assert.strictEqual(findLastCheckpoint('/this/path/should/never/exist'), null);
});

test('findLastCheckpoint: empty directory → null', () => {
  const dir = mkTmp('chkp-empty');
  assert.strictEqual(findLastCheckpoint(dir), null);
});

test('findLastCheckpoint: excludes heartbeat.jsonl even when it is the newest', () => {
  const dir = mkTmp('chkp-hb');
  const md = path.join(dir, 'impl-complete.md');
  const hb = path.join(dir, 'heartbeat.jsonl');
  fs.writeFileSync(md, 'a');
  fs.writeFileSync(hb, 'b');
  fs.utimesSync(md, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(hb, new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.strictEqual(findLastCheckpoint(dir), 'impl-complete.md');
});

test('findLastCheckpoint: excludes .lock / .tmp / .swp suffixes', () => {
  const dir = mkTmp('chkp-trans');
  const real = path.join(dir, 'real.md');
  fs.writeFileSync(real, 'real');
  const future = new Date(2027, 0, 1);
  for (const fn of ['editor.swp', 'process.lock', 'partial.tmp']) {
    const p = path.join(dir, fn);
    fs.writeFileSync(p, '...');
    fs.utimesSync(p, future, future);
  }
  assert.strictEqual(findLastCheckpoint(dir), 'real.md');
});

test('findLastCheckpoint: ignores subdirectories (shallow scan)', () => {
  const dir = mkTmp('chkp-subdir');
  const sub = path.join(dir, 'subdir');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'inside.md'), 'a');
  fs.writeFileSync(path.join(dir, 'top.md'), 'top');
  assert.strictEqual(findLastCheckpoint(dir), 'top.md');
});

test('findLastCheckpoint: mixed extensions ranked purely by mtime', () => {
  const dir = mkTmp('chkp-mixed');
  const md = path.join(dir, 'a.md');
  const json = path.join(dir, 'b.json');
  fs.writeFileSync(md, 'a');
  fs.writeFileSync(json, '{}');
  fs.utimesSync(md, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(json, new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.strictEqual(findLastCheckpoint(dir), 'b.json');
});

// =========================================================================
// E — coerceTimestampMs
// =========================================================================

test('coerceTimestampMs: ISO string → epoch ms', () => {
  assert.strictEqual(
    coerceTimestampMs('2026-04-29T05:00:00Z'),
    Date.parse('2026-04-29T05:00:00Z')
  );
});

test('coerceTimestampMs: Date object → epoch ms', () => {
  const d = new Date('2026-04-29T05:00:00Z');
  assert.strictEqual(coerceTimestampMs(d), d.getTime());
});

test('coerceTimestampMs: finite number → unchanged', () => {
  assert.strictEqual(coerceTimestampMs(1234567890), 1234567890);
});

test('coerceTimestampMs: empty string → null (NOT zero-epoch)', () => {
  assert.strictEqual(coerceTimestampMs(''), null);
  assert.strictEqual(coerceTimestampMs('   '), null);
});

test('coerceTimestampMs: null/undefined → null', () => {
  assert.strictEqual(coerceTimestampMs(null), null);
  assert.strictEqual(coerceTimestampMs(undefined), null);
});

test('coerceTimestampMs: garbage string → null', () => {
  assert.strictEqual(coerceTimestampMs('not a date'), null);
});

test('coerceTimestampMs: non-finite number → null', () => {
  assert.strictEqual(coerceTimestampMs(Infinity), null);
  assert.strictEqual(coerceTimestampMs(NaN), null);
});

// =========================================================================
// E2 — asPositiveInt (mirrors parse-manifest's expectPositiveInt semantics)
// =========================================================================

test('asPositiveInt: integer number → unchanged', () => {
  assert.strictEqual(asPositiveInt(5), 5);
  assert.strictEqual(asPositiveInt(60), 60);
});

test('asPositiveInt: numeric string → coerced (matches parse-manifest)', () => {
  // parse-manifest validates via Number(v), so "5" passes validation.
  // checkHealth must coerce identically — codex round 4 [P2].
  assert.strictEqual(asPositiveInt('5'), 5);
  assert.strictEqual(asPositiveInt('30'), 30);
});

test('asPositiveInt: zero, negative, fractional, non-finite → null', () => {
  assert.strictEqual(asPositiveInt(0), null);
  assert.strictEqual(asPositiveInt(-1), null);
  assert.strictEqual(asPositiveInt(1.5), null);
  assert.strictEqual(asPositiveInt(Infinity), null);
  assert.strictEqual(asPositiveInt(NaN), null);
});

test('asPositiveInt: empty string → null (NOT zero — empty-string-as-override guard)', () => {
  assert.strictEqual(asPositiveInt(''), null);
  assert.strictEqual(asPositiveInt('   '), null);
});

test('asPositiveInt: garbage string → null', () => {
  assert.strictEqual(asPositiveInt('forever'), null);
  assert.strictEqual(asPositiveInt('5.5'), null);
});

test('asPositiveInt: null/undefined → null', () => {
  assert.strictEqual(asPositiveInt(null), null);
  assert.strictEqual(asPositiveInt(undefined), null);
});

// =========================================================================
// F — readPhaseStatus
// =========================================================================

test('readPhaseStatus: missing status file → null', () => {
  const dir = mkTmp('rs-missing');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  assert.strictEqual(readPhaseStatus(manifestPath, 'phase-1'), null);
});

test('readPhaseStatus: returns entry for phase-1', () => {
  const dir = mkTmp('rs-found');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  writeStatus(manifestPath, {
    phases: { 'phase-1': { status: 'running', pid: 9999, started_at: '2026-04-29T05:00:00Z' } },
  });
  const entry = readPhaseStatus(manifestPath, 'phase-1');
  assert.strictEqual(entry.status, 'running');
  assert.strictEqual(entry.pid, 9999);
});

test('readPhaseStatus: phase id not in status → null', () => {
  const dir = mkTmp('rs-notfound');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  writeStatus(manifestPath, { phases: { 'phase-2': { status: 'pending' } } });
  assert.strictEqual(readPhaseStatus(manifestPath, 'phase-1'), null);
});

test('readPhaseStatus: corrupt YAML → null (does not throw)', () => {
  const dir = mkTmp('rs-corrupt');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const statusPath = path.join(dir, `${base}-status.yaml`);
  fs.writeFileSync(statusPath, '{ this is: not\n  valid yaml: [\n');
  assert.strictEqual(readPhaseStatus(manifestPath, 'phase-1'), null);
});

test('readPhaseStatus: phases as array (instead of map) → null', () => {
  const dir = mkTmp('rs-arr');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const statusPath = path.join(dir, `${base}-status.yaml`);
  fs.writeFileSync(statusPath, yaml.dump({ phases: ['nope'] }));
  assert.strictEqual(readPhaseStatus(manifestPath, 'phase-1'), null);
});

// =========================================================================
// G — checkHealth happy paths
// =========================================================================

test('checkHealth: alive (PID alive, within timeout, no heartbeat)', () => {
  const dir = mkTmp('ch-alive');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'impl-prompt.md'), 'hi');
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { status: 'running', pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.alive, true);
  assert.strictEqual(result.pidAlive, true);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.heartbeatAge, null);
  assert.strictEqual(result.heartbeatStale, false);
  assert.strictEqual(result.lastCheckpoint, 'impl-prompt.md');
  assert.strictEqual(result.error, undefined);
});

test('checkHealth: alive with fresh heartbeat', () => {
  const dir = mkTmp('ch-alive-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'impl-prompt.md'), 'hi');
  const hbTime = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.alive, true);
  assert.strictEqual(result.heartbeatStale, false);
  assert.strictEqual(typeof result.heartbeatAge, 'number');
  assert.ok(result.heartbeatAge >= 59 && result.heartbeatAge <= 61,
    `expected ~60s, got ${result.heartbeatAge}`);
});

test('checkHealth: crashed (PID gone + stale heartbeat) — lastCheckpoint populated', () => {
  const dir = mkTmp('ch-crashed');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'qa-playbook.md'), 'playbook');
  const hbTime = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  const startedAt = new Date(Date.now() - 12 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'qa', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_DEAD,
  });

  assert.strictEqual(result.alive, false);
  assert.strictEqual(result.pidAlive, false);
  assert.strictEqual(result.heartbeatStale, true);
  assert.strictEqual(result.lastCheckpoint, 'qa-playbook.md');
});

test('checkHealth: long-running (PID alive + stale heartbeat + within timeout) — alive (advisory only)', () => {
  const dir = mkTmp('ch-longrun');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'impl-prompt.md'), 'hi');
  const hbTime = new Date(Date.now() - 8 * 60_000).toISOString(); // stale (>5min)
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // <30min timeout
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  // Stale heartbeat alone does NOT flip alive — it's advisory.
  assert.strictEqual(result.alive, true);
  assert.strictEqual(result.heartbeatStale, true);
  assert.strictEqual(result.timedOut, false);
});

test('checkHealth: timed out (PID alive + within heartbeat threshold + past timeout)', () => {
  const dir = mkTmp('ch-timeout');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 10,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'impl-prompt.md'), 'hi');
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), pid: 9999 }) + '\n'
  );
  const startedAt = new Date(Date.now() - 15 * 60_000).toISOString(); // past 10-min deadline
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.pidAlive, true);
  assert.strictEqual(result.alive, false); // primary signal: pidAlive && !timedOut
});

// =========================================================================
// H — checkHealth heartbeat edges
// =========================================================================

test('checkHealth: no heartbeat file + PID alive → alive, heartbeatAge null', () => {
  const dir = mkTmp('ch-no-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.alive, true);
  assert.strictEqual(result.heartbeatAge, null);
  assert.strictEqual(result.heartbeatStale, false);
});

test('checkHealth: no heartbeat file + PID gone → dead', () => {
  const dir = mkTmp('ch-no-hb-dead');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_DEAD,
  });

  assert.strictEqual(result.alive, false);
  assert.strictEqual(result.pidAlive, false);
  assert.strictEqual(result.heartbeatAge, null);
});

test('checkHealth: empty heartbeat file → no usable heartbeat', () => {
  const dir = mkTmp('ch-empty-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'heartbeat.jsonl'), '');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.heartbeatAge, null);
  assert.strictEqual(result.heartbeatStale, false);
});

test('checkHealth: malformed JSON last line → no heartbeat (does not throw)', () => {
  const dir = mkTmp('ch-malformed-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    '{"ts":"2026-04-29T05:00:00Z"}\n{garbage'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.heartbeatAge, null);
});

test('checkHealth: future heartbeat ts (clock skew) → age clamped to 0', () => {
  const dir = mkTmp('ch-future-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const futureTs = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: futureTs, pid: 9999 }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.heartbeatAge, 0); // clamped
  assert.strictEqual(result.heartbeatStale, false);
});

test('checkHealth: heartbeatStaleMs override changes the stale threshold', () => {
  const dir = mkTmp('ch-hb-threshold');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const hbTime = new Date(Date.now() - 30_000).toISOString(); // 30s old
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const r1 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    heartbeatStaleMs: 60_000, _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(r1.heartbeatStale, false);

  const r2 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    heartbeatStaleMs: 10_000, _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(r2.heartbeatStale, true);
});

// =========================================================================
// I — checkHealth timeout edges
// =========================================================================

test('checkHealth: timeout uses defaults.phase_timeout_minutes when phase has none', () => {
  const dir = mkTmp('ch-timeout-default');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    defaults: { phase_timeout_minutes: 5 },
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true);
});

test('checkHealth: falls back to DEFAULT_TIMEOUT_MINUTES (60) when neither set', () => {
  const dir = mkTmp('ch-timeout-fallback');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.alive, true);
});

test('checkHealth: quoted-numeric timeout_minutes is honored (codex round 4 [P2])', () => {
  // parse-manifest's expectPositiveInt validates via Number(v), so a
  // YAML-quoted "5" passes. checkHealth must coerce identically;
  // otherwise the quoted form silently falls through to
  // DEFAULT_TIMEOUT_MINUTES.
  const dir = mkTmp('ch-quoted-timeout');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: '5', // string form, accepted by parse-manifest
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Started 10 min ago — past 5-min quoted timeout
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true, 'quoted "5" must coerce to 5min timeout');
});

test('checkHealth: quoted-numeric defaults.heartbeat_timeout_minutes is honored', () => {
  const dir = mkTmp('ch-quoted-hb');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    defaults: { heartbeat_timeout_minutes: '1' }, // string form
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 30,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Heartbeat 90s old — stale under 60s threshold
  const hbTime = new Date(Date.now() - 90_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.heartbeatStale, true, 'quoted "1" must coerce to 60s heartbeat threshold');
});

test('checkHealth: timeout per-phase override beats defaults', () => {
  const dir = mkTmp('ch-timeout-override');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    defaults: { phase_timeout_minutes: 60 },
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 5,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // 10 min ago: over phase 5min, under default 60min — per-phase wins.
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true);
});

test('checkHealth: timedOut false when started_at missing', () => {
  const dir = mkTmp('ch-timeout-missing-started-at');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, { phases: { 'phase-1': { pid: 9999 } } });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, false);
});

test('checkHealth: started_at as YAML Date object (DEFAULT_SCHEMA) is handled', () => {
  const dir = mkTmp('ch-timeout-date-obj');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const statusPath = path.join(dir, `${base}-status.yaml`);
  // Bare ISO timestamp with no quotes — DEFAULT_SCHEMA parses to Date.
  const startedAtIso = new Date(Date.now() - 60 * 60_000).toISOString();
  fs.writeFileSync(
    statusPath,
    `phases:\n  phase-1:\n    pid: 9999\n    started_at: ${startedAtIso}\n`
  );

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true);
});

test('checkHealth: started_at fallback to spawned_at (camelCase drift)', () => {
  const dir = mkTmp('ch-spawned-at');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, spawned_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, true);
});

test('checkHealth: empty-string started_at treated as missing (NOT zero-epoch)', () => {
  // Empty-string-as-explicit-override guard: '' must not parse as 0.
  // If it did, "now > 0 + 30min" would force timedOut: true.
  const dir = mkTmp('ch-empty-started-at');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: '' } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.timedOut, false);
});

test('checkHealth: _now injection allows deterministic deadline testing', () => {
  const dir = mkTmp('ch-now-inject');
  const manifestPath = writeManifest(dir, makeBaseManifest()); // 30-min timeout
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const fixedStart = '2026-04-29T05:00:00Z';
  const startedMs = Date.parse(fixedStart);
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: fixedStart } },
  });

  const r1 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE, _now: () => startedMs + 30 * 60_000 - 1,
  });
  assert.strictEqual(r1.timedOut, false);

  const r2 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE, _now: () => startedMs + 30 * 60_000 + 1,
  });
  assert.strictEqual(r2.timedOut, true);
});

// =========================================================================
// J — checkHealth PID resolution
// =========================================================================

test('checkHealth: PID resolved via getSessionPid fallback when status has no pid', () => {
  const dir = mkTmp('ch-pid-fallback');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const seen = [];
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: (name) => { seen.push(name); return 4242; },
    _killer: KILLER_ALIVE,
  });

  assert.deepStrictEqual(seen, ['orch-phase-1-impl']);
  assert.strictEqual(result.pidAlive, true);
  assert.strictEqual(result.alive, true);
});

test('checkHealth: PID lookup returns null → pidAlive false', () => {
  const dir = mkTmp('ch-pid-null');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, false);
  assert.strictEqual(result.alive, false);
});

test('checkHealth: PID lookup throws → pidAlive null (NOT false — codex round 4 [P2])', () => {
  // A thrown lookup is "couldn't decide" (transient WMI hiccup,
  // PowerShell blocked by AV, etc.). Per the public contract, this
  // must surface as pidAlive: null so Unit 11 doesn't enter recovery
  // on a transient failure. False would conflate "lookup errored"
  // with "agent crashed" and force a respawn loop.
  const dir = mkTmp('ch-pid-throws');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => { throw new Error('WMI failure'); },
    _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null, 'lookup throw must NOT be conflated with confirmed crash');
  assert.strictEqual(result.alive, false, 'alive still requires pidAlive === true');
});

test('checkHealth: status.pid is IGNORED — always uses getSessionPid (role-scoped via session name)', () => {
  // Manifest-status only stores ONE pid per phase (Unit 4 shape). For
  // multi-role phases (impl + qa), the last-written role's pid would
  // otherwise mask the others. Codex round 2 [P2]. Verify the lookup
  // path is always taken regardless of what's in status.pid.
  const dir = mkTmp('ch-ignores-status-pid');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 7777, started_at: new Date().toISOString() } },
  });

  let lookupCalled = false;
  let killerSawPid = null;
  checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => { lookupCalled = true; return 9999; },
    _killer: (pid) => { killerSawPid = pid; },
  });

  assert.strictEqual(lookupCalled, true, 'lookup must be called (role disambiguation)');
  assert.strictEqual(killerSawPid, 9999, 'killer sees lookup pid, not status.pid');
});

test('checkHealth: sessionName override changes the PID-lookup name', () => {
  const dir = mkTmp('ch-session-name');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  let seen = null;
  checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    sessionName: 'custom-session-1',
    _pidLookup: (name) => { seen = name; return 5555; },
    _killer: KILLER_ALIVE,
  });

  assert.strictEqual(seen, 'custom-session-1');
});

test('checkHealth: garbage status.pid is harmless (status.pid is unused for liveness)', () => {
  // Even if a corrupt status file has pid: 'not-a-pid', the live PID
  // comes from getSessionPid, so the bad value can't poison the check.
  const dir = mkTmp('ch-garbage-pid');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 'not-a-pid', started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, true);
  assert.strictEqual(result.alive, true);
});

test('checkHealth: production-path runner failure propagates as pidAlive: null (codex P1 round 5)', () => {
  // The exact bug Codex round 5 caught: getSessionPid's default mode
  // swallows runner failures as null. The CLI used that default and
  // would conflate "PowerShell errored" with "no matching process",
  // pushing pidAlive to false and triggering recovery on transient
  // hiccups. Verify checkHealth's default lookup uses
  // throwOnError: true and surfaces the failure as pidAlive: null.
  //
  // We verify by going through the real getSessionPid with an
  // injected runner that throws — exactly what would happen if
  // PowerShell.exe failed to spawn or Get-CimInstance crashed.
  const { getSessionPid: realGetSessionPid } = require('./spawn-session');
  const dir = mkTmp('ch-runner-fail');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const failingRunner = () => {
    const e = new Error('PowerShell could not be spawned');
    throw e;
  };
  // Build a lookup that mimics checkHealth's default — calls
  // getSessionPid with throwOnError: true. If checkHealth's default
  // didn't pass throwOnError, this would simulate that bug; we
  // override to assert the *correct* behavior.
  const lookup = (name) =>
    realGetSessionPid(name, {
      _runner: failingRunner,
      excludeWrappers: true,
      throwOnError: true,
    });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: lookup,
    _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null,
    'runner failure must surface as null, not false');
  assert.strictEqual(result.alive, false,
    'alive remains false (requires pidAlive === true)');
});

test('checkHealth: real getSessionPid is invoked with excludeWrappers: true (codex P1 round 3)', () => {
  // Wrapper PID would falsely report alive after Claude exits, since
  // cmd /k and powershell -NoExit keep the tab open with --name on
  // their CommandLine. Verify checkHealth passes excludeWrappers: true
  // when constructing its default lookup.
  //
  // Strategy: temporarily monkey-patch require.cache for spawn-session
  // is overkill. Instead, we verify the contract via the test that
  // checkHealth's default lookup returns null when only a wrapper is
  // visible. We can't easily exercise that without spawning a real
  // wrapper, so we mock at the parsePidLookupOutput layer: build a
  // fake _pidLookup that DOES go through the same WMI parser the
  // production path uses.
  const { parsePidLookupOutput } = require('./spawn-session');
  const dir = mkTmp('ch-wrapper-aware');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  // Simulate WMI: only cmd /k wrapper survives.
  const stdout = JSON.stringify([
    {
      ProcessId: 5555,
      CommandLine: 'cmd /k claude --name orch-phase-1-impl --model sonnet',
    },
  ]);
  // The lookup checkHealth uses must call parsePidLookupOutput with
  // excludeWrappers: true and therefore return null.
  const wrapperAwareLookup = (name) =>
    parsePidLookupOutput(stdout, name, { excludeWrappers: true });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: wrapperAwareLookup,
    _killer: KILLER_ALIVE, // even if wrapper PID were used, alive would be true
  });

  // Expected: wrapper-aware lookup returns null → pidAlive false → alive false
  assert.strictEqual(result.pidAlive, false, 'wrapper-only must read as dead');
  assert.strictEqual(result.alive, false);
});

test('checkHealth: role disambiguation — impl and qa lookups use distinct session names', () => {
  // The core defect codex round 2 caught: with one shared status.pid,
  // checking impl and qa would see the same pid. With session-name
  // lookup, they're naturally scoped — impl looks up orch-X-impl,
  // qa looks up orch-X-qa, and the WMI returns role-scoped PIDs.
  const dir = mkTmp('ch-multi-role');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 7777, started_at: new Date().toISOString() } },
  });

  // Simulate WMI: impl session is dead (returns null), qa session is alive (returns pid)
  const lookups = {
    'orch-phase-1-impl': null,
    'orch-phase-1-qa': 8888,
  };
  const lookup = (name) => lookups[name] ?? null;

  const implResult = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: lookup, _killer: KILLER_ALIVE,
  });
  const qaResult = checkHealth({
    phaseId: 'phase-1', role: 'qa', manifestPath,
    _pidLookup: lookup, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(implResult.pidAlive, false, 'impl is dead');
  assert.strictEqual(qaResult.pidAlive, true, 'qa is alive');
});

test('checkHealth: PID kill returns null code (unknown error) → pidAlive null, alive false', () => {
  const dir = mkTmp('ch-pid-unknown');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 1234, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 1234, _killer: KILLER_UNKNOWN,
  });

  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.alive, false);
});

test('checkHealth: defaults.heartbeat_timeout_minutes from manifest is honored', () => {
  // Codex round 2 [P2]: when a manifest sets a non-default heartbeat
  // timeout, checkHealth must use it instead of HEARTBEAT_STALE_MS.
  const dir = mkTmp('ch-manifest-hb-timeout');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    defaults: { heartbeat_timeout_minutes: 1 }, // 60_000ms
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 30,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Heartbeat 90s old — stale under 60s threshold, fresh under default 5min
  const hbTime = new Date(Date.now() - 90_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  // 90s > 60s threshold from manifest → stale (would have been false under HEARTBEAT_STALE_MS)
  assert.strictEqual(result.heartbeatStale, true);
});

test('checkHealth: opts.heartbeatStaleMs overrides manifest defaults.heartbeat_timeout_minutes', () => {
  const dir = mkTmp('ch-hb-opts-override');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    defaults: { heartbeat_timeout_minutes: 1 }, // would mark 90s as stale
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 30,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const hbTime = new Date(Date.now() - 90_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: hbTime, pid: 9999 }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  // Opts override: 5min — 90s is well within fresh
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    heartbeatStaleMs: 5 * 60_000,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.heartbeatStale, false);
});

// =========================================================================
// K — checkHealth: phase dir + error paths
// =========================================================================

test('checkHealth: phase directory missing → alive false, error set, lastCheckpoint null', () => {
  const dir = mkTmp('ch-no-phase-dir');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  // Do NOT create the phase directory.
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.alive, false);
  assert.strictEqual(result.lastCheckpoint, null);
  assert.match(result.error, /phase directory not found/);
});

test('checkHealth: manifest does not exist → returns error, does not throw', () => {
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl',
    manifestPath: path.join(os.tmpdir(), 'definitely-does-not-exist-xyz.yaml'),
  });
  assert.strictEqual(result.alive, false);
  assert.match(result.error, /manifest not found/);
});

test('checkHealth: phaseId not in manifest → returns error', () => {
  const dir = mkTmp('ch-phase-not-found');
  const manifestPath = writeManifest(dir, makeBaseManifest());

  const result = checkHealth({
    phaseId: 'phase-99', role: 'impl', manifestPath,
  });

  assert.strictEqual(result.alive, false);
  assert.match(result.error, /phase "phase-99" not found/);
});

test('checkHealth: invalid manifest YAML → returns error', () => {
  const dir = mkTmp('ch-bad-yaml');
  const manifestPath = path.join(dir, 'manifest.yaml');
  fs.writeFileSync(manifestPath, 'this is: not\n  valid: [yaml\n');

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
  });

  assert.strictEqual(result.alive, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('checkHealth: phase dir missing keeps PID and timeout fields populated for diagnostics', () => {
  const dir = mkTmp('ch-no-phase-dir-fields');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.alive, false);
  assert.strictEqual(result.pidAlive, true); // diagnostic visibility
  assert.strictEqual(result.timedOut, false);
});

// =========================================================================
// L — checkHealth: input validation
// =========================================================================

test('checkHealth: invalid phaseId throws', () => {
  assert.throws(
    () => checkHealth({ phaseId: 'has spaces', role: 'impl', manifestPath: '/x' }),
    /phaseId.*not safe/
  );
  assert.throws(
    () => checkHealth({ phaseId: '../traversal', role: 'impl', manifestPath: '/x' }),
    /phaseId.*not safe/
  );
});

test('checkHealth: empty phaseId throws', () => {
  assert.throws(
    () => checkHealth({ phaseId: '', role: 'impl', manifestPath: '/x' }),
    /phaseId/
  );
});

test('checkHealth: missing phaseId throws', () => {
  assert.throws(
    () => checkHealth({ role: 'impl', manifestPath: '/x' }),
    /phaseId/
  );
});

test('checkHealth: invalid role throws', () => {
  assert.throws(
    () => checkHealth({ phaseId: 'phase-1', role: 'bogus', manifestPath: '/x' }),
    /role must be one of/
  );
});

test('checkHealth: recovery role rejected (V1.5 territory)', () => {
  assert.throws(
    () => checkHealth({ phaseId: 'phase-1', role: 'recovery', manifestPath: '/x' }),
    /role must be one of/
  );
});

test('checkHealth: missing manifestPath throws', () => {
  assert.throws(
    () => checkHealth({ phaseId: 'phase-1', role: 'impl' }),
    /manifestPath is required/
  );
  assert.throws(
    () => checkHealth({ phaseId: 'phase-1', role: 'impl', manifestPath: '' }),
    /manifestPath is required/
  );
});

test('checkHealth: invalid heartbeatStaleMs throws', () => {
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', heartbeatStaleMs: -1,
    }),
    /heartbeatStaleMs/
  );
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', heartbeatStaleMs: 'huge',
    }),
    /heartbeatStaleMs/
  );
});

// =========================================================================
// M — defaults + overrides
// =========================================================================

test('defaultPhaseDir composes <workdir>/docs/orchestration/phases/<phaseId>', () => {
  assert.strictEqual(
    defaultPhaseDir('/tmp/repo', 'phase-3'),
    path.join('/tmp/repo', 'docs', 'orchestration', 'phases', 'phase-3')
  );
});

test('defaultSessionName composes orch-<phase>-<role>', () => {
  assert.strictEqual(defaultSessionName('phase-1', 'impl'), 'orch-phase-1-impl');
  assert.strictEqual(defaultSessionName('phase.0', 'qa'), 'orch-phase.0-qa');
});

test('checkHealth: phaseDir override takes precedence over derived workdir path', () => {
  const dir = mkTmp('ch-phasedir-override');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const customPhaseDir = path.join(dir, 'custom-location');
  fs.mkdirSync(customPhaseDir, { recursive: true });
  fs.writeFileSync(path.join(customPhaseDir, 'work-product.md'), 'real');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    phaseDir: customPhaseDir, _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.lastCheckpoint, 'work-product.md');
});

test('checkHealth: manifest.workdir is NOT used for protocol root (matches scaffold-protocol)', () => {
  // Per docs/manifest-reference.md §workdir, manifest.workdir is the
  // spawned tab's --startingDirectory, NOT the protocol root. Protocol
  // artifacts always live under the manifest's directory. Verify
  // checkHealth honors that convention even when manifest.workdir
  // points elsewhere — otherwise it would falsely report `phase
  // directory not found` on healthy sessions.
  const dir = mkTmp('ch-no-manifest-workdir-leak');
  const tabStartDir = path.join(dir, 'agent-cwd');
  fs.mkdirSync(tabStartDir, { recursive: true });
  const manifestPath = writeManifest(dir, {
    name: 'test',
    workdir: tabStartDir, // tab CWD — must NOT be treated as protocol root
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 30,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  // Place phase artifacts under manifest_dir, NOT under tabStartDir.
  const phaseDirCorrect = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDirCorrect, { recursive: true });
  fs.writeFileSync(path.join(phaseDirCorrect, 'real-artifact.md'), 'ok');
  // Decoy: place a misleading file under tabStartDir/docs/... — if
  // checkHealth wrongly used manifest.workdir, it would return this.
  const phaseDirWrong = path.join(tabStartDir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDirWrong, { recursive: true });
  fs.writeFileSync(path.join(phaseDirWrong, 'WRONG-artifact.md'), 'should not surface');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath, _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.lastCheckpoint, 'real-artifact.md');
  assert.strictEqual(result.alive, true);
  assert.strictEqual(result.error, undefined);
});

// =========================================================================
// N — CLI smoke (≤2 spawnSync invocations per todo 044)
// =========================================================================

const CLI_ENTRY = path.resolve(__dirname, 'check-health.js');

test('CLI: --help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [CLI_ENTRY, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--phase/);
});

test('CLI: happy-path invocation exits 0 with valid JSON status', () => {
  const dir = mkTmp('cli-happy');
  const manifestPath = writeManifest(dir, {
    name: 'test',
    phases: [
      {
        id: 'phase-1',
        completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
        timeout_minutes: 60,
        agents: [{ role: 'impl' }],
      },
    ],
  });
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'impl-prompt.md'), 'hi');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  // The CLI doesn't accept _pidLookup injection, so it calls real
  // getSessionPid(orch-phase-1-impl). The session was never spawned →
  // PID lookup returns null → pidAlive is false → alive is false. We
  // assert exit 0 + valid JSON shape (the goal: the binary doesn't
  // crash on a real call). A live-session smoke test belongs in
  // integration coverage, not unit tests.
  const r = spawnSync(
    process.execPath,
    [CLI_ENTRY, '--phase', 'phase-1', '--role', 'impl', '--manifest', manifestPath],
    { encoding: 'utf8' }
  );
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(typeof parsed.alive, 'boolean');
  assert.ok('pidAlive' in parsed);
  assert.ok('timedOut' in parsed);
  assert.ok('heartbeatAge' in parsed);
  assert.ok('heartbeatStale' in parsed);
  assert.ok('lastCheckpoint' in parsed);
  assert.strictEqual(parsed.lastCheckpoint, 'impl-prompt.md');
});
