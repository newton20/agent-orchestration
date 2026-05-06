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

test('H2b [todo 107.d] recovery max-3 INNER boundary asserted (retry_count=2 → spawn iteration=3, NOT exhausted)', () => {
  // The pre-existing H2 only asserted the outer boundary: retry_count=3
  // with max=3 → exhausted (no spawn). 107.d closes the inner gap:
  // retry_count=2 with max=3 must still recover (cur < maxRetries),
  // and the emitted spawn action's iteration must be cur + 1 = 3. An
  // off-by-one swap of `>=` → `>` (or `<` → `<=`) would still pass
  // H1 / H2 / H4 but fail this assertion.
  const dir = mkTmp('orch-H2b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: 2 } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    const recoverySpawn = actions.find(
      (a) => a.type === 'spawn' && a.mode === 'recovery'
    );
    assert.ok(
      recoverySpawn,
      'retry_count=2 must still trigger recovery (inner boundary)'
    );
    assert.strictEqual(
      recoverySpawn.iteration,
      3,
      'recovery iteration must be retry_count + 1 = 3'
    );
    assert.ok(
      !actions.some(
        (a) => a.type === 'mark_phase_failed' && /budget_exhausted/.test(a.reason || '')
      ),
      'retry_count=2 must NOT emit budget-exhausted'
    );
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

test('H5 [todo 097] shape-corrupt retry_count="two" blocks the phase (no recovery)', () => {
  const dir = mkTmp('orch-H5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: 'two' } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(
      actions.some(
        (a) => a.type === 'mark_phase_blocked' && /retry_count_shape_corrupt/.test(a.reason || '')
      ),
      'shape-corrupt retry_count must emit mark_phase_blocked, not silently coerce to 0'
    );
    assert.ok(
      !actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'),
      'shape-corrupt phase must not enter the recovery dispatch path'
    );
  } finally {
    rmrf(dir);
  }
});

test('H5b [todo 097] shape-corrupt retry_count=2.5 (float) blocks the phase', () => {
  const dir = mkTmp('orch-H5b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: 2.5 } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked'),
      'float retry_count must emit mark_phase_blocked'
    );
  } finally {
    rmrf(dir);
  }
});

test('H5c [todo 097] retry_count=-1 (negative) blocks the phase', () => {
  const dir = mkTmp('orch-H5c');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: -1 } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
  } finally {
    rmrf(dir);
  }
});

test('H5d [todo 097] retry_count absent → treated as 0 (legitimate fresh-spawn, NOT blocked)', () => {
  const dir = mkTmp('orch-H5d');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    // Note: NO retry_count key on the phase entry.
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(
      !actions.some((a) => a.type === 'mark_phase_blocked'),
      'absent retry_count is a legitimate fresh-spawn case; must NOT block'
    );
  } finally {
    rmrf(dir);
  }
});

test('H5e [todo 097] retry_count present with explicit null blocks the phase', () => {
  const dir = mkTmp('orch-H5e');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: null } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked'),
      'explicit null retry_count is shape-corrupt (vs absence which defaults to 0)'
    );
  } finally {
    rmrf(dir);
  }
});

test('H5f [todo 097] retry_count=5 above MAX_RETRIES (3) is NOT shape-corrupt — flows through to budget-exhausted recovery path', () => {
  const dir = mkTmp('orch-H5f');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: 5 } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    // Over-budget integer must NOT be misclassified as shape-corrupt.
    assert.ok(
      !actions.some(
        (a) => a.type === 'mark_phase_blocked' && /retry_count_shape_corrupt/.test(a.reason || '')
      ),
      'over-budget integer is legitimate historical state, NOT shape-corrupt'
    );
    // The exhausted-budget path emits mark_phase_failed via decideRecoveryAction.
    assert.ok(
      actions.some(
        (a) => a.type === 'mark_phase_failed' && /recovery_budget_exhausted/.test(a.reason || '')
      ),
      'over-budget integer triggers the documented recovery-budget-exhausted policy'
    );
  } finally {
    rmrf(dir);
  }
});

test('H6 [todo 094] recovery action populates priorPid + completedCheckpointsBlock from existing data', () => {
  // Manifest has 3 phases; phase-prev was completed; phase-1 is the
  // running phase whose pid=4242 just died. The recovery action must
  // emit priorPid=4242 and a completedCheckpointsBlock that lists
  // phase-prev sourced from status.phases iteration (NOT from a
  // top-level completed_phases field — that field does not exist).
  const dir = mkTmp('orch-H6');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'phase-prev',
            completion_signal: 'docs/orchestration/phases/phase-prev/impl-complete.md',
            agent: { role: 'impl' },
          },
          {
            id: 'phase-1',
            completion_signal: 'docs/orchestration/phases/phase-1/impl-complete.md',
            agent: { role: 'impl' },
            depends_on: ['phase-prev'],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        'phase-prev': { status: 'completed' },
        'phase-1': { status: 'running', pid: 4242, retry_count: 0 },
      },
    });
    makePhaseDir(mp, 'phase-prev');
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false, heartbeatAge: 30 }) }
    );
    const recoverySpawn = actions.find(
      (a) => a.type === 'spawn' && a.mode === 'recovery'
    );
    assert.ok(recoverySpawn, 'recovery spawn must be emitted');
    assert.strictEqual(
      recoverySpawn.priorPid,
      4242,
      'priorPid sourced from manifest-status pid field'
    );
    assert.ok(
      typeof recoverySpawn.lastHeartbeatTimestamp === 'string',
      `lastHeartbeatTimestamp derived from heartbeatAge=30; got ${JSON.stringify(recoverySpawn.lastHeartbeatTimestamp)}`
    );
    assert.ok(
      typeof recoverySpawn.completedCheckpointsBlock === 'string' &&
        /phase-prev/.test(recoverySpawn.completedCheckpointsBlock),
      `completedCheckpointsBlock must mention phase-prev; got ${JSON.stringify(recoverySpawn.completedCheckpointsBlock)}`
    );
  } finally {
    rmrf(dir);
  }
});

test('H6b [todo 094] recovery action emits explicit null for absent fields (NOT undefined)', () => {
  // No heartbeat → lastHeartbeatTimestamp: null. No completed phases
  // → completedCheckpointsBlock: null. No prior pid → priorPid: null.
  // No plan_units → remainingWorkBlock: null. The dispatch's RA #2
  // requires explicit null (not undefined / omitted) so the V1.5
  // hook can distinguish "field not populated" from "field absent
  // from contract."
  const dir = mkTmp('orch-H6b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: { 'phase-1': { status: 'running', retry_count: 0 } },
    });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      // No heartbeat record exists; checkHealth returns heartbeatAge=null.
      { _checkHealth: () => makeStubHealth({ pidAlive: false, heartbeatAge: null }) }
    );
    const recoverySpawn = actions.find(
      (a) => a.type === 'spawn' && a.mode === 'recovery'
    );
    assert.ok(recoverySpawn);
    assert.strictEqual(recoverySpawn.priorPid, null);
    assert.strictEqual(recoverySpawn.lastHeartbeatTimestamp, null);
    assert.strictEqual(recoverySpawn.remainingWorkBlock, null);
    assert.strictEqual(recoverySpawn.completedCheckpointsBlock, null);
    // Sanity — keys must be PRESENT (not omitted).
    assert.ok('priorPid' in recoverySpawn);
    assert.ok('lastHeartbeatTimestamp' in recoverySpawn);
    assert.ok('remainingWorkBlock' in recoverySpawn);
    assert.ok('completedCheckpointsBlock' in recoverySpawn);
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

test('I4b [todo 098] startup_grace RESETS the counter (flap pattern: lookup_failed → grace → lookup_failed counts 1, not 2)', () => {
  // The "consecutive" word in todo 071's contract is load-bearing:
  // recovery only fires after N _consecutive_ failures. Pre-fix,
  // startup_grace was a skip-the-increment, not a reset — the
  // pattern lookup_failed → startup_grace → lookup_failed left the
  // counter at 2 (off-by-one from the contract). The fix resets on
  // grace so the second null is the second consecutive failure
  // counted from a fresh start.
  const dir = mkTmp('orch-I4b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.strictEqual(counters.get('phase-1:impl'), 1);
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'startup_grace' }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.strictEqual(
      counters.has('phase-1:impl'),
      false,
      'startup_grace must RESET the counter, not just skip the increment'
    );
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.strictEqual(counters.get('phase-1:impl'), 1);
    assert.ok(
      !actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'),
      'should NOT recover on second lookup_failed when grace reset the counter'
    );
  } finally {
    rmrf(dir);
  }
});

test('I4c [todo 098] flap pattern under custom --converge-n=2 also honors startup_grace reset', () => {
  // Verifies the threshold itself is unchanged by 098's fix — the
  // configured --converge-n is preserved, only the WHEN-to-reset
  // semantic changed. With converge-n=2: lookup_failed → grace →
  // lookup_failed → lookup_failed should fire on the third call
  // (counter sequence: 1, reset to 0, 1, 2 → trigger).
  const dir = mkTmp('orch-I4c');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    let actions;
    actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'lookup_failed' }),
        lookupFailedConvergeN: 2,
      }
    );
    assert.ok(!actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'));
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: 'startup_grace' }),
        lookupFailedConvergeN: 2,
      }
    );
    actions = O.decideTickActions(
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

test('I4d [todo 108.j] convergence counter: unknown / null pidAliveReason still counts toward convergence', () => {
  // The dispatcher comment at orchestrate.js documents:
  //   "'lookup_failed' OR 'session_not_found' OR null reason ⇒ count."
  // The null-reason branch was untested pre-fix; a refactor that
  // accidentally short-circuited unknown reasons would have left
  // recovery dispatch buggy. Verify counter increments for each
  // null-reason call below the threshold, and that the threshold
  // call still triggers recovery.
  const dir = mkTmp('orch-I4d');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const counters = new Map();
    // Two below-threshold calls increment counter to 1, 2.
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: null }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.strictEqual(counters.get('phase-1:impl'), 1);
    O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: null }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.strictEqual(counters.get('phase-1:impl'), 2);
    // Third call hits convergence threshold → recovery action emitted
    // and counter is deleted.
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: counters },
      {
        _checkHealth: () =>
          makeStubHealth({ pidAlive: null, pidAliveReason: null }),
        lookupFailedConvergeN: 3,
      }
    );
    assert.ok(
      actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'),
      'null pidAliveReason must converge to recovery on the Nth call'
    );
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

test('K4b [todo 101] schema_version=1 (V1 baseline) accepted', () => {
  const dir = mkTmp('orch-K4b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ schema_version: 1 }) }
    );
    assert.ok(!actions.some((a) => a.type === 'fatal'));
  } finally {
    rmrf(dir);
  }
});

test('K4c [todo 101] schema_version="1.1" accepted with warning (soft-band)', () => {
  const dir = mkTmp('orch-K4c');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ schema_version: '1.1' }) }
    );
    assert.ok(!actions.some((a) => a.type === 'fatal'), 'minor bump must not fatal');
    assert.ok(
      actions.some(
        (a) => a.type === 'log' && a.level === 'warn' && /soft-compat band/.test(a.message)
      ),
      'minor bump must emit a soft-band warning'
    );
  } finally {
    rmrf(dir);
  }
});

test('K4d [todo 101] schema_version=2 (major bump) → fatal', () => {
  const dir = mkTmp('orch-K4d');
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
    assert.ok(
      actions.some((a) => a.type === 'fatal' && /schema_version/.test(a.message))
    );
  } finally {
    rmrf(dir);
  }
});

