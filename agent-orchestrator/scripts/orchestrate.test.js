/**
 * Unit 11 — orchestrate.js test suite.
 *
 * Tests are pure-JS with injected fakes; no real `wt`/`claude`/PowerShell
 * spawns. Two CLI smoke tests use spawnSync (subprocess budget per todo
 * 044: ≤3 per dispatch — we use 2 here, leaving room for one more).
 *
 * Categories:
 *   A. Constants + module exports
 *   B. Path helpers
 *   C. Lockfile (acquireLock / releaseLock)
 *   D. PID snapshot + pollAllPhases batching
 *   E. Status helpers (depsMet / depsBlocked / isTerminalStatus)
 *   F. Completion-signal + qa-verdict parsing
 *   G. decideTickActions — happy paths
 *   H. decideTickActions — recovery / crash
 *   I. decideTickActions — tri-state convergence
 *   J. decideTickActions — review loop
 *   K. decideTickActions — edge cases (config / runtime / blocked / etc.)
 *   L. executeActions — spawn seam (camelCase → snake_case translation)
 *   M. executeActions — persist / mark_phase_* / dryRun
 *   N. runOrchestrator end-to-end (with injected seams)
 *   O. CLI parsing
 *   P. Stateless invariant
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const O = require('./orchestrate');

// -------------------- Helpers --------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* best-effort */
  }
}

function writeManifest(dir, contents) {
  const p = path.join(dir, 'manifest.yaml');
  fs.writeFileSync(p, yaml.dump(contents), 'utf8');
  return p;
}

function writeStatus(manifestPath, contents) {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const sp = path.join(dir, `${base}-status.yaml`);
  fs.writeFileSync(sp, yaml.dump(contents), 'utf8');
  return sp;
}

function readStatus(manifestPath) {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath, path.extname(manifestPath));
  const sp = path.join(dir, `${base}-status.yaml`);
  if (!fs.existsSync(sp)) return null;
  return yaml.load(fs.readFileSync(sp, 'utf8'), { schema: yaml.DEFAULT_SCHEMA });
}

function makeBaseManifest({
  phases = [
    {
      id: 'phase-1',
      completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
      timeout_minutes: 30,
      agents: [{ role: 'impl' }],
    },
  ],
  workdir,
} = {}) {
  return {
    name: 'test-orch',
    workdir: workdir || undefined,
    phases,
  };
}

function makePhaseDir(manifestPath, phaseId) {
  const dir = path.join(
    path.dirname(manifestPath),
    'docs',
    'orchestration',
    'phases',
    phaseId
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCompletionSignal(phaseDir, role, status = 'complete') {
  const p = path.join(phaseDir, `${role}-complete.md`);
  const fm = ['---', `status: ${status}`, '---', '# done'].join('\n');
  fs.writeFileSync(p, fm, 'utf8');
  return p;
}

function makeStubHealth(over = {}) {
  return {
    schema_version: 1,
    alive: true,
    pidAlive: true,
    pidAliveReason: null,
    timedOut: false,
    heartbeatAge: null,
    heartbeatStale: false,
    heartbeatCorrupt: false,
    heartbeatTruncated: false,
    lastCheckpoint: null,
    ...over,
  };
}

function silentLogger() {
  return () => {};
}

function recordingLogger() {
  const records = [];
  const fn = (level, message, meta) => {
    records.push({ level, message, meta });
  };
  fn.records = records;
  return fn;
}

// =========================================================================
// A — module exports + constants
// =========================================================================

test('A1 exports the documented public surface', () => {
  for (const name of [
    'runOrchestrator',
    'runOneTick',
    'pollAllPhases',
    'decideTickActions',
    'executeActions',
    'acquireLock',
    'releaseLock',
    'buildPidSnapshot',
    'parseQaVerdict',
    'parseCompletionSignal',
    'parseCliArgs',
    'defaultSessionName',
    'flagFilePath',
  ]) {
    assert.strictEqual(typeof O[name], 'function', `missing ${name}`);
  }
});

test('A2 default constants match design decisions', () => {
  assert.strictEqual(O.DEFAULT_ACTIVE_INTERVAL_MS, 30_000);
  assert.strictEqual(O.DEFAULT_IDLE_INTERVAL_MS, 120_000);
  assert.strictEqual(O.DEFAULT_MAX_RECOVERY_RETRIES, 3);
  assert.strictEqual(O.DEFAULT_REVIEW_LOOP_MAX_ITERATIONS, 3);
  assert.strictEqual(O.DEFAULT_LOOKUP_FAILED_CONVERGE_N, 3);
  assert.strictEqual(O.DEFAULT_STARTUP_GRACE_MS, 60_000);
  assert.strictEqual(O.SCHEMA_VERSION_EXPECTED, 1);
});

test('A3 MAX_FLAG_BYTES matches session-start.js cap (256 KiB)', () => {
  assert.strictEqual(O.MAX_FLAG_BYTES, 256 * 1024);
});

test('A4 LOCKFILE_NAME is .orchestrator.lock', () => {
  assert.strictEqual(O.LOCKFILE_NAME, '.orchestrator.lock');
});

// =========================================================================
// B — path helpers
// =========================================================================

test('B1 defaultSessionName composes orch-<phase>-<role>', () => {
  assert.strictEqual(O.defaultSessionName('phase-1', 'impl'), 'orch-phase-1-impl');
});

test('B2 flagFilePath places .pending-<sessionName> under orchDir', () => {
  const p = O.flagFilePath('/x/docs/orchestration', 'orch-a-impl');
  assert.strictEqual(p, path.join('/x/docs/orchestration', '.pending-orch-a-impl'));
});

test('B3 phaseDirFor uses manifestDir + docs/orchestration/phases/<id>', () => {
  const got = O.phaseDirFor('/x', 'phase-1');
  assert.strictEqual(
    path.normalize(got),
    path.normalize('/x/docs/orchestration/phases/phase-1')
  );
});

test('B4 templatesDirFor matches scaffold-protocol destination', () => {
  const got = O.templatesDirFor('/x');
  assert.strictEqual(
    path.normalize(got),
    path.normalize('/x/docs/orchestration/templates')
  );
});

test('B5 completionSignalFor and qaVerdictFor are predictable', () => {
  assert.strictEqual(
    path.basename(O.completionSignalFor('/p', 'impl')),
    'impl-complete.md'
  );
  assert.strictEqual(path.basename(O.qaVerdictFor('/p')), 'qa-verdict.json');
});

// =========================================================================
// C — lockfile
// =========================================================================

test('C1 acquireLock writes lockfile when none exists', () => {
  const dir = mkTmp('orch-lock');
  try {
    const p = O.acquireLock(dir, { _pid: 12345, _now: () => '2026-05-02T00:00:00Z' });
    assert.ok(fs.existsSync(p));
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(obj.pid, 12345);
    assert.strictEqual(obj.startedAt, '2026-05-02T00:00:00Z');
  } finally {
    rmrf(dir);
  }
});

test('C2 acquireLock refuses when existing lock pid is alive', () => {
  const dir = mkTmp('orch-lock');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: 'now', hostname: 'h' })
    );
    assert.throws(
      () =>
        O.acquireLock(dir, {
          _pid: 1,
          _killer: () => {}, // alive
        }),
      /another orchestrator/
    );
  } finally {
    rmrf(dir);
  }
});

