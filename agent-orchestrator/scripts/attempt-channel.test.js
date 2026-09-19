'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { attemptFixture } = require('./attempt-channel.test-support');
const {
  buildAttemptBinding, prepareAttemptChannel, readAttemptChannel, recordHookObservation, reconcileAttemptChannel,
} = require('./attempt-channel');

function hook(prepared, event, payload = {}) {
  return recordHookObservation({
    engineFamily: 'copilot', event, environment: prepared.environment,
    payload: {
      sessionId: prepared.binding.session_id, timestamp: 1000, cwd: prepared.binding.workdir,
      ...(event === 'sessionStart' ? { source: 'startup' } : { prompt: prepared.binding.kickoff }),
      ...payload,
    },
  });
}

test('binding pins exact immutable identity and hashes while keeping the submitted task short', (t) => {
  const { root, attempt } = attemptFixture(t);
  attempt.intent.prompt_text = 'full assignment '.repeat(15000);
  attempt.intent.prompt_sha256 = createHash('sha256').update(attempt.intent.prompt_text).digest('hex');
  fs.writeFileSync(attempt.artifacts.prompt, attempt.intent.prompt_text);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  assert.equal(prepared.binding.session_id, attempt.attempt_id);
  assert.equal(prepared.binding.launch_token, attempt.intent.launch_token);
  assert.equal(prepared.binding.review_iteration, 0);
  assert.ok(prepared.binding.kickoff.includes(attempt.intent.prompt_sha256));
  assert.ok(prepared.binding.kickoff.includes(attempt.intent.launch_token));
  assert.ok(Buffer.byteLength(prepared.binding.kickoff) < 4096);
  assert.deepEqual(prepareAttemptChannel(attempt, { artifactRoot: root }), prepared);
  const changed = structuredClone(attempt);
  changed.intent.launch_token = randomUUID();
  assert.throws(() => prepareAttemptChannel(changed, { artifactRoot: root }), /immutable|conflict/);
});

test('prompt corruption, mismatched identity paths and traversal are rejected before publication', (t) => {
  const { root, attempt } = attemptFixture(t);
  fs.appendFileSync(attempt.artifacts.prompt, 'tampered');
  assert.throws(() => buildAttemptBinding(attempt, { artifactRoot: root }), /prompt.*hash/);
  fs.writeFileSync(attempt.artifacts.prompt, attempt.intent.prompt_text);
  for (const changed of [
    { ...attempt, phase_id: '../escape' },
    { ...attempt, review_iteration: -1 },
    { ...attempt, artifacts: { ...attempt.artifacts, prompt: path.join(root, 'elsewhere.md') } },
  ]) assert.throws(() => prepareAttemptChannel(changed, { artifactRoot: root }), /identity|artifact/);
  assert.equal(fs.existsSync(path.join(attempt.artifacts.directory, 'engine-binding.json')), false);
});

test('exclusive unfinished publication is ambiguous and never silently reclaimed', (t) => {
  const { root, attempt } = attemptFixture(t);
  const claim = path.join(attempt.artifacts.directory, 'engine-binding.json.claim');
  fs.writeFileSync(claim, 'interrupted publication');
  assert.throws(() => prepareAttemptChannel(attempt, { artifactRoot: root }), /ambiguous.*publication/);
  assert.equal(fs.readFileSync(claim, 'utf8'), 'interrupted publication');
});

test('a publisher that wins after the initial read does not leave a new orphan claim', (t) => {
  const { root, attempt } = attemptFixture(t);
  const binding = buildAttemptBinding(attempt, { artifactRoot: root });
  const file = path.join(attempt.artifacts.directory, 'engine-binding.json');
  const originalOpen = fs.openSync;
  let raced = false;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (target === `${file}.claim` && !raced) {
      raced = true;
      fs.writeFileSync(file, JSON.stringify(binding));
    }
    return originalOpen(target, ...args);
  });
  assert.deepEqual(prepareAttemptChannel(attempt, { artifactRoot: root }).binding, binding);
  assert.ok(raced);
  assert.equal(fs.existsSync(`${file}.claim`), false);
});

