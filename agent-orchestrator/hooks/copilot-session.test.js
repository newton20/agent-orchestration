'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const { attemptFixture } = require('../scripts/attempt-channel.test-support');
const { prepareAttemptChannel, readAttemptChannel } = require('../scripts/attempt-channel');
const { recordCopilotObservation } = require('./copilot-session');
const { recordClaudeObservation } = require('./claude-observation');

test('installed hook commands record through the real Windows shell boundary', {
  skip: process.platform !== 'win32',
}, (t) => {
  const pluginRoot = path.resolve(__dirname, '..');
  for (const engine of ['agency-copilot', 'claude']) {
    const { root, attempt } = attemptFixture(t, engine);
    const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
    const env = { ...process.env, ...prepared.environment,
      AGENT_ORCHESTRATOR_PLUGIN_ROOT: pluginRoot, AGENT_ORCHESTRATOR_NODE: process.execPath };
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const payload = { cwd: root, source: 'startup', session_id: attempt.attempt_id,
        sessionId: attempt.attempt_id, timestamp: 1000, prompt: prepared.binding.kickoff };
      let program, args;
      if (engine === 'agency-copilot') {
        const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));
        const name = event === 'SessionStart' ? 'sessionStart' : 'userPromptSubmitted';
        program = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-Command', config.hooks[name][0].powershell];
      } else {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8'));
        const observer = config.hooks[event].flatMap((entry) => entry.hooks)
          .find((entry) => entry.command.includes('run-observation.cmd'));
        assert.ok(observer && observer.async === false);
        const gitExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
        program = path.resolve(gitExec, '..', '..', '..', 'bin', 'bash.exe');
        args = ['-c', observer.command];
        env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      }
      const result = spawnSync(program, args, { env, input: JSON.stringify(payload), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '{}');
    }
    const receipts = readAttemptChannel(attempt, { artifactRoot: root });
    assert.ok(receipts.startup);
    assert.ok(receipts.submission);
  }
});

test('Copilot documented camelCase and compatible PascalCase/snake_case contracts record observations only', (t) => {
  for (const snake of [false, true]) {
    const { root, attempt } = attemptFixture(t);
    const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
    const payload = { cwd: root, timestamp: snake ? new Date(1000).toISOString() : 1000, source: 'startup' };
    payload[snake ? 'session_id' : 'sessionId'] = attempt.attempt_id;
    payload[snake ? 'initial_prompt' : 'initialPrompt'] = prepared.binding.kickoff;
    if (snake) payload.hook_event_name = 'SessionStart';
    const startup = recordCopilotObservation(payload, {
      event: snake ? 'SessionStart' : 'sessionStart', environment: prepared.environment,
    });
    assert.equal(startup.status, 'recorded');
    assert.equal(startup.additionalContext, undefined);
    assert.equal(readAttemptChannel(attempt, { artifactRoot: root }).submission, null);
    const submission = recordCopilotObservation({
      ...payload, ...(snake ? { hook_event_name: 'UserPromptSubmit' } : {}), prompt: prepared.binding.kickoff,
    }, {
      event: snake ? 'UserPromptSubmit' : 'userPromptSubmitted', environment: prepared.environment,
    });
    assert.equal(submission.status, 'recorded');
  }
});

test('Claude observer supports only exact startup and real UserPromptSubmit, never additionalContext', (t) => {
  const { root, attempt } = attemptFixture(t, 'agency-claude');
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  const payload = { cwd: root, session_id: attempt.attempt_id, source: 'startup', hook_event_name: 'SessionStart' };
  assert.equal(recordClaudeObservation(payload, { environment: prepared.environment }).status, 'recorded');
  assert.equal(readAttemptChannel(attempt, { artifactRoot: root }).submission, null);
  assert.equal(recordClaudeObservation({ ...payload, hook_event_name: 'UserPromptSubmit', prompt: prepared.binding.kickoff }, {
    environment: prepared.environment,
  }).status, 'recorded');
  assert.equal(recordCopilotObservation({ ...payload, timestamp: 1000 }, {
    environment: prepared.environment,
  }).status, 'ignored');
});

test('hook CLI is a quiet no-op without an attempt binding and fails closed on malformed input', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_ORCHESTRATOR_')) delete env[key];
  for (const input of ['{}', '{broken', 'x'.repeat(256 * 1024 + 1)]) {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'copilot-session.js'), 'sessionStart'], {
      env, input, encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), '{}');
  }
});

test('two real hook processes contend on one durable receipt without overwriting or launching an engine', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  const input = JSON.stringify({ sessionId: attempt.attempt_id, timestamp: 1000, cwd: root, source: 'startup' });
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'copilot-session.js'), 'sessionStart'], {
      env: { ...process.env, ...prepared.environment }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.on('close', (code) => { assert.equal(code, 0); assert.equal(output.trim(), '{}'); resolve(); });
    child.stdin.end(input);
  });
  await Promise.all([invoke(), invoke()]);
  const receipt = readAttemptChannel(attempt, { artifactRoot: root }).startup;
  assert.equal(receipt.session_id, attempt.attempt_id);
  assert.equal(receipt.process, undefined);
  assert.equal(fs.existsSync(`${prepared.paths.startup}.claim`), false);
});