test('C3 acquireLock overwrites stale lock when prior pid is dead', () => {
  const dir = mkTmp('orch-lock');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: 'old', hostname: 'h' })
    );
    const p = O.acquireLock(dir, {
      _pid: 7,
      _now: () => 'fresh',
      _killer: () => {
        const e = new Error('no such');
        e.code = 'ESRCH';
        throw e;
      },
    });
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(obj.pid, 7);
    assert.strictEqual(obj.startedAt, 'fresh');
  } finally {
    rmrf(dir);
  }
});

test('C4 acquireLock rejects corrupt lockfile', () => {
  const dir = mkTmp('orch-lock');
  try {
    fs.writeFileSync(path.join(dir, '.orchestrator.lock'), 'not json');
    assert.throws(() => O.acquireLock(dir, { _pid: 1 }), /corrupt lockfile/);
  } finally {
    rmrf(dir);
  }
});

test('C5 releaseLock unlinks the file (best-effort)', () => {
  const dir = mkTmp('orch-lock');
  try {
    const p = O.acquireLock(dir, { _pid: 1 });
    assert.ok(fs.existsSync(p));
    O.releaseLock(p);
    assert.ok(!fs.existsSync(p));
    // Idempotent: second release does not throw.
    O.releaseLock(p);
  } finally {
    rmrf(dir);
  }
});

test('C6 acquireLock surfaces ELOCKED code on contention', () => {
  const dir = mkTmp('orch-lock');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 42, startedAt: 'x', hostname: 'h' })
    );
    try {
      O.acquireLock(dir, { _pid: 1, _killer: () => {} });
      assert.fail('should have thrown');
    } catch (e) {
      assert.strictEqual(e.code, 'ELOCKED');
    }
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// D — PID snapshot + pollAllPhases
// =========================================================================

test('D1 buildPidSnapshot returns empty Map for empty list', () => {
  const m = O.buildPidSnapshot([]);
  assert.ok(m instanceof Map);
  assert.strictEqual(m.size, 0);
});

test('D2 buildPidSnapshot parses a single PowerShell call into a Map', () => {
  const stdout = JSON.stringify([
    {
      ProcessId: 4242,
      CommandLine: 'C:\\claude.exe --name orch-phase-1-impl',
    },
    {
      ProcessId: 4243,
      CommandLine: 'C:\\claude.exe --name orch-phase-2-qa',
    },
  ]);
  const m = O.buildPidSnapshot(['orch-phase-1-impl', 'orch-phase-2-qa', 'orch-missing'], {
    _pidRunner: () => stdout,
  });
  assert.strictEqual(m.get('orch-phase-1-impl').pid, 4242);
  assert.strictEqual(m.get('orch-phase-2-qa').pid, 4243);
  assert.strictEqual(m.has('orch-missing'), false);
});

test('D3 buildPidSnapshot returns null on runner failure', () => {
  const m = O.buildPidSnapshot(['orch-x'], {
    _pidRunner: () => {
      throw new Error('powershell failed');
    },
  });
  assert.strictEqual(m, null);
});

test('D4 pollAllPhases returns ok with phases + status + pidSnapshot', () => {
  const dir = mkTmp('orch-poll');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const r = O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () => '[]',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.phases.length, 1);
    assert.strictEqual(r.phases[0].id, 'phase-1');
    assert.ok(r.pidSnapshot instanceof Map);
  } finally {
    rmrf(dir);
  }
});

test('D5 pollAllPhases surfaces config error for invalid manifest', () => {
  const dir = mkTmp('orch-poll');
  try {
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'not: a: valid: yaml: : :');
    const r = O.pollAllPhases({ manifestPath: path.join(dir, 'manifest.yaml') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorKind, 'config');
  } finally {
    rmrf(dir);
  }
});

test('D6 pollAllPhases threads injected seams (no real WMI call)', () => {
  const dir = mkTmp('orch-poll');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    let runnerCalled = 0;
    O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () => {
        runnerCalled += 1;
        return '[]';
      },
    });
    assert.strictEqual(runnerCalled, 1, 'PID runner is called exactly once per tick');
  } finally {
    rmrf(dir);
  }
});

test('D7 pollAllPhases empty-string manifestPath throws', () => {
  assert.throws(
    () => O.pollAllPhases({ manifestPath: '' }),
    /manifestPath is required/
  );
});

// =========================================================================
// E — status helpers
// =========================================================================

test('E1 getPhaseStatus default is pending for unknown phase', () => {
  const e = O.getPhaseStatus({ phases: {} }, 'nope');
  assert.strictEqual(e.status, 'pending');
});

test('E2 depsMet true when all deps completed', () => {
  const status = {
    phases: { a: { status: 'completed' }, b: { status: 'completed' } },
  };
  assert.strictEqual(
    O.depsMet({ depends_on: ['a', 'b'] }, status),
    true
  );
});

test('E3 depsMet false when any dep is not completed', () => {
  const status = {
    phases: { a: { status: 'completed' }, b: { status: 'running' } },
  };
  assert.strictEqual(O.depsMet({ depends_on: ['a', 'b'] }, status), false);
});

test('E4 depsBlocked true when any dep failed', () => {
  const status = { phases: { a: { status: 'failed' } } };
  assert.strictEqual(O.depsBlocked({ depends_on: ['a'] }, status), true);
});

test('E5 isTerminalStatus distinguishes terminal vs non-terminal', () => {
  for (const s of ['completed', 'failed', 'blocked']) {
    assert.strictEqual(O.isTerminalStatus(s), true, `${s} should be terminal`);
  }
  for (const s of ['pending', 'running', undefined]) {
    assert.strictEqual(O.isTerminalStatus(s), false, `${s} should not be terminal`);
  }
});

// =========================================================================
// F — completion-signal + qa-verdict parsing
// =========================================================================

test('F1 parseCompletionSignal returns null for missing file', () => {
  const dir = mkTmp('orch-sig');
  try {
    const r = O.parseCompletionSignal(path.join(dir, 'nope.md'));
    assert.strictEqual(r, null);
  } finally {
    rmrf(dir);
  }
});

test('F2 parseCompletionSignal extracts status from frontmatter', () => {
  const dir = mkTmp('orch-sig');
  try {
    const p = path.join(dir, 'impl-complete.md');
    fs.writeFileSync(p, '---\nstatus: complete\n---\n# body\n');
    const r = O.parseCompletionSignal(p);
    assert.strictEqual(r.status, 'complete');
  } finally {
    rmrf(dir);
  }
});

test('F3 parseCompletionSignal tolerates CRLF line endings', () => {
  const dir = mkTmp('orch-sig');
  try {
    const p = path.join(dir, 'impl-complete.md');
    fs.writeFileSync(p, '---\r\nstatus: blocked\r\n---\r\n# body\r\n');
    const r = O.parseCompletionSignal(p);
    assert.strictEqual(r.status, 'blocked');
  } finally {
    rmrf(dir);
  }
});

test('F4 parseQaVerdict prefers qa-verdict.json over qa-complete.md', () => {
  const dir = mkTmp('orch-verdict');
  try {
    fs.writeFileSync(
      path.join(dir, 'qa-verdict.json'),
      JSON.stringify({ pass: false, failures: [{ test: 'A', expected: 1, actual: 2 }] })
    );
    fs.writeFileSync(
      path.join(dir, 'qa-complete.md'),
      '---\nstatus: complete\n---\n# body'
    );
    const v = O.parseQaVerdict(dir, 'qa');
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.failures.length, 1);
    assert.strictEqual(v.source, 'qa-verdict.json');
  } finally {
    rmrf(dir);
  }
});