test('redirected artifact directories and receipt files are rejected', (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  const redirected = path.join(root, 'redirected');
  fs.mkdirSync(redirected);
  fs.symlinkSync(redirected, prepared.paths.startup, 'junction');
  assert.throws(() => hook(prepared, 'sessionStart'), /redirected/);
  assert.throws(() => readAttemptChannel(attempt, { artifactRoot: root }), /redirected/);
});

test('startup/context is not submission; exact user prompt follows startup once', (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  assert.equal(hook(prepared, 'userPromptSubmitted').status, 'ignored');
  assert.equal(hook(prepared, 'sessionStart', { initialPrompt: prepared.binding.kickoff }).status, 'recorded');
  assert.equal(readAttemptChannel(attempt, { artifactRoot: root }).submission, null);
  assert.equal(hook(prepared, 'userPromptSubmitted', { prompt: 'different task' }).status, 'ignored');
  assert.equal(hook(prepared, 'userPromptSubmitted').status, 'recorded');
  const before = fs.readFileSync(prepared.paths.submission, 'utf8');
  assert.equal(hook(prepared, 'userPromptSubmitted').status, 'duplicate');
  assert.equal(fs.readFileSync(prepared.paths.submission, 'utf8'), before);
});

test('wrong token, session, cwd, initial prompt and snake/camel conflicts cannot steal a receipt', (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  for (const payload of [
    { sessionId: randomUUID() }, { session_id: randomUUID() }, { cwd: path.dirname(root) },
    { initialPrompt: 'wrong kickoff' }, { timestamp: '1000' },
  ]) assert.equal(hook(prepared, 'sessionStart', payload).status, 'ignored');
  const wrong = { ...prepared, environment: { ...prepared.environment, AGENT_ORCHESTRATOR_TOKEN: randomUUID() } };
  assert.equal(hook(wrong, 'sessionStart').status, 'ignored');
  assert.equal(fs.existsSync(prepared.paths.startup), false);
  assert.equal(fs.existsSync(prepared.paths.binding), true);
});

test('resume/new/clear/compact never acknowledge kickoff or allow delayed submission', (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  const startup = fs.readFileSync(prepared.paths.startup, 'utf8');
  for (const source of ['resume', 'new', 'clear', 'compact']) {
    assert.equal(hook(prepared, 'sessionStart', { source, timestamp: 2000 }).status, 'ignored');
    assert.equal(hook(prepared, 'userPromptSubmitted', { timestamp: 3000 }).status, 'ignored');
  }
  assert.equal(fs.readFileSync(prepared.paths.startup, 'utf8'), startup);
  assert.equal(fs.existsSync(prepared.paths.submission), false);
});

test('receipt identity corruption is rejected rather than repaired or acknowledged', (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  const receipt = JSON.parse(fs.readFileSync(prepared.paths.startup, 'utf8'));
  receipt.review_iteration = 1;
  fs.writeFileSync(prepared.paths.startup, JSON.stringify(receipt));
  assert.throws(() => readAttemptChannel(attempt, { artifactRoot: root }), /receipt.*identity/);
});

test('restart reconciliation never launches or invents engine process evidence from a hook', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted', { pid: 999 });
  const observations = [];
  const result = await reconcileAttemptChannel(attempt, { artifactRoot: root, observe: async (o) => observations.push(o) });
  assert.equal(result.status, 'needs_operator');
  assert.match(result.reason, /process.*correlation/);
  assert.deepEqual(observations, []);
  assert.equal(readAttemptChannel(attempt, { artifactRoot: root }).submission.process, undefined);
});

test('reconcile acknowledges exact submission only after canonical process/session correlation, awaiting observe', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted');
  attempt.session_id = attempt.attempt_id;
  attempt.engine_process = { pid: 42, creation_time: '2026-09-18T00:00:00.000Z', ...attempt.launch_host };
  const observed = [];
  let callbackFinished = false;
  const reconcile = () => reconcileAttemptChannel(attempt, { artifactRoot: root, observe: async (o) => {
    await new Promise((resolve) => setImmediate(resolve));
    observed.push(o);
    callbackFinished = true;
  } });
  assert.equal((await reconcile()).status, 'submission_observed');
  assert.equal(callbackFinished, true);
  assert.equal(observed[0].kind, 'submission');
  assert.equal(observed[0].acknowledged, true);
  assert.equal(observed[0].attempt_id, attempt.attempt_id);
  await reconcile();
  assert.deepEqual(observed[1], observed[0], 'durable receipt produces stable observation ID after restart');
  attempt.submission = { acknowledged: true };
  await reconcile();
  assert.equal(observed.length, 2);
});

