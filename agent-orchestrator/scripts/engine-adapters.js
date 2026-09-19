'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ENGINES = Object.freeze(['claude', 'agency-claude', 'agency-copilot']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVOCATION_KEYS = ['engine', 'executable', 'pluginDir', 'access', 'permissionMode',
  'kickoff', 'sessionName', 'sessionId', 'model'];

function knownOptions(options, keys) {
  for (const key of Object.keys(options)) {
    if (!keys.includes(key)) throw new Error(`unsupported option: ${key}`);
  }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function capabilitiesFor(engine) {
  if (!ENGINES.includes(engine)) throw new Error(`unsupported engine: ${engine}`);
  return Object.freeze({
    engines: Object.freeze([engine]), read_only_enforced: false,
    tracks_descendants: false, live_verified: false,
  });
}

function resolveEngineExecutable(engine, { pathValue = process.env.PATH || '' } = {}) {
  capabilitiesFor(engine);
  const name = engine === 'claude' ? 'claude' : 'agency';
  for (const value of pathValue.split(path.delimiter).filter(Boolean)) {
    const directory = path.resolve(value.replace(/^"(.*)"$/, '$1'));
    for (const extension of ['.exe', '.cmd', '.bat', '.ps1']) {
      const candidate = path.join(directory, `${name}${extension}`);
      let stat;
      try { stat = fs.statSync(candidate); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      if (extension !== '.exe') throw new Error(`unsupported PATH shell shim: ${candidate}; put the native executable on PATH`);
      return fs.realpathSync.native(candidate);
    }
  }
  throw new Error(`${name}.exe is missing from PATH`);
}

function buildEngineInvocation(options) {
  knownOptions(options, INVOCATION_KEYS);
  const { engine, executable, pluginDir, access, kickoff, sessionName, sessionId, model } = options;
  capabilitiesFor(engine);
  absolute(executable, 'executable');
  absolute(pluginDir, 'plugin directory');
  if (access === 'read-only') throw new Error('read-only enforcement is not proven for this engine');
  if (access !== 'mutating') throw new Error('explicit mutating access is required');
  if (!UUID_V4.test(sessionId || '')) throw new Error('explicit UUIDv4 session ID is required');
  if (typeof kickoff !== 'string' || !kickoff.trim() || kickoff.startsWith('-') ||
      kickoff.includes('\0') || Buffer.byteLength(kickoff) > 4096) throw new Error('bounded kickoff task is required');
  if (typeof sessionName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionName)) {
    throw new Error('invalid session name');
  }
  if (model != null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))) {
    throw new Error('invalid explicit model');
  }
  let permissionMode = options.permissionMode ?? 'default';
  let args;
  if (engine === 'agency-copilot') {
    if (permissionMode !== 'default') throw new Error('unsupported Copilot permission policy');
    args = ['copilot', '--plugin', `local:${pluginDir}`, '--session-id', sessionId];
    if (model != null) args.push('--model', model);
    args.push('--interactive', kickoff);
  } else {
    if (permissionMode === 'default') permissionMode = 'manual';
    if (permissionMode === 'bypassPermissions') throw new Error('privileged permission mode requires separate live consent; unsupported');
    if (!['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan'].includes(permissionMode)) {
      throw new Error('unsupported Claude permission policy');
    }
    args = engine === 'agency-claude' ? ['claude', '--plugin', `local:${pluginDir}`] : ['--plugin-dir', pluginDir];
    args.push('--session-id', sessionId, '--name', sessionName, '--permission-mode', permissionMode);
    if (model != null) args.push('--model', model);
    args.push(kickoff);
  }
  return { file: executable, args };
}

function hasToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_./:-])${escaped}(?=$|[^A-Za-z0-9_./:-])`).test(text);
}

function inspectEnginePreflight(options, { probe = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], shell: false,
}) } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required');
  const invocation = buildEngineInvocation(options);
  try {
    if (!/\.exe$/i.test(options.executable) || !fs.statSync(options.executable).isFile()) {
      throw new Error('installed absolute executable required; shell shims are unsupported');
    }
  } catch (error) { throw new Error(`executable preflight failed: ${error.message}`); }
  for (const relative of [
    path.join('.claude-plugin', 'plugin.json'),
    options.engine === 'agency-copilot' ? 'hooks.json' : path.join('hooks', 'hooks.json'),
    ...(options.engine === 'claude' ? [] : ['agency.json']),
  ]) {
    const file = path.join(options.pluginDir, relative);
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) { throw new Error(`plugin preflight failed for ${relative}: ${error.message}`); }
  }
  const hook = options.engine === 'agency-copilot' ? 'copilot-session.js' : 'claude-observation.js';
  for (const relative of [
    path.join('hooks', hook), path.join('scripts', 'attempt-channel.js'),
    path.join('scripts', 'node_modules', 'js-yaml', 'package.json'),
  ]) {
    try {
      if (!fs.statSync(path.join(options.pluginDir, relative)).isFile()) throw new Error('not a regular file');
    } catch (error) { throw new Error(`plugin runtime preflight failed for ${relative}: ${error.message}`); }
  }
  const run = (args) => {
    try {
      const output = probe(invocation.file, args);
      if (typeof output !== 'string' || !output.trim() || Buffer.byteLength(output) > 256 * 1024) {
        throw new Error('missing or oversized capability response');
      }
      return output.trim();
    } catch (error) { throw new Error(`preflight ${args.join(' ')} failed: ${error.message}`); }
  };
  const agency = options.engine !== 'claude';
  let agencyVersion = null;
  if (agency) {
    agencyVersion = run(['--version']);
    if (!/agency/i.test(agencyVersion) || !/\d+\.\d+\.\d+/.test(agencyVersion)) {
      throw new Error('preflight Agency version is unproven');
    }
  }
  const prefix = agency ? [options.engine === 'agency-copilot' ? 'copilot' : 'claude'] : [];
  const engineVersion = run([...prefix, '--version']);
  const engineName = options.engine === 'agency-copilot' ? /copilot/i : /claude/i;
  if (!engineName.test(engineVersion) || !/\d+\.\d+\.\d+/.test(engineVersion)) {
    throw new Error('preflight selected-engine version is unproven; native installation is not wrapper selection evidence');
  }
  const help = run([...prefix, '--help']);
  const required = options.engine === 'agency-copilot'
    ? ['--interactive', '--session-id']
    : ['--session-id', '--name', '--permission-mode', ...(agency ? [] : ['--plugin-dir'])];
  if (agency) required.push('--plugin');
  if (options.model != null) required.push('--model');
  for (const flag of required) {
    if (!hasToken(help, flag)) throw new Error(`preflight installed engine lacks ${flag} capability`);
  }
  if (options.model != null) {
    const modelSection = /--model\b[\s\S]*?(?=\r?\n\s+-{1,2}[A-Za-z]|\r?\n\s*\r?\n|$)/.exec(help)?.[0];
    if (!modelSection || !hasToken(modelSection, options.model)) {
      throw new Error(`preflight model ${options.model} is unproven by installed help; no alias substitution`);
    }
  }
  if (options.engine !== 'agency-copilot') {
    const mode = options.permissionMode && options.permissionMode !== 'default' ? options.permissionMode : 'manual';
    const section = /--permission-mode\b[\s\S]*?(?=\r?\n\s+-{1,2}[A-Za-z]|\r?\n\s*\r?\n|$)/.exec(help)?.[0];
    if (!section || !hasToken(section, mode)) throw new Error(`preflight permission mode ${mode} is unproven`);
  }
  return {
    invocation, agency_version: agencyVersion, engine_version: engineVersion,
    executable_sha256: createHash('sha256').update(fs.readFileSync(invocation.file)).digest('hex'),
    help_sha256: createHash('sha256').update(help).digest('hex'),
    live_verified: false,
  };
}

function createEngineAdapter(options) {
  knownOptions(options, ['engine', 'executable', 'pluginDir', 'artifactRoot', 'permissionMode', 'shell']);
  const config = { ...options };
  const capabilities = capabilitiesFor(config.engine);
  absolute(config.executable, 'executable');
  absolute(config.pluginDir, 'plugin directory');
  absolute(config.artifactRoot, 'artifact root');
  return Object.freeze({
    kind: 'engine', capabilities,
    async prepareCandidate(attempt, preflightOptions) {
      const channel = require('./attempt-channel');
      const binding = channel.buildAttemptBinding(attempt, { artifactRoot: config.artifactRoot });
      if (attempt.engine !== config.engine) throw new Error('adapter engine does not match immutable attempt');
      const invocationOptions = {
        engine: config.engine, executable: config.executable, pluginDir: config.pluginDir,
        permissionMode: config.permissionMode ?? 'default', access: attempt.access,
        model: attempt.model, kickoff: binding.kickoff,
        sessionId: binding.session_id, sessionName: attempt.intent.session_name,
      };
      const preflight = inspectEnginePreflight(invocationOptions, preflightOptions);
      const { buildEngineSpawnCommand } = require('./spawn-session');
      if (typeof buildEngineSpawnCommand !== 'function') throw new Error('pure engine spawn builder integration is unavailable');
      const prepared = channel.prepareAttemptChannel(attempt, { artifactRoot: config.artifactRoot });
      prepared.environment.AGENT_ORCHESTRATOR_PLUGIN_ROOT = config.pluginDir;
      prepared.environment.AGENT_ORCHESTRATOR_ENGINE = config.engine;
      prepared.environment.AGENT_ORCHESTRATOR_NODE = process.execPath;
      const spawn = buildEngineSpawnCommand({
        workdir: attempt.workdir, title: attempt.intent.session_name, invocation: preflight.invocation,
        environment: prepared.environment, shell: config.shell ?? 'powershell',
      });
      return { kind: 'engine_candidate', live_verified: false, preflight, channel: prepared, spawn };
    },
    async launch() {
      // Enabling production dispatch requires separately reviewed live evidence, not a runtime flag.
      throw new Error('production launch disabled pending separate live acceptance');
    },
    async reconcile(attempt, context) {
      if (attempt.engine !== config.engine) throw new Error('adapter engine does not match immutable attempt');
      return require('./attempt-channel').reconcileAttemptChannel(attempt, {
        ...context, artifactRoot: config.artifactRoot,
      });
    },
  });
}

module.exports = { capabilitiesFor, resolveEngineExecutable, buildEngineInvocation, inspectEnginePreflight, createEngineAdapter };
