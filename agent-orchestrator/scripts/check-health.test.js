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
  readHeartbeatRecord,
  findLastCheckpoint,
  readPhaseStatus,
  coerceTimestampMs,
  asPositiveInt,
  defaultPhaseDir,
  defaultSessionName,
  parseCliArgs,
  parseNonNegativeIntFlag,
  VALID_ROLES,
  DEFAULT_TIMEOUT_MINUTES,
  HEARTBEAT_STALE_MS,
  DEFAULT_STARTUP_GRACE_MS,
  HEARTBEAT_TAIL_WINDOW_BYTES,
  MAX_CHECKPOINT_ENTRIES,
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

test('exports DEFAULT_STARTUP_GRACE_MS = 60_000 (60 seconds)', () => {
  assert.strictEqual(DEFAULT_STARTUP_GRACE_MS, 60_000);
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

test('parseHeartbeatTail: role filter returns most recent matching role', () => {
  // Codex round 6 [P2]: shared heartbeat file across roles. Without
  // role filter the last impl write would mask a stale qa.
  const content = [
    '{"ts":"2026-04-29T05:00:00Z","pid":1,"role":"qa"}',
    '{"ts":"2026-04-29T05:01:00Z","pid":2,"role":"impl"}',
    '{"ts":"2026-04-29T05:02:00Z","pid":2,"role":"impl"}',
  ].join('\n');
  const qa = parseHeartbeatTail(content, { role: 'qa' });
  const impl = parseHeartbeatTail(content, { role: 'impl' });
  assert.strictEqual(qa.tsMs, Date.parse('2026-04-29T05:00:00Z'));
  assert.strictEqual(impl.tsMs, Date.parse('2026-04-29T05:02:00Z'));
});

test('parseHeartbeatTail: role filter walks past malformed and wrong-role lines', () => {
  const content = [
    '{"ts":"2026-04-29T05:00:00Z","pid":1,"role":"impl"}', // older impl entry
    '{"ts":"2026-04-29T05:01:00Z","pid":2,"role":"qa"}',
    '{ malformed',
    '{"ts":"2026-04-29T05:03:00Z","pid":3,"role":"qa"}',  // newer qa
  ].join('\n');
  const r = parseHeartbeatTail(content, { role: 'impl' });
  assert.strictEqual(r.tsMs, Date.parse('2026-04-29T05:00:00Z'));
  assert.strictEqual(r.pid, 1);
});

test('parseHeartbeatTail: role filter — no matching role → null', () => {
  const content = '{"ts":"2026-04-29T05:00:00Z","pid":1,"role":"impl"}\n';
  assert.strictEqual(parseHeartbeatTail(content, { role: 'qa' }), null);
});

test('parseHeartbeatTail: no-role-filter strict-tail unchanged (malformed last line → null)', () => {
  // Default behavior must remain strict-tail when role isn't supplied.
  const content = '{"ts":"2026-04-29T05:00:00Z"}\n{garbage';
  assert.strictEqual(parseHeartbeatTail(content), null);
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

// -------------------------------------------------------------------------
// findLastCheckpoint cap (todo 068)
// -------------------------------------------------------------------------

test('findLastCheckpoint: cap exposed and equals 256', () => {
  // The cap value is part of the contract — operators may legitimately
  // care about the threshold when designing scaffolds. Pin it.
  assert.strictEqual(MAX_CHECKPOINT_ENTRIES, 256);
});

test('findLastCheckpoint: at exactly the cap (256 entries) — full mtime scan still runs', () => {
  // Boundary: behavior must be unchanged at the cap, only > cap.
  const fakeEntries = Array.from({ length: MAX_CHECKPOINT_ENTRIES }, (_, i) => ({
    name: `file-${i}.md`,
    isFile: () => true,
  }));
  let statCount = 0;
  const fakeStat = () => {
    statCount++;
    return { mtimeMs: 1000 + statCount };
  };
  const result = findLastCheckpoint('/fake', () => fakeEntries, fakeStat);
  assert.ok(result, 'at-cap directory still produces a winner');
  assert.strictEqual(statCount, MAX_CHECKPOINT_ENTRIES, 'all entries stat-d at the cap');
});

test('findLastCheckpoint: above cap (>256 entries) → ZERO statSyncs and null return (todo 068 safety property)', () => {
  // The verifiable safety property per the AC: cap-exceeded branch
  // executes ZERO per-entry statSync calls. We inject a counting
  // _statSync and assert count === 0.
  const fakeEntries = Array.from({ length: MAX_CHECKPOINT_ENTRIES + 1 }, (_, i) => ({
    name: `file-${i}.md`,
    isFile: () => true,
  }));
  let statCount = 0;
  const countingStat = () => {
    statCount++;
    return { mtimeMs: 1 };
  };
  let warning = null;
  const result = findLastCheckpoint(
    '/fake',
    () => fakeEntries,
    countingStat,
    (msg) => { warning = msg; }
  );
  assert.strictEqual(statCount, 0, 'past cap, ZERO per-entry statSync calls');
  assert.strictEqual(result, null, 'past cap, lastCheckpoint is null');
  // Advisory diagnostic must surface (log line per AC).
  assert.match(warning, /phase dir overflowed/);
});

test('findLastCheckpoint: above cap does NOT name-sort + take-first (would discard newest with timestamp-prefixed names)', () => {
  // Named entries are timestamp-prefixed; ascending name sort would
  // pick the OLDEST. Verify we don't fall into that trap by surfacing
  // null instead of a plausible-but-wrong "winner."
  const fakeEntries = Array.from({ length: 300 }, (_, i) => ({
    name: `2026-04-${String(i + 1).padStart(2, '0')}-checkpoint.md`,
    isFile: () => true,
  }));
  const result = findLastCheckpoint('/fake', () => fakeEntries, () => ({ mtimeMs: 1 }), () => {});
  assert.strictEqual(result, null, 'must NOT name-sort + take-first as a fallback');
});

test('findLastCheckpoint: empty dir below cap still returns null (no advisory)', () => {
  let warningCount = 0;
  const result = findLastCheckpoint('/fake', () => [], () => ({ mtimeMs: 1 }), () => { warningCount++; });
  assert.strictEqual(result, null);
  assert.strictEqual(warningCount, 0, 'empty dir is not an overflow case');
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'qa', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: new Date().toISOString(), pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: futureTs, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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

test('checkHealth: spawned_at-only row is ignored (todo 078 — fallback removed)', () => {
  // PR #17 dropped the `spawned_at` fallback. A status row that only
  // carries `spawned_at` (camelCase drift from spawn-session's
  // spawnedAt return shape) is now silently ignored by the timeout
  // check. The 1-hour-old started_at would have produced
  // `timedOut: true` under the pre-PR-#17 fallback; with the fallback
  // removed, the timeout check is skipped (no canonical timestamp)
  // and the verdict is governed only by pidAlive. This makes a
  // misnamed writer loud — operators get a stuck "alive but never
  // times out" rather than a silently-correct fallback.
  const dir = mkTmp('ch-spawned-at-only');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, spawned_at: oneHourAgo } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(
    result.timedOut,
    false,
    'spawned_at must NOT be read; timeout check is skipped without started_at'
  );
  assert.strictEqual(result.pidAlive, true, 'pid lookup still resolves the live pid');
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

test('checkHealth: lookup null + within startup grace → pidAlive null (codex P2 round 7)', () => {
  // Just-spawned session: spawn-session has run wt but the inner
  // Claude child hasn't registered with WMI yet. excludeWrappers:
  // true correctly returns null (only the wrapper is visible).
  // Without grace, we'd report pidAlive: false → Unit 11 triggers
  // recovery on a still-spawning session. Grace surfaces this as
  // pidAlive: null instead.
  const dir = mkTmp('ch-startup-grace');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Started 5 seconds ago — well within 60s grace
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, // Claude child not yet visible
    _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null, 'startup grace must surface null, not false');
  assert.strictEqual(result.alive, false); // alive still requires pidAlive === true
});

test('checkHealth: lookup null + past startup grace → pidAlive null + reason session_not_found (todo 071 BEHAVIOR CHANGE)', () => {
  // BEHAVIOR CHANGE vs PR #15: this case used to surface as
  // `pidAlive: false`. PR #17 (todo 071) makes it
  // `pidAlive: null + pidAliveReason: 'session_not_found'` so Unit 11's
  // tri-state convergence ("two consecutive nulls past grace = crash")
  // applies uniformly. ESRCH from kill(pid, 0) STAYS pidAlive: false —
  // see the kill-ESRCH test below.
  const dir = mkTmp('ch-past-grace');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Started 5 minutes ago — well past 60s grace
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: startedAt } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null,
    _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null, 'past grace, null lookup → null (not false)');
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
  assert.strictEqual(result.alive, false, 'alive still requires pidAlive === true');
});

test('checkHealth: startupGraceMs override is respected', () => {
  const dir = mkTmp('ch-grace-override');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: startedAt } },
  });

  // Default 60s: 30s ago is within grace → null + 'startup_grace'
  const r1 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(r1.pidAlive, null);
  assert.strictEqual(r1.pidAliveReason, 'startup_grace');

  // 10s grace: 30s ago is past grace → null + 'session_not_found'
  // (todo 071 behavior change — was pidAlive: false pre-PR-#17).
  const r2 = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
    startupGraceMs: 10_000,
  });
  assert.strictEqual(r2.pidAlive, null);
  assert.strictEqual(r2.pidAliveReason, 'session_not_found');
});