test('F5 parseQaVerdict falls back to qa-complete.md frontmatter', () => {
  const dir = mkTmp('orch-verdict');
  try {
    fs.writeFileSync(
      path.join(dir, 'qa-complete.md'),
      '---\nstatus: complete\n---\n# body'
    );
    const v = O.parseQaVerdict(dir, 'qa');
    assert.strictEqual(v.pass, true);
    assert.strictEqual(v.source, 'qa-complete.md');
  } finally {
    rmrf(dir);
  }
});

test('F6 parseQaVerdict status: blocked → pass: false from frontmatter fallback', () => {
  const dir = mkTmp('orch-verdict');
  try {
    fs.writeFileSync(
      path.join(dir, 'qa-complete.md'),
      '---\nstatus: blocked\n---\n# body'
    );
    const v = O.parseQaVerdict(dir, 'qa');
    assert.strictEqual(v.pass, false);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// G — decideTickActions: happy paths
// =========================================================================

function tickStateFor({ manifestPath, status, healthFn }) {
  return {
    manifestPath,
    manifest: { name: 'p', phases: [], workdir: undefined },
    phases: [],
    status: status || { phases: Object.create(null) },
    pidSnapshot: new Map(),
    _healthFn: healthFn,
  };
}

test('G1 single pending phase with no deps → spawn + persist running', () => {
  const dir = mkTmp('orch-G1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const spawn = actions.find((a) => a.type === 'spawn');
    assert.ok(spawn, 'spawn action emitted');
    assert.strictEqual(spawn.phaseId, 'phase-1');
    assert.strictEqual(spawn.role, 'impl');
    assert.strictEqual(spawn.mode, 'initial');
    const persist = actions.find((a) => a.type === 'persist');
    assert.ok(persist);
    assert.strictEqual(persist.updates.status, 'running');
  } finally {
    rmrf(dir);
  }
});

test('G2 multi-phase parallel (no deps) → both spawn this tick', () => {
  const dir = mkTmp('orch-G2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const spawnIds = actions
      .filter((a) => a.type === 'spawn')
      .map((a) => a.phaseId)
      .sort();
    assert.deepStrictEqual(spawnIds, ['a', 'b']);
  } finally {
    rmrf(dir);
  }
});

test('G3 linear deps: phase B blocked until A completes', () => {
  const dir = mkTmp('orch-G3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            depends_on: ['a'],
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { a: { status: 'running' } } });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    const spawnIds = actions.filter((a) => a.type === 'spawn').map((a) => a.phaseId);
    assert.ok(!spawnIds.includes('b'), 'b must not spawn while a is running');
  } finally {
    rmrf(dir);
  }
});

test('G4 linear deps: B advances after A is completed', () => {
  const dir = mkTmp('orch-G4');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            depends_on: ['a'],
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { a: { status: 'completed' } } });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const spawnIds = actions.filter((a) => a.type === 'spawn').map((a) => a.phaseId);
    assert.deepStrictEqual(spawnIds, ['b']);
  } finally {
    rmrf(dir);
  }
});

test('G5 running phase, healthy, with no completion signal → no actions for that phase', () => {
  const dir = mkTmp('orch-G5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', pid: 100, started_at: '2026-05-02T00:00:00Z' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: true }) }
    );
    const spawns = actions.filter((a) => a.type === 'spawn');
    const marks = actions.filter((a) => a.type.startsWith('mark_'));
    assert.strictEqual(spawns.length, 0);
    assert.strictEqual(marks.length, 0);
  } finally {
    rmrf(dir);
  }
});

test('G6 running phase + completion signal → mark_phase_completed', () => {
  const dir = mkTmp('orch-G6');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'phase-1');
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_completed' && a.phaseId === 'phase-1'));
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// H — recovery / crash
// =========================================================================

test('H1 pidAlive=false (ESRCH) → recovery action emitted (no convergence wait)', () => {
  const dir = mkTmp('orch-H1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    const spawn = actions.find((a) => a.type === 'spawn' && a.mode === 'recovery');
    assert.ok(spawn, 'recovery spawn emitted');
    assert.strictEqual(spawn.iteration, 1);
  } finally {
    rmrf(dir);
  }
});

test('H2 retry budget exhausted (retry_count >= max) → mark_phase_failed', () => {
  const dir = mkTmp('orch-H2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 3 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_failed' && a.phaseId === 'phase-1'));
    assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

test('H3 timeout → recovery (treated as crash)', () => {
  const dir = mkTmp('orch-H3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: true, timedOut: true }) }
    );
    assert.ok(actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

test('H4 retry_count increments on each recovery dispatch', () => {
  const dir = mkTmp('orch-H4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 1 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    const persist = actions.find(
      (a) => a.type === 'persist' && a.updates && a.updates.retry_count !== undefined
    );
    assert.ok(persist);
    assert.strictEqual(persist.updates.retry_count, 2);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// I — tri-state convergence
// =========================================================================

test('I1 startup_grace null does NOT count toward convergence', () => {
  const dir = mkTmp('orch-I1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    // Run 5 ticks of startup_grace; counter should remain empty.
    for (let i = 0; i < 5; i++) {
      O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: counters },
        {
          _checkHealth: () =>
            makeStubHealth({ pidAlive: null, pidAliveReason: 'startup_grace' }),
        }
      );
    }
    assert.strictEqual(counters.size, 0, 'startup_grace must not increment the counter');
  } finally {
    rmrf(dir);
  }
});

test('I2 lookup_failed nulls increment counter; below N → no recovery', () => {
  const dir = mkTmp('orch-I2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    for (let i = 0; i < 2; i++) {
      const actions = O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: counters },
        {
          _checkHealth: () =>
            makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
          lookupFailedConvergeN: 3,
        }
      );
      assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
    }
    assert.strictEqual(counters.get('phase-1:impl'), 2);
  } finally {
    rmrf(dir);
  }
});

test('I3 N consecutive lookup_failed nulls → recovery on the Nth tick', () => {
  const dir = mkTmp('orch-I3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    let lastActions = null;
    for (let i = 0; i < 3; i++) {
      lastActions = O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: counters },
        {
          _checkHealth: () =>
            makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
          lookupFailedConvergeN: 3,
        }
      );
    }
    assert.ok(lastActions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

test('I4 session_not_found nulls also count toward convergence', () => {
  const dir = mkTmp('orch-I4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    let lastActions = null;
    for (let i = 0; i < 3; i++) {
      lastActions = O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: counters },
        {
          _checkHealth: () =>
            makeStubHealth({ pidAlive: null, pidAliveReason: 'session_not_found' }),
          lookupFailedConvergeN: 3,
        }
      );
    }
    assert.ok(lastActions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

test('I5 first non-null reading clears the counter', () => {
  const dir = mkTmp('orch-I5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    // 2 nulls, then alive.
    for (let i = 0; i < 2; i++) {
      O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: counters },
        {
          _checkHealth: () =>
            makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        }
      );
    }
    assert.strictEqual(counters.get('phase-1:impl'), 2);
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      { _checkHealth: () => makeStubHealth({ pidAlive: true }) }
    );
    assert.strictEqual(counters.has('phase-1:impl'), false);
  } finally {
    rmrf(dir);
  }
});

test('I6 custom convergeN is honored', () => {
  const dir = mkTmp('orch-I6');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    // convergeN = 2 → recovery on second null.
    let actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        lookupFailedConvergeN: 2,
      }
    );
    assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
    actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        lookupFailedConvergeN: 2,
      }
    );
    assert.ok(actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// J — review loop
// =========================================================================

test('J1 review-enabled phase initial dispatch only spawns impl', () => {
  const dir = mkTmp('orch-J1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const spawns = actions.filter((a) => a.type === 'spawn');
    assert.strictEqual(spawns.length, 1);
    assert.strictEqual(spawns[0].role, 'impl');
    const persist = actions.find((a) => a.type === 'persist');
    assert.strictEqual(persist.updates.review_iteration, 1);
    assert.strictEqual(persist.updates.review_stage, 'impl');
  } finally {
    rmrf(dir);
  }
});

test('J2 impl-complete on review phase → QA spawn + stage advance', () => {
  const dir = mkTmp('orch-J2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'impl', review_iteration: 1 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const qaSpawn = actions.find((a) => a.type === 'spawn' && a.role === 'qa');
    assert.ok(qaSpawn);
    const persist = actions.find(
      (a) => a.type === 'persist' && a.updates && a.updates.review_stage === 'qa'
    );
    assert.ok(persist);
  } finally {
    rmrf(dir);
  }
});

test('J3 QA verdict pass → mark_phase_completed', () => {
  const dir = mkTmp('orch-J3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 1 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'complete');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_completed' && a.phaseId === 'p'));
  } finally {
    rmrf(dir);
  }
});