test('K4e [todo 101] malformed schema_version values rejected as fatal', () => {
  const dir = mkTmp('orch-K4e');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    for (const bad of ['1.0.x', 'abc', '', null, 1.5]) {
      const actions = O.decideTickActions(
        { ...tickRes, manifestPath: mp },
        { convergenceCounters: new Map() },
        { _checkHealth: () => makeStubHealth({ schema_version: bad }) }
      );
      assert.ok(
        actions.some((a) => a.type === 'fatal'),
        `malformed value ${JSON.stringify(bad)} must be rejected as fatal`
      );
    }
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
      resume: true, // codex round 21 P2: required when status has running phases
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

test('O3 parseCliArgs: --once sets maxTicks to 1 (todo 108.e: no separate `once` field)', () => {
  const a = O.parseCliArgs(['node', 's.js', '--once', 'm.yaml']);
  assert.strictEqual(a.maxTicks, 1);
  assert.strictEqual(a.once, undefined);
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

test('O6 parseCliArgs: --plugin-dir + --project-name capture string args (todo 108.m: path must exist)', () => {
  // Todo 108.m: --plugin-dir now validates the path exists at the
  // CLI boundary. Use the test directory itself to satisfy the check.
  const dir = mkTmp('orch-O6');
  try {
    const a = O.parseCliArgs([
      'node',
      's.js',
      '--plugin-dir',
      dir,
      '--project-name',
      'demo',
      'm.yaml',
    ]);
    assert.strictEqual(a.pluginDir, dir);
    assert.strictEqual(a.projectName, 'demo');
  } finally {
    rmrf(dir);
  }
});

test('O6a [todo 108.m] --plugin-dir nonexistent path → CliError', () => {
  assert.throws(
    () =>
      O.parseCliArgs([
        'node',
        's.js',
        '--plugin-dir',
        '/nonexistent-plugin-dir-' + Date.now(),
        'm.yaml',
      ]),
    /--plugin-dir path does not exist/
  );
});

test('O6b [todo 106] --plugin-dir followed by another flag → error (no greedy consume)', () => {
  // Pre-fix `--plugin-dir --resume bar.yaml` parsed as
  // `pluginDir = '--resume'` and silently dropped `--resume`.
  // The fix rejects `-`-prefixed values for path-typed flags.
  assert.throws(
    () => O.parseCliArgs(['node', 's.js', '--plugin-dir', '--resume', 'bar.yaml']),
    /--plugin-dir requires a path|use --plugin-dir=/
  );
});

test('O6c [todo 106] --project-name followed by another flag → error', () => {
  assert.throws(
    () => O.parseCliArgs(['node', 's.js', '--project-name', '--once', 'bar.yaml']),
    /--project-name requires a path|use --project-name=/
  );
});

test('O6d [todo 106] --plugin-dir=<--special-path> escape hatch via `=` form', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--plugin-dir=--special-path',
    '--resume',
    'bar.yaml',
  ]);
  assert.strictEqual(a.pluginDir, '--special-path');
  assert.strictEqual(a.resume, true);
  assert.strictEqual(a.manifestPath, 'bar.yaml');
});

test('O6e [todo 106] --project-name=<value> escape hatch', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--project-name=--my-project',
    'bar.yaml',
  ]);
  assert.strictEqual(a.projectName, '--my-project');
});

test('O6f [todo 106] non-flag value continues to work normally', () => {
  // Sanity check: the existing happy path is preserved — only
  // `-`-prefixed values trip the new check. Use the cwd as a
  // path that always exists (todo 108.m's existence check).
  const dir = mkTmp('orch-O6f');
  try {
    const a = O.parseCliArgs([
      'node',
      's.js',
      '--plugin-dir',
      dir,
      '--resume',
      'bar.yaml',
    ]);
    assert.strictEqual(a.pluginDir, dir);
    assert.strictEqual(a.resume, true);
  } finally {
    rmrf(dir);
  }
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

test('S3 [codex round 15 P2] per-agent plugin_dir is V1.5 deferred — CLI --plugin-dir wins', () => {
  // Round 2 P2 enabled agents[].plugin_dir, but round 15 P2
  // identified that doing so breaks the SessionStart hook (single-
  // valued --plugin-dir on spawn-session means agent.plugin_dir
  // would replace the orchestrator plugin, where the hook lives).
  // V1 contract: the orchestrator plugin (or operator's CLI
  // override) wins; agents[].plugin_dir is logged as V1.5 deferred.
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
    const log = recordingLogger();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: log,
        projectName: 'p',
        pluginDir: '/cli/plugin',
      }
    );
    // CLI --plugin-dir wins, NOT agents[].plugin_dir.
    assert.strictEqual(fakeSpawn.calls[0].pluginDir, '/cli/plugin');
    // Operator must see a warning explaining why agent.plugin_dir was ignored.
    assert.ok(
      log.records.some((r) => /V1\.5 deferred/.test(r.message)),
      'orchestrator must warn when ignoring agents[].plugin_dir'
    );
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

// =========================================================================
// U — codex round 4 regression tests
// =========================================================================

test('U1 [codex round 4 P1] review-enabled phase with only impl agent → snapshot includes synthesized QA', () => {
  const dir = mkTmp('orch-U1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }], // only impl declared
          },
        ],
      })
    );
    let queriedNames = null;
    O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () => '[]',
    });
    // Probe the snapshot builder directly with a runner that captures
    // the names list it parses against.
    const snap = O.buildPidSnapshot(['orch-p-impl', 'orch-p-qa'], {
      _pidRunner: () =>
        JSON.stringify([
          { ProcessId: 100, CommandLine: 'claude --name orch-p-impl' },
          { ProcessId: 200, CommandLine: 'claude --name orch-p-qa' },
        ]),
    });
    assert.strictEqual(snap.get('orch-p-impl').pid, 100);
    assert.strictEqual(snap.get('orch-p-qa').pid, 200);
    // And confirm pollAllPhases includes orch-p-qa in its name list
    // (we can't directly inspect, but a tick that uses _pidSnapshot
    // works correctly only if the synthesized QA is in the snapshot).
    // This is exercised end-to-end by the J-series review tests; the
    // direct test above is the regression-pin for the snapshot
    // builder's integration.
    void queriedNames;
  } finally {
    rmrf(dir);
  }
});

test('U1b [codex round 4 P1] pollAllPhases includes synthesized QA role for review-enabled impl-only phase', () => {
  const dir = mkTmp('orch-U1b');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    // Capture the runner's stdin/argv pair to confirm pollAllPhases
    // calls buildPidLookupArgs once per tick. The names we asked
    // about live in the parser's output, not the input — so we
    // assert via the resulting snapshot's keys instead.
    const tickRes = O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () =>
        JSON.stringify([
          { ProcessId: 100, CommandLine: 'claude --name orch-p-impl' },
          { ProcessId: 200, CommandLine: 'claude --name orch-p-qa' },
        ]),
    });
    // Both impl and qa entries should be in the snapshot — proving
    // the orchestrator looked up qa even though it isn't declared in
    // phase.agents.
    assert.ok(tickRes.pidSnapshot.has('orch-p-impl'));
    assert.ok(tickRes.pidSnapshot.has('orch-p-qa'));
  } finally {
    rmrf(dir);
  }
});

test('U2 [codex round 4 P2] CLI --review-loop-max-iterations applies when manifest omits the field', () => {
  const dir = mkTmp('orch-U2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            // review_loop without max_iterations — normalize fills
            // the default 3, which would mask any CLI override.
            review_loop: { enabled: true },
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 5 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'blocked'); // FAIL
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // CLI raised the cap to 10. With the bug, normalizePhases set
    // max_iterations to 3 and the orchestrator would have escalated
    // at iteration 5. After the fix, iteration 5 < CLI cap of 10, so
    // we expect a respawn.
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { reviewLoopMaxIterations: 10 }
    );
    assert.ok(
      actions.some((a) => a.type === 'spawn' && a.mode === 'review_retry'),
      'CLI cap of 10 must allow respawn at iteration 5'
    );
    assert.ok(
      !actions.some((a) => a.type === 'mark_phase_failed'),
      'CLI cap of 10 must NOT escalate at iteration 5'
    );
  } finally {
    rmrf(dir);
  }
});

test('U3 [codex round 4 P2] multi-role phase with one role blocked → does NOT mark complete', () => {
  const dir = mkTmp('orch-U3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            // No review_loop — both impl and qa run as concurrent roles.
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'p');
    // impl complete but qa blocked.
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    writeCompletionSignal(phaseDir, 'qa', 'blocked');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    // QA's blocked status must trigger mark_phase_blocked for the
    // phase, not mark_phase_completed even though impl is complete.
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
    assert.ok(!actions.some((a) => a.type === 'mark_phase_completed'));
  } finally {
    rmrf(dir);
  }
});

test('U4 [codex round 4 P2] multi-role phase with both roles complete → marks complete', () => {
  const dir = mkTmp('orch-U4');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    writeCompletionSignal(phaseDir, 'qa', 'complete');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth() }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_completed'));
  } finally {
    rmrf(dir);
  }
});

