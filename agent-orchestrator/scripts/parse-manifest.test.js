/**
 * Unit 2 test suite. Uses node:test (built-in, Node >= 20).
 * Run: npm test   (from agent-orchestrator/scripts/)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  loadManifest,
  validate,
  findDanglingDeps,
  analyzeDeps,
  normalizePhases,
  statusPathFor,
  runUpdate,
  VALID_ID_RE,
} = require('./parse-manifest');
const { FLAG_NAME_RE } = require('../hooks/session-start');

function write(manifestObj) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-manifest-'));
  const file = path.join(tmp, 'manifest.yaml');
  fs.writeFileSync(file, yaml.dump(manifestObj));
  return file;
}

function writeRaw(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-manifest-raw-'));
  const file = path.join(tmp, 'manifest.yaml');
  fs.writeFileSync(file, content);
  return file;
}

const validMinimal = {
  name: 'minimal',
  phases: [
    {
      id: 'phase-0',
      completion_signal: 'signals/phase-0.md',
      agent: { role: 'impl' },
    },
  ],
};

// -------------------- Happy paths --------------------

test('valid minimal manifest: loads, validates, normalizes', () => {
  const file = write(validMinimal);
  const loaded = loadManifest(file);
  assert.strictEqual(loaded.ok, true);

  const result = validate(loaded.manifest);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.strictEqual(result.errors.length, 0);

  const phases = normalizePhases(loaded.manifest);
  assert.strictEqual(phases.length, 1);
  assert.strictEqual(phases[0].agents[0].role, 'impl');
  assert.strictEqual(phases[0].review_loop.enabled, false);
});

test('valid full manifest with defaults, launcher, review loop, parallel phases', () => {
  const manifest = {
    name: 'full',
    workdir: '../..',
    launcher: {
      shell: 'powershell',
      binary: 'agency claude',
      auto_mode_flag: '--enable-auto-mode',
      shell_args: '-NoExit -Command',
      passthrough_flags: ['--model=sonnet'],
    },
    defaults: {
      model: 'sonnet',
      phase_timeout_minutes: 120,
      heartbeat_timeout_minutes: 5,
      notifications: { enabled: false, email: 'user@example.com' },
    },
    phases: [
      {
        id: 'phase-0',
        completion_signal: 'signals/phase-0.md',
        agents: [{ role: 'impl' }, { role: 'qa' }],
        review_loop: { enabled: true, max_iterations: 3 },
      },
      {
        id: 'phase-1a',
        depends_on: ['phase-0'],
        parallel_with: ['phase-1b'],
        completion_signal: 'signals/phase-1a.md',
        agent: { role: 'impl' },
      },
      {
        id: 'phase-1b',
        depends_on: ['phase-0'],
        parallel_with: ['phase-1a'],
        completion_signal: 'signals/phase-1b.md',
        agent: { role: 'impl' },
      },
      {
        id: 'phase-2',
        depends_on: ['phase-1a', 'phase-1b'],
        completion_signal: 'signals/phase-2.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const file = write(manifest);
  const loaded = loadManifest(file);
  const result = validate(loaded.manifest);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.executionOrder, [
    'phase-0',
    'phase-1a',
    'phase-1b',
    'phase-2',
  ]);

  const phases = normalizePhases(loaded.manifest);
  assert.strictEqual(phases[0].timeout_minutes, 120, 'inherits defaults.phase_timeout_minutes');
  assert.strictEqual(phases[0].agents[0].model, 'sonnet', 'inherits defaults.model');
  assert.strictEqual(phases[0].review_loop.enabled, true);
});

test('phase-level timeout_minutes overrides defaults.phase_timeout_minutes', () => {
  const manifest = {
    name: 'override',
    defaults: { phase_timeout_minutes: 30 },
    phases: [
      {
        id: 'p0',
        timeout_minutes: 5,
        completion_signal: 'signals/p0.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const phases = normalizePhases(write(manifest) && manifest);
  assert.strictEqual(phases[0].timeout_minutes, 5);
});

test('unknown top-level fields produce warnings, not errors', () => {
  const manifest = {
    ...validMinimal,
    future_feature: 'whatever',
    experimental: { enabled: true },
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.some((w) => w.path === 'future_feature'));
  assert.ok(result.warnings.some((w) => w.path === 'experimental'));
});

test('agent and agents both present: agents takes precedence, warning emitted', () => {
  const manifest = {
    name: 'both',
    phases: [
      {
        id: 'p0',
        completion_signal: 'signals/p0.md',
        agent: { role: 'impl' },
        agents: [{ role: 'impl' }, { role: 'qa' }],
      },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.some((w) => w.message.includes('takes precedence')));

  const phases = normalizePhases(manifest);
  assert.strictEqual(phases[0].agents.length, 2);
});

// -------------------- Error paths --------------------

test('missing phases array: specific error', () => {
  const result = validate({ name: 'broken' });
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.path === 'phases' && /non-empty array/.test(e.message))
  );
});

test('empty phases array: specific error', () => {
  const result = validate({ name: 'broken', phases: [] });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'phases'));
});

test('phase.id must match [A-Za-z0-9._-]+ (path-traversal guard)', () => {
  for (const id of [
    '../../outside',
    '..\\outside',
    'with/slash',
    'with\\backslash',
    'with space',
    'with:colon',
  ]) {
    const manifest = {
      name: 'hostile',
      phases: [
        { id, completion_signal: 'sig.md', agent: { role: 'impl' } },
      ],
    };
    const result = validate(manifest);
    assert.strictEqual(result.valid, false, `expected "${id}" to fail`);
    assert.ok(
      result.errors.some(
        (e) =>
          e.path === 'phases[0].id' &&
          /not safe as a filesystem/.test(e.message)
      ),
      `expected filesystem-safety error for "${id}"`
    );
  }
});

test('phase.id rejects __proto__ / prototype / constructor', () => {
  for (const id of ['__proto__', 'prototype', 'constructor']) {
    const manifest = {
      name: 'reserved',
      phases: [
        { id, completion_signal: 'sig.md', agent: { role: 'impl' } },
      ],
    };
    const result = validate(manifest);
    assert.strictEqual(result.valid, false, `expected "${id}" to fail`);
    assert.ok(
      result.errors.some(
        (e) => e.path === 'phases[0].id' && /reserved JavaScript property/.test(e.message)
      )
    );
  }
});

test('missing phase.id: reports phases[0].id', () => {
  const manifest = {
    name: 'no-id',
    phases: [{ completion_signal: 'sig.md', agent: { role: 'impl' } }],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === 'phases[0].id' && /missing required/.test(e.message)
    )
  );
});

test('duplicate phase.id: explicit duplicate error', () => {
  const manifest = {
    name: 'dup',
    phases: [
      { id: 'p0', completion_signal: 's0.md', agent: { role: 'impl' } },
      { id: 'p0', completion_signal: 's1.md', agent: { role: 'impl' } },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === 'phases[1].id' && /duplicate/.test(e.message)
    )
  );
});

test('missing completion_signal: specific error', () => {
  const manifest = {
    name: 'no-sig',
    phases: [{ id: 'p0', agent: { role: 'impl' } }],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'phases[0].completion_signal'));
});

test('invalid launcher.shell: whitelist error with suggestion', () => {
  const manifest = {
    ...validMinimal,
    launcher: { shell: 'pwsh' },
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  const err = result.errors.find((e) => e.path === 'launcher.shell');
  assert.ok(err, 'expected launcher.shell error');
  assert.match(err.message, /powershell \| cmd/);
});

test('non-positive timeout_minutes: specific error', () => {
  const manifest = {
    name: 't',
    phases: [
      {
        id: 'p0',
        timeout_minutes: -5,
        completion_signal: 'sig.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === 'phases[0].timeout_minutes' && /positive integer/.test(e.message)
    )
  );
});

test('non-integer timeout_minutes: rejected', () => {
  const manifest = {
    name: 't',
    phases: [
      {
        id: 'p0',
        timeout_minutes: 'forever',
        completion_signal: 'sig.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
});

test('phase missing both agent and agents: specific error', () => {
  const manifest = {
    name: 'no-agent',
    phases: [{ id: 'p0', completion_signal: 'sig.md' }],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === 'phases[0]' && /agent.*agents/.test(e.message)
    )
  );
});

test('dangling depends_on: reports the specific reference', () => {
  const manifest = {
    name: 'dangling',
    phases: [
      {
        id: 'p0',
        depends_on: ['nonexistent'],
        completion_signal: 'sig.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const dangling = findDanglingDeps(manifest.phases);
  assert.strictEqual(dangling.length, 1);
  assert.match(dangling[0].message, /nonexistent/);
});

test('circular dependency: cycle detected, valid=false', () => {
  const manifest = {
    name: 'cycle',
    phases: [
      {
        id: 'a',
        depends_on: ['b'],
        completion_signal: 'a.md',
        agent: { role: 'impl' },
      },
      {
        id: 'b',
        depends_on: ['c'],
        completion_signal: 'b.md',
        agent: { role: 'impl' },
      },
      {
        id: 'c',
        depends_on: ['a'],
        completion_signal: 'c.md',
        agent: { role: 'impl' },
      },
    ],
  };
  const { cycle, order } = analyzeDeps(manifest.phases);
  assert.strictEqual(order, null);
  // Cycle is a ring: first == last, three unique nodes in a 3-cycle.
  assert.ok(cycle && cycle.length === 4);
  assert.strictEqual(cycle[0], cycle[cycle.length - 1]);
  assert.strictEqual(new Set(cycle).size, 3);

  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /circular/.test(e.message)));
});

test('invalid YAML: parse error surfaces with line/col when available', () => {
  const file = writeRaw('name: t\nphases:\n  - id: p0\n    completion_signal: sig.md\n    agent: {role: impl\n');
  const loaded = loadManifest(file);
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /YAML parse error/);
});

test('manifest file does not exist: clear error', () => {
  const loaded = loadManifest('/tmp/definitely-not-a-real-manifest.yaml');
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /not found/);
});

test('empty manifest file: explicit error', () => {
  const file = writeRaw('');
  const loaded = loadManifest(file);
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /empty/);
});

// -------------------- Update mode helpers --------------------

test('statusPathFor: sibling file with -status suffix', () => {
  assert.strictEqual(
    statusPathFor('/a/b/manifest.yaml'),
    path.join('/a/b', 'manifest-status.yaml')
  );
  assert.strictEqual(
    statusPathFor('/a/b/sprint3.yml'),
    path.join('/a/b', 'sprint3-status.yaml')
  );
});

// -------------------- Required fields per the plan --------------------

test('missing top-level name: specific error (plan requires name)', () => {
  const manifest = {
    phases: [
      { id: 'p0', completion_signal: 's.md', agent: { role: 'impl' } },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === 'name' && /missing required/.test(e.message)
    )
  );
});

test('empty string name: rejected', () => {
  const manifest = {
    name: '   ',
    phases: [
      { id: 'p0', completion_signal: 's.md', agent: { role: 'impl' } },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'name'));
});

test('missing agent.role (shorthand form): reports phases[i].agent.role', () => {
  const manifest = {
    name: 'noRole',
    phases: [
      { id: 'p0', completion_signal: 's.md', agent: { model: 'sonnet' } },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.path === 'phases[0].agent.role' && /missing required/.test(e.message)
    )
  );
});

test('missing role on an agents[] entry: reports the indexed path', () => {
  const manifest = {
    name: 'noRole2',
    phases: [
      {
        id: 'p0',
        completion_signal: 's.md',
        agents: [{ role: 'impl' }, { model: 'sonnet' }],
      },
    ],
  };
  const result = validate(manifest);
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.path === 'phases[0].agents[1].role' &&
        /missing required/.test(e.message)
    )
  );
});

// -------------------- Cycle detection truthfulness --------------------

test('cycle detection: returns the actual cycle path, not downstream residue', () => {
  // a <-> b cycle, c depends on b (downstream but not in cycle)
  const phases = [
    { id: 'a', depends_on: ['b'], completion_signal: 'a.md', agent: { role: 'impl' } },
    { id: 'b', depends_on: ['a'], completion_signal: 'b.md', agent: { role: 'impl' } },
    { id: 'c', depends_on: ['b'], completion_signal: 'c.md', agent: { role: 'impl' } },
  ];
  const { cycle } = analyzeDeps(phases);
  assert.ok(cycle && cycle.length >= 2, 'cycle should be non-trivial');
  // c is downstream of the cycle but not part of it — must not appear
  assert.ok(!cycle.includes('c'), 'cycle should not include non-cyclic downstream node');
  // first and last of the cycle should be the same node (ring representation)
  assert.strictEqual(cycle[0], cycle[cycle.length - 1]);
});

// -------------------- Update mode --------------------

test('runUpdate: writes a new status file with the expected shape', () => {
  const file = write({ ...validMinimal });
  const result = runUpdate(file, 'phase-0', {
    status: 'running',
    pid: 12345,
    started_at: '2026-04-18T12:00:00Z',
  });
  assert.strictEqual(result.ok, true, result.error);
  const parsed = yaml.load(fs.readFileSync(result.status_file, 'utf8'));
  assert.strictEqual(parsed.phases['phase-0'].status, 'running');
  assert.strictEqual(parsed.phases['phase-0'].pid, 12345);
  assert.strictEqual(parsed.phases['phase-0'].started_at, '2026-04-18T12:00:00Z');
  assert.ok(parsed.updated_at, 'expected updated_at timestamp');
});

test('runUpdate: second call preserves prior fields', () => {
  const file = write({ ...validMinimal });
  runUpdate(file, 'phase-0', { status: 'running', pid: 111 });
  const r2 = runUpdate(file, 'phase-0', { status: 'completed' });
  assert.strictEqual(r2.ok, true);
  const parsed = yaml.load(fs.readFileSync(r2.status_file, 'utf8'));
  assert.strictEqual(parsed.phases['phase-0'].status, 'completed');
  assert.strictEqual(parsed.phases['phase-0'].pid, 111, 'pid must survive second update');
});

test('runUpdate: preserves status entries for unrelated phases', () => {
  const manifest = {
    name: 'multi',
    phases: [
      { id: 'p0', completion_signal: 'p0.md', agent: { role: 'impl' } },
      { id: 'p1', completion_signal: 'p1.md', agent: { role: 'impl' } },
    ],
  };
  const file = write(manifest);
  runUpdate(file, 'p0', { status: 'completed', pid: 100 });
  const r = runUpdate(file, 'p1', { status: 'running', pid: 200 });
  const parsed = yaml.load(fs.readFileSync(r.status_file, 'utf8'));
  assert.strictEqual(parsed.phases.p0.status, 'completed');
  assert.strictEqual(parsed.phases.p0.pid, 100);
  assert.strictEqual(parsed.phases.p1.status, 'running');
});

test('runUpdate: unknown phase id rejected', () => {
  const file = write({ ...validMinimal });
  const r = runUpdate(file, 'no-such-phase', { status: 'running' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/);
});

test('runUpdate: invalid status value rejected', () => {
  const file = write({ ...validMinimal });
  const r = runUpdate(file, 'phase-0', { status: 'exploded' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /status must be one of/);
});

test('runUpdate: __proto__ phase id rejected (prototype-pollution guard)', () => {
  const manifest = {
    name: 'x',
    phases: [
      { id: 'phase-0', completion_signal: 's.md', agent: { role: 'impl' } },
    ],
  };
  const file = write(manifest);
  const r = runUpdate(file, '__proto__', { status: 'running' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not safe as a YAML map key|not found/);
});

test('runUpdate: malformed manifest (phases as object, not array) refuses cleanly', () => {
  const file = writeRaw('name: bad\nphases: {}\n');
  const r = runUpdate(file, 'phase-0', { status: 'running' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /manifest is invalid/);
});

test('runUpdate: corrupt status file surfaces as error, not a crash', () => {
  const file = write({ ...validMinimal });
  const statusPath = statusPathFor(file);
  fs.writeFileSync(statusPath, '{not valid yaml: [');
  const r = runUpdate(file, 'phase-0', { status: 'running' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /corrupt status file/);
});

// -------------------- Integration: the plugin's own example --------------------

test('the plugin\'s schema/manifest-example.yaml validates', () => {
  const example = path.resolve(__dirname, '..', 'schema', 'manifest-example.yaml');
  if (!fs.existsSync(example)) return; // not present yet if test runs in isolation
  const loaded = loadManifest(example);
  assert.strictEqual(loaded.ok, true, loaded.error);
  const result = validate(loaded.manifest);
  assert.strictEqual(
    result.valid,
    true,
    'expected example manifest to validate: ' + JSON.stringify(result.errors)
  );
});

test('the prototype\'s manifest-example.yaml validates', () => {
  const example = path.resolve(
    __dirname,
    '..',
    'prototype',
    'manifest-example.yaml'
  );
  if (!fs.existsSync(example)) return;
  const loaded = loadManifest(example);
  assert.strictEqual(loaded.ok, true, loaded.error);
  const result = validate(loaded.manifest);
  assert.strictEqual(
    result.valid,
    true,
    'expected prototype example to validate: ' + JSON.stringify(result.errors)
  );
});

// -------------------- Cross-module ID-class lockstep --------------------

// VALID_ID_RE (parse-manifest.js) and FLAG_NAME_RE (hooks/session-start.js)
// share the same ID character class. The prose pointers above each constant
// carry the contract; this test makes drift between them a CI failure
// rather than a comment-review oversight. See docs/todos/006 + 027.
test('VALID_ID_RE and FLAG_NAME_RE share the same ID character class', () => {
  assert.ok(VALID_ID_RE instanceof RegExp, 'VALID_ID_RE must be exported as a RegExp');
  assert.ok(FLAG_NAME_RE instanceof RegExp, 'FLAG_NAME_RE must be exported as a RegExp');
  assert.strictEqual(
    FLAG_NAME_RE.source,
    '^\\.pending-' + VALID_ID_RE.source.slice(1),
    'FLAG_NAME_RE.source must be "^\\.pending-" prepended to VALID_ID_RE.source ' +
      '(minus its leading ^). Update both regexes together — see ' +
      'docs/todos/006 / 027 and hooks/README.md Contract invariants.'
  );
});