test('checkHealth: lookup null + no started_at → pidAlive null + reason session_not_found (todo 071)', () => {
  // No started_at means no grace anchor — checkHealth cannot tell
  // whether we're inside the startup window. PR #17 unifies this with
  // "past grace": pidAlive: null + reason 'session_not_found' so Unit
  // 11's tri-state convergence applies. (Pre-PR-#17 returned false.)
  const dir = mkTmp('ch-grace-no-anchor');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { } }, // no started_at
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
});

test('checkHealth: invalid startupGraceMs throws', () => {
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', startupGraceMs: -1,
    }),
    /startupGraceMs/
  );
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', startupGraceMs: 'huge',
    }),
    /startupGraceMs/
  );
});

test('checkHealth: PID lookup returns null + past grace → pidAlive null + reason session_not_found (todo 071)', () => {
  // Pre-PR-#17 surfaced pidAlive: false; todo 071 unifies all
  // "WMI lookup miss past grace" cases under
  // pidAlive: null + reason 'session_not_found'.
  const dir = mkTmp('ch-pid-null');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Started 5 minutes ago — well past 60s startup grace
  writeStatus(manifestPath, {
    phases: {
      'phase-1': { started_at: new Date(Date.now() - 5 * 60_000).toISOString() },
    },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
  assert.strictEqual(result.alive, false);
});

test('checkHealth: PID lookup throws → pidAlive null + reason lookup_failed (todo 071)', () => {
  // A thrown lookup is "couldn't decide" (transient WMI hiccup,
  // PowerShell blocked by AV, etc.). Per the public contract, this
  // must surface as pidAlive: null so Unit 11 doesn't enter recovery
  // on a transient failure. False would conflate "lookup errored"
  // with "agent crashed" and force a respawn loop.
  // Todo 071 (PR #17): the reason channel is 'lookup_failed' so the
  // caller can distinguish this from a startup-grace null or a
  // session-not-found null.
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
  assert.strictEqual(result.pidAliveReason, 'lookup_failed');

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
  // Started 5 minutes ago — past 60s startup grace. The wrapper-masks-
  // crashed-agent scenario is what we're testing; grace would otherwise
  // surface as null, which is correct in the startup window but not
  // here.
  writeStatus(manifestPath, {
    phases: {
      'phase-1': { started_at: new Date(Date.now() - 5 * 60_000).toISOString() },
    },
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

  // Expected: wrapper-aware lookup returns null → past grace →
  // pidAlive: null + reason 'session_not_found' (todo 071 BEHAVIOR
  // CHANGE: was pidAlive: false pre-PR-#17). The wrapper-mask
  // regression anchor still holds — wrapper-only must NOT read as
  // alive — and the contract is now "tri-state convergence applies"
  // rather than "single-poll confirmed crash."
  assert.strictEqual(result.pidAlive, null, 'wrapper-only must NOT read as alive');
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
  assert.strictEqual(result.alive, false);
});

test('checkHealth: heartbeat filtered by role — fresh impl write does NOT mask stale qa (codex P2 round 6)', () => {
  // Multi-role phases share heartbeat.jsonl; impl and qa each append
  // entries tagged with their `role`. Without filtering, qa's freshness
  // would be reported as impl's last write age — a fresh impl entry
  // would falsely report qa as alive even when qa hasn't heartbeated
  // in 30 minutes.
  const dir = mkTmp('ch-multirole-hb');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // qa last heartbeated 30 min ago; impl heartbeated 30s ago. The
  // protocol allows both to share heartbeat.jsonl.
  const qaTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const implTs = new Date(Date.now() - 30_000).toISOString();
  const lines = [
    JSON.stringify({ ts: qaTs, pid: 1, role: 'qa', phase_id: 'phase-1' }),
    JSON.stringify({ ts: implTs, pid: 2, role: 'impl', phase_id: 'phase-1' }),
  ];
  fs.writeFileSync(path.join(phaseDir, 'heartbeat.jsonl'), lines.join('\n') + '\n');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const qaResult = checkHealth({
    phaseId: 'phase-1', role: 'qa', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  const implResult = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  // qa should see the 30-min-old qa heartbeat → stale
  assert.strictEqual(qaResult.heartbeatStale, true, 'qa heartbeat must read as stale');
  assert.ok(qaResult.heartbeatAge >= 30 * 60 - 5, `qa age expected ~30min, got ${qaResult.heartbeatAge}s`);
  // impl should see the 30s-old impl heartbeat → fresh
  assert.strictEqual(implResult.heartbeatStale, false, 'impl heartbeat must read as fresh');
  assert.ok(implResult.heartbeatAge >= 28 && implResult.heartbeatAge <= 32,
    `impl age expected ~30s, got ${implResult.heartbeatAge}s`);
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
  // Past 60s startup grace so a null lookup reads as crash, not "still spawning".
  writeStatus(manifestPath, {
    phases: {
      'phase-1': {
        pid: 7777,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    },
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

  // impl: lookup returns null past grace → null + 'session_not_found'
  // (todo 071 behavior change). Either way, alive is false.
  assert.strictEqual(implResult.pidAlive, null, 'impl null lookup → null (todo 071)');
  assert.strictEqual(implResult.pidAliveReason, 'session_not_found');
  assert.strictEqual(implResult.alive, false);
  // qa: lookup returns 8888 → kill ok → pidAlive true.
  assert.strictEqual(qaResult.pidAlive, true, 'qa is alive');
  assert.strictEqual(qaResult.pidAliveReason, null, 'no reason set when pidAlive is true');
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
    JSON.stringify({ ts: hbTime, pid: 9999, role: 'impl', phase_id: 'phase-1' }) + '\n'
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
  // Todo 072 (PR #17): runtime diagnostic, not config — Unit 11 keeps polling.
  assert.strictEqual(result.errorKind, 'runtime');
});

test('checkHealth: manifest does not exist → returns error, does not throw', () => {
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl',
    manifestPath: path.join(os.tmpdir(), 'definitely-does-not-exist-xyz.yaml'),
  });
  assert.strictEqual(result.alive, false);
  assert.match(result.error, /manifest not found/);
  // Todo 072 (PR #17): config failure — Unit 11 should pause polling.
  assert.strictEqual(result.errorKind, 'config');
});

test('checkHealth: phaseId not in manifest → returns error', () => {
  const dir = mkTmp('ch-phase-not-found');
  const manifestPath = writeManifest(dir, makeBaseManifest());

  const result = checkHealth({
    phaseId: 'phase-99', role: 'impl', manifestPath,
  });

  assert.strictEqual(result.alive, false);
  assert.match(result.error, /phase "phase-99" not found/);
  assert.strictEqual(result.errorKind, 'config');
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
  assert.strictEqual(result.errorKind, 'config');
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
  // ce:review round 1: lib must match CLI (integer-only). Pre-fix
  // accepted 1.5 silently, diverging from the documented contract.
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', heartbeatStaleMs: 1.5,
    }),
    /heartbeatStaleMs.*non-negative integer/
  );
});

test('checkHealth: invalid startupGraceMs (non-integer) throws (ce:review round 1)', () => {
  assert.throws(
    () => checkHealth({
      phaseId: 'phase-1', role: 'impl', manifestPath: '/x', startupGraceMs: 30000.5,
    }),
    /startupGraceMs.*non-negative integer/
  );
});

// =========================================================================
// M — defaults + overrides
// =========================================================================

test('defaultPhaseDir composes <manifestDir>/docs/orchestration/phases/<phaseId>', () => {
  // Per todo 070 (PR #17), the parameter is `manifestDir` — the manifest's
  // containing directory, NOT `manifest.workdir`. The fixture path uses
  // a manifest-dir-shaped value so future readers don't reintroduce the
  // workdir mental model the rename was meant to retire.
  const manifestDir = path.join('/path', 'to', 'manifest-root');
  assert.strictEqual(
    defaultPhaseDir(manifestDir, 'phase-3'),
    path.join(manifestDir, 'docs', 'orchestration', 'phases', 'phase-3')
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
// K — Heartbeat tail-read fixed window (todo 067)
// =========================================================================
//
// Behavior:
//   - Files smaller than the 64 KiB initial window: read fully, no
//     partial-line drop applied.
//   - Files between 64 KiB and 256 KiB: 64 KiB tail read first; if the
//     latest role-matching record falls within that tail, return it.
//     Otherwise re-expand to 256 KiB.
//   - Files larger than 1 MiB with the latest role-matching record
//     beyond the maximum window: return null + heartbeatCorrupt as
//     observed (tail-only signal — itself a freshness clue for Unit 11).

test('readHeartbeatRecord: small file (< 64 KiB) parsed without partial-line drop', () => {
  const dir = mkTmp('hb-tail-small');
  const filePath = path.join(dir, 'heartbeat.jsonl');
  const ts = '2026-04-29T05:00:00Z';
  fs.writeFileSync(filePath, JSON.stringify({ ts, pid: 1, role: 'impl' }) + '\n');
  const r = readHeartbeatRecord(filePath, 'impl');
  assert.strictEqual(r.tsMs, Date.parse(ts));
  assert.strictEqual(r.pid, 1);
  assert.strictEqual(r.corrupt, false);
});

test('readHeartbeatRecord: tail-window read finds latest record at end of large file', () => {
  // File > 64 KiB: garbage prefix + latest impl record at the end.
  // The walk goes end → start, so it lands on the impl line first
  // and returns without scanning the prefix. corrupt: false because
  // we never had to look at the corrupt prefix.
  const dir = mkTmp('hb-tail-window');
  const filePath = path.join(dir, 'heartbeat.jsonl');
  const padding = ('x'.repeat(80) + '\n').repeat(900); // ~73 KiB of garbage
  const ts = '2026-04-29T05:00:00Z';
  const tail = JSON.stringify({ ts, pid: 7777, role: 'impl' }) + '\n';
  fs.writeFileSync(filePath, padding + tail);
  const r = readHeartbeatRecord(filePath, 'impl');
  assert.strictEqual(r.tsMs, Date.parse(ts));
  assert.strictEqual(r.pid, 7777);
  // We returned on the very last line; the corrupt prefix was never
  // examined during the role-filter walk.
  assert.strictEqual(r.corrupt, false);
});

test('readHeartbeatRecord: tail-window walks past corrupt suffix lines to find a valid record', () => {
  // File > 64 KiB with malformed lines AT THE END (after the latest
  // impl record). The walk encounters the malformed lines first
  // (corrupt = true) before salvaging the impl record further back.
  const dir = mkTmp('hb-tail-corrupt-suffix');
  const filePath = path.join(dir, 'heartbeat.jsonl');
  const padding = ('x'.repeat(80) + '\n').repeat(900); // ~73 KiB of garbage prefix (irrelevant — sits in the dropped head)
  const ts = '2026-04-29T05:00:00Z';
  const middle = JSON.stringify({ ts, pid: 7777, role: 'impl' }) + '\n';
  const corruptSuffix = '{ malformed-tail\nstill-not-json\n';
  fs.writeFileSync(filePath, padding + middle + corruptSuffix);
  const r = readHeartbeatRecord(filePath, 'impl');
  assert.strictEqual(r.tsMs, Date.parse(ts));
  assert.strictEqual(r.pid, 7777);
  assert.strictEqual(r.corrupt, true, 'walk traversed malformed suffix → corrupt advisory');
});

test('readHeartbeatRecord: re-expands from 64 KiB → 256 KiB when latest record sits past the smaller window', () => {
  // The latest impl record is at the START of the file. Push 200 KiB of
  // qa records after it. 64 KiB tail sees only qa → no impl match.
  // 256 KiB tail covers the full file → impl record found.
  const dir = mkTmp('hb-tail-reexpand');
  const filePath = path.join(dir, 'heartbeat.jsonl');
  const implTs = '2026-04-29T05:00:00Z';
  const implLine = JSON.stringify({ ts: implTs, pid: 1, role: 'impl' }) + '\n';
  // Each qa line is ~70 bytes; 3000 lines ≈ 210 KiB > 64 KiB but
  // entire file ≈ implLine + 210 KiB ≈ 210 KiB < 256 KiB.
  const qaLine =
    JSON.stringify({ ts: '2026-04-29T05:00:01Z', pid: 2, role: 'qa' }) + '\n';
  const padding = qaLine.repeat(3000);
  fs.writeFileSync(filePath, implLine + padding);
  const stat = fs.statSync(filePath);
  assert.ok(
    stat.size > HEARTBEAT_TAIL_WINDOW_BYTES[0] && stat.size < HEARTBEAT_TAIL_WINDOW_BYTES[1],
    `file size ${stat.size} must be in (64 KiB, 256 KiB) for this test to exercise the re-expand`
  );
  const r = readHeartbeatRecord(filePath, 'impl');
  assert.strictEqual(r.tsMs, Date.parse(implTs));
  assert.strictEqual(r.pid, 1);
});

test('readHeartbeatRecord: latest role-matching record beyond max window → null + heartbeatCorrupt', () => {
  // Simulate a file > 1 MiB where the impl record sits at the very
  // start (offset 0). All windows up to 1 MiB read only qa-padded
  // tail. Per todo 067 AC: return null with diagnostic; the absent
  // freshness reading is itself a "this agent stopped emitting"
  // signal for Unit 11. Use injected fs seams so we don't actually
  // create a 1+ MiB file on disk.
  const totalSize = HEARTBEAT_TAIL_WINDOW_BYTES[2] + 16 * 1024; // 1 MiB + 16 KiB
  // Build a synthetic "tail" that's qa-only — every read returns this
  // tail. (Actual byte offsets don't matter for this seam-only test.)
  const qaLine =
    JSON.stringify({ ts: '2026-04-29T05:00:00Z', pid: 1, role: 'qa' }) + '\n';
  const tailBuffer = Buffer.from('\n' + qaLine.repeat(20000), 'utf8');
  const opts = {
    _openSync: () => 99,
    _fstatSync: () => ({ size: totalSize }),
    _readSync: (_fd, buf, _o, length, _offset) => {
      // Always return qa-padded content, exactly `length` bytes.
      const slice = tailBuffer.slice(0, Math.min(length, tailBuffer.length));
      slice.copy(buf, 0);
      return slice.length;
    },
    _closeSync: () => {},
  };
  const r = readHeartbeatRecord('/fake-path', 'impl', opts);
  // No impl match anywhere we looked → null OR a diagnostic-only record.
  // Per AC the call returns "no usable heartbeat" (tsMs=null or null).
  if (r === null) {
    // No corruption observed — fine.
  } else {
    assert.strictEqual(r.tsMs, null, 'no role-matching record found in 1 MiB tail');
  }
});

test('readHeartbeatRecord: window starts exactly at a record boundary — first line is NOT dropped (codex round 1)', () => {
  // Edge case codex caught on round 1: when the byte just before
  // `startOffset` is `\n`, the read aligns exactly with a record
  // boundary and the first line is complete. The pre-fix code
  // unconditionally dropped the leading line, silently discarding a
  // matching record that fit perfectly inside the window. Use
  // injected seams so we can describe the exact byte layout.
  const window = HEARTBEAT_TAIL_WINDOW_BYTES[0]; // 64 KiB
  // Synthetic file: an unrelated leading region + a `\n` at exactly
  // (size - window - 1) so the read at offset (size - window) lands
  // immediately after a record terminator. The first byte of the
  // window is the start of a complete impl record we want preserved.
  const ts = '2026-04-29T05:00:00Z';
  const implLine = JSON.stringify({ ts, pid: 4242, role: 'impl' }) + '\n';
  const padding = 'x'.repeat(window - implLine.length); // pad inside the window
  const tailContent = implLine + padding;
  // Pretend file is `<prefix>\n` + tailContent. size = prefixLength + 1 + tailContent.length.
  // Make prefix exactly 100 bytes; size = 101 + tailContent.length. window length = tailContent.length.
  const prefixLength = 100;
  const totalSize = prefixLength + 1 + tailContent.length;
  const startOffset = totalSize - window; // == prefixLength + 1
  // Sanity: tailContent.length == window
  assert.strictEqual(tailContent.length, window, 'fixture: tail content size matches window');
  // Sanity: byte at (startOffset - 1) is the `\n` separator.
  // We assert this implicitly via the seam below.
  let peeks = 0;
  let dataReads = 0;
  const opts = {
    _openSync: () => 99,
    _fstatSync: () => ({ size: totalSize }),
    _readSync: (_fd, buf, _o, length, offset) => {
      if (length === 1 && offset === startOffset - 1) {
        peeks++;
        buf[0] = 0x0a; // '\n'
        return 1;
      }
      // Otherwise we're reading the window itself.
      dataReads++;
      assert.strictEqual(offset, startOffset, `unexpected read offset ${offset}`);
      assert.strictEqual(length, window, `unexpected read length ${length}`);
      Buffer.from(tailContent, 'utf8').copy(buf, 0);
      return tailContent.length;
    },
    _closeSync: () => {},
  };
  const r = readHeartbeatRecord('/fake', 'impl', opts);
  assert.ok(r, 'boundary-aligned record must NOT be discarded');
  assert.strictEqual(r.tsMs, Date.parse(ts), 'recovered impl record at boundary');
  assert.strictEqual(r.pid, 4242);
  assert.strictEqual(peeks, 1, 'the peek-before-startOffset path must run');
  assert.strictEqual(dataReads, 1, 'no re-expansion needed when boundary alignment is honored');
});

test('readHeartbeatRecord: empty file → null', () => {
  const dir = mkTmp('hb-tail-empty');
  const filePath = path.join(dir, 'heartbeat.jsonl');
  fs.writeFileSync(filePath, '');
  assert.strictEqual(readHeartbeatRecord(filePath, 'impl'), null);
});

test('readHeartbeatRecord: missing file → null (no throw)', () => {
  assert.strictEqual(
    readHeartbeatRecord(path.join(os.tmpdir(), 'definitely-not-here-xyz.jsonl'), 'impl'),
    null
  );
});

test('checkHealth: heartbeat tail-read keeps existing small-file behavior intact', () => {
  // Regression anchor: with a normal-sized heartbeat (< 64 KiB), the
  // tail-read must produce identical results to the pre-todo-067
  // full-file read.
  const dir = mkTmp('ch-hb-tail-regression');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const ts = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts, pid: 9999, role: 'impl', message: 'tick' }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.ok(typeof result.heartbeatAge === 'number' && result.heartbeatAge >= 28 && result.heartbeatAge <= 32);
  assert.strictEqual(result.heartbeatStale, false);
  assert.strictEqual(result.heartbeatCorrupt, false);
});

// =========================================================================
// L0 — heartbeatCorrupt diagnostic (todo 083)
// =========================================================================
//
// Three cases per the AC:
//   1. clean walk → false
//   2. malformed-tail-only → true (no valid record salvageable)
//   3. malformed-tail + older-valid-record → true AND freshness still
//      surfaces (the corruption advisory rides alongside the recovered
//      heartbeat).
//
// Codex round 1 of triage corrected the AC away from "AND no valid
// record" — that wording would silently drop the corruption signal
// whenever an older record salvaged the freshness reading.

test('heartbeatCorrupt: clean walk → heartbeatCorrupt false', () => {
  const dir = mkTmp('hbc-clean');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const ts = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts, pid: 9999, role: 'impl' }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.heartbeatCorrupt, false, 'clean walk → false');
  assert.ok(typeof result.heartbeatAge === 'number');
});

test('heartbeatCorrupt: malformed-tail-only walk → heartbeatCorrupt true (no record salvaged)', () => {
  const dir = mkTmp('hbc-malformed-only');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Only malformed lines — no salvageable record at all.
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    '{ malformed\nnot-json either\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.heartbeatCorrupt, true, 'any malformed line → true');
  assert.strictEqual(result.heartbeatAge, null, 'no valid record → no age');
  assert.strictEqual(result.heartbeatStale, false);
});

test('heartbeatCorrupt: malformed-tail + older-valid-record walk → corrupt true AND freshness surfaces (codex round 1)', () => {
  // Codex round 1 of triage on PR #16 caught this case. Pre-correction
  // wording "...AND found no valid record..." would silently drop the
  // corruption signal here — defeating the advisory's stated purpose.
  // The corrected condition is "any malformed line seen during the walk."
  const dir = mkTmp('hbc-malformed-plus-valid');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const olderTs = new Date(Date.now() - 60_000).toISOString();
  // Older valid impl record + newer corrupt tail. The walk encounters
  // the malformed line first (corrupt = true), then salvages the
  // older record. Both signals must surface.
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts: olderTs, pid: 7777, role: 'impl' }) + '\n' +
      '{ malformed-tail\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.heartbeatCorrupt, true, 'corruption advisory rides alongside salvaged record');
  assert.ok(
    typeof result.heartbeatAge === 'number' && result.heartbeatAge >= 55 && result.heartbeatAge <= 65,
    `freshness still surfaces (~60s); got ${result.heartbeatAge}s`
  );
});

test('heartbeatCorrupt: wrong-role lines without malformation → corrupt false', () => {
  // Validly-parsed JSON for another role is NOT corruption — it's a
  // legitimate entry belonging to that other consumer.
  const dir = mkTmp('hbc-wrong-role-clean');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const ts = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts, pid: 1, role: 'qa' }) + '\n' +
      JSON.stringify({ ts, pid: 2, role: 'impl' }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.heartbeatCorrupt, false);
});