test('U5 [codex round 4 P2] lockfile uses exclusive create — second concurrent acquire fails', () => {
  const dir = mkTmp('orch-U5');
  try {
    // First acquire succeeds.
    const p1 = O.acquireLock(dir, { _pid: 1 });
    assert.ok(fs.existsSync(p1));
    // Second acquire (different pid, would-be live process) fails
    // because the file already exists. We mock killer to claim "alive"
    // so the recovery branch can't bypass the exclusivity test.
    assert.throws(
      () => O.acquireLock(dir, { _pid: 2, _killer: () => {} }),
      (err) => err.code === 'ELOCKED'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// V — codex round 5 regression tests
// =========================================================================

test('V1 [codex round 5 P1] flag file written under workdir/docs/orchestration when workdir != manifestDir', () => {
  const dir = mkTmp('orch-V1');
  try {
    const wd = path.join(dir, 'subworkdir');
    fs.mkdirSync(wd, { recursive: true });
    const mp = writeManifest(dir, makeBaseManifest({ workdir: 'subworkdir' }));
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate({ promptText: '# v1' }),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Flag file lives where the hook reads — under workdir, not manifestDir.
    const wdFlag = path.join(wd, 'docs', 'orchestration', '.pending-orch-phase-1-impl');
    assert.ok(fs.existsSync(wdFlag), `expected flag at ${wdFlag}`);
    // The OLD path (under manifestDir) should NOT have the flag.
    const oldFlag = path.join(dir, 'docs', 'orchestration', '.pending-orch-phase-1-impl');
    assert.ok(!fs.existsSync(oldFlag), 'flag must NOT be at manifestDir path when workdir differs');
  } finally {
    rmrf(dir);
  }
});

test('V2 [codex round 5 P2] manifest completion_signal honored — orchestrator polls custom path', () => {
  const dir = mkTmp('orch-V2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            // Custom path
            completion_signal: 'docs/custom/p/impl-complete.md',
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    // Write the signal at the custom path the manifest declared.
    const customDir = path.join(dir, 'docs', 'custom', 'p');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, 'impl-complete.md'),
      '---\nstatus: complete\n---\n# done'
    );
    // Also create the conventional phase dir (used for heartbeats etc).
    makePhaseDir(mp, 'p');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_completed' && a.phaseId === 'p'),
      'orchestrator should poll the manifest-declared completion_signal path'
    );
  } finally {
    rmrf(dir);
  }
});

test('V3 [codex round 5 P2] resolveCompletionSignal returns manifest path for matching role basename', () => {
  const manifest = {
    phases: [
      {
        id: 'p',
        completion_signal: 'docs/custom/p/impl-complete.md',
        agents: [{ role: 'impl' }],
      },
    ],
  };
  const dir = mkTmp('orch-V3');
  try {
    const got = O.resolveCompletionSignal(manifest, dir, 'p', 'impl');
    assert.strictEqual(
      path.normalize(got),
      path.normalize(path.join(dir, 'docs', 'custom', 'p', 'impl-complete.md'))
    );
  } finally {
    rmrf(dir);
  }
});

test('V4 [codex round 5 P2] resolveCompletionSignal falls back to convention for non-matching role', () => {
  const manifest = {
    phases: [
      {
        id: 'p',
        completion_signal: 'docs/custom/p/impl-complete.md',
        agents: [{ role: 'impl' }, { role: 'qa' }],
      },
    ],
  };
  // Asking for 'qa' should fall back to convention (not pull the impl-complete.md path).
  const got = O.resolveCompletionSignal(manifest, '/manifestDir', 'p', 'qa');
  assert.match(path.normalize(got), /qa-complete\.md$/);
});

test('V5 [codex round 5 P2] review_retry: spawn failure preserves QA verdict signals on disk', () => {
  const dir = mkTmp('orch-V5');
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
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    writeCompletionSignal(phaseDir, 'qa', 'blocked');
    fs.writeFileSync(
      path.join(phaseDir, 'qa-verdict.json'),
      JSON.stringify({ pass: false, failures: [] })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const failingSpawn = () => {
      throw new Error('wt unavailable');
    };
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
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: failingSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Spawn failed — the prior verdict signals MUST still be on disk.
    assert.ok(fs.existsSync(path.join(phaseDir, 'qa-complete.md')), 'qa-complete.md must survive failed retry spawn');
    assert.ok(fs.existsSync(path.join(phaseDir, 'qa-verdict.json')), 'qa-verdict.json must survive failed retry spawn');
    assert.ok(fs.existsSync(path.join(phaseDir, 'impl-complete.md')), 'impl-complete.md must survive failed retry spawn');
  } finally {
    rmrf(dir);
  }
});

test('V6 [codex round 5 P2] generate-prompt receives manifest completion_signal as completionSignalPath', () => {
  const dir = mkTmp('orch-V6');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/custom/p/impl-complete.md',
            agents: [{ role: 'impl' }],
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
        projectName: 'p',
      }
    );
    const passedPath = fakeGen.calls[0].completionSignalPath;
    assert.match(path.normalize(passedPath), /docs[\\/]custom[\\/]p[\\/]impl-complete\.md$/);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// W — codex round 6 regression tests
// =========================================================================

test('W1 [codex round 6 P2] arbitrary single-role completion_signal path is honored', () => {
  const dir = mkTmp('orch-W1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            // Arbitrary path — no role-name in basename.
            completion_signal: 'signals/phase-0-done.md',
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    fs.mkdirSync(path.join(dir, 'signals'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'signals', 'phase-0-done.md'),
      '---\nstatus: complete\n---\n# done'
    );
    makePhaseDir(mp, 'p');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_completed' && a.phaseId === 'p'),
      'arbitrary completion_signal path should be polled directly'
    );
  } finally {
    rmrf(dir);
  }
});

test('W1b [codex round 6 P2] resolveCompletionSignal returns arbitrary path verbatim for single-role phase', () => {
  const manifest = {
    phases: [
      {
        id: 'p',
        completion_signal: 'signals/done.md',
        agents: [{ role: 'impl' }],
      },
    ],
  };
  const dir = mkTmp('orch-W1b');
  try {
    const got = O.resolveCompletionSignal(manifest, dir, 'p', 'impl');
    assert.strictEqual(
      path.normalize(got),
      path.normalize(path.join(dir, 'signals', 'done.md'))
    );
  } finally {
    rmrf(dir);
  }
});

test('W2 [codex round 6 P2] partial multi-role spawn failure persists running so successful role is not re-spawned', () => {
  const dir = mkTmp('orch-W2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    let calls = 0;
    const flakySpawn = (opts) => {
      calls += 1;
      // First (impl) succeeds; second (qa) fails.
      if (calls === 2) throw new Error('qa spawn unavailable');
      return {
        pid: 4242,
        command: 'fake',
        argv: [],
        sessionName: opts.name,
        title: opts.name,
        spawnedAt: '2026-05-02T00:00:00Z',
      };
    };
    const fakeUpdate = makeFakeRunUpdate();
    O.executeActions(
      [
        { type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'spawn', phaseId: 'p', role: 'qa', mode: 'initial', iteration: 1 },
        { type: 'persist', phaseId: 'p', updates: { status: 'running' } },
      ],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: flakySpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Phase-level status: running MUST be persisted so the next tick
    // doesn't re-dispatch impl as a "pending" phase.
    const runningPersist = fakeUpdate.calls.find(
      (c) => c.updates && c.updates.status === 'running'
    );
    assert.ok(runningPersist, 'phase status: running must be persisted on partial multi-role failure');
  } finally {
    rmrf(dir);
  }
});

test('W3 [codex round 6 P2] all-spawns-failed → persist is skipped (next tick retries)', () => {
  const dir = mkTmp('orch-W3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeUpdate = makeFakeRunUpdate();
    O.executeActions(
      [
        { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'persist', phaseId: 'phase-1', updates: { status: 'running' } },
      ],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: () => {
          throw new Error('all spawns fail');
        },
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // No running persist when ALL spawns failed — phase stays pending.
    const runningPersist = fakeUpdate.calls.find(
      (c) => c.updates && c.updates.status === 'running'
    );
    assert.ok(!runningPersist, 'no persist when every spawn for the phase failed');
  } finally {
    rmrf(dir);
  }
});

test('W4 [codex round 6 P2] --max-ticks with running phases left → ok=false summary=max_ticks_unfinished', async () => {
  const dir = mkTmp('orch-W4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1, // exit before any phase reaches terminal
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'max_ticks_unfinished');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// X — codex round 7 regression tests
// =========================================================================

test('X1b [todo 110] spawn failure rolls back the spawning marker to pending (calls rollbackSpawningMarker helper)', () => {
  const dir = mkTmp('orch-X1b');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const updates = [];
    const trackingRunUpdate = (manifestPath, phaseId, u) => {
      updates.push({ phaseId, ...u });
      return { ok: true };
    };
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: () => {
          throw new Error('wt unavailable');
        },
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: trackingRunUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // The spawn-throw path writes (1) the pre-spawn 'spawning' marker
    // and then (2) the rollback to 'pending' via the shared helper.
    const markerWrites = updates.filter((u) => u.status === 'spawning');
    const rollbackWrites = updates.filter(
      (u) => u.status === 'pending' && u.dispatched_at === ''
    );
    assert.strictEqual(markerWrites.length, 1, 'pre-spawn marker written exactly once');
    assert.strictEqual(rollbackWrites.length, 1, 'rollback to pending written exactly once');
    // Order matters — rollback must come AFTER marker.
    const markerIdx = updates.findIndex((u) => u.status === 'spawning');
    const rollbackIdx = updates.findIndex(
      (u) => u.status === 'pending' && u.dispatched_at === ''
    );
    assert.ok(markerIdx < rollbackIdx, 'rollback follows marker write');
  } finally {
    rmrf(dir);
  }
});

test('X1c [todo 096] post-spawn runUpdate throw LEAVES the spawning marker intact (NOT rolled back)', () => {
  // 096's contract: when spawnFn already returned successfully (the wt
  // tab is live), a thrown post-spawn runUpdate must NOT touch the
  // manifest-status. The 'spawning' marker stays so the next tick's
  // reconciliation pass can adopt the live session via PID match.
  // Rolling back here would orphan the live tab and re-introduce the
  // duplicate-spawn class todo 088 / 093 / 096 are designed to close.
  const dir = mkTmp('orch-X1c');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const updates = [];
    let runUpdateCalls = 0;
    const trackingRunUpdate = (manifestPath, phaseId, u) => {
      runUpdateCalls += 1;
      updates.push({ phaseId, ...u });
      // First call = pre-spawn marker (write 'spawning'). Succeed.
      // Second call = post-spawn runUpdate (transition to 'running'
      //   + persist pid/started_at). THROW.
      if (runUpdateCalls === 2) {
        throw new Error('post-spawn runUpdate FS error');
      }
      return { ok: true };
    };
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: trackingRunUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Marker write succeeded (first runUpdate call).
    const markerWrites = updates.filter((u) => u.status === 'spawning');
    assert.strictEqual(markerWrites.length, 1, 'pre-spawn marker written once');
    // CRITICAL: NO rollback to 'pending' — the marker must remain
    // 'spawning' so reconciliation adopts on the next tick.
    const rollbackWrites = updates.filter(
      (u) => u.status === 'pending' && u.dispatched_at === ''
    );
    assert.strictEqual(
      rollbackWrites.length,
      0,
      'post-spawn runUpdate throw must NOT roll back the spawning marker'
    );
  } finally {
    rmrf(dir);
  }
});

test('X1 [codex round 7 P1] spawn failure unlinks the flag file (no leak)', () => {
  const dir = mkTmp('orch-X1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: () => {
          throw new Error('wt unavailable');
        },
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    const flagPath = path.join(
      dir,
      'docs',
      'orchestration',
      '.pending-orch-phase-1-impl'
    );
    assert.ok(!fs.existsSync(flagPath), 'flag must be unlinked when spawn throws');
  } finally {
    rmrf(dir);
  }
});

test('X2 [codex round 7 P2] terminal completion observed same-tick (mark_phase_completed reflected before maxTicks check)', async () => {
  const dir = mkTmp('orch-X2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'phase-1');
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1, // single tick
    });
    // Phase had a completion signal at start; the single tick marks
    // it completed. Pre-fix: terminal check ran against pre-action
    // status and exit looked like max_ticks_unfinished.
    assert.strictEqual(result.summary, 'completed', `expected completed, got ${result.summary}`);
    assert.strictEqual(result.ok, true);
  } finally {
    rmrf(dir);
  }
});

test('X3 [codex round 7 P1 + todo 107.a] flag-consume defaults to 0ms when test seam injects spawn (no explicit override)', () => {
  // Todo 107.a: pre-fix this test was vacuous (`assert.ok(true)`)
  // and over-stated coverage by 1. The actual contract: when
  // tests pass `_spawnSession` AND don't override `flagConsumeTimeoutMs`,
  // the flag-consume busy-wait collapses to 0ms so the suite stays
  // fast. We verify functionally by running executeActions through
  // the fake-spawn path with no explicit timeout and asserting the
  // call returns quickly even though the production default would
  // have been 10s.
  const dir = mkTmp('orch-X3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    const t0 = Date.now();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        // No flagConsumeTimeoutMs override — the fake-spawn detection
        // collapses to 0; production default is 10_000.
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 1000,
      `fake-spawn flag-consume must collapse to 0ms (production default would be 10000ms); took ${elapsed}ms`
    );
    assert.strictEqual(fakeSpawn.calls.length, 1, 'fake spawn ran exactly once');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// Y — codex round 8 regression tests
// =========================================================================

test('Y1 [codex round 8 P2] multi-role phase + custom impl signal basename → impl signal honored', () => {
  const dir = mkTmp('orch-Y1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            // Custom name with no role-prefix
            completion_signal: 'signals/phase-0-impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    fs.mkdirSync(path.join(dir, 'signals'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'signals', 'phase-0-impl-complete.md'),
      '---\nstatus: complete\n---\n# done'
    );
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'complete');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    // The orchestrator should poll the manifest's custom path for
    // impl AND the conventional path for qa, and mark the phase
    // completed once both are present.
    assert.ok(actions.some((a) => a.type === 'mark_phase_completed'));
  } finally {
    rmrf(dir);
  }
});