test('J4 QA verdict fail (iter 1 of 3) → respawn impl with bumped iteration', () => {
  const dir = mkTmp('orch-J4');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 1 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'blocked'); // FAIL via frontmatter
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const implRespawn = actions.find(
      (a) => a.type === 'spawn' && a.mode === 'review_retry' && a.role === 'impl'
    );
    assert.ok(implRespawn);
    assert.strictEqual(implRespawn.iteration, 2);
    const persist = actions.find(
      (a) => a.type === 'persist' && a.updates && a.updates.review_iteration === 2
    );
    assert.ok(persist);
    assert.strictEqual(persist.updates.review_stage, 'impl');
  } finally {
    rmrf(dir);
  }
});

test('J5 QA verdict fail at max iterations → mark_phase_failed', () => {
  const dir = mkTmp('orch-J5');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 3 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'blocked');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some(
        (a) =>
          a.type === 'mark_phase_failed' &&
          /review_loop_exceeded/.test(a.reason || '')
      )
    );
  } finally {
    rmrf(dir);
  }
});

test('J6 QA verdict from qa-verdict.json overrides frontmatter', () => {
  const dir = mkTmp('orch-J6');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 1 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    // Frontmatter says complete, but verdict.json says pass: false.
    writeCompletionSignal(phaseDir, 'qa', 'complete');
    fs.writeFileSync(
      path.join(phaseDir, 'qa-verdict.json'),
      JSON.stringify({ pass: false, failures: [{ test: 'A', expected: 'X', actual: 'Y' }] })
    );
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const respawn = actions.find(
      (a) => a.type === 'spawn' && a.mode === 'review_retry'
    );
    assert.ok(respawn, 'qa-verdict.json pass: false should drive review_retry');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// K — edge cases (config / runtime / blocked)
// =========================================================================

test('K1 errorKind config → mark_phase_blocked + log', () => {
  const dir = mkTmp('orch-K1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: () =>
          makeStubHealth({ error: 'boom', errorKind: 'config' }),
      }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
  } finally {
    rmrf(dir);
  }
});

test('K2 errorKind runtime → log + keep polling (no mark_phase_*)', () => {
  const dir = mkTmp('orch-K2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: () =>
          makeStubHealth({ error: 'phase dir gone', errorKind: 'runtime' }),
      }
    );
    assert.ok(!actions.some((a) => a.type === 'mark_phase_blocked'));
    assert.ok(actions.some((a) => a.type === 'log' && a.level === 'warn'));
  } finally {
    rmrf(dir);
  }
});

test('K3 phase depends_on a failed phase → mark_phase_blocked', () => {
  const dir = mkTmp('orch-K3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            depends_on: ['a'],
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { a: { status: 'failed' } } });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked' && a.phaseId === 'b')
    );
  } finally {
    rmrf(dir);
  }
});

test('K4 schema_version mismatch → fatal', () => {
  const dir = mkTmp('orch-K4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ schema_version: 2 }) }
    );
    assert.ok(actions.some((a) => a.type === 'fatal' && /schema_version/.test(a.message)));
  } finally {
    rmrf(dir);
  }
});

test('K5 heartbeatTruncated logs debug but does not trigger recovery', () => {
  const dir = mkTmp('orch-K5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: true, heartbeatTruncated: true, heartbeatStale: true }),
      }
    );
    assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
    assert.ok(actions.some((a) => a.type === 'log' && /heartbeatTruncated/.test(a.message)));
  } finally {
    rmrf(dir);
  }
});

test('K6 unknown errorKind logs warning but does not crash', () => {
  const dir = mkTmp('orch-K6');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: true, error: 'weird', errorKind: 'novel' }),
      }
    );
    assert.ok(actions.some((a) => a.type === 'log' && /unknown errorKind/.test(a.message)));
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// L — executeActions: spawn seam + camelCase translation
// =========================================================================

function makeFakeSpawnSession({ pid = 4242, spawnedAt = '2026-05-02T01:00:00Z' } = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    return {
      pid,
      command: 'fake',
      argv: [],
      sessionName: opts.name,
      title: opts.title || opts.name,
      spawnedAt,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeGenerate({ promptText = '# fake prompt\nbody.' } = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    if (opts.dryRun) {
      return { promptPath: '<dry>', charCount: promptText.length, varsUsed: [], warnings: [] };
    }
    fs.mkdirSync(opts.phaseDir, { recursive: true });
    const promptPath = path.join(
      opts.phaseDir,
      `${opts.role === 'recovery' ? opts.recoveryRole : opts.role}-prompt.md`
    );
    fs.writeFileSync(promptPath, promptText, 'utf8');
    return { promptPath, charCount: promptText.length, varsUsed: [], warnings: [] };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeRunUpdate() {
  const calls = [];
  const fn = (mp, phaseId, updates) => {
    calls.push({ phaseId, updates });
    // Simulate a successful runUpdate by writing the status file.
    return { ok: true, status_file: mp, phase: phaseId, updates };
  };
  fn.calls = calls;
  return fn;
}

test('L1 executeActions translates spawnedAt → started_at on persist (todo 087)', () => {
  const dir = mkTmp('orch-L1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession({ pid: 9001, spawnedAt: '2026-05-02T05:00:00Z' });
    const fakeGen = makeFakeGenerate();
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
    ];
    O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
    });
    const persistCall = fakeUpdate.calls.find(
      (c) => c.updates && c.updates.started_at !== undefined
    );
    assert.ok(persistCall, 'persist with started_at must fire');
    assert.strictEqual(persistCall.updates.started_at, '2026-05-02T05:00:00Z');
    assert.strictEqual(persistCall.updates.pid, 9001);
    // Nothing should write `spawnedAt` to manifest-status.
    for (const c of fakeUpdate.calls) {
      assert.strictEqual(
        c.updates.spawnedAt,
        undefined,
        'spawnedAt (camelCase) must NOT leak into manifest-status'
      );
    }
  } finally {
    rmrf(dir);
  }
});