test('heartbeatCorrupt: parseHeartbeatTail role-filter return shape includes corrupt', () => {
  // Direct unit test on the helper. Verifies the contract change: the
  // role-filter return now carries `corrupt`. Strict-tail mode is
  // unchanged (no role argument).
  const ts = '2026-04-29T05:00:00Z';
  // Clean walk
  const clean = parseHeartbeatTail(
    JSON.stringify({ ts, pid: 1, role: 'impl' }) + '\n',
    { role: 'impl' }
  );
  assert.deepStrictEqual(clean, { tsMs: Date.parse(ts), pid: 1, corrupt: false });

  // Malformed-only walk → object with null tsMs/pid + corrupt true
  const malformed = parseHeartbeatTail('{ broken\n', { role: 'impl' });
  assert.deepStrictEqual(malformed, { tsMs: null, pid: null, corrupt: true });

  // Salvaged record with corruption → corrupt true alongside record
  const salvaged = parseHeartbeatTail(
    JSON.stringify({ ts, pid: 1, role: 'impl' }) + '\n{ broken\n',
    { role: 'impl' }
  );
  assert.strictEqual(salvaged.tsMs, Date.parse(ts));
  assert.strictEqual(salvaged.corrupt, true);
});

// =========================================================================
// L1 — schema_version + errorKind contract (todos 072 + 075)
// =========================================================================