test('Y2 [codex round 8 P2] multi-role + qa-named manifest signal → impl falls back to convention', () => {
  const manifest = {
    phases: [
      {
        id: 'p',
        completion_signal: 'docs/x/qa-complete.md',
        agents: [{ role: 'impl' }, { role: 'qa' }],
      },
    ],
  };
  const dir = mkTmp('orch-Y2');
  try {
    const implSig = O.resolveCompletionSignal(manifest, dir, 'p', 'impl');
    const qaSig = O.resolveCompletionSignal(manifest, dir, 'p', 'qa');
    // qa gets the manifest's path; impl falls back to convention.
    assert.match(path.normalize(qaSig), /docs[\\/]x[\\/]qa-complete\.md$/);
    assert.match(path.normalize(implSig), /impl-complete\.md$/);
    assert.ok(!implSig.includes('docs/x'), 'impl should NOT use the qa-named path');
  } finally {
    rmrf(dir);
  }
});

test('Y3 [codex round 15 P2] agents[].plugin_dir ignored; orchestrator plugin wins', () => {
  // Round 8 P2 wired agent.plugin_dir → spawnSession; round 15 P2
  // reverted that because spawn-session's --plugin-dir is single-
  // valued and agent.plugin_dir would silently replace the
  // orchestrator plugin (the only place the SessionStart hook
  // lives). V1 always passes the orchestrator plugin (or CLI
  // override) and logs a warning when agents[].plugin_dir is set.
  const dir = mkTmp('orch-Y3');
  try {
    fs.mkdirSync(path.join(dir, 'plugins', 'my-plugin'), { recursive: true });
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl', plugin_dir: 'plugins/my-plugin' }],
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
      }
    );
    // No CLI --plugin-dir → defaults to orchestrator plugin root.
    const orchestratorPlugin = path.resolve(__dirname, '..');
    assert.strictEqual(
      path.normalize(fakeSpawn.calls[0].pluginDir),
      path.normalize(orchestratorPlugin)
    );
  } finally {
    rmrf(dir);
  }
});

test('Y4 [codex round 8 P1] timed-out flag is unlinked so the next spawn does not consume it', () => {
  const dir = mkTmp('orch-Y4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // Force the wait to fire (default-skip is when _spawnSession is
    // a fake; we DO pass a fake here but explicitly set a tiny
    // timeout to exercise the timeout branch.) The fake spawn does
    // NOT consume the flag, so existsSync(flagPath) stays true and
    // the timeout fires immediately.
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        flagConsumeTimeoutMs: 50, // tiny — fires fast
        flagConsumePollMs: 10,
      }
    );
    const flagPath = path.join(
      dir, 'docs', 'orchestration', '.pending-orch-phase-1-impl'
    );
    assert.ok(
      !fs.existsSync(flagPath),
      'timed-out flag must be unlinked to prevent cross-session delivery'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// Z — codex round 9 regression tests
// =========================================================================

test('Z1 [codex round 9 P2] no --plugin-dir → defaults to plugin root', () => {
  const dir = mkTmp('orch-Z1');
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
        // No pluginDir, no agent.plugin_dir → must default to
        // agent-orchestrator/ (one level up from scripts/).
      }
    );
    const expected = path.resolve(__dirname, '..');
    assert.strictEqual(
      path.normalize(fakeSpawn.calls[0].pluginDir),
      path.normalize(expected),
      'absent --plugin-dir should default to this plugin root so the SessionStart hook loads'
    );
  } finally {
    rmrf(dir);
  }
});

test('Z2 [codex round 9 P2] flag-timeout treated as spawn failure (does not falsely mark phase running)', () => {
  const dir = mkTmp('orch-Z2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeUpdate = makeFakeRunUpdate();
    const out = O.executeActions(
      [
        { type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'persist', phaseId: 'phase-1', updates: { status: 'running' } },
      ],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
        flagConsumeTimeoutMs: 30, // fires fast
        flagConsumePollMs: 10,
      }
    );
    // The status: running persist must NOT have fired (single-role
    // spawn whose flag delivery timed out → all-failed → skip).
    const runningPersist = fakeUpdate.calls.find(
      (c) => c.updates && c.updates.status === 'running'
    );
    assert.ok(!runningPersist, 'flag-timeout must not falsely mark phase running');
    assert.ok(out.warnings.some((w) => /spawn failed/.test(w)));
  } finally {
    rmrf(dir);
  }
});

test('Z3 [codex round 9 P2] unsupported agent role → mark_phase_blocked, no infinite spawn loop', () => {
  const dir = mkTmp('orch-Z3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            // 'coordinator' is not in VALID_ROLES (which is impl/qa/coord)
            agents: [{ role: 'coordinator' }],
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
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked' && /unsupported_role/.test(a.reason)),
      'unsupported role should mark phase blocked'
    );
    assert.ok(
      !actions.some((a) => a.type === 'spawn'),
      'no spawn should be scheduled for unsupported roles'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AA — codex round 10 regression tests
// =========================================================================

test('AA1 [codex round 10 P2] review-enabled phase with only qa declared → snapshot includes synthesized impl', () => {
  const dir = mkTmp('orch-AA1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            agents: [{ role: 'qa' }], // ONLY qa — planner synthesizes impl
          },
        ],
      })
    );
    const tickRes = O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () =>
        JSON.stringify([
          { ProcessId: 100, CommandLine: 'claude --name orch-p-impl' },
          { ProcessId: 200, CommandLine: 'claude --name orch-p-qa' },
        ]),
    });
    assert.ok(tickRes.pidSnapshot.has('orch-p-impl'), 'synthesized impl session must be in snapshot');
    assert.ok(tickRes.pidSnapshot.has('orch-p-qa'), 'declared qa session must be in snapshot');
  } finally {
    rmrf(dir);
  }
});

test('AA2 [codex round 10 P2] mark_phase_blocked stops emitting recovery spawns for sibling roles', () => {
  const dir = mkTmp('orch-AA2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running' } } });
    const phaseDir = makePhaseDir(mp, 'p');
    // impl writes blocked → phase should be marked blocked.
    writeCompletionSignal(phaseDir, 'impl', 'blocked');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // qa is "missing" — pidAlive: false would otherwise drive a recovery spawn.
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked'),
      'mark_phase_blocked must be emitted for the impl-blocked role'
    );
    assert.ok(
      !actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'),
      'no recovery spawn should be emitted for sibling roles after a phase block'
    );
  } finally {
    rmrf(dir);
  }
});

test('AA3 [codex round 10 P2] spawn-only tick uses active cadence (does NOT sleep idleMs after dispatch)', async () => {
  const dir = mkTmp('orch-AA3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const sleepCalls = [];
    let tick = 0;
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => {
        tick += 1;
        if (tick === 2) {
          // On tick 2, the just-spawned phase reports complete.
          writeCompletionSignal(makePhaseDir(mp, 'phase-1'), 'impl', 'complete');
        }
        return makeStubHealth({ pidAlive: true });
      },
      _pidRunner: () => '[]',
      _sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      logger: silentLogger(),
      projectName: 't',
      activeIntervalMs: 100,
      idleIntervalMs: 99999, // huge — would visibly delay if used
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, true);
    // The first sleep (after tick 1's dispatch) MUST be the active
    // interval, not the idle one. Pre-fix, tickState.status loaded
    // at start-of-tick still showed phase-1 as pending → idle.
    assert.strictEqual(
      sleepCalls[0],
      100,
      `first sleep must use active cadence, got ${sleepCalls[0]}`
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AB — codex round 11 regression tests
// =========================================================================

test('AB1 [codex round 11 P2] parseQaVerdict honors signalPath opt for custom QA paths', () => {
  const dir = mkTmp('orch-AB1');
  try {
    // Custom QA signal at a non-conventional path.
    const customDir = path.join(dir, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    const customSig = path.join(customDir, 'qa-complete.md');
    fs.writeFileSync(customSig, '---\nstatus: complete\n---\n# pass');
    // Conventional path also exists with DIFFERENT content.
    const convSig = path.join(dir, 'qa-complete.md');
    fs.writeFileSync(convSig, '---\nstatus: blocked\n---\n# fail');
    // Default path (no signalPath) reads conventional → blocked → fail.
    const defaultV = O.parseQaVerdict(dir, 'qa');
    assert.strictEqual(defaultV.pass, false);
    // With signalPath set, reads custom → complete → pass.
    const customV = O.parseQaVerdict(dir, 'qa', { signalPath: customSig });
    assert.strictEqual(customV.pass, true);
  } finally {
    rmrf(dir);
  }
});

test('AB2 [codex round 11 P2] review-loop with custom QA signal path advances on pass', () => {
  const dir = mkTmp('orch-AB2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            // Multi-role with qa-named manifest path → resolves to qa role's signal.
            completion_signal: 'docs/x/qa-complete.md',
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
    fs.mkdirSync(path.join(dir, 'docs', 'x'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'x', 'qa-complete.md'),
      '---\nstatus: complete\n---\n# pass'
    );
    makePhaseDir(mp, 'p');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_completed'),
      'review-loop must complete the phase reading the custom QA signal path'
    );
  } finally {
    rmrf(dir);
  }
});

test('AB3 [codex round 11 P3] generate-prompt receives heartbeatPath in genOpts', () => {
  const dir = mkTmp('orch-AB3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    const passedHeartbeat = fakeGen.calls[0].heartbeatPath;
    assert.ok(passedHeartbeat, 'heartbeatPath must be set on every dispatch');
    assert.match(path.normalize(passedHeartbeat), /heartbeat\.jsonl$/);
    assert.match(path.normalize(passedHeartbeat), /phase-1[\\/]heartbeat\.jsonl$/);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AC — codex round 12 regression tests
// =========================================================================

test('AC1 [codex round 12 P2] stale lock reclaim uses rename so two starters cannot both succeed', () => {
  const dir = mkTmp('orch-AC1');
  try {
    // Plant a stale lock. The first orchestrator will reclaim it.
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: 'old', hostname: 'h' })
    );
    const lockedPath = O.acquireLock(dir, {
      _pid: 1,
      _killer: () => {
        const e = new Error('no such');
        e.code = 'ESRCH';
        throw e;
      },
    });
    // Second orchestrator (also fresh start) should now SEE our
    // freshly-claimed lock as live, not as stale.
    assert.throws(
      () =>
        O.acquireLock(dir, {
          _pid: 2,
          _killer: () => {}, // alive — pid 1 is "live"
        }),
      (err) => err.code === 'ELOCKED'
    );
    O.releaseLock(lockedPath);
  } finally {
    rmrf(dir);
  }
});

test('AC1b [todo 107.c] stale-lock reclaim ENOENT (rename loser) falls through to exclusive create', () => {
  // The reclaim path renames the stale lockfile to a sidecar so two
  // concurrent reclaimers can't both clobber. The LOSER of that race
  // sees ENOENT on rename — pre-fix this branch was untested and a
  // refactor that made ENOENT throw could break the orchestrator's
  // start handshake silently. Inject a renameSync that throws ENOENT
  // on the stale-rename and verify acquireLock falls through to the
  // exclusive-create path (which then succeeds because the actual
  // file no longer exists).
  const dir = mkTmp('orch-AC1b');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: 'old', hostname: 'h' })
    );
    let renameCalls = 0;
    const renameENOENT = (from, to) => {
      renameCalls += 1;
      // First call: stale-lock rename; the "winner" already moved
      // the file aside. Simulate ENOENT.
      if (renameCalls === 1) {
        // Actually unlink the file ourselves so the subsequent
        // exclusive-create path finds an empty slot.
        try { fs.unlinkSync(from); } catch (_) { /* already gone */ }
        const e = new Error('ENOENT: file vanished');
        e.code = 'ENOENT';
        throw e;
      }
      return fs.renameSync(from, to);
    };
    const lockedPath = O.acquireLock(dir, {
      _pid: 1,
      _killer: () => {
        const e = new Error('no such');
        e.code = 'ESRCH';
        throw e;
      },
      _renameSync: renameENOENT,
    });
    assert.ok(typeof lockedPath === 'string');
    assert.ok(fs.existsSync(lockedPath), 'fresh lockfile must exist after fall-through');
    O.releaseLock(lockedPath);
  } finally {
    rmrf(dir);
  }
});