test('L2 executeActions writes flag file atomically with prompt content', () => {
  const dir = mkTmp('orch-L2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate({ promptText: '# hello prompt' });
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
    ];
    O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
    });
    const flagPath = O.flagFilePath(
      O.orchDirFor(dir),
      'orch-phase-1-impl'
    );
    assert.ok(fs.existsSync(flagPath));
    assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), '# hello prompt');
  } finally {
    rmrf(dir);
  }
});

test('L3 executeActions refuses to spawn when prompt exceeds MAX_FLAG_BYTES', () => {
  const dir = mkTmp('orch-L3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const big = 'a'.repeat(O.MAX_FLAG_BYTES + 1);
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate({ promptText: big });
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
    ];
    const out = O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
    });
    assert.ok(out.warnings.some((w) => /MAX_FLAG_BYTES/.test(w)));
    // No spawn should have happened.
    assert.strictEqual(fakeSpawn.calls.length, 0);
  } finally {
    rmrf(dir);
  }
});

test('L4 executeActions in dryRun mode does not spawn or write flag', () => {
  const dir = mkTmp('orch-L4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
    ];
    O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
      dryRun: true,
    });
    assert.strictEqual(fakeSpawn.calls.length, 0);
    assert.strictEqual(fakeUpdate.calls.length, 0);
    const flagPath = O.flagFilePath(O.orchDirFor(dir), 'orch-phase-1-impl');
    assert.ok(!fs.existsSync(flagPath));
  } finally {
    rmrf(dir);
  }
});

test('L5 recovery spawn passes role: recovery + recoveryRole to generate-prompt', () => {
  const dir = mkTmp('orch-L5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      {
        type: 'spawn',
        phaseId: 'phase-1',
        role: 'impl',
        mode: 'recovery',
        iteration: 2,
      },
    ];
    O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
    });
    assert.strictEqual(fakeGen.calls[0].role, 'recovery');
    assert.strictEqual(fakeGen.calls[0].recoveryRole, 'impl');
  } finally {
    rmrf(dir);
  }
});

test('L6 review_retry spawn inlines prior verdict failures into previous_phase_briefing', () => {
  const dir = mkTmp('orch-L6');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const fakeUpdate = makeFakeRunUpdate();
    const actions = [
      {
        type: 'spawn',
        phaseId: 'p',
        role: 'impl',
        mode: 'review_retry',
        iteration: 2,
        verdict: {
          pass: false,
          failures: [{ test: 'A', expected: '1', actual: '2' }],
          source: 'qa-complete.md',
          signalStatus: 'blocked',
        },
      },
    ];
    O.executeActions(actions, tickState, { convergenceCounters: new Map() }, {
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _runUpdate: fakeUpdate,
      logger: silentLogger(),
      projectName: 'p',
    });
    const briefing = fakeGen.calls[0].previousPhaseBriefing;
    assert.ok(briefing);
    assert.match(briefing, /Prior QA verdict/);
    assert.match(briefing, /test=/);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// M — executeActions: persist + mark_phase_*
// =========================================================================

test('M1 mark_phase_completed dispatches runUpdate with status: completed', () => {
  const dir = mkTmp('orch-M1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeUpdate = makeFakeRunUpdate();
    O.executeActions(
      [{ type: 'mark_phase_completed', phaseId: 'phase-1' }],
      tickState,
      { convergenceCounters: new Map() },
      { _runUpdate: fakeUpdate, logger: silentLogger() }
    );
    assert.strictEqual(fakeUpdate.calls[0].updates.status, 'completed');
    assert.ok(fakeUpdate.calls[0].updates.completed_at);
  } finally {
    rmrf(dir);
  }
});

test('M2 mark_phase_failed dispatches runUpdate with status: failed + error', () => {
  const dir = mkTmp('orch-M2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeUpdate = makeFakeRunUpdate();
    const log = recordingLogger();
    O.executeActions(
      [{ type: 'mark_phase_failed', phaseId: 'phase-1', reason: 'recovery_budget_exhausted:pid_esrch' }],
      tickState,
      { convergenceCounters: new Map() },
      { _runUpdate: fakeUpdate, logger: log }
    );
    assert.strictEqual(fakeUpdate.calls[0].updates.status, 'failed');
    assert.match(fakeUpdate.calls[0].updates.error, /recovery_budget_exhausted/);
    // Renders the structured terminal block.
    assert.ok(log.records.some((r) => /problem/i.test(r.message)));
  } finally {
    rmrf(dir);
  }
});

test('M3 fatal action halts further execution this tick', () => {
  const dir = mkTmp('orch-M3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeUpdate = makeFakeRunUpdate();
    const out = O.executeActions(
      [
        { type: 'fatal', message: 'boom' },
        { type: 'mark_phase_completed', phaseId: 'phase-1' },
      ],
      tickState,
      { convergenceCounters: new Map() },
      { _runUpdate: fakeUpdate, logger: silentLogger() }
    );
    assert.strictEqual(out.fatal, 'boom');
    // The mark_phase_completed should NOT have fired.
    assert.strictEqual(fakeUpdate.calls.length, 0);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// N — runOrchestrator end-to-end (integrated, all seams injected)
// =========================================================================

test('N1 runOrchestrator: 1-phase manifest reaches `completed` via signal', async () => {
  const dir = mkTmp('orch-N1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
    let tickCount = 0;
    const fakeCheck = () => makeStubHealth({ pidAlive: true });
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _checkHealth: () => {
        tickCount += 1;
        if (tickCount >= 2) {
          // Drop the completion signal mid-loop so the next tick advances.
          fs.mkdirSync(phaseDir, { recursive: true });
          writeCompletionSignal(phaseDir, 'impl', 'complete');
        }
        return fakeCheck();
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 'test-orch',
      maxTicks: 10,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.summary, 'completed');
    const status = readStatus(mp);
    assert.strictEqual(status.phases['phase-1'].status, 'completed');
  } finally {
    rmrf(dir);
  }
});

test('N2 runOrchestrator: 2-phase linear manifest completes both in dependency order', async () => {
  const dir = mkTmp('orch-N2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            depends_on: ['a'],
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    let tick = 0;
    const fakeCheck = () => makeStubHealth({ pidAlive: true });
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _checkHealth: () => {
        tick += 1;
        if (tick === 2) writeCompletionSignal(makePhaseDir(mp, 'a'), 'impl', 'complete');
        if (tick === 5) writeCompletionSignal(makePhaseDir(mp, 'b'), 'impl', 'complete');
        return fakeCheck();
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 20,
    });
    assert.strictEqual(result.ok, true);
    const status = readStatus(mp);
    assert.strictEqual(status.phases.a.status, 'completed');
    assert.strictEqual(status.phases.b.status, 'completed');
  } finally {
    rmrf(dir);
  }
});

test('N3 runOrchestrator: --resume picks up status, skips completed phases', async () => {
  const dir = mkTmp('orch-N3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            depends_on: ['a'],
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    // Simulate a prior orchestrator that completed phase a.
    writeStatus(mp, { phases: { a: { status: 'completed' } } });
    let tick = 0;
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: fakeSpawn,
      _generatePrompt: fakeGen,
      _checkHealth: () => {
        tick += 1;
        if (tick === 2) writeCompletionSignal(makePhaseDir(mp, 'b'), 'impl', 'complete');
        return makeStubHealth({ pidAlive: true });
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 10,
    });
    assert.strictEqual(result.ok, true);
    // Phase a was never re-spawned (only b should appear in spawn calls).
    const aSpawns = fakeSpawn.calls.filter((c) => /-a-/.test(c.name));
    assert.strictEqual(aSpawns.length, 0);
  } finally {
    rmrf(dir);
  }
});

test('N4 runOrchestrator: lock contention exits code 2', async () => {
  const dir = mkTmp('orch-N4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const orchDir = path.join(dir, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(
      path.join(orchDir, '.orchestrator.lock'),
      JSON.stringify({ pid: 99999, startedAt: 'old', hostname: 'h' })
    );
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _killer: () => {}, // alive
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 2);
    assert.strictEqual(result.summary, 'lock_contention');
  } finally {
    rmrf(dir);
  }
});

test('N5 runOrchestrator: terminal failure produces ok=false summary', async () => {
  const dir = mkTmp('orch-N5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 3 } } });
    makePhaseDir(mp, 'phase-1');
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: false }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'completed_with_failures');
  } finally {
    rmrf(dir);
  }
});