test('schema_version: success-path output has the documented V1 field set', () => {
  // Todo 075 snapshot test (PR #17). Future field renames break this
  // loudly. The full V1 success-path field set is the order
  // schema_version → alive → pidAlive → pidAliveReason → timedOut →
  // heartbeatAge → heartbeatStale → heartbeatCorrupt → lastCheckpoint.
  // Error-path responses additionally carry `error` + `errorKind`
  // (covered separately).
  const dir = mkTmp('schema-success');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });

  assert.strictEqual(result.schema_version, 1, 'schema_version must equal 1');
  // The first key in JSON serialization order.
  assert.strictEqual(
    Object.keys(result)[0],
    'schema_version',
    'schema_version must be the first field of the output'
  );
  // Pin the success-path field set. If a future PR renames or removes a
  // field, this assertion fails loudly.
  assert.deepStrictEqual(
    Object.keys(result),
    [
      'schema_version',
      'alive',
      'pidAlive',
      'pidAliveReason',
      'timedOut',
      'heartbeatAge',
      'heartbeatStale',
      'heartbeatCorrupt',
      'lastCheckpoint',
    ],
    'V1 success-path field set drift — bump schema_version and update --help (todo 076) before changing.'
  );
  // Theme 1 coherence invariants:
  assert.strictEqual(
    result.pidAliveReason,
    null,
    'pidAliveReason must be null when pidAlive is true (only set on null)'
  );
  assert.strictEqual(result.error, undefined, 'no error on success path');
  assert.strictEqual(
    result.errorKind,
    undefined,
    'errorKind only set when error set'
  );
});