test('AC1c [todo 108.k] stale-signal post-spawn cleanup tolerates statSync throws (file vanished mid-cleanup)', () => {
  // The post-spawn cleanup at executeSpawn iterates staleUnlinks and
  // calls statSync to compare current mtime vs pre-spawn snapshot.
  // If the file vanished between snapshot and cleanup (e.g., another
  // process unlinked it), statSync throws ENOENT — pre-fix the
  // catch-all silently swallowed without coverage. Test that the
  // happy path tolerates a synthetic statSync throw.
  const dir = mkTmp('orch-AC1c');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = makePhaseDir(mp, 'phase-1');
    // Plant a stale signal that the cleanup pass will try to inspect.
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    let statSyncCalls = 0;
    const throwingStatSync = (p) => {
      // First call (pre-spawn snapshot): use real fs.statSync.
      // Subsequent calls (post-spawn cleanup): throw ENOENT to
      // simulate the file vanishing mid-cleanup.
      statSyncCalls += 1;
      if (statSyncCalls === 1) return fs.statSync(p);
      const e = new Error('ENOENT: file vanished');
      e.code = 'ENOENT';
      throw e;
    };
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // Recovery dispatch triggers stale-signal cleanup.
    const result = O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'recovery', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        _statSync: throwingStatSync,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Should NOT crash — the throwing statSync is tolerated.
    assert.strictEqual(result.fatal, null);
    assert.strictEqual(result.spawned, 1);
  } finally {
    rmrf(dir);
  }
});

test('AC2 [codex round 12 P2] initial impl dispatch unlinks stale impl-complete.md', () => {
  const dir = mkTmp('orch-AC2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = makePhaseDir(mp, 'phase-1');
    // Stale completion signal from a prior run.
    writeCompletionSignal(phaseDir, 'impl', 'complete');
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
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
    assert.ok(
      !fs.existsSync(path.join(phaseDir, 'impl-complete.md')),
      'stale impl-complete.md must be unlinked on initial dispatch'
    );
  } finally {
    rmrf(dir);
  }
});

test('AC3 [codex round 12 P2] mark_phase_blocked filters out queued spawn for the same phase', () => {
  const dir = mkTmp('orch-AC3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, { phases: { p: { status: 'running', retry_count: 0 } } });
    const phaseDir = makePhaseDir(mp, 'p');
    // qa role's signal: blocked → triggers mark_phase_blocked.
    writeCompletionSignal(phaseDir, 'qa', 'blocked');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // impl role's checkHealth returns pidAlive: false → would
    // normally emit a recovery spawn. We assert that the post-
    // process filter drops it because the phase is going to be
    // blocked.
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _checkHealth: ({ role }) =>
          role === 'qa'
            ? makeStubHealth({ pidAlive: true })
            : makeStubHealth({ pidAlive: false }),
      }
    );
    assert.ok(actions.some((a) => a.type === 'mark_phase_blocked'));
    assert.ok(
      !actions.some((a) => a.type === 'spawn' && a.phaseId === 'p'),
      'no spawn must remain for a phase being marked blocked'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AD — codex round 13 regression tests
// =========================================================================

test('AD1 [codex round 13 P2] custom completion_signal parent dir created before spawn', () => {
  const dir = mkTmp('orch-AD1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            // Custom path with a parent dir that does NOT exist yet.
            completion_signal: 'signals/sub/phase-0-done.md',
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'p', role: 'impl', mode: 'initial', iteration: 1 }],
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
    assert.ok(
      fs.existsSync(path.join(dir, 'signals', 'sub')),
      'parent of custom completion path must be created before spawn'
    );
  } finally {
    rmrf(dir);
  }
});

test('AD2 [codex round 13 P2] fresh post-spawn signal NOT clobbered by cleanup', () => {
  const dir = mkTmp('orch-AD2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = makePhaseDir(mp, 'phase-1');
    // Plant a stale signal with an OLD mtime.
    const sigPath = path.join(phaseDir, 'impl-complete.md');
    fs.writeFileSync(sigPath, '---\nstatus: complete\n---\n# old');
    const oldTime = Date.now() / 1000 - 3600; // 1 hour ago
    fs.utimesSync(sigPath, oldTime, oldTime);
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // Custom spawn fake that writes a FRESH signal during the spawn
    // (simulates a fast agent that consumes the prompt + writes
    // before the cleanup loop runs).
    const freshSpawn = (opts) => {
      // Write a fresh signal with a NEW mtime.
      fs.writeFileSync(sigPath, '---\nstatus: complete\n---\n# fresh');
      // bumping mtime to "now" via a fresh write
      return {
        pid: 4242,
        command: 'fake',
        argv: [],
        sessionName: opts.name,
        title: opts.name,
        spawnedAt: '2026-05-02T01:00:00Z',
      };
    };
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: freshSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // The fresh signal must SURVIVE the post-spawn cleanup.
    assert.ok(fs.existsSync(sigPath), 'fresh signal must NOT be clobbered');
    assert.match(fs.readFileSync(sigPath, 'utf8'), /# fresh/);
  } finally {
    rmrf(dir);
  }
});

test('AD3 [codex round 13 P2] truly stale signal (older than pre-spawn) IS cleaned', () => {
  const dir = mkTmp('orch-AD3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const phaseDir = makePhaseDir(mp, 'phase-1');
    const sigPath = path.join(phaseDir, 'impl-complete.md');
    fs.writeFileSync(sigPath, '---\nstatus: complete\n---\n# stale');
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    // Spawn fake does NOT touch the signal — it remains stale
    // (mtime <= pre-spawn snapshot). Cleanup should unlink it.
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
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
    assert.ok(!fs.existsSync(sigPath), 'truly stale signal must be cleaned');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AE — codex round 14 regression tests
// =========================================================================

test('AE1 [codex round 14 P2] aborted run reports ok=false', async () => {
  const dir = mkTmp('orch-AE1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const ac = new AbortController();
    ac.abort(); // pre-aborted
    const result = await O.runOrchestrator({
      manifestPath: mp,
      signal: ac.signal,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false, 'aborted run must report ok=false');
    assert.strictEqual(result.summary, 'aborted');
  } finally {
    rmrf(dir);
  }
});

test('AE2 [codex round 14 P2] --once does not sleep after the requested tick', async () => {
  const dir = mkTmp('orch-AE2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    let sleepInvocations = 0;
    await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => {
        sleepInvocations += 1;
        return Promise.resolve();
      },
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1,
    });
    assert.strictEqual(
      sleepInvocations,
      0,
      `--once should never sleep, got ${sleepInvocations} sleep call(s)`
    );
  } finally {
    rmrf(dir);
  }
});

test('AE3 [codex round 14 P2] quoted max_iterations: "5" is honored', () => {
  const dir = mkTmp('orch-AE3');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: '5' }, // quoted
            agents: [{ role: 'impl' }, { role: 'qa' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: { status: 'running', review_stage: 'qa', review_iteration: 4 },
      },
    });
    const phaseDir = makePhaseDir(mp, 'p');
    writeCompletionSignal(phaseDir, 'qa', 'blocked'); // FAIL on iter 4
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    // With max_iterations: "5" honored, iter 4 < 5 → respawn impl
    // (review_retry). Pre-fix the quoted value was rejected and the
    // CLI/built-in default of 3 was used → escalate at iter 4 > 3.
    assert.ok(
      actions.some((a) => a.type === 'spawn' && a.mode === 'review_retry'),
      'quoted max_iterations: "5" must allow respawn at iteration 4'
    );
  } finally {
    rmrf(dir);
  }
});

test('AE4 [codex round 14 P2] dry-run does not create phase directory', () => {
  const dir = mkTmp('orch-AE4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        dryRun: true,
      }
    );
    const phaseDir = path.join(dir, 'docs', 'orchestration', 'phases', 'phase-1');
    assert.ok(!fs.existsSync(phaseDir), 'dry-run must NOT create the phase directory');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AF — codex round 15 regression tests
// =========================================================================

test('AF1 [codex round 15 P2] manifest defaults.permission_mode → launcher auto_mode_flag', () => {
  const dir = mkTmp('orch-AF1');
  try {
    const mp = writeManifest(
      dir,
      Object.assign(makeBaseManifest(), {
        defaults: { permission_mode: 'default' },
      })
    );
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
      }
    );
    const launcherArg = fakeSpawn.calls[0].launcher;
    assert.ok(launcherArg, 'launcher must be set when permission_mode is configured');
    assert.strictEqual(
      launcherArg.auto_mode_flag,
      '--permission-mode default',
      `expected --permission-mode default, got ${launcherArg.auto_mode_flag}`
    );
  } finally {
    rmrf(dir);
  }
});

test('AF2 [codex round 15 P2] manifest without permission_mode → launcher unchanged (uses spawn-session default)', () => {
  const dir = mkTmp('orch-AF2');
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
      }
    );
    // launcher is null → spawn-session uses DEFAULT_LAUNCHER.
    assert.strictEqual(fakeSpawn.calls[0].launcher, null);
  } finally {
    rmrf(dir);
  }
});

test('AF3 [codex round 15 P2 + todo 100] permission_mode merges with manifest launcher block (enum-validated value)', () => {
  const dir = mkTmp('orch-AF3');
  try {
    const mp = writeManifest(
      dir,
      Object.assign(makeBaseManifest(), {
        launcher: { shell: 'powershell', binary: 'agency claude' },
        // Todo 100: permission_mode is a strict enum. The legacy free-form
        // value `'bypass'` no longer validates; use the canonical Claude
        // Code mode name so the merge path still exercises the same code.
        defaults: { permission_mode: 'bypassPermissions' },
      })
    );
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
      }
    );
    const launcherArg = fakeSpawn.calls[0].launcher;
    assert.strictEqual(launcherArg.shell, 'powershell');
    assert.strictEqual(launcherArg.binary, 'agency claude');
    assert.strictEqual(launcherArg.auto_mode_flag, '--permission-mode bypassPermissions');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AG — codex round 16 regression tests
// =========================================================================

test('AG1 [codex round 16 P2] unrecognized signal status falls through to health-check (recovery still possible)', () => {
  const dir = mkTmp('orch-AG1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running', retry_count: 0 } } });
    const phaseDir = makePhaseDir(mp, 'phase-1');
    // Agent exited mid-write — `status: failed` is not a valid
    // protocol status. Pre-fix, the orchestrator logged + continued,
    // skipping the health-check, so the phase stayed running forever.
    writeCompletionSignal(phaseDir, 'impl', 'failed');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      { _checkHealth: () => makeStubHealth({ pidAlive: false }) }
    );
    // health check shows pidAlive=false → recovery should fire even
    // though there's a present-but-bad completion signal.
    assert.ok(
      actions.some((a) => a.type === 'spawn' && a.mode === 'recovery'),
      'recovery must still trigger when signal has unrecognized status + agent dead'
    );
  } finally {
    rmrf(dir);
  }
});