test('N6 runOrchestrator: invalid manifest halts with config error (no infinite loop)', async () => {
  const dir = mkTmp('orch-N6');
  try {
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'name: x\nphases: []');
    const result = await O.runOrchestrator({
      manifestPath: path.join(dir, 'manifest.yaml'),
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      skipScaffold: true,
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// O — CLI argument parsing
// =========================================================================

test('O1 parseCliArgs: bare manifest path', () => {
  const a = O.parseCliArgs(['node', 's.js', 'manifest.yaml']);
  assert.strictEqual(a.manifestPath, 'manifest.yaml');
  assert.strictEqual(a.resume, false);
});

test('O2 parseCliArgs: --resume', () => {
  const a = O.parseCliArgs(['node', 's.js', '--resume', 'm.yaml']);
  assert.strictEqual(a.resume, true);
});

test('O3 parseCliArgs: --once sets maxTicks to 1', () => {
  const a = O.parseCliArgs(['node', 's.js', '--once', 'm.yaml']);
  assert.strictEqual(a.maxTicks, 1);
  assert.strictEqual(a.once, true);
});

test('O4 parseCliArgs: integer flags accept positive ints', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--active-interval-ms',
    '5000',
    '--converge-n',
    '5',
    'm.yaml',
  ]);
  assert.strictEqual(a.activeIntervalMs, 5000);
  assert.strictEqual(a.lookupFailedConvergeN, 5);
});

test('O5 parseIntFlag rejects empty string (empty-string-as-explicit-override class)', () => {
  // Institutional-memory pattern: empty value to a flag that requires
  // a number is a USER mistake, not a default. parseIntFlag throws a
  // CliError; main() catches and exits — but the throw is testable
  // without spawning a subprocess.
  assert.throws(
    () => O.parseIntFlag('--active-interval-ms', ''),
    /requires an integer/
  );
});

test('O5b parseIntFlag rejects whitespace-only', () => {
  assert.throws(() => O.parseIntFlag('--converge-n', '   '), /requires an integer/);
});

test('O5c parseIntFlag rejects non-integer', () => {
  assert.throws(() => O.parseIntFlag('--converge-n', '3.5'), /requires an integer/);
});

test('O5d parseIntFlag positive-only flag rejects 0', () => {
  assert.throws(
    () => O.parseIntFlag('--converge-n', '0', { allowZero: false }),
    /positive integer/
  );
});

test('O5e parseCliArgs throws CliError on unknown argument', () => {
  assert.throws(
    () => O.parseCliArgs(['node', 's.js', '--bogus', 'm.yaml']),
    /unknown argument/
  );
});

test('O5f parseCliArgs throws when manifest path missing', () => {
  assert.throws(
    () => O.parseCliArgs(['node', 's.js']),
    /manifest path is required/
  );
});

test('O5g parseCliArgs --help sets showHelp; main path skips manifest required', () => {
  const a = O.parseCliArgs(['node', 's.js', '--help']);
  assert.strictEqual(a.showHelp, true);
  assert.strictEqual(a.manifestPath, null);
});

test('O6 parseCliArgs: --plugin-dir + --project-name capture string args', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--plugin-dir',
    '/p',
    '--project-name',
    'demo',
    'm.yaml',
  ]);
  assert.strictEqual(a.pluginDir, '/p');
  assert.strictEqual(a.projectName, 'demo');
});

test('O7 parseCliArgs: --dry-run + --skip-scaffold are flags', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--dry-run',
    '--skip-scaffold',
    'm.yaml',
  ]);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.skipScaffold, true);
});

// =========================================================================
// P — stateless invariant + idempotency
// =========================================================================

test('P1 two consecutive ticks with no change produce identical actions', () => {
  const dir = mkTmp('orch-P1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeHealth = () => makeStubHealth({ pidAlive: true });
    const a1 = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: fakeHealth }
    );
    const a2 = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: fakeHealth }
    );
    // Both should be empty (running + healthy + no signal).
    assert.deepStrictEqual(a1, a2);
  } finally {
    rmrf(dir);
  }
});

test('P2 orchestrator can be re-instantiated from manifest+status alone', async () => {
  const dir = mkTmp('orch-P2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    // Simulate a kill mid-run: status records `running`, no in-memory state.
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    let tick = 0;
    // First instance: drop the completion signal on tick 2 and let it complete.
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => {
        tick += 1;
        if (tick === 2) {
          writeCompletionSignal(makePhaseDir(mp, 'phase-1'), 'impl', 'complete');
        }
        return makeStubHealth({ pidAlive: true });
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, true);
    const final = readStatus(mp);
    assert.strictEqual(final.phases['phase-1'].status, 'completed');
  } finally {
    rmrf(dir);
  }
});

test('P3 manifest mid-run edit: orchestrator re-reads + survives without crash', async () => {
  const dir = mkTmp('orch-P3');
  try {
    // Start with both phases declared. Phase a is already running (per
    // status). Phase b has not yet been touched. On tick 1, before
    // anything else happens, the manifest is rewritten to drop b — so
    // the next tick's pollAllPhases sees only a.
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'a',
            completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
          {
            id: 'b',
            completion_signal: 'docs/orchestration/phases/b/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    // Both phases marked running upstream so the first tick does not
    // dispatch fresh spawns for either — the test is about manifest
    // re-read survival, not initial dispatch.
    writeStatus(mp, {
      phases: {
        a: { status: 'running', retry_count: 0, started_at: new Date().toISOString() },
        b: { status: 'running', retry_count: 0, started_at: new Date().toISOString() },
      },
    });
    makePhaseDir(mp, 'a');
    makePhaseDir(mp, 'b');
    let tick = 0;
    const fakeSpawn = makeFakeSpawnSession();
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: fakeSpawn,
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: ({ phaseId }) => {
        tick += 1;
        if (tick === 1) {
          // Operator edits the manifest mid-run, removing phase b.
          writeManifest(
            dir,
            makeBaseManifest({
              phases: [
                {
                  id: 'a',
                  completion_signal: 'docs/orchestration/phases/a/impl-complete.md',
                  agents: [{ role: 'impl' }],
                },
              ],
            })
          );
        }
        if (tick >= 3 && phaseId === 'a') {
          writeCompletionSignal(makePhaseDir(mp, 'a'), 'impl', 'complete');
        }
        return makeStubHealth({ pidAlive: true });
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 10,
    });
    assert.strictEqual(result.ok, true);
    // After the edit, phase a completes; phase b is no longer present
    // in the manifest's phases array, so the orchestrator stops
    // iterating it. The status entry persists for history but
    // isTerminalStatus is checked only against the live phases list.
    const status = readStatus(mp);
    assert.strictEqual(status.phases.a.status, 'completed');
  } finally {
    rmrf(dir);
  }
});

