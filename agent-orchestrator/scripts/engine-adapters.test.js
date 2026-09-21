'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { attemptFixture } = require('./attempt-channel.test-support');
const {
  capabilitiesFor, buildEngineInvocation, inspectEnginePreflight, createEngineAdapter, resolveEngineExecutable,
} = require('./engine-adapters');

const pluginDir = path.resolve(__dirname, '..');
const executable = path.resolve('agency.exe');
const base = {
  engine: 'agency-copilot', executable, pluginDir, access: 'mutating',
  permissionMode: 'default', kickoff: 'Read the attempt prompt and perform only this assignment.',
  sessionName: 'orch-attempt-a', sessionId: randomUUID(), model: 'gpt-5',
};

test('PATH resolution pins the first supported native engine and rejects missing engines and shadowing shims', (t) => {
  const root = path.resolve(`.u3-path-fixture-${randomUUID()}`);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pathValue = [first, second].join(path.delimiter);
  assert.throws(() => resolveEngineExecutable('agency-copilot', { pathValue }), /PATH/);
  fs.writeFileSync(path.join(second, 'agency.exe'), 'fake, never executed');
  assert.equal(resolveEngineExecutable('agency-claude', { pathValue }), fs.realpathSync.native(path.join(second, 'agency.exe')));
  assert.equal(resolveEngineExecutable('agency-copilot', { pathValue: `missing-relative${path.delimiter}${pathValue}` }),
    fs.realpathSync.native(path.join(second, 'agency.exe')));
  fs.writeFileSync(path.join(first, 'agency.cmd'), 'not executed');
  assert.throws(() => resolveEngineExecutable('agency-copilot', { pathValue }), /shim/);
  fs.writeFileSync(path.join(first, 'agency.exe'), 'fake, never executed');
  assert.equal(resolveEngineExecutable('agency-copilot', { pathValue }), fs.realpathSync.native(path.join(first, 'agency.exe')));
});

test('Copilot maps interactive submission without Claude flags or permission escalation', () => {
  const result = buildEngineInvocation(base);
  assert.equal(result.file, executable);
  assert.ok(result.args.includes('--interactive'));
  assert.ok(result.args.includes(base.kickoff));
  for (const flag of ['--name', '--permission-mode', '--enable-auto-mode', '--allow-all-tools', '--yolo']) {
    assert.ok(!result.args.includes(flag), flag);
  }
  assert.ok(result.args.includes('--model'));
  assert.ok(result.args.includes(base.model));
  assert.ok(result.args.includes(`local:${pluginDir}`));
  assert.equal(result.args[result.args.indexOf('--session-id') + 1], base.sessionId);
});

test('Claude engines retain explicit plugin, name, model and permission mappings', () => {
  for (const engine of ['claude', 'agency-claude']) {
    const result = buildEngineInvocation({ ...base, engine, model: 'sonnet' });
    assert.ok(result.args.includes('--name'));
    assert.ok(result.args.includes(base.sessionName));
    assert.ok(result.args.includes('--plugin-dir') || result.args.includes('--plugin'));
    assert.ok(result.args.includes('sonnet'));
    assert.ok(result.args.includes(base.kickoff));
    assert.ok(!result.args.includes('--interactive'));
    assert.equal(result.args[result.args.indexOf('--permission-mode') + 1], 'manual');
    assert.equal(result.args[result.args.indexOf('--session-id') + 1], base.sessionId);
    assert.ok(result.args.includes(engine === 'claude' ? pluginDir : `local:${pluginDir}`));
  }
});