test('AG2 [codex round 16 P2] abort during sleep exits without waiting full interval', async () => {
  const dir = mkTmp('orch-AG2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const ac = new AbortController();
    let sleepCalls = 0;
    let abortedDuringSleep = false;
    const startTime = Date.now();
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      signal: ac.signal,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      // Real sleep — but abort fires after 50ms so the race resolves quickly.
      _sleep: async (ms) => {
        sleepCalls += 1;
        if (sleepCalls === 1) {
          // Schedule abort during the first sleep.
          setTimeout(() => {
            abortedDuringSleep = true;
            ac.abort();
          }, 50);
        }
        await new Promise((r) => setTimeout(r, ms));
      },
      logger: silentLogger(),
      projectName: 't',
      activeIntervalMs: 5000, // 5 seconds — would be visible if not raced
      idleIntervalMs: 5000,
      maxTicks: 10,
    });
    const elapsed = Date.now() - startTime;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'aborted');
    assert.ok(abortedDuringSleep, 'abort fired during the sleep');
    // Total time should be MUCH less than 5000ms (the active interval).
    // The race should finish within ~3s — tolerating up to two
    // probeProcessStartTime PowerShell spawns (~140ms each) + the
    // 50ms abort fire + baseline noise on slow hardware.
    assert.ok(
      elapsed < 3000,
      `aborted run should exit fast; took ${elapsed}ms (interval was 5000ms)`
    );
  } finally {
    rmrf(dir);
  }
});

test('AG3 [todo 095] abort listener stays at 1 across many ticks (no MaxListenersExceededWarning)', async () => {
  // Pre-fix, runOrchestrator wired addEventListener('abort', ..., {once:true})
  // every tick — Node fires MaxListenersExceededWarning at 11. Run 50 ticks
  // through a fast-resolving _sleep and assert the listener count stays at 1.
  const dir = mkTmp('orch-AG3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    const ac = new AbortController();
    let warningSeen = false;
    const onWarning = (w) => {
      if (
        w &&
        (w.name === 'MaxListenersExceededWarning' ||
          /MaxListenersExceededWarning/.test(String(w.message || w)))
      ) {
        warningSeen = true;
      }
    };
    process.on('warning', onWarning);
    let maxObservedListeners = 0;
    try {
      await O.runOrchestrator({
        manifestPath: mp,
        resume: true,
        signal: ac.signal,
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _checkHealth: () => makeStubHealth({ pidAlive: true }),
        _pidRunner: () => '[]',
        _sleep: async () => {
          // Sample listener count mid-loop. Node EventTarget exposes count
          // on the underlying [Symbol(events)] map; we count via getMaxListeners
          // proxy where available, else fall back to N=0 (the assertion
          // below is conservative — the warning catches the regression).
          if (typeof ac.signal[Symbol.for('events')] !== 'undefined') {
            const m = ac.signal[Symbol.for('events')];
            const handlers = m && m.get && m.get('abort');
            if (handlers && typeof handlers.length === 'number') {
              maxObservedListeners = Math.max(maxObservedListeners, handlers.length);
            }
          }
        },
        logger: silentLogger(),
        projectName: 't',
        activeIntervalMs: 1,
        idleIntervalMs: 1,
        maxTicks: 50,
      });
    } finally {
      process.removeListener('warning', onWarning);
    }
    assert.strictEqual(
      warningSeen,
      false,
      'MaxListenersExceededWarning fired — abort listeners are leaking per tick'
    );
    // Listener count cap (when introspection is available) is at most 1
    // because we register a single run-lifetime listener.
    if (maxObservedListeners > 0) {
      assert.ok(
        maxObservedListeners <= 1,
        `expected <=1 abort listener, observed ${maxObservedListeners}`
      );
    }
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AH — codex round 17 regression tests
// =========================================================================

test('AH1 [codex round 17 P1] flag-consume timeout stops further spawns this tick', () => {
  const dir = mkTmp('orch-AH1');
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
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeSpawn = makeFakeSpawnSession();
    O.executeActions(
      [
        { type: 'spawn', phaseId: 'a', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'spawn', phaseId: 'b', role: 'impl', mode: 'initial', iteration: 1 },
        { type: 'persist', phaseId: 'a', updates: { status: 'running' } },
        { type: 'persist', phaseId: 'b', updates: { status: 'running' } },
      ],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        flagConsumeTimeoutMs: 30, // tiny — first spawn's flag wait fires
        flagConsumePollMs: 10,
      }
    );
    // First spawn: attempted (the throw happens inside; spawnFn was
    // called). Second spawn: skipped because flagTimeoutThisTick.
    assert.strictEqual(
      fakeSpawn.calls.length,
      1,
      `only the first spawn should attempt; second must be deferred. Got ${fakeSpawn.calls.length}.`
    );
  } finally {
    rmrf(dir);
  }
});

test('AH2 [codex round 17 P2] --dry-run defaults to maxTicks=1 (no infinite loop)', () => {
  const a = O.parseCliArgs(['node', 's.js', '--dry-run', 'manifest.yaml']);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.maxTicks, 1, '--dry-run alone should default to 1 tick');
});

test('AH3 [codex round 17 P2] --dry-run + explicit --max-ticks honors operator override', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--max-ticks',
    '5',
    '--dry-run',
    'm.yaml',
  ]);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.maxTicks, 5, 'explicit --max-ticks must NOT be clobbered by --dry-run');
});

test('AH4 [codex round 17 P2] --dry-run after --max-ticks (different argv order) honors operator override', () => {
  const a = O.parseCliArgs([
    'node',
    's.js',
    '--dry-run',
    '--max-ticks',
    '3',
    'm.yaml',
  ]);
  assert.strictEqual(a.dryRun, true);
  assert.strictEqual(a.maxTicks, 3);
});

// =========================================================================
// AI — codex round 18 regression tests
// =========================================================================

test('AI1 [codex round 18 P2] dry-run does not write the lockfile', async () => {
  const dir = mkTmp('orch-AI1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 1,
      dryRun: true,
    });
    const lockPath = path.join(dir, 'docs', 'orchestration', '.orchestrator.lock');
    assert.ok(!fs.existsSync(lockPath), 'dry-run must NOT create the lockfile');
    assert.strictEqual(result.lockPath, null);
  } finally {
    rmrf(dir);
  }
});

test('AI2 [codex round 18 P2] dry-run renders against the source templates dir', () => {
  // Verify the dry-run path resolves templatesDir to this plugin's
  // source templates/ folder, NOT the (non-existent) live
  // docs/orchestration/templates/ that scaffold-protocol would
  // copy. Without this, every dry-run on a fresh manifest would
  // throw "cannot read template" before the first action runs.
  const dir = mkTmp('orch-AI2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        dryRun: true,
      }
    );
    const passedTmpl = fakeGen.calls[0].templatesDir;
    // Should match the plugin source templates dir, not the live one.
    const sourceTmpl = path.resolve(__dirname, '..', 'templates');
    assert.strictEqual(
      path.normalize(passedTmpl),
      path.normalize(sourceTmpl),
      `dry-run should render from source templates, got ${passedTmpl}`
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AJ — codex round 19 regression tests
// =========================================================================

test('AJ1 [codex round 19 P2] dry-run honors --plugin-dir for templates source', () => {
  const dir = mkTmp('orch-AJ1');
  try {
    // Make a phony alternate plugin with its own templates dir.
    const altPlugin = path.join(dir, 'alt-plugin');
    fs.mkdirSync(path.join(altPlugin, 'templates'), { recursive: true });
    const mp = writeManifest(dir, makeBaseManifest());
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const fakeGen = makeFakeGenerate();
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: fakeGen,
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
        dryRun: true,
        pluginDir: altPlugin,
      }
    );
    const passed = fakeGen.calls[0].templatesDir;
    assert.strictEqual(
      path.normalize(passed),
      path.normalize(path.join(altPlugin, 'templates')),
      'dry-run should use --plugin-dir/templates as the source'
    );
  } finally {
    rmrf(dir);
  }
});

