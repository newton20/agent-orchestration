'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertArtifactPath } = require('./artifact-path');
const { canonicalPath } = require('./workspace-owner');
const { canonicalJson } = require('./state-store');

const MAX_BYTES = 256 * 1024;
const ID_FIELDS = ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINES = ['claude', 'agency-claude', 'agency-copilot'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identityOf = (value) => Object.fromEntries(ID_FIELDS.map((key) => [key, value[key]]));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);

function pathsFor(root, identity) {
  for (const key of ID_FIELDS.filter((key) => key !== 'review_iteration')) {
    if (typeof identity[key] !== 'string' || !/^(?!\.+$)[A-Za-z0-9._-]{1,128}$/.test(identity[key]) ||
        ['__proto__', 'constructor', 'prototype'].includes(identity[key])) throw new Error('invalid attempt identity');
  }
  if (!Number.isSafeInteger(identity.review_iteration) || identity.review_iteration < 0 ||
      !UUID_V4.test(identity.attempt_id)) throw new Error('invalid attempt identity');
  const directory = path.join(root, 'docs', 'orchestration', 'runs', identity.run_id,
    'phases', identity.phase_id, identity.role, String(identity.review_iteration), identity.attempt_id);
  const paths = {
    directory, prompt: path.join(directory, `${identity.role}-prompt.md`),
    binding: path.join(directory, 'engine-binding.json'),
    startup: path.join(directory, 'engine-startup.json'),
    submission: path.join(directory, 'engine-submission.json'),
    interruption: path.join(directory, 'engine-interruption.json'),
  };
  for (const file of Object.values(paths)) assertArtifactPath(root, file);
  return paths;
}