test('unsupported capabilities fail closed without silently changing the request', () => {
  assert.throws(() => capabilitiesFor('unknown'), /unsupported engine/);
  for (const engine of ['claude', 'agency-claude', 'agency-copilot']) {
    assert.throws(() => buildEngineInvocation({ ...base, engine, access: 'read-only' }), /read-only/);
    assert.equal(capabilitiesFor(engine).tracks_descendants, false);
    assert.equal(capabilitiesFor(engine).live_verified, false);
    assert.equal(capabilitiesFor(engine).read_only_enforced, false);
  }
  for (const permissionMode of ['acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
    assert.throws(() => buildEngineInvocation({ ...base, permissionMode }), /permission/);
  }
  assert.throws(() => buildEngineInvocation({ ...base, executable: 'agency' }), /absolute/);
  assert.throws(() => buildEngineInvocation({ ...base, pluginDir: null }), /plugin/);
  assert.throws(() => buildEngineInvocation({ ...base, model: '--yolo' }), /model/);
  assert.throws(() => buildEngineInvocation({ ...base, sessionId: null }), /session/);
  assert.throws(() => buildEngineInvocation({ ...base, kickoff: 'x'.repeat(256 * 1024) }), /kickoff/);
  assert.throws(() => buildEngineInvocation({ ...base, extraFlags: ['--yolo'] }), /unsupported option/);
  assert.throws(() => buildEngineInvocation({ ...base, engine: 'claude', permissionMode: 'bypassPermissions' }), /consent/);
});

test('Claude permission modes are explicit; no ambient auto-mode grant', () => {
  for (const mode of ['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan']) {
    const result = buildEngineInvocation({ ...base, engine: 'claude', permissionMode: mode });
    assert.equal(result.args[result.args.indexOf('--permission-mode') + 1], mode);
    assert.ok(!result.args.includes('--dangerously-skip-permissions'));
  }
});

function installation(t) {
  const root = path.resolve(`.u3-adapter-fixture-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'agency.exe');
  fs.writeFileSync(exe, 'offline capability-probe fixture; never executed');
  return { ...base, executable: exe };
}

test('preflight checks installed selected-engine help/version separately from Agency and preserves model', (t) => {
  const options = installation(t);
  const calls = [];
  const report = inspectEnginePreflight(options, { probe(file, args) {
    assert.equal(file, options.executable);
    calls.push(args);
    if (args.length === 1) return 'Agency 2026.9.16.4 --plugin';
    if (args.at(-1) === '--version') return 'GitHub Copilot CLI 1.0.85';
    return '--plugin --interactive --session-id --model Model (choices: gpt-5, gpt-5-mini)';
  } });
  assert.deepEqual(calls, [['--version'], ['copilot', '--version'], ['copilot', '--help']]);
  assert.equal(report.engine_version, 'GitHub Copilot CLI 1.0.85');
  assert.equal(report.live_verified, false);
  assert.equal(report.invocation.args[report.invocation.args.indexOf('--model') + 1], 'gpt-5');
});

test('Claude preflight uses the installed manual CLI spelling for default approval policy', (t) => {
  const options = { ...installation(t), engine: 'claude', model: 'sonnet' };
  const report = inspectEnginePreflight(options, { probe(_file, args) {
    if (args[0] === '--version') return '2.1.275 (Claude Code)';
    return [
      '  --session-id <uuid>',
      '  --name <name>',
      '  --plugin-dir <path>',
      '  --permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
      '  --model <model> alias for the latest model (e.g. sonnet or opus)',
    ].join('\n');
  } });
  assert.equal(report.engine_version, '2.1.275 (Claude Code)');
  assert.equal(report.invocation.args[report.invocation.args.indexOf('--permission-mode') + 1], 'manual');
});

test('preflight rejects missing flags, unknown selected version/model, failed probes and absent plugin', (t) => {
  const options = installation(t);
  const probeFor = (help, version = 'GitHub Copilot CLI 1.0.85') => (_file, args) =>
    args.length === 1 ? 'Agency 2026.9.16.4' : args.at(-1) === '--version' ? version : `--plugin ${help}`;
  assert.throws(() => inspectEnginePreflight(options, { probe: probeFor('--model gpt-5') }), /--interactive/);
  assert.throws(() => inspectEnginePreflight(options, {
    probe: probeFor('--interactive --session-id --model gpt-5', 'Agency 2026.9.16.4'),
  }), /selected.engine version/);
  assert.throws(() => inspectEnginePreflight(options, {
    probe: probeFor('--interactive --session-id --model choose a model'),
  }), /model.*unproven/);
  assert.throws(() => inspectEnginePreflight(options, { probe() { throw Error('not installed'); } }), /preflight.*not installed/);
  assert.throws(() => inspectEnginePreflight({ ...options, pluginDir: path.join(path.dirname(options.executable), 'missing') }), /plugin/);
});

test('production adapter never impersonates fixture or accepts an opt-in launch bypass', async () => {
  const adapter = createEngineAdapter({ engine: base.engine, executable, pluginDir, artifactRoot: path.resolve('.') });
  assert.equal(adapter.kind, 'engine');
  assert.equal(adapter.capabilities.live_verified, false);
  await assert.rejects(adapter.launch({}, { observe() { assert.fail('must not emit'); } }), /live acceptance/);
  assert.throws(() => createEngineAdapter({
    engine: base.engine, executable, pluginDir, artifactRoot: path.resolve('.'), liveAccepted: true,
  }), /unsupported option/);
});

test('candidate preparation integrates actual pure terminal builder and attempt channel without launching', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const exe = path.join(root, 'agency.exe');
  fs.writeFileSync(exe, 'offline fixture; never executed');
  const adapter = createEngineAdapter({ engine: attempt.engine, executable: exe, pluginDir, artifactRoot: root });
  const result = await adapter.prepareCandidate(attempt, { probe(_file, args) {
    if (args.length === 1) return 'Agency 2026.9.16.4 --plugin';
    return args.at(-1) === '--version' ? 'GitHub Copilot CLI 1.0.85' : '--plugin --interactive --session-id --model';
  } });
  assert.equal(result.kind, 'engine_candidate');
  assert.equal(result.live_verified, false);
  assert.equal(result.spawn.program, 'wt.exe');
  assert.ok(result.spawn.argv.includes('-EncodedCommand'));
  const script = Buffer.from(result.spawn.argv.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('AGENT_ORCHESTRATOR_PLUGIN_ROOT'));
  assert.ok(script.includes(pluginDir));
  assert.ok(script.includes(attempt.intent.launch_token));
  assert.equal(result.channel.binding.session_id, attempt.attempt_id);
  assert.equal(attempt.engine_process, undefined);
  assert.equal(attempt.submission, undefined);
  await assert.rejects(adapter.launch(attempt, { observe() { assert.fail('must not emit'); } }), /live acceptance/);
});

test('failed installed capability probe publishes no binding and reports missing installations explicitly', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const missing = path.join(root, 'missing.exe');
  const adapter = createEngineAdapter({ engine: attempt.engine, executable: missing, pluginDir, artifactRoot: root });
  await assert.rejects(adapter.prepareCandidate(attempt), /executable preflight/);
  assert.equal(fs.existsSync(path.join(attempt.artifacts.directory, 'engine-binding.json')), false);
});

test('plugin preflight rejects missing runtime hook entrypoints before any engine probe', (t) => {
  const options = installation(t);
  const incompletePlugin = path.join(path.dirname(options.executable), 'plugin');
  fs.mkdirSync(path.join(incompletePlugin, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(incompletePlugin, 'hooks'));
  fs.writeFileSync(path.join(incompletePlugin, '.claude-plugin', 'plugin.json'), '{}');
  fs.writeFileSync(path.join(incompletePlugin, 'hooks', 'hooks.json'), '{}');
  fs.writeFileSync(path.join(incompletePlugin, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(incompletePlugin, 'agency.json'), '{}');
  assert.throws(() => inspectEnginePreflight({ ...options, pluginDir: incompletePlugin }, {
    probe() { assert.fail('incomplete package must fail before an engine probe'); },
  }), /plugin.*copilot-session/);
});