test('incomplete or wrong-host canonical process evidence does not authorize submission', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted');
  attempt.session_id = attempt.attempt_id;
  for (const process of [
    { pid: 42 }, { pid: 42, creation_time: null, ...attempt.launch_host },
    { pid: 42, creation_time: '2026-09-18T00:00:00Z', hostname: 'other-host', host_boot_id: 'test-boot' },
  ]) {
    attempt.engine_process = process;
    const result = await reconcileAttemptChannel(attempt, { artifactRoot: root, observe() { assert.fail('unproven process'); } });
    assert.equal(result.status, 'needs_operator');
  }
});

test('historical terminal attempts accept no fresh acknowledgement or closure claims', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted');
  attempt.session_id = attempt.attempt_id;
  attempt.engine_process = { pid: 42, creation_time: '2026-09-18T00:00:00.000Z', ...attempt.launch_host };
  attempt.outcome = { type: 'completed' };
  const before = fs.readdirSync(attempt.artifacts.directory).sort();
  const result = await reconcileAttemptChannel(attempt, {
    artifactRoot: root, observe() { assert.fail('terminal observations are closure-only and closure is unproven'); },
  });
  assert.equal(result.status, 'closure_unproven');
  assert.deepEqual(fs.readdirSync(attempt.artifacts.directory).sort(), before);
  assert.throws(() => prepareAttemptChannel(attempt, { artifactRoot: root }), /terminal/);
});

test('wrong tuple identity never reads another attempt receipt', (t) => {
  const { root, attempt } = attemptFixture(t);
  prepareAttemptChannel(attempt, { artifactRoot: root });
  for (const [field, value] of Object.entries({
    run_id: 'other-run', phase_id: 'other-phase', role: 'qa', review_iteration: 1, attempt_id: randomUUID(),
  })) {
    assert.throws(() => readAttemptChannel({ ...attempt, [field]: value }, { artifactRoot: root }), /artifact identity/);
  }
});

test('observation failure propagates without changing receipts or creating asynchronous callbacks', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted');
  attempt.session_id = attempt.attempt_id;
  attempt.engine_process = { pid: 42, creation_time: '2026-09-18T00:00:00.000Z', ...attempt.launch_host };
  const before = fs.readFileSync(prepared.paths.submission, 'utf8');
  let calls = 0;
  await assert.rejects(reconcileAttemptChannel(attempt, {
    artifactRoot: root, async observe() { calls++; throw new Error('canonical store unavailable'); },
  }), /canonical store unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(prepared.paths.submission, 'utf8'), before);
});

test('an Agency wrapper canonical launch PID is not accepted as the engine process', async (t) => {
  const { root, attempt } = attemptFixture(t);
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  hook(prepared, 'sessionStart');
  hook(prepared, 'userPromptSubmitted');
  attempt.session_id = attempt.attempt_id;
  attempt.engine_process = { pid: 42, creation_time: '2026-09-18T00:00:00.000Z', ...attempt.launch_host };
  attempt.launch_process = { ...attempt.engine_process };
  assert.equal((await reconcileAttemptChannel(attempt, {
    artifactRoot: root, observe() { assert.fail('wrapper cannot prove engine identity'); },
  })).status, 'needs_operator');
});

test('V2 worker environment isolates the legacy pending-context hook from unrelated prompts', (t) => {
  const { root, attempt } = attemptFixture(t, 'claude');
  const prepared = prepareAttemptChannel(attempt, { artifactRoot: root });
  assert.equal(prepared.environment.AGENT_FLAG_TOKEN, attempt.intent.launch_token);
  const legacy = path.join(root, 'docs', 'orchestration', '.pending-unrelated');
  fs.writeFileSync(legacy, 'Legacy assignment for another session');
  const { runHook } = require('../hooks/session-start');
  const output = runHook({ projectDir: root, source: 'startup', tabToken: prepared.environment.AGENT_FLAG_TOKEN });
  assert.equal(output, '{}');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'Legacy assignment for another session');
});