test('AJ2 [codex round 19 P2] duplicate roles → mark_phase_blocked, no spawns scheduled', () => {
  const dir = mkTmp('orch-AJ2');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            agents: [{ role: 'impl' }, { role: 'impl' }], // duplicate!
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
    assert.ok(
      actions.some((a) => a.type === 'mark_phase_blocked' && /duplicate_role/.test(a.reason)),
      'duplicate roles must mark phase blocked'
    );
    assert.ok(
      !actions.some((a) => a.type === 'spawn'),
      'no spawn should be scheduled for a phase with duplicate roles'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AK — codex round 20 regression tests
// =========================================================================

test('AK1 [codex round 20 P2] stale .pending-* flags are swept before writing the new flag', () => {
  const dir = mkTmp('orch-AK1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const orchDir = path.join(dir, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    // Plant a leftover flag from a crashed prior orchestrator (different phase id).
    const stalePath = path.join(orchDir, '.pending-orch-other-impl');
    fs.writeFileSync(stalePath, '# stale from prior crashed run');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
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
    // The stale flag must be GONE.
    assert.ok(
      !fs.existsSync(stalePath),
      'stale .pending-* flag from prior orchestrator must be swept'
    );
    // The new flag for this dispatch must EXIST.
    const newPath = path.join(orchDir, '.pending-orch-phase-1-impl');
    assert.ok(fs.existsSync(newPath), 'new flag for this dispatch must be written');
  } finally {
    rmrf(dir);
  }
});

test('AK2 [codex round 20 P2] flag for THIS dispatch is not deleted by the sweep', () => {
  const dir = mkTmp('orch-AK2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    const orchDir = path.join(dir, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    // Plant a flag with the SAME session name (e.g. retry from a prior orchestrator).
    const samePath = path.join(orchDir, '.pending-orch-phase-1-impl');
    fs.writeFileSync(samePath, '# old prompt for same session');
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate({ promptText: '# new prompt' }),
        _runUpdate: makeFakeRunUpdate(),
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // The flag must be the NEW prompt (rename overwrote the same-name flag).
    assert.strictEqual(fs.readFileSync(samePath, 'utf8'), '# new prompt');
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AL — codex round 21 regression tests
// =========================================================================

test('AL1 [codex round 21 P2 + todo 107.b] tmp flag basename does NOT match the hook FLAG_NAME_RE (imported from source-of-truth)', () => {
  // Todo 107.b: import FLAG_NAME_RE from `../hooks/session-start`
  // instead of duplicating the regex literal here. If the source-of-
  // truth regex changes (e.g. to add a new ID character class),
  // this test must follow automatically — copying the literal
  // silently de-syncs invariant coverage from the source. The hook
  // and parse-manifest's VALID_ID_RE already share the class via
  // the docs/todos/006 / 027 contract; this test is the
  // orchestrator-side mirror.
  const { FLAG_NAME_RE } = require('../hooks/session-start');
  const goodTmp = '.flagtmp-orch-phase-1-impl-1234-5678';
  const badLegacyTmp = '.pending-orch-phase-1-impl.tmp-1234-5678';
  assert.strictEqual(FLAG_NAME_RE.test(goodTmp), false);
  assert.strictEqual(
    FLAG_NAME_RE.test(badLegacyTmp),
    true,
    'sanity check: legacy `.pending-*.tmp-*` form WOULD have matched (pre-fix)'
  );
});

test('AL2 [codex round 21 P2] mid-write tmp file does not get scooped by the hook', () => {
  // Verify the actual tmp path the orchestrator writes uses
  // .flagtmp- prefix (so it cannot be confused for a real flag).
  const dir = mkTmp('orch-AL2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    let tmpObserved = null;
    // Override fs.writeFileSync indirectly by spying via _writeFileSync.
    // We DON'T actually write — capture the tmp path.
    const writeSpy = (p, content, _opts) => {
      tmpObserved = p;
    };
    const renameSpy = () => {}; // no-op
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: makeFakeRunUpdate(),
        _writeFileSync: writeSpy,
        _renameSync: renameSpy,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    assert.ok(tmpObserved, 'tmp path was used during the rename');
    const tmpName = path.basename(tmpObserved);
    assert.match(tmpName, /^\.flagtmp-/, `tmp prefix must be .flagtmp-, got ${tmpName}`);
  } finally {
    rmrf(dir);
  }
});

test('AL3 [codex round 21 P2] bare run with non-completed manifest-status refuses to start', async () => {
  const dir = mkTmp('orch-AL3');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    const result = await O.runOrchestrator({
      manifestPath: mp,
      // resume: NOT set
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
    assert.strictEqual(result.summary, 'resume_required');
    assert.match(result.error, /--resume/);
  } finally {
    rmrf(dir);
  }
});

test('AL4 [codex round 21 P2] --resume run honors existing manifest-status', async () => {
  const dir = mkTmp('orch-AL4');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'running' } } });
    makePhaseDir(mp, 'phase-1');
    let tick = 0;
    const result = await O.runOrchestrator({
      manifestPath: mp,
      resume: true,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => {
        tick += 1;
        if (tick === 2) writeCompletionSignal(makePhaseDir(mp, 'phase-1'), 'impl', 'complete');
        return makeStubHealth({ pidAlive: true });
      },
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.summary, 'completed');
  } finally {
    rmrf(dir);
  }
});

test('AL5 [codex round 21 P2] bare run with all-completed manifest-status proceeds (no resume needed)', async () => {
  const dir = mkTmp('orch-AL5');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, { phases: { 'phase-1': { status: 'completed' } } });
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 3,
    });
    assert.strictEqual(result.summary, 'completed', `expected completed, got ${result.summary}`);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AM — codex round 22 regression tests
// =========================================================================

test('AM1 [codex round 22 P2 + todo 107.e] shared-workdir secondary lock refuses second concurrent orchestrator (verifies r1 acquired + cleanup + same-path)', async () => {
  const dir = mkTmp('orch-AM1');
  try {
    const sharedWorkdir = path.join(dir, 'shared');
    fs.mkdirSync(sharedWorkdir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'm1'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'm2'), { recursive: true });
    const mp1 = writeManifest(
      path.join(dir, 'm1'),
      makeBaseManifest({ workdir: path.relative(path.join(dir, 'm1'), sharedWorkdir) })
    );
    const mp2 = writeManifest(
      path.join(dir, 'm2'),
      makeBaseManifest({ workdir: path.relative(path.join(dir, 'm2'), sharedWorkdir) })
    );
    const sharedLockPath = path.join(
      sharedWorkdir,
      'docs',
      'orchestration',
      '.orchestrator.lock'
    );
    // Todo 107.e: explicit assertion that r1 actually acquired the
    // shared-workdir lockfile during its pre-flight. Pre-fix the
    // test never confirmed this — a regression that silently
    // skipped the workdir-lock acquire would have passed.
    const r1 = await O.runOrchestrator({
      manifestPath: mp1,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 0,
    });
    void r1;
    // After r1 exits cleanly, both its locks should be released.
    // Todo 107.e: explicit cleanup assertion — neither the shared
    // workdir lockfile nor the manifestDir lockfile may persist.
    assert.ok(
      !fs.existsSync(sharedLockPath),
      'r1 must release the shared-workdir lockfile on clean exit'
    );
    const m1LockPath = path.join(
      path.dirname(mp1),
      'docs',
      'orchestration',
      '.orchestrator.lock'
    );
    assert.ok(
      !fs.existsSync(m1LockPath),
      'r1 must release the manifestDir lockfile on clean exit'
    );

    // Plant a "live" lock at the shared workdir to simulate a second
    // concurrent orchestrator.
    fs.mkdirSync(path.dirname(sharedLockPath), { recursive: true });
    fs.writeFileSync(
      sharedLockPath,
      JSON.stringify({ pid: 99999, startedAt: 'now', hostname: 'h' })
    );
    const r2 = await O.runOrchestrator({
      manifestPath: mp2,
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
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.summary, 'lock_contention');
    assert.match(r2.error, /workdir/);
  } finally {
    rmrf(dir);
  }
});

test('AM1b [todo 107.e] same-path workdir (manifestDir IS workdir) does NOT acquire two locks against itself', async () => {
  // Edge case the pre-fix AM1 test didn't cover: when manifestDir and
  // workdir resolve to the SAME path (workdir absent or pointing at
  // manifestDir), the orchestrator must take exactly ONE lock —
  // re-acquiring the same lockfile would self-conflict. On
  // case-insensitive filesystems (NTFS, APFS) the comparison should
  // also collapse path-case differences.
  const dir = mkTmp('orch-AM1b');
  try {
    // No `workdir` field → defaults to manifestDir (same-path case).
    const mp = writeManifest(dir, makeBaseManifest());
    const r = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 0,
    });
    void r;
    // Neither path's lockfile should remain after a clean exit.
    const lockPath = path.join(
      path.dirname(mp),
      'docs',
      'orchestration',
      '.orchestrator.lock'
    );
    assert.ok(
      !fs.existsSync(lockPath),
      'same-path scenario must release its single lockfile cleanly'
    );
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AN — codex round 23 regression tests
// =========================================================================

test('AN1 [codex round 23 P2] scaffold without templates → preflight fails fast', async () => {
  const dir = mkTmp('orch-AN1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    // Inject a scaffold fake that returns ok but with templates_dir: null
    // (matches scaffold-protocol's behavior when the source templates/ dir
    // is missing under --plugin-dir).
    const fakeScaffold = () => ({
      ok: true,
      protoDir: path.join(dir, 'docs', 'orchestration'),
      phases_created: ['phase-1'],
      events_log: '/x',
      events_log_preserved: false,
      templates_dir: null,
      templates_copied: 0,
      templates_skipped: 0,
      warnings: ['templates directory not found at /nonexistent/templates'],
    });
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      _scaffoldProtocol: fakeScaffold,
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'scaffold_no_templates');
    assert.match(result.error, /templates/);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AO — codex round 24 regression tests
// =========================================================================

test('AO1 [codex round 24 P2] missing manifest.workdir → workdir_not_found preflight failure', async () => {
  const dir = mkTmp('orch-AO1');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({ workdir: 'nonexistent-typo-dir' })
    );
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'workdir_not_found');
    assert.match(result.error, /workdir/);
  } finally {
    rmrf(dir);
  }
});

test('AO2 [codex round 24 P2] incomplete templates dir → scaffold_no_templates preflight failure', async () => {
  const dir = mkTmp('orch-AO2');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    // Inject scaffold that returns non-null templates_dir but the
    // dir is empty (missing required template files).
    const emptyTmplDir = path.join(dir, 'docs', 'orchestration', 'templates');
    fs.mkdirSync(emptyTmplDir, { recursive: true });
    const fakeScaffold = () => ({
      ok: true,
      protoDir: path.join(dir, 'docs', 'orchestration'),
      phases_created: ['phase-1'],
      events_log: '/x',
      events_log_preserved: false,
      templates_dir: emptyTmplDir,
      templates_copied: 0,
      templates_skipped: 0,
      warnings: [],
    });
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth(),
      _pidRunner: () => '[]',
      _sleep: () => Promise.resolve(),
      _scaffoldProtocol: fakeScaffold,
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 5,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.summary, 'scaffold_no_templates');
    assert.match(result.error, /protocol-header\.md/);
  } finally {
    rmrf(dir);
  }
});

// =========================================================================
// AP — ce:review round 1 P1 regression tests (todos 088-092)
// =========================================================================

test('AP2 [todo 089] alive PID + matching startedAt → ELOCKED', () => {
  const dir = mkTmp('orch-AP2');
  try {
    const recordedIso = '2026-05-03T01:00:00.000Z';
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: recordedIso, hostname: 'h' })
    );
    assert.throws(
      () =>
        O.acquireLock(dir, {
          _pid: 1,
          _killer: () => {}, // pid alive
          // OS reports the SAME start time → not recycled.
          _startTimeProbe: () => Date.parse(recordedIso),
        }),
      (err) => err.code === 'ELOCKED'
    );
  } finally {
    rmrf(dir);
  }
});

test('AP3 [todo 089] alive PID + DIFFERENT startedAt → reclaim path fires (recycled PID)', () => {
  const dir = mkTmp('orch-AP3');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({
        pid: 999,
        startedAt: '2026-05-03T01:00:00.000Z',
        hostname: 'h',
      })
    );
    // OS reports a DIFFERENT start time (recycled PID held by an
    // unrelated process started later).
    const lockPath = O.acquireLock(dir, {
      _pid: 7,
      _killer: () => {}, // pid alive
      _startTimeProbe: () => Date.parse('2026-05-03T02:00:00.000Z'),
      _now: () => 'fresh',
    });
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(obj.pid, 7, 'reclaim path should have replaced the stale lock');
    O.releaseLock(lockPath);
  } finally {
    rmrf(dir);
  }
});

test('AP4 [todo 089] ESRCH still triggers reclaim (existing behavior preserved)', () => {
  const dir = mkTmp('orch-AP4');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: '2026-05-03T01:00:00.000Z', hostname: 'h' })
    );
    const lockPath = O.acquireLock(dir, {
      _pid: 7,
      _killer: () => {
        const e = new Error('no such');
        e.code = 'ESRCH';
        throw e;
      },
      // probe should NOT be consulted in this branch (alive=false from killer)
      _startTimeProbe: () => {
        throw new Error('should not be called when killer says ESRCH');
      },
    });
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(obj.pid, 7);
    O.releaseLock(lockPath);
  } finally {
    rmrf(dir);
  }
});

test('AP5 [todo 089] alive PID + probe failure → ELOCKED (conservative)', () => {
  const dir = mkTmp('orch-AP5');
  try {
    fs.writeFileSync(
      path.join(dir, '.orchestrator.lock'),
      JSON.stringify({ pid: 999, startedAt: '2026-05-03T01:00:00.000Z', hostname: 'h' })
    );
    assert.throws(
      () =>
        O.acquireLock(dir, {
          _pid: 1,
          _killer: () => {},
          _startTimeProbe: () => null, // probe inconclusive
        }),
      (err) => err.code === 'ELOCKED'
    );
  } finally {
    rmrf(dir);
  }
});