function readBytes(root, file) {
  assertArtifactPath(root, file);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('attempt channel requires a bounded regular file');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length !== stat.size) throw new Error('attempt channel file changed during read');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function readJson(root, file) {
  const bytes = readBytes(root, file);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

function publishExclusive(root, file, data) {
  const prior = readJson(root, file);
  if (prior !== null) {
    if (!equal(prior, data)) throw new Error('immutable attempt channel publication conflict');
    return false;
  }
  const claim = `${file}.claim`;
  assertArtifactPath(root, claim);
  let fd;
  try { fd = fs.openSync(claim, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('ambiguous attempt channel publication; intervention required');
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${canonicalJson(data)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // Keep interrupted claims. Reclaiming one could replay an externally observed publication.
  assertArtifactPath(root, file);
  try { fs.linkSync(claim, file); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fs.unlinkSync(claim);
    if (!equal(readJson(root, file), data)) throw new Error('immutable attempt channel publication conflict');
    return false;
  }
  fs.unlinkSync(claim);
  return true;
}

function kickoffFor(binding) {
  return `Read the full assignment at ${JSON.stringify(binding.prompt_path)} and execute only that assignment. ` +
    `Verify its SHA256 is ${binding.prompt_sha256} before acting. ` +
    `Attempt identity: ${canonicalJson(identityOf(binding))}. Launch token: ${binding.launch_token}. ` +
    'Report only through the attempt-bound artifact paths in that assignment.';
}

function validateBinding(binding, root) {
  if (!binding || binding.schema_version !== 1 || binding.kind !== 'engine_binding' ||
      !ENGINES.includes(binding.engine) || binding.access !== 'mutating' ||
      !UUID_V4.test(binding.launch_token || '') || binding.session_id !== binding.attempt_id ||
      typeof binding.prompt_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.prompt_sha256)) {
    throw new Error('invalid immutable attempt binding');
  }
  const paths = pathsFor(root, binding);
  if (binding.prompt_path !== paths.prompt || binding.workdir !== canonicalPath(binding.workdir)) {
    throw new Error('attempt artifact or working directory identity mismatch');
  }
  const prompt = readBytes(root, paths.prompt);
  if (!prompt || sha256(prompt) !== binding.prompt_sha256) throw new Error('persisted prompt hash mismatch');
  if (binding.kickoff !== kickoffFor(binding) || Buffer.byteLength(binding.kickoff) > 4096) {
    throw new Error('invalid bounded attempt kickoff');
  }
  return paths;
}

function buildAttemptBinding(attempt, { artifactRoot }) {
  const paths = pathsFor(artifactRoot, attempt);
  if (attempt.artifacts?.directory !== paths.directory || attempt.artifacts?.prompt !== paths.prompt) {
    throw new Error('attempt artifact identity mismatch');
  }
  if (attempt.access === 'read-only') throw new Error('read-only enforcement is unproven');
  if (typeof attempt.intent?.prompt_text !== 'string' ||
      sha256(attempt.intent.prompt_text) !== attempt.intent.prompt_sha256) throw new Error('immutable prompt hash mismatch');
  const binding = {
    schema_version: 1, kind: 'engine_binding', ...identityOf(attempt), engine: attempt.engine,
    access: attempt.access, workdir: attempt.workdir, session_id: attempt.attempt_id,
    launch_token: attempt.intent.launch_token, prompt_path: paths.prompt,
    prompt_sha256: attempt.intent.prompt_sha256,
  };
  binding.kickoff = kickoffFor(binding);
  validateBinding(binding, artifactRoot);
  return binding;
}

function prepareAttemptChannel(attempt, { artifactRoot }) {
  if (attempt.outcome) throw new Error('terminal attempt cannot prepare another kickoff');
  if (!['queued', 'launching'].includes(attempt.status)) throw new Error('attempt channel preparation requires a dispatch intent');
  const binding = buildAttemptBinding(attempt, { artifactRoot });
  const paths = pathsFor(artifactRoot, attempt);
  publishExclusive(artifactRoot, paths.binding, binding);
  return {
    binding, paths, environment: {
      AGENT_ORCHESTRATOR_ROOT: artifactRoot,
      AGENT_ORCHESTRATOR_ATTEMPT: paths.binding,
      AGENT_ORCHESTRATOR_TOKEN: binding.launch_token,
      AGENT_ORCHESTRATOR_IDENTITY: canonicalJson(identityOf(binding)),
      // The installed V1 context hook must not consume an unrelated tokenless pending prompt.
      AGENT_FLAG_TOKEN: binding.launch_token,
    },
  };
}

function receiptBase(binding, kind) {
  return {
    schema_version: 1, kind, ...identityOf(binding), engine: binding.engine,
    session_id: binding.session_id, launch_token: binding.launch_token, cwd: binding.workdir,
    binding_sha256: sha256(canonicalJson(binding)), kickoff_sha256: sha256(binding.kickoff),
  };
}

function validateReceipt(receipt, binding, kind) {
  if (receipt === null) return null;
  const base = receiptBase(binding, kind);
  if (!receipt || Object.entries(base).some(([key, value]) => receipt[key] !== value) ||
      typeof receipt.observed_at !== 'string' || !Number.isFinite(Date.parse(receipt.observed_at)) ||
      (receipt.event_timestamp !== null && (!Number.isFinite(receipt.event_timestamp) || receipt.event_timestamp < 0)) ||
      (kind === 'engine_startup' && receipt.source !== 'startup') ||
      (kind === 'engine_submission' && receipt.acknowledged !== true) ||
      (kind === 'engine_interruption' && !['resume', 'new', 'clear', 'compact'].includes(receipt.source))) {
    throw new Error('receipt provenance or identity mismatch');
  }
  return receipt;
}

function readReceipts(root, paths, binding) {
  return Object.fromEntries(['startup', 'submission', 'interruption'].map((kind) => [
    kind, validateReceipt(readJson(root, paths[kind]), binding, `engine_${kind}`),
  ]));
}

function readAttemptChannel(attempt, { artifactRoot }) {
  const expected = buildAttemptBinding(attempt, { artifactRoot });
  const paths = pathsFor(artifactRoot, attempt);
  const binding = readJson(artifactRoot, paths.binding);
  if (binding === null) return { binding: null, startup: null, submission: null, interruption: null };
  if (!equal(binding, expected)) throw new Error('immutable attempt binding identity mismatch');
  return { binding, ...readReceipts(artifactRoot, paths, binding) };
}

function eventKind(event) {
  if (['sessionStart', 'SessionStart'].includes(event)) return 'startup';
  if (['userPromptSubmitted', 'UserPromptSubmit'].includes(event)) return 'submission';
  return null;
}

function payloadField(payload, camel, snake) {
  if (payload[camel] !== undefined && payload[snake] !== undefined && payload[camel] !== payload[snake]) {
    throw new Error('inconsistent hook payload aliases');
  }
  return payload[camel] ?? payload[snake];
}

function recordHookObservation({ engineFamily, event, payload, environment = process.env }) {
  const ignored = { status: 'ignored' };
  const root = environment.AGENT_ORCHESTRATOR_ROOT;
  const file = environment.AGENT_ORCHESTRATOR_ATTEMPT;
  const token = environment.AGENT_ORCHESTRATOR_TOKEN;
  if (!root || !file || !token || !environment.AGENT_ORCHESTRATOR_IDENTITY) return ignored;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ignored;
  const kind = eventKind(event || payload.hook_event_name);
  if (!kind || (payload.hook_event_name && eventKind(payload.hook_event_name) !== kind)) return ignored;
  const binding = readJson(root, file);
  if (!binding || binding.launch_token !== token) return ignored;
  const paths = validateBinding(binding, root);
  if (file !== paths.binding || !equal(identityOf(binding), JSON.parse(environment.AGENT_ORCHESTRATOR_IDENTITY))) return ignored;
  if ((engineFamily === 'copilot' && binding.engine !== 'agency-copilot') ||
      (engineFamily === 'claude' && !['claude', 'agency-claude'].includes(binding.engine)) ||
      !['copilot', 'claude'].includes(engineFamily)) return ignored;
  let sessionId, initialPrompt;
  try {
    sessionId = payloadField(payload, 'sessionId', 'session_id');
    initialPrompt = payloadField(payload, 'initialPrompt', 'initial_prompt');
  } catch { return ignored; }
  if (sessionId !== binding.session_id || typeof payload.cwd !== 'string') return ignored;
  try { if (canonicalPath(payload.cwd) !== binding.workdir) return ignored; } catch { return ignored; }
  let eventTimestamp = null;
  if (engineFamily === 'copilot') {
    const compatible = ['SessionStart', 'UserPromptSubmit'].includes(event || payload.hook_event_name);
    eventTimestamp = compatible && typeof payload.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(payload.timestamp)
      ? Date.parse(payload.timestamp) : payload.timestamp;
    if (typeof eventTimestamp !== 'number' || !Number.isSafeInteger(eventTimestamp) || eventTimestamp < 0 ||
        !Number.isFinite(new Date(eventTimestamp).getTime())) return ignored;
  }
  const receipt = (name) => ({
    ...receiptBase(binding, `engine_${name}`), event_timestamp: eventTimestamp,
    observed_at: new Date(eventTimestamp ?? Date.now()).toISOString(),
  });
  const prior = readReceipts(root, paths, binding);
  if (kind === 'startup' && payload.source !== 'startup') {
    if (['resume', 'new', 'clear', 'compact'].includes(payload.source) && !prior.interruption) {
      publishExclusive(root, paths.interruption, { ...receipt('interruption'), source: payload.source });
    }
    return ignored;
  }
  if (prior.interruption) return ignored;
  if (kind === 'startup') {
    if (initialPrompt !== undefined && initialPrompt !== binding.kickoff) return ignored;
    if (prior.startup) return { status: 'duplicate' };
    publishExclusive(root, paths.startup, { ...receipt('startup'), source: 'startup' });
  } else {
    if (payload.prompt !== binding.kickoff || !prior.startup ||
        (eventTimestamp !== null && eventTimestamp < prior.startup.event_timestamp)) return ignored;
    if (prior.submission) return { status: 'duplicate' };
    publishExclusive(root, paths.submission, { ...receipt('submission'), acknowledged: true });
  }
  return { status: 'recorded' };
}

function hasCanonicalProcessCorrelation(attempt) {
  const process = attempt.engine_process;
  return attempt.session_id === attempt.attempt_id && process &&
    Number.isSafeInteger(process.pid) && process.pid > 0 &&
    typeof process.creation_time === 'string' && Number.isFinite(Date.parse(process.creation_time)) &&
    typeof process.hostname === 'string' && process.hostname.length > 0 &&
    process.hostname.toLowerCase() === attempt.launch_host?.hostname?.toLowerCase() &&
    typeof process.host_boot_id === 'string' && process.host_boot_id.length > 0 &&
    process.host_boot_id === attempt.launch_host?.host_boot_id &&
    !(attempt.engine !== 'claude' && process.pid === attempt.launch_process?.pid);
}

async function reconcileAttemptChannel(attempt, { artifactRoot, observe }) {
  // Hooks cannot prove closure of unknown descendants, including on historical terminal attempts.
  if (attempt.outcome) return { status: 'closure_unproven', reason: 'descendant lifetime is not tracked' };
  if (attempt.status === 'queued') return { status: 'not_dispatched' };
  if (attempt.submission?.acknowledged === true) return { status: 'already_observed' };
  const channel = readAttemptChannel(attempt, { artifactRoot });
  if (!channel.binding || !channel.startup || !channel.submission || channel.interruption) {
    return { status: 'needs_operator', reason: 'uninterrupted startup and exact user submission are unproven; replay denied' };
  }
  // Canonical session/process correlation must come from independent OS evidence, never a hook PID.
  if (!hasCanonicalProcessCorrelation(attempt)) {
    return { status: 'needs_operator', reason: 'independent engine process/session correlation is required; hook payload has no process evidence' };
  }
  if (typeof observe !== 'function') throw new Error('awaited observation callback is required');
  await observe({
    ...identityOf(attempt), id: `engine-submission-${sha256(canonicalJson(channel.submission))}`,
    kind: 'submission', acknowledged: true,
  });
  return { status: 'submission_observed' };
}

async function runObservationHookCli(record) {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes <= MAX_BYTES) chunks.push(chunk);
    }
    if (bytes > MAX_BYTES) throw new Error('hook input exceeds attempt observation size limit');
    record(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      event: process.argv[2], environment: process.env,
    });
  } catch (error) {
    process.stderr.write(`[attempt-observation] ${error.message}\n`);
  }
  process.stdout.write('{}\n');
}

module.exports = {
  buildAttemptBinding, prepareAttemptChannel, readAttemptChannel, recordHookObservation,
  reconcileAttemptChannel, runObservationHookCli,
};
