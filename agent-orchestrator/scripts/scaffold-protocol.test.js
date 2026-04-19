/**
 * Unit 3 test suite. Uses node:test (built-in).
 * Run: npm test   (from agent-orchestrator/scripts/)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const { scaffoldProtocol } = require('./scaffold-protocol');

// Fixture builder: writes a manifest + a plugin-dir with template stubs
// into a fresh temp dir. Returns paths so tests can inspect results.
function makeFixture({ manifest, templates = ['protocol-header.md'] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-protocol-'));
  const manifestPath = path.join(root, 'manifest.yaml');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));

  const pluginDir = path.join(root, 'plugin');
  const templatesSrc = path.join(pluginDir, 'templates');
  fs.mkdirSync(templatesSrc, { recursive: true });
  for (const t of templates) {
    fs.writeFileSync(path.join(templatesSrc, t), `# ${t}\nstub content for tests.\n`);
  }

  return {
    root,
    manifestPath,
    pluginDir,
    protoDir: path.join(root, 'docs', 'orchestration'),
  };
}

const threePhaseManifest = {
  name: 'three-phase',
  phases: [
    { id: 'phase-0', completion_signal: 'signals/phase-0.md', agent: { role: 'impl' } },
    {
      id: 'phase-1',
      depends_on: ['phase-0'],
      completion_signal: 'signals/phase-1.md',
      agent: { role: 'impl' },
    },
    {
      id: 'phase-2',
      depends_on: ['phase-1'],
      completion_signal: 'signals/phase-2.md',
      agent: { role: 'impl' },
    },
  ],
};

// -------------------- Happy paths --------------------

test('3-phase manifest: creates phase dirs, logs/, events.jsonl, templates/', () => {
  const fx = makeFixture({
    manifest: threePhaseManifest,
    templates: ['protocol-header.md', 'impl-prompt.md'],
  });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.phases_created, ['phase-0', 'phase-1', 'phase-2']);
  assert.strictEqual(result.templates_copied, 2);
  assert.strictEqual(result.templates_skipped, 0);

  // Verify on disk
  for (const id of ['phase-0', 'phase-1', 'phase-2']) {
    assert.ok(
      fs.existsSync(path.join(fx.protoDir, 'phases', id)),
      `expected phases/${id}/ to exist`
    );
    assert.ok(fs.statSync(path.join(fx.protoDir, 'phases', id)).isDirectory());
  }
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'logs')));
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'logs', 'events.jsonl')));
  assert.strictEqual(
    fs.readFileSync(path.join(fx.protoDir, 'logs', 'events.jsonl'), 'utf8'),
    ''
  );
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'templates', 'protocol-header.md')));
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'templates', 'impl-prompt.md')));
});

test('dry-run: returns actions without writing', () => {
  const fx = makeFixture({ manifest: threePhaseManifest });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
    dryRun: true,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.dryRun, true);
  assert.ok(Array.isArray(result.actions) && result.actions.length > 0);
  assert.ok(!fs.existsSync(path.join(fx.protoDir, 'phases')));
  assert.ok(!fs.existsSync(path.join(fx.protoDir, 'logs')));
});

test('parallel phases: each parallel_with phase gets its own dir', () => {
  const manifest = {
    name: 'parallel',
    phases: [
      {
        id: 'phase-0',
        completion_signal: 'signals/phase-0.md',
        agent: { role: 'impl' },
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
    ],
  };
  const fx = makeFixture({ manifest });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'phases', 'phase-1a')));
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'phases', 'phase-1b')));
});

// -------------------- Idempotency --------------------

test('idempotent: second run does not clobber existing phase artifacts', () => {
  const fx = makeFixture({ manifest: threePhaseManifest });
  scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });

  // Simulate an agent writing a completion signal + a phase artifact
  const artifactPath = path.join(fx.protoDir, 'phases', 'phase-1', 'notes.md');
  fs.writeFileSync(artifactPath, 'agent-produced notes');

  const result2 = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result2.ok, true);

  // The agent's artifact must survive the second scaffold call
  assert.strictEqual(
    fs.readFileSync(artifactPath, 'utf8'),
    'agent-produced notes',
    'existing phase artifacts must survive a second scaffold'
  );
});

test('idempotent: existing events.jsonl with content is not truncated', () => {
  const fx = makeFixture({ manifest: threePhaseManifest });
  scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });

  const eventsLog = path.join(fx.protoDir, 'logs', 'events.jsonl');
  const event = '{"ts":"2026-04-19T01:00:00Z","phase":"phase-0","status":"running"}\n';
  fs.writeFileSync(eventsLog, event);

  const result2 = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result2.ok, true);
  assert.strictEqual(result2.events_log_preserved, true);
  assert.strictEqual(
    fs.readFileSync(eventsLog, 'utf8'),
    event,
    'events.jsonl must not be truncated on a re-run'
  );
});

test('idempotent: existing template copy is not overwritten (user edits preserved)', () => {
  const fx = makeFixture({
    manifest: threePhaseManifest,
    templates: ['protocol-header.md'],
  });
  scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });

  const dstTemplate = path.join(fx.protoDir, 'templates', 'protocol-header.md');
  const userEdited = '# protocol-header.md\nUSER LOCAL EDIT — do not clobber\n';
  fs.writeFileSync(dstTemplate, userEdited);

  const result2 = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result2.ok, true);
  assert.strictEqual(result2.templates_skipped, 1);
  assert.strictEqual(result2.templates_copied, 0);
  assert.strictEqual(
    fs.readFileSync(dstTemplate, 'utf8'),
    userEdited,
    'user-edited template copy must survive a second scaffold'
  );
});

// -------------------- Error paths --------------------

test('invalid manifest: refuses with structured errors, writes nothing', () => {
  const fx = makeFixture({
    manifest: {
      name: 'bad',
      phases: [
        {
          id: 'phase-0',
          depends_on: ['nonexistent'],
          completion_signal: 'signals/phase-0.md',
          agent: { role: 'impl' },
        },
      ],
    },
  });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(
    result.errors.some((e) => /references unknown phase/.test(e.message))
  );
  // Must not have created anything
  assert.ok(!fs.existsSync(path.join(fx.protoDir, 'phases')));
});

test('circular manifest: refuses cleanly', () => {
  const fx = makeFixture({
    manifest: {
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
          depends_on: ['a'],
          completion_signal: 'b.md',
          agent: { role: 'impl' },
        },
      ],
    },
  });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some((e) => /circular dependency/.test(e.message))
  );
});

test('missing plugin-dir templates: still creates phases + logs, emits warning', () => {
  const fx = makeFixture({ manifest: threePhaseManifest });
  // Point at a nonexistent plugin dir
  const bogusPluginDir = path.join(fx.root, 'does-not-exist');
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: bogusPluginDir,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(path.join(fx.protoDir, 'phases', 'phase-0')));
  assert.strictEqual(result.templates_copied, 0);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
  assert.match(result.warnings[0], /templates directory not found/);
});

test('missing manifest file: clean error', () => {
  const result = scaffoldProtocol({
    manifestPath: '/tmp/definitely-not-a-real-manifest-scaffold.yaml',
    pluginDir: '/tmp',
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /not found/);
});

// -------------------- Path safety --------------------

test('hostile phase.id ("../../outside") is rejected by validation, writes nothing', () => {
  const fx = makeFixture({
    manifest: {
      name: 'hostile',
      phases: [
        {
          id: '../../outside',
          completion_signal: 'signals/a.md',
          agent: { role: 'impl' },
        },
      ],
    },
  });
  const result = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.path === 'phases[0].id' &&
        /not safe as a filesystem/.test(e.message)
    )
  );
  // And nothing was written outside phases/:
  assert.ok(!fs.existsSync(path.join(fx.root, '..', 'outside')));
  assert.ok(!fs.existsSync(path.join(fx.protoDir, 'phases')));
});

test('phase id with backslash / forward slash / whitespace all rejected', () => {
  for (const id of ['with/slash', 'with\\backslash', 'with space', 'with:colon', '']) {
    const fx = makeFixture({
      manifest: {
        name: `bad-${Math.random()}`,
        phases: [
          { id, completion_signal: 'sig.md', agent: { role: 'impl' } },
        ],
      },
    });
    const result = scaffoldProtocol({
      manifestPath: fx.manifestPath,
      pluginDir: fx.pluginDir,
    });
    assert.strictEqual(result.ok, false, `expected "${id}" to be rejected`);
  }
});

// -------------------- Partial-copy recovery --------------------

test('zero-byte existing template copy is recovered (not preserved as "user edit")', () => {
  const fx = makeFixture({
    manifest: threePhaseManifest,
    templates: ['protocol-header.md'],
  });
  scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });

  // Simulate a prior-run crash mid-copy: destination exists but is empty.
  const dstTemplate = path.join(fx.protoDir, 'templates', 'protocol-header.md');
  fs.writeFileSync(dstTemplate, '');
  assert.strictEqual(fs.statSync(dstTemplate).size, 0);

  const result2 = scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  assert.strictEqual(result2.ok, true);
  // Zero-byte file was recovered by re-copy, not skipped-as-user-edit.
  assert.ok(fs.statSync(dstTemplate).size > 0);
});

test('no stale .tmp files after successful copy', () => {
  const fx = makeFixture({
    manifest: threePhaseManifest,
    templates: ['protocol-header.md', 'impl-prompt.md'],
  });
  scaffoldProtocol({
    manifestPath: fx.manifestPath,
    pluginDir: fx.pluginDir,
  });
  const templatesDir = path.join(fx.protoDir, 'templates');
  const leftoverTmps = fs
    .readdirSync(templatesDir)
    .filter((f) => f.includes('.tmp'));
  assert.strictEqual(leftoverTmps.length, 0, leftoverTmps.join(','));
});

// -------------------- Integration with Unit 1 plugin --------------------

test("consumes the plugin's own schema/manifest-example.yaml (integration)", () => {
  const exampleManifest = path.resolve(
    __dirname,
    '..',
    'schema',
    'manifest-example.yaml'
  );
  if (!fs.existsSync(exampleManifest)) return; // tolerated in isolated runs

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-int-'));
  // Copy the example manifest into a temp dir so we don't scribble on
  // the plugin's own schema/ directory.
  const localManifest = path.join(tmp, 'manifest.yaml');
  fs.copyFileSync(exampleManifest, localManifest);

  const pluginDir = path.resolve(__dirname, '..');
  const result = scaffoldProtocol({
    manifestPath: localManifest,
    pluginDir,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.phases_created, [
    'phase-0',
    'phase-1',
    'phase-2a',
    'phase-2b',
    'phase-3',
  ]);
  // The real plugin templates/ has protocol-header.md, so at least one
  // file should have been copied.
  assert.ok(result.templates_copied >= 1);
});