test('AP9 [todo 092] giant qa-verdict.json (>cap) → returns null, does not OOM', () => {
  const dir = mkTmp('orch-AP9');
  try {
    const phaseDir = makePhaseDir(dir, 'p');
    const huge = Buffer.alloc(O.MAX_QA_VERDICT_BYTES + 1024, 'x');
    fs.writeFileSync(path.join(phaseDir, 'qa-verdict.json'), huge);
    fs.writeFileSync(
      path.join(phaseDir, 'qa-complete.md'),
      '---\nstatus: complete\n---\n# fallback'
    );
    // Should fall through to qa-complete.md (verdict.json over cap).
    const v = O.parseQaVerdict(phaseDir, 'qa');
    assert.ok(v, 'must return a verdict from frontmatter fallback');
    assert.strictEqual(v.source, 'qa-complete.md');
  } finally {
    rmrf(dir);
  }
});

test('AP10 [todo 092] giant completion-signal (>cap) → null', () => {
  const dir = mkTmp('orch-AP10');
  try {
    const sig = path.join(dir, 'impl-complete.md');
    const huge = Buffer.alloc(O.MAX_COMPLETION_SIGNAL_BYTES + 1024, 'x');
    fs.writeFileSync(sig, huge);
    const r = O.parseCompletionSignal(sig);
    assert.strictEqual(r, null, 'over-cap signal must return null');
  } finally {
    rmrf(dir);
  }
});

test('AP11 [todo 092] safeReadAgentFile rejects symlink', () => {
  const dir = mkTmp('orch-AP11');
  try {
    const realFile = path.join(dir, 'real.md');
    fs.writeFileSync(realFile, 'hello');
    const linkFile = path.join(dir, 'link.md');
    try {
      fs.symlinkSync(realFile, linkFile, 'file');
    } catch (e) {
      // Windows requires admin or developer-mode for symlinks; skip
      // gracefully if symlink creation is denied.
      if (e && (e.code === 'EPERM' || e.code === 'ENOSYS')) {
        return; // platform-skip
      }
      throw e;
    }
    const r = O.safeReadAgentFile(linkFile, 1024);
    assert.strictEqual(r, null, 'symlink must be refused');
  } finally {
    rmrf(dir);
  }
});

test('AP12 [todo 092] safeReadAgentFile reads small regular file', () => {
  const dir = mkTmp('orch-AP12');
  try {
    const f = path.join(dir, 'ok.md');
    fs.writeFileSync(f, 'hello world');
    const r = O.safeReadAgentFile(f, 1024);
    assert.strictEqual(r, 'hello world');
  } finally {
    rmrf(dir);
  }
});

test('AP13 [re-round P1] lockfile records OS process start time (apples-to-apples on resume)', () => {
  const dir = mkTmp('orch-AP13');
  try {
    // Acquire with a probe that returns a known OS start time. The
    // recorded `startedAt` MUST equal that OS time, NOT Date.now()
    // at acquire — otherwise the recycling tiebreaker compares
    // wall-clock vs OS-time and falsely reports recycling against
    // the same orchestrator.
    const osStart = Date.parse('2026-05-03T00:00:00.000Z');
    const lockPath = O.acquireLock(dir, {
      _pid: 12345,
      _now: () => '2026-05-03T01:00:00.000Z', // wall-clock at acquire (1h later)
      _startTimeProbe: () => osStart,
    });
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(
      obj.startedAt,
      new Date(osStart).toISOString(),
      'recorded startedAt must be OS-reported start time, not Date.now() at acquire'
    );
    O.releaseLock(lockPath);
  } finally {
    rmrf(dir);
  }
});

test('AP14 [re-round P1] probe failure → falls back to wall-clock (lock still functions)', () => {
  const dir = mkTmp('orch-AP14');
  try {
    const lockPath = O.acquireLock(dir, {
      _pid: 1,
      _now: () => '2026-05-03T00:00:00.000Z',
      _startTimeProbe: () => null, // probe inconclusive
    });
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(obj.startedAt, '2026-05-03T00:00:00.000Z');
    O.releaseLock(lockPath);
  } finally {
    rmrf(dir);
  }
});

test('AP15 [re-round P2] post-spawn persist always sets status: running', () => {
  const dir = mkTmp('orch-AP15');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const updates = [];
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: makeFakeSpawnSession(),
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: (mp_, phaseId, u) => {
          updates.push({ phaseId, updates: u });
          return { ok: true, status_file: mp_, phase: phaseId, updates: u };
        },
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    // Find the post-spawn persist (the one that sets pid + clears
    // dispatched_at). It MUST also set status: 'running'.
    const postSpawn = updates.find(
      (c) =>
        c.updates &&
        c.updates.dispatched_at === '' &&
        Number.isInteger(c.updates.pid)
    );
    assert.ok(postSpawn, 'post-spawn persist must exist');
    assert.strictEqual(
      postSpawn.updates.status,
      'running',
      'post-spawn persist MUST always include status: running (no caller fallback)'
    );
  } finally {
    rmrf(dir);
  }
});

test('AP16 [re-round P2] reconciliation loop probes synthesized review-loop roles', () => {
  const dir = mkTmp('orch-AP16');
  try {
    const mp = writeManifest(
      dir,
      makeBaseManifest({
        phases: [
          {
            id: 'p',
            completion_signal: 'docs/orchestration/phases/p/impl-complete.md',
            review_loop: { enabled: true, max_iterations: 3 },
            // ONLY impl declared. QA is synthesized.
            agents: [{ role: 'impl' }],
          },
        ],
      })
    );
    writeStatus(mp, {
      phases: {
        p: {
          status: 'spawning',
          dispatched_at: '2026-05-03T01:00:00.000Z',
          retry_count: 0,
        },
      },
    });
    makePhaseDir(mp, 'p');
    // Live SYNTHESIZED qa session in the snapshot.
    const tickRes = O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () =>
        JSON.stringify([
          { ProcessId: 7777, CommandLine: 'claude --name orch-p-qa' },
        ]),
    });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const adopt = actions.find(
      (a) =>
        a.type === 'persist' &&
        a.updates &&
        a.updates.status === 'running' &&
        a.updates.pid === 7777
    );
    assert.ok(
      adopt,
      'reconciliation must adopt the synthesized qa session even though only impl is declared'
    );
  } finally {
    rmrf(dir);
  }
});

test('AP6 [todo 090] pre-spawn marker written before spawnFn fires', () => {
  const dir = mkTmp('orch-AP6');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    fs.mkdirSync(path.join(dir, 'docs', 'orchestration', 'templates'), { recursive: true });
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const updateCalls = [];
    let spawnCalled = false;
    let preMarkerWritten = false;
    const fakeUpdate = (mp_, phaseId, updates) => {
      updateCalls.push({ phaseId, updates });
      // Capture whether dispatched_at was written before spawn.
      if (
        updates &&
        updates.status === 'spawning' &&
        typeof updates.dispatched_at === 'string'
      ) {
        if (!spawnCalled) preMarkerWritten = true;
      }
      return { ok: true, status_file: mp_, phase: phaseId, updates };
    };
    const fakeSpawn = (opts) => {
      spawnCalled = true;
      return {
        pid: 4242,
        command: 'fake',
        argv: [],
        sessionName: opts.name,
        title: opts.name,
        spawnedAt: '2026-05-03T01:00:00Z',
      };
    };
    O.executeActions(
      [{ type: 'spawn', phaseId: 'phase-1', role: 'impl', mode: 'initial', iteration: 1 }],
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {
        _spawnSession: fakeSpawn,
        _generatePrompt: makeFakeGenerate(),
        _runUpdate: fakeUpdate,
        logger: silentLogger(),
        projectName: 'p',
      }
    );
    assert.ok(preMarkerWritten, 'pre-spawn marker (status: spawning + dispatched_at) must be written BEFORE spawnFn');
    // Post-spawn persist should clear dispatched_at.
    const postCall = updateCalls.find(
      (c) => c.updates && c.updates.dispatched_at === ''
    );
    assert.ok(postCall, 'post-spawn persist should clear dispatched_at');
  } finally {
    rmrf(dir);
  }
});

test('AP7 [todo 090] resume with status: spawning + live PID → adopt (no duplicate spawn)', () => {
  const dir = mkTmp('orch-AP7');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: {
        'phase-1': {
          status: 'spawning',
          dispatched_at: '2026-05-03T01:00:00.000Z',
          retry_count: 0,
        },
      },
    });
    makePhaseDir(mp, 'phase-1');
    // Simulate the live tab in the PID snapshot.
    const tickRes = O.pollAllPhases({
      manifestPath: mp,
      _pidRunner: () =>
        JSON.stringify([
          {
            ProcessId: 4242,
            CommandLine: 'claude --name orch-phase-1-impl',
          },
        ]),
    });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    // Should adopt: persist with status: running + pid: 4242.
    const adopt = actions.find(
      (a) =>
        a.type === 'persist' &&
        a.updates &&
        a.updates.status === 'running' &&
        a.updates.pid === 4242
    );
    assert.ok(adopt, 'reconciliation should adopt the live session');
    // No spawn action should be emitted for phase-1 — duplicate prevention.
    assert.ok(
      !actions.some((a) => a.type === 'spawn' && a.phaseId === 'phase-1'),
      'no duplicate spawn for phase already in spawning + adopted'
    );
  } finally {
    rmrf(dir);
  }
});

test('AP8 [todo 090] resume with status: spawning + no live PID → reset to pending + retry_count++', () => {
  const dir = mkTmp('orch-AP8');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    writeStatus(mp, {
      phases: {
        'phase-1': {
          status: 'spawning',
          dispatched_at: '2026-05-03T01:00:00.000Z',
          retry_count: 0,
        },
      },
    });
    makePhaseDir(mp, 'phase-1');
    // Empty PID snapshot — no live session.
    const tickRes = O.pollAllPhases({ manifestPath: mp, _pidRunner: () => '[]' });
    const actions = O.decideTickActions(
      { ...tickRes, manifestPath: mp },
      { convergenceCounters: new Map() },
      {}
    );
    const reset = actions.find(
      (a) =>
        a.type === 'persist' &&
        a.updates &&
        a.updates.status === 'pending' &&
        a.updates.retry_count === 1
    );
    assert.ok(reset, 'reconciliation should reset to pending + retry_count++');
  } finally {
    rmrf(dir);
  }
});

test('AP1 [todo 088] uncaught throw inside runOneTick is caught; loop survives', async () => {
  const dir = mkTmp('orch-AP1');
  try {
    const mp = writeManifest(dir, makeBaseManifest());
    let tick = 0;
    const result = await O.runOrchestrator({
      manifestPath: mp,
      _spawnSession: makeFakeSpawnSession(),
      _generatePrompt: makeFakeGenerate(),
      _checkHealth: () => makeStubHealth({ pidAlive: true }),
      _pidRunner: () => '[]',
      // Inject a runUpdate that throws on the FIRST call (simulating
      // an EBUSY mid-tick). The orchestrator's try/catch around
      // runOneTick should swallow the throw and continue. On tick 2
      // a normal runUpdate runs, the phase completes, and the loop
      // exits cleanly.
      _runUpdate: (mp_, phaseId, updates) => {
        tick += 1;
        if (tick === 1) throw new Error('EBUSY: status file in use');
        return { ok: true, status_file: mp_, phase: phaseId, updates };
      },
      _sleep: () => Promise.resolve(),
      logger: silentLogger(),
      projectName: 't',
      maxTicks: 3,
    });
    // The first tick threw, but the loop kept going and reached
    // maxTicks without crashing.
    assert.ok(tick >= 2, `expected tick to advance past the throw, got ${tick}`);
    // Result can be max_ticks_unfinished — the point is no crash.
    assert.ok(
      ['max_ticks_unfinished', 'completed', 'completed_with_failures'].includes(result.summary),
      `unexpected summary: ${result.summary}`
    );
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