test('P4 isActiveTick true when any phase is running, false otherwise', () => {
  const t1 = {
    phases: [{ id: 'a' }],
    status: { phases: { a: { status: 'running' } } },
  };
  const t2 = {
    phases: [{ id: 'a' }],
    status: { phases: { a: { status: 'completed' } } },
  };
  assert.strictEqual(O.isActiveTick(t1), true);
  assert.strictEqual(O.isActiveTick(t2), false);
});

// =========================================================================
// Q — CLI smoke tests (subprocess; respect todo 044's ≤3 budget)
// =========================================================================

test('Q1 CLI: --help exits 0 with usage text', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'orchestrate.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--resume/);
});

// =========================================================================
// R — codex round 1 regression tests (P1 + P2 fixes)
// =========================================================================

test('R1 [codex round 1 P1] non-review phase + status: blocked → mark_phase_blocked, NOT mark_phase_completed', () => {
  const dir = mkTmp('orch-R1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'phase-1');
    // Agent wrote impl-complete.md with status: blocked (legitimate
    // per protocol-header.md). Pre-fix, the orchestrator marked the
    // phase complete because the file existed.
    writeCompletionSignal(phaseDir, 'impl', 'blocked');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    assert.ok(
      !actions.some((a) => a.type === 'mark_phase_completed'),
      'must NOT mark complete when agent reported blocked'
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
  } finally {
    rmrf(dir);
  }
});

test('R2 [codex round 1 P1] non-review phase + status: partial → mark_phase_blocked', () => {
  const dir = mkTmp('orch-R2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'phase-1');
    writeCompletionSignal(phaseDir, 'impl', 'partial');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
    assert.ok(!actions.some((a) => a.type === 'mark_phase_completed'));
  } finally {
    rmrf(dir);
  }
});

test('R3 [codex round 1 P1] downstream phase blocked when upstream is `blocked` (not just `failed`)', () => {
  const dir = mkTmp('orch-R3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          { id: 'a', completion_signal: 'docs/orchestration/phases/a/impl-complete.md', agents: [{ role: 'impl' }] },
          { id: 'b', completion_signal: 'docs/orchestration/phases/b/impl-complete.md', depends_on: ['a'], agents: [{ role: 'impl' }] },
        ],
      })
    );
    writeStatus(mp, { phases: { a: { status: 'blocked', error: 'agent_signal:blocked:impl' } } });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked' && a.phaseId === 'b'),
      'phase b must be blocked when its dep is blocked, not just when failed'
    );
  } finally {
    rmrf(dir);
  }
});

test('R4 [codex round 1 P1] review_retry spawn deletes stale impl-complete + qa-complete + qa-verdict', () => {
  const dir = mkTmp('orch-R4');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    const phaseDir = makePhaseDir(mp, 'p');
    // Stale signals from iteration 1.
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    writeCompletionSignal(phaseDir, 'qa', 'blocked');
    fs.writeFileSync(
      path.join(phaseDir, 'qa-verdict.json'),
      JSON.stringify({ pass: false, failures: [] })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    const fakeUpdate = makeFakeRunUpdate();
    O.executeActions(
      [
        {
          type: 'spawn',
          phaseId: 'p',
          role: 'impl',
          mode: 'review_retry',
          iteration: 2,
          verdict: { pass: false, failures: [], source: 'qa-complete.md', signalStatus: 'blocked' },
        },
      ],
      tickState,
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: fakeGen,
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    assert.ok(!fs.existsSync(path.join(phaseDir, 'impl-complete.md')), 'impl-complete.md should be deleted');
    assert.ok(!fs.existsSync(path.join(phaseDir, 'qa-complete.md')), 'qa-complete.md should be deleted');
    assert.ok(!fs.existsSync(path.join(phaseDir, 'qa-verdict.json')), 'qa-verdict.json should be deleted');
  } finally {
    rmrf(dir);
  }
});

test('R5 [codex round 1 P1] recovery spawn deletes stale completion signal for the same role', () => {
  const dir = mkTmp('orch-R5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = makePhaseDir(mp, 'phase-1');
    writeCompletionSignal(phaseDir, 'impl', 'complete'); // pretend prior agent wrote this just before crashing
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'recovery', iteration: 2 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    assert.ok(!fs.existsSync(path.join(phaseDir, 'impl-complete.md')));
  } finally {
    rmrf(dir);
  }
});

test('R6 [codex round 1 P2] relative manifest workdir resolves against manifestDir', () => {
  const dir = mkTmp('orch-R6');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        workdir: 'subdir/inner',
      })
    );
    fs.mkdirSync(path.join(dir, 'subdir', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    const expected = path.resolve(dir, 'subdir', 'inner');
    assert.strictEqual(
      path.normalize(fakeSpawn.calls[0].workdir),
      path.normalize(expected),
      'spawnSession should receive an absolute workdir resolved against manifestDir'
    );
    // generate-prompt should also see the resolved path.
    assert.strictEqual(
      path.normalize(fakeGen.calls[0].workdir),
      path.normalize(expected)
    );
  } finally {
    rmrf(dir);
  }
});

test('R7 [codex round 1 P2] per-phase review_loop.max_iterations overrides the CLI default', () => {
  const dir = mkTmp('orch-R7');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 1 }, // tight cap
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 1 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'blocked'); // FAIL on iteration 1
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      // CLI default would be 3 — per-phase 1 should win and escalate immediately.
      { reviewLoopMaxIterations: 5 }
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_failed' && /review_loop_exceeded/.test(a.reason)),
      'per-phase max_iterations: 1 must escalate even though CLI default is higher'
    );
  } finally {
    rmrf(dir);
  }
});

test('R8 [codex round 1 P2] explicit zero CLI overrides are respected (?? not ||)', () => {
  const dir = mkTmp('orch-R8');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // maxRecoveryRetries: 0 means "don't recover at all". Pre-fix, the
    // `||` default replaced the explicit 0 with DEFAULT_MAX_RECOVERY_RETRIES = 3
    // and the orchestrator would silently retry up to 3 times instead.
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: () => makeStubHealth({ pidAlive: false }),
        maxRecoveryRetries: 0,
      }
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_failed'),
      'maxRecoveryRetries: 0 must mark failed immediately, not retry'
    );
    assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
  } finally {
    rmrf(dir);
  }
});