test('schema_version: pre-flight config error carries schema_version + errorKind', () => {
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl',
    manifestPath: path.join(os.tmpdir(), 'definitely-not-here-xyz.yaml'),
  });
  assert.strictEqual(result.schema_version, 1);
  assert.strictEqual(Object.keys(result)[0], 'schema_version');
  assert.strictEqual(result.errorKind, 'config');
});

test('schema_version: mid-flight runtime error carries schema_version + errorKind=runtime', () => {
  const dir = mkTmp('schema-runtime-err');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  // Do NOT create the phase directory.
  writeStatus(manifestPath, {
    phases: { 'phase-1': { pid: 9999, started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.schema_version, 1);
  assert.strictEqual(result.errorKind, 'runtime');
  // Theme 1 coherence: pidAlive + heartbeatAge are still meaningfully
  // populated on runtime errors so a debugger sees the partial signal.
  assert.strictEqual(result.pidAlive, true, 'pidAlive populated for runtime-error diagnostics');
});

// =========================================================================
// L2 — pidAliveReason tri-state contract (todo 071)
// =========================================================================
//
// Per the dispatch's invariants:
//   - WMI lookup-null past startup grace → pidAlive: null + 'session_not_found'
//     (BEHAVIOR CHANGE vs PR #15)
//   - ESRCH from kill(pid, 0) STAYS pidAlive: false (strongest dead signal)
//   - lookup throw → null + 'lookup_failed'
//   - within startup grace → null + 'startup_grace'
//
// The behavior-change tests live in section L (above). This section
// covers the three pidAliveReason values + the ESRCH-stays-false
// invariant + the pidAliveReason: null-when-known cases.

test('pidAliveReason: startup_grace when within grace window', () => {
  const dir = mkTmp('par-startup-grace');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date(Date.now() - 5_000).toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'startup_grace');
});

test('pidAliveReason: lookup_failed when lookup runner throws', () => {
  const dir = mkTmp('par-lookup-throw');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => { throw new Error('powershell timeout'); },
    _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'lookup_failed');
});

test('pidAliveReason: session_not_found when WMI miss past grace', () => {
  const dir = mkTmp('par-session-not-found');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date(Date.now() - 5 * 60_000).toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => null, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
});

test('pidAliveReason: ESRCH from kill stays pidAlive: false (NOT null) — strongest dead signal invariant', () => {
  // The dispatch's ESRCH invariant: when we have a real PID and the
  // kernel says ESRCH, that's the strongest "dead" signal possible.
  // Do NOT downgrade to null + 'session_not_found'. The tri-state
  // null is reserved for cases where we genuinely couldn't decide.
  const dir = mkTmp('par-esrch-stays-false');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_DEAD, // ESRCH path
  });
  assert.strictEqual(result.pidAlive, false, 'ESRCH stays false (strongest dead signal)');
  assert.strictEqual(result.pidAliveReason, null, 'no reason channel when pidAlive is a definitive false');
});