test('S1 [codex round 2 P2] spawn failure → matching persist is skipped (phase stays pending)', () => {
  const dir = mkTmp('orch-S1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const tickState = { ...tickRes, manifestPath: mp };
    const fakeUpdate = makeFakeRunUpdate();
    const failingSpawn = () => {
      throw new Error('wt not on PATH');
    };
    O.executeActions(
      [
        { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'persist', phaseId: 'phase-1', updates: { status: 'running' } },
      ],
      tickState,
      { convergenceCounters: new Map() },
      {
        _spawnSession: failingSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // No persist call should have fired — the matching spawn failed.
    const runningPersists = fakeUpdate.calls.filter(
      (c) => c.updates && c.updates.status === 'running'
    );
    assert.strictEqual(
      runningPersists.length,
      0,
      'phase-1 must NOT be persisted as running when its spawn failed'
    );
  } finally {
    rmrf(dir);
  }
});

test('S2 [codex round 2 P2] runOneTick resets spawnFailedThisTick between ticks', async () => {
  const dir = mkTmp('orch-S2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    let spawnAttempts = 0;
    let spawnFailedFirstTick = false;
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) {
          spawnFailedFirstTick = true;
          throw new Error('first attempt failed');
        }
        // Second attempt succeeds.
        return {
          pid: 4242,
          command: 'fake',
          argv: [],
          sessionName: `orch-phase-1-impl`,
          title: 'fake',
          spawnedAt: '2026-05-02T01:00:00Z',
        };
      },
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 3,
    });
    // Should have retried on tick 2 (phase-1 still pending after tick 1's spawn failure).
    assert.ok(spawnFailedFirstTick);
    assert.ok(spawnAttempts >= 2, `expected at least 2 spawn attempts, got ${spawnAttempts}`);
  } finally {
    rmrf(dir);
  }
});

test('S3 [codex round 2 P2] per-agent plugin_dir overrides CLI --plugin-dir', () => {
  const dir = mkTmp('orch-S3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl', plugin_dir: '/per/agent/plugin' }],
          },
        ],
      })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        pluginDir: '/cli/plugin', // CLI flag — should be overridden
      }
    );
    assert.strictEqual(fakeSpawn.calls[0].pluginDir, '/per/agent/plugin');
  } finally {
    rmrf(dir);
  }
});

test('S4 [codex round 2 P2] CLI --plugin-dir is the fallback when agent has no plugin_dir', () => {
  const dir = mkTmp('orch-S4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        pluginDir: '/cli/plugin',
      }
    );
    assert.strictEqual(fakeSpawn.calls[0].pluginDir, '/cli/plugin');
  } finally {
    rmrf(dir);
  }
});

test('S5 [codex round 2 P2] --max-ticks reflects same-tick failure in exitOk', async () => {
  const dir = mkTmp('orch-S5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 3 } } });
    makePhaseDir(mp, 'phase-1');
    // The single tick will mark phase-1 failed (retry_count >= max).
    // Pre-fix: maxTicks=1 exited with exitOk=true because the post-action
    // status mark hadn't propagated to tickState.status before the
    // next loop iteration's terminal check.
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: false }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1,
    });
    assert.strictEqual(result.ok, false, '--max-ticks 1 with same-tick failure must report ok=false');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// T — codex round 3 regression tests
// =========================================================================

function copyTemplatesTo(destDir) {
  const src = path.join(__dirname, '..', 'templates');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name.endsWith('.md')) {
      fs.copyFileSync(path.join(src, name), path.join(destDir, name));
    }
  }
}

test('T1 [codex round 3 P1] impl spawn with REAL generatePrompt + no plan_path → fallback stub satisfies required plan_units', () => {
  const dir = mkTmp('orch-T1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tmpl = path.join(dir, 'docs', 'orchestration', 'templates');
    copyTemplatesTo(tmpl);
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    const fakeUpdate = makeFakeRunUpdate();
    const out = O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        // _generatePrompt: NOT injected — uses the real generate-prompt.
        _runUpdate: fakeUpdate,
        templatesDir: tmpl,
        logger: silentLogger(),
        projectName: 't',
      }
    );
    assert.strictEqual(out.warnings.filter((w) => /spawn failed/.test(w)).length, 0,
      `spawn must succeed even without plan_path; warnings=${JSON.stringify(out.warnings)}`);
    // The rendered prompt should contain the fallback stub.
    const promptPath = path.join(
      dir, 'docs', 'orchestration', 'phases', 'phase-1', 'impl-prompt.md'
    );
    assert.ok(fs.existsSync(promptPath));
    const text = fs.readFileSync(promptPath, 'utf8');
    assert.match(text, /No plan excerpt configured for phase phase-1/);
  } finally {
    rmrf(dir);
  }
});

test('T2 [codex round 3 P1] impl spawn with manifest plan_path + plan_unit_marker extracts the marked unit', () => {
  const dir = mkTmp('orch-T2');
  try {
    const planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(
      planPath,
      [
        '# Plan',
        '',
        '- [ ] **Unit alpha: First unit**',
        '  This is unit alpha\'s body. Ship X.',
        '',
        '- [ ] **Unit beta: Second unit**',
        '  This is unit beta\'s body. Ship Y.',
      ].join('\n')
    );
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }],
            plan_path: 'plan.md',
            plan_unit_marker: 'alpha',
          },
        ],
      })
    );
    const tmpl = path.join(dir, 'docs', 'orchestration', 'templates');
    copyTemplatesTo(tmpl);
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _runUpdate: makeFakeRunUpdate(),
        templatesDir: tmpl,
        logger: silentLogger(),
        projectName: 't',
      }
    );
    const text = fs.readFileSync(
      path.join(dir, 'docs', 'orchestration', 'phases', 'p', 'impl-prompt.md'),
      'utf8'
    );
    assert.match(text, /This is unit alpha/);
    assert.ok(!/This is unit beta/.test(text), 'beta should NOT leak into alpha\'s prompt');
  } finally {
    rmrf(dir);
  }
});

test('T3 [codex round 3 P2] manifest review_loop.pr_or_branch reaches QA prompt', () => {
  const dir = mkTmp('orch-T3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: {
              enabled: true,
              max_iterations: 3,
              pr_or_branch: 'feat/my-branch',
              qa_scope_rows: '1. Custom scope row.\n2. Another row.',
            },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'qa', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 't',
      }
    );
    assert.strictEqual(fakeGen.calls[0].prOrBranchUnderTest, 'feat/my-branch');
    assert.strictEqual(
      fakeGen.calls[0].qaScopeRows,
      '1. Custom scope row.\n2. Another row.'
    );
  } finally {
    rmrf(dir);
  }
});

test('T4 [codex round 3 P1] phase plan_units literal string overrides plan_path', () => {
  const dir = mkTmp('orch-T4');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }],
            plan_units: '## Inline excerpt\n\nDo the thing.',
          },
        ],
      })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 't',
      }
    );
    assert.strictEqual(fakeGen.calls[0].planUnits, '## Inline excerpt\n\nDo the thing.');
    // planPath / planUnitMarker should NOT also be set when literal is present.
    assert.strictEqual(fakeGen.calls[0].planPath, undefined);
  } finally {
    rmrf(dir);
  }
});

test('Q2 CLI: missing manifest path exits 1', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'orchestrate.js')], {
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /manifest path is required/);
});