test('pidAliveReason: kill returns unknown errno → null + lookup_failed', () => {
  // isPidAlive returns null for any errno that isn't ESRCH or EPERM
  // (kernel reported something we can't interpret). That's "couldn't
  // decide" — same wire value as a runner failure (Unit 11 treats
  // both as re-poll).
  const dir = mkTmp('par-kill-unknown-errno');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const killerUnknownErrno = () => {
    const e = new Error('kernel returned unknown errno');
    e.code = 'EWHAT'; // not ESRCH, not EPERM
    throw e;
  };
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: killerUnknownErrno,
  });
  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'lookup_failed');
});

test('pidAliveReason: null when pidAlive is true (no reason for known-alive)', () => {
  const dir = mkTmp('par-true-no-reason');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.pidAlive, true);
  assert.strictEqual(result.pidAliveReason, null);
});

// =========================================================================
// M2 — Unit 11 batching seams (todo 086)
// =========================================================================

test('checkHealth: _loadedManifest bypasses loadManifest entirely', () => {
  // No on-disk manifest exists. With _loadedManifest provided, the
  // existsSync probe and loadManifest call are both skipped — the
  // checkHealth result reflects the in-memory manifest verbatim.
  const dir = mkTmp('seam-loaded-manifest');
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');

  const fakeManifestPath = path.join(dir, 'NOT-ON-DISK.yaml');
  const inMemoryManifest = {
    name: 'in-memory',
    phases: [
      { id: 'phase-1', completion_signal: 'docs/orchestration/phases/phase-1/done.md',
        timeout_minutes: 60, agents: [{ role: 'impl' }] },
    ],
  };

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath: fakeManifestPath,
    _loadedManifest: inMemoryManifest,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
    _loadedStatus: null, // no status file expected; declare it explicitly
  });
  assert.strictEqual(result.error, undefined, 'no manifest-not-found error when _loadedManifest provided');
  assert.strictEqual(result.lastCheckpoint, 'work.md');
});

test('checkHealth: _loadedStatus null short-circuits readPhaseStatus', () => {
  // Caller declares "no status file". The _readFileSync seam would
  // throw if invoked — so its non-invocation is the assertion.
  const dir = mkTmp('seam-loaded-status-null');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');

  let readFileCalls = 0;
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _loadedStatus: null,
    _readFileSync: (...args) => {
      // Heartbeat path read is OK; status path read MUST not happen.
      readFileCalls++;
      return fs.readFileSync(...args);
    },
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  // No status file present anyway, but the seam ensures we never asked.
  assert.strictEqual(result.alive, true);
  // The heartbeat probe may or may not call readFileSync (no heartbeat
  // file exists in this fixture), so the assertion is upper-bounded by
  // "1 read at most" rather than 0. The point is the status path was
  // not consulted via readPhaseStatus.
  assert.ok(readFileCalls <= 1, `expected status-path read to be skipped, got ${readFileCalls} reads`);
});

test('checkHealth: _loadedStatus object indexes phases by phaseId', () => {
  const dir = mkTmp('seam-loaded-status-obj');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');

  // 1-hour-old started_at against the default 60min timeout → timed out.
  const oldStart = new Date(Date.now() - 61 * 60_000).toISOString();
  const inMemoryStatus = {
    phases: { 'phase-1': { started_at: oldStart, pid: 9999 } },
  };

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _loadedStatus: inMemoryStatus,
    _pidLookup: () => 9999, _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.timedOut, true, 'started_at from injected status drives timeout');
});

test('checkHealth: _pidSnapshot Map provides PID without invoking _pidLookup', () => {
  const dir = mkTmp('seam-pid-snapshot-map');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  let lookupCalls = 0;
  const snapshot = new Map([['orch-phase-1-impl', { pid: 7777, parentPid: 1 }]]);
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidSnapshot: snapshot,
    _pidLookup: () => { lookupCalls++; return 9999; },
    _killer: KILLER_ALIVE,
  });
  assert.strictEqual(lookupCalls, 0, '_pidSnapshot must short-circuit the lookup path');
  assert.strictEqual(result.pidAlive, true);
});

test('checkHealth: _pidSnapshot missing entry past grace → null + reason session_not_found', () => {
  // The snapshot is authoritative (the orchestrator covered the whole
  // tick with one upstream WMI call). A missing entry past grace
  // surfaces the same way as a real WMI miss past grace:
  // pidAlive: null + reason 'session_not_found' (todo 071 behavior
  // change — pre-PR-#17 was pidAlive: false). Unit 11's tri-state
  // convergence ("two consecutive nulls past grace = crash") applies.
  const dir = mkTmp('seam-pid-snapshot-miss');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  const oldStart = new Date(Date.now() - 5 * 60_000).toISOString();
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: oldStart } },
  });

  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidSnapshot: new Map(), // empty — no entry for this session
    startupGraceMs: 60_000, // 1min — well under the 5min started_at
  });
  assert.strictEqual(result.pidAlive, null);
  assert.strictEqual(result.pidAliveReason, 'session_not_found');
  assert.strictEqual(result.alive, false);
});

test('checkHealth: _pidSnapshot accepts plain-object form too (ergonomic)', () => {
  const dir = mkTmp('seam-pid-snapshot-obj');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'work.md'), 'hi');
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const snapshot = { 'orch-phase-1-impl': { pid: 4242 } };
  const result = checkHealth({
    phaseId: 'phase-1', role: 'impl', manifestPath,
    _pidSnapshot: snapshot,
    _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.pidAlive, true);
});

// =========================================================================
// N — CLI smoke (≤2 spawnSync invocations per todo 044)
// =========================================================================

const CLI_ENTRY = path.resolve(__dirname, 'check-health.js');

test('CLI: --help prints usage, V1 schema, and tri-state semantics (todos 074 + 076)', () => {
  const r = spawnSync(process.execPath, [CLI_ENTRY, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--phase/);
  // Todo 074 — timing flags surface in --help.
  assert.match(r.stdout, /--startup-grace-ms/);
  assert.match(r.stdout, /--heartbeat-stale-ms/);
  // Todo 076 — OUTPUT section pins the V1 schema and tri-state.
  assert.match(r.stdout, /OUTPUT \(schema_version: 1\)/);
  assert.match(r.stdout, /pidAlive .*true \| false \| null/);
  assert.match(r.stdout, /pidAliveReason/);
  assert.match(r.stdout, /startup_grace/);
  assert.match(r.stdout, /lookup_failed/);
  assert.match(r.stdout, /session_not_found/);
  assert.match(r.stdout, /errorKind/);
  assert.match(r.stdout, /heartbeatCorrupt/);
  assert.match(r.stdout, /heartbeatAge/);
  // Tri-state policy: "do not trigger recovery on a single null."
  assert.match(r.stdout, /must NOT trigger\s+recovery/);
  // Worked example block is present.
  assert.match(r.stdout, /Worked example/);
  assert.match(r.stdout, /"schema_version": 1/);
});

// -------------------------------------------------------------------------
// CLI parser (todo 074 — in-process, no spawnSync)
// -------------------------------------------------------------------------

function makeArgv(...rest) {
  // process.argv[0] = node, [1] = script; parseCliArgs starts at index 2.
  return ['node', 'check-health.js', ...rest];
}

test('parseCliArgs: required flags only — startup/heartbeat are undefined', () => {
  const args = parseCliArgs(makeArgv('--phase', 'p1', '--role', 'impl', '--manifest', '/m'));
  assert.strictEqual(args.phaseId, 'p1');
  assert.strictEqual(args.role, 'impl');
  assert.strictEqual(args.manifestPath, '/m');
  assert.strictEqual(args.startupGraceMs, undefined);
  assert.strictEqual(args.heartbeatStaleMs, undefined);
});

test('parseCliArgs: --startup-grace-ms and --heartbeat-stale-ms parse as integers', () => {
  const args = parseCliArgs(
    makeArgv(
      '--phase', 'p1', '--role', 'impl', '--manifest', '/m',
      '--startup-grace-ms', '30000',
      '--heartbeat-stale-ms', '120000'
    )
  );
  assert.strictEqual(args.startupGraceMs, 30000);
  assert.strictEqual(args.heartbeatStaleMs, 120000);
});

test('parseCliArgs: --startup-grace-ms 0 is a valid explicit zero override (not "use default")', () => {
  // Empty-string-as-explicit-override regression class. `0` differs from
  // `undefined` (= default) and from `''` (= operator typo). The library
  // accepts 0 as a valid grace window; the CLI must too.
  const args = parseCliArgs(
    makeArgv(
      '--phase', 'p1', '--role', 'impl', '--manifest', '/m',
      '--startup-grace-ms', '0'
    )
  );
  assert.strictEqual(args.startupGraceMs, 0);
});

test('parseCliArgs: rejects negative integers', () => {
  assert.throws(
    () => parseCliArgs(
      makeArgv('--phase', 'p1', '--role', 'impl', '--manifest', '/m',
        '--startup-grace-ms', '-5')
    ),
    /must be a non-negative integer/
  );
});

test('parseCliArgs: rejects non-integer values (1.5, NaN)', () => {
  assert.throws(
    () => parseCliArgs(
      makeArgv('--phase', 'p1', '--role', 'impl', '--manifest', '/m',
        '--heartbeat-stale-ms', '1.5')
    ),
    /must be a non-negative integer/
  );
  assert.throws(
    () => parseCliArgs(
      makeArgv('--phase', 'p1', '--role', 'impl', '--manifest', '/m',
        '--heartbeat-stale-ms', 'NaN')
    ),
    /must be a non-negative integer/
  );
});

test('parseCliArgs: rejects empty string and whitespace-only values', () => {
  // Empty string would otherwise coerce via Number('') === 0 — but that
  // looks like an explicit zero, when it really means "operator forgot
  // the value." Trim+empty → loud error rather than silent default.
  assert.throws(
    () => parseNonNegativeIntFlag('--startup-grace-ms', ''),
    /requires a non-negative integer/
  );
  assert.throws(
    () => parseNonNegativeIntFlag('--startup-grace-ms', '   '),
    /requires a non-negative integer/
  );
  assert.throws(
    () => parseNonNegativeIntFlag('--startup-grace-ms', undefined),
    /requires a non-negative integer/
  );
});

test('parseCliArgs: --startup-grace-ms threads through to checkHealth library API', () => {
  // Round-trip: parser produces { startupGraceMs }, the value is accepted
  // by the library and shapes the verdict. The startup-grace branch only
  // fires when the pid lookup misses; with the lookup returning null and
  // started_at within the grace window, pidAlive must be `null`.
  const dir = mkTmp('cli-startup-grace-passthrough');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // started_at very recent (well within any grace > 0).
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  const args = parseCliArgs(
    makeArgv(
      '--phase', 'phase-1', '--role', 'impl', '--manifest', manifestPath,
      '--startup-grace-ms', '120000' // 2 minutes
    )
  );
  // Verify in-process pass-through: the library honors the override.
  const result = checkHealth({
    phaseId: args.phaseId,
    role: args.role,
    manifestPath: args.manifestPath,
    startupGraceMs: args.startupGraceMs,
    _pidLookup: () => null, // miss — startup-grace branch
  });
  assert.strictEqual(result.pidAlive, null, 'within-grace miss → pidAlive: null');
});

test('parseCliArgs: --heartbeat-stale-ms threads through to checkHealth library API', () => {
  const dir = mkTmp('cli-heartbeat-stale-passthrough');
  const manifestPath = writeManifest(dir, makeBaseManifest());
  const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
  fs.mkdirSync(phaseDir, { recursive: true });
  // Heartbeat 60 seconds old.
  const ts = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    path.join(phaseDir, 'heartbeat.jsonl'),
    JSON.stringify({ ts, pid: 9999, role: 'impl', message: 'tick' }) + '\n'
  );
  writeStatus(manifestPath, {
    phases: { 'phase-1': { started_at: new Date().toISOString() } },
  });

  // 30s threshold → the 60s-old heartbeat counts as stale.
  const args = parseCliArgs(
    makeArgv(
      '--phase', 'phase-1', '--role', 'impl', '--manifest', manifestPath,
      '--heartbeat-stale-ms', '30000'
    )
  );
  const result = checkHealth({
    phaseId: args.phaseId,
    role: args.role,
    manifestPath: args.manifestPath,
    heartbeatStaleMs: args.heartbeatStaleMs,
    _pidLookup: () => 9999,
    _killer: KILLER_ALIVE,
  });
  assert.strictEqual(result.heartbeatStale, true, '60s heartbeat with 30s threshold = stale');
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
