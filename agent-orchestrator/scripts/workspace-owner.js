'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID, randomBytes } = require('node:crypto');

const handles = new WeakMap();
const MAX_DISCOVERY_BYTES = 64 * 1024;
let platformInfo;

function canonicalPath(value) {
  const resolved = path.normalize(fs.realpathSync.native(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveWorkspace(workdir) {
  try {
    const directory = canonicalPath(workdir);
    if (!fs.statSync(directory).isDirectory()) throw new Error('workdir is not a directory');
    // Ambient Git overrides must not turn a different checkout into this owner.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const root = canonicalPath(execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    }).trim());
    return Object.freeze({ identity_version: 1, kind: 'git-worktree', root, key: root });
  } catch (error) {
    throw new Error(`cannot resolve Git worktree identity for ${workdir}: ${error.message}`);
  }
}

function validateWorkspace(workspace) {
  if (!workspace || workspace.identity_version !== 1 || workspace.kind !== 'git-worktree' ||
      typeof workspace.root !== 'string' || !path.isAbsolute(workspace.root) || workspace.key !== workspace.root ||
      path.normalize(workspace.root) !== workspace.root ||
      (process.platform === 'win32' && workspace.root !== workspace.root.toLowerCase())) {
    throw new Error('invalid canonical workspace identity');
  }
}

function pipeNameFor(workspace, namespace = 'controller') {
  validateWorkspace(workspace);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw new Error('invalid owner namespace');
  const hash = createHash('sha256').update(workspace.key).digest('hex');
  return `\\\\.\\pipe\\agent-orchestrator-${namespace}-${hash}`;
}

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function psString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function getPlatformInfo() {
  if (process.platform !== 'win32') throw new Error('workspace ownership requires Windows named pipes');
  if (!platformInfo) {
    const data = JSON.parse(powershell(
      `$ErrorActionPreference='Stop'; @{ root=[Environment]::GetFolderPath('LocalApplicationData'); ` +
      `sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress`
    ));
    if (!data.root || !path.isAbsolute(data.root) || !/^S-1-/.test(data.sid)) {
      throw new Error('cannot determine private LocalApplicationData directory or current user SID');
    }
    platformInfo = data;
  }
  return platformInfo;
}

function getHostEvidence() {
  const evidence = { hostname: os.hostname(), host_boot_id: null, pid: process.pid, creation_time: null, observation: 'unknown' };
  try {
    const data = JSON.parse(powershell(
      `$ErrorActionPreference='Stop'; $b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime; ` +
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'; ` +
      `@{ boot=$b.ToUniversalTime().ToString('o'); creation=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`
    ));
    if (Number.isFinite(Date.parse(data.boot))) evidence.host_boot_id = data.boot;
    if (Number.isFinite(Date.parse(data.creation))) evidence.creation_time = data.creation;
    evidence.observation = evidence.host_boot_id && evidence.creation_time ? 'complete' : 'unknown';
  } catch (error) {
    evidence.error = `OS identity observation unavailable: ${error.message.split('\n')[0]}`;
  }
  return evidence;
}

function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  try {
    const raw = powershell(
      `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'); ` +
      `if ($p.Count -eq 0) { '{"state":"dead"}' } else { ` +
      `@{ state='live'; creation_time=$p[0].CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`
    );
    return JSON.parse(raw);
  } catch (error) {
    return { state: 'unknown', error: error.message.split('\n')[0] };
  }
}

function readDiscovery(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size > MAX_DISCOVERY_BYTES) throw new Error(`oversized discovery record: ${file}`);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function inspectLegacyLocks(lockPaths, { host = getHostEvidence(), probeProcess: probe = probeProcess } = {}) {
  const drained = [];
  for (const file of [...new Set(lockPaths.map((p) => path.resolve(p)))]) {
    let bytes;
    try {
      if (fs.statSync(file).size > MAX_DISCOVERY_BYTES) throw new Error('oversized legacy lock');
      bytes = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`cannot inspect legacy lock ${file}: ${error.message}`);
    }
    let previous;
    try { previous = JSON.parse(bytes); } catch (error) {
      throw new Error(`corrupt legacy lock ${file}: ${error.message}`);
    }
    let state = 'unknown';
    if (previous && previous.hostname === host.hostname && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
      if (previous.host_boot_id && host.host_boot_id && previous.host_boot_id !== host.host_boot_id) {
        state = 'dead';
      } else {
        let observed;
        try { observed = probe(previous.pid); } catch (error) { observed = { state: 'unknown', error: error.message }; }
        state = observed?.state || 'unknown';
        // Old startedAt could be a wall-clock fallback; only explicit OS
        // creation evidence is safe for a PID-reuse death determination.
        if (state === 'live' && previous.creation_time && observed.creation_time &&
            Number.isFinite(Date.parse(previous.creation_time)) && Number.isFinite(Date.parse(observed.creation_time)) &&
            Date.parse(previous.creation_time) !== Date.parse(observed.creation_time)) state = 'dead';
      }
    }
    if (state !== 'dead') throw new Error(`legacy owner is ${state} at ${file}; drain pre-upgrade controllers before activation`);
    drained.push({ path: file, bytes });
  }
  return drained;
}

function restrictDirectory(directory, sid) {
  fs.mkdirSync(directory, { recursive: true });
  powershell(
    `$ErrorActionPreference='Stop'; $sid=[Security.Principal.SecurityIdentifier]::new(${psString(sid)}); ` +
    `$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ` +
    `$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); ` +
    `$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl(${psString(directory)}, $acl)`
  );
}

function assertOwnership(owner, workspace, namespace = 'controller') {
  validateWorkspace(workspace);
  const held = handles.get(owner);
  if (!held || !held.active || !held.server.listening || held.workspace.key !== workspace.key || held.namespace !== namespace) {
    throw new Error('live kernel workspace ownership is required for mutation');
  }
}

async function acquireWorkspaceOwner(workspace, options = {}) {
  validateWorkspace(workspace);
  workspace = Object.freeze({ ...workspace });
  if (resolveWorkspace(workspace.root).key !== workspace.key) throw new Error('workspace identity changed before ownership acquisition');
  const info = getPlatformInfo();
  const namespace = options.namespace || 'controller';
  const pipeName = pipeNameFor(workspace, namespace);
  const serviceId = randomUUID();
  const runtimeRoot = options._runtimeRoot || path.join(info.root, 'agent-orchestrator', 'runtime');
  const hash = createHash('sha256').update(workspace.key).digest('hex');
  const partition = path.join(runtimeRoot, hash, namespace);
  const instanceDir = path.join(partition, serviceId);
  const discoveryPath = path.join(instanceDir, 'owner.json');
  let readiness = 'starting';
  let evidence;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      let request;
      try { request = JSON.parse(input.trim()); } catch (_) {
        socket.end(JSON.stringify({ ok: false, error: 'invalid request' }) + '\n');
        return;
      }
      const response = request?.type === 'readiness' && request.workspace_key === workspace.key
        ? { ok: true, status: readiness, workspace_key: workspace.key, namespace, service_id: serviceId, process: evidence }
        : { ok: false, error: 'only matching-workspace readiness queries are supported' };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise((resolve, reject) => {
    const failed = (cause) => {
      const error = new Error(`cannot bind workspace owner (${cause.code}): contention or permissions; ${cause.message}`);
      error.code = cause.code === 'EADDRINUSE' ? 'ELOCKED' : cause.code;
      reject(error);
    };
    server.once('error', failed);
    server.listen({ path: pipeName, exclusive: true }, () => { server.removeListener('error', failed); resolve(); });
  });
  const held = { active: true, server, workspace, namespace };
  const capabilityPath = path.join(instanceDir, 'operator-capability.json');
  let capabilityCreated = false;
  let discoveryCreated = false;
  let released = false;
  const owner = Object.freeze({
    workspace, namespace, serviceId, pipeName, discoveryPath,
    setReadiness(status) {
      assertOwnership(owner, workspace, namespace);
      if (typeof status !== 'string' || !status) throw new Error('readiness status is required');
      readiness = status;
    },
    async release() {
      if (released) return;
      released = true;
      held.active = false;
      try {
        if (discoveryCreated && fs.existsSync(discoveryPath)) {
          const record = readDiscovery(discoveryPath);
          if (record.service_id === serviceId && record.workspace_key === workspace.key) {
            fs.unlinkSync(discoveryPath);
            if (capabilityCreated) fs.unlinkSync(capabilityPath);
            fs.rmdirSync(instanceDir);
          }
        } else if (!discoveryCreated && capabilityCreated) {
          fs.unlinkSync(capabilityPath);
          fs.rmdirSync(instanceDir);
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  });
  handles.set(owner, held);
  server.on('error', () => { held.active = false; });
  try {
    evidence = getHostEvidence();
    const locks = inspectLegacyLocks(options.legacyLockPaths || [], { host: evidence, probeProcess: options._probeLegacyProcess || probeProcess });
    fs.mkdirSync(partition, { recursive: true });
    for (const entry of fs.readdirSync(partition, { withFileTypes: true })) {
      if (!entry.isDirectory()) throw new Error('invalid owner discovery partition');
      const recordPath = path.join(partition, entry.name, 'owner.json');
      let record;
      try { record = readDiscovery(recordPath); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (record.schema_version !== 1 || record.workspace_key !== workspace.key || record.namespace !== namespace ||
          record.pipe_name !== pipeName || record.service_id !== entry.name) {
        throw new Error('owner discovery full-key collision or namespace mismatch');
      }
    }
    restrictDirectory(instanceDir, info.sid);
    fs.writeFileSync(capabilityPath, JSON.stringify({
      service_id: serviceId, capability: randomBytes(32).toString('base64url'),
    }), { flag: 'wx', mode: 0o600 });
    capabilityCreated = true;
    fs.writeFileSync(discoveryPath, JSON.stringify({
      schema_version: 1, workspace_key: workspace.key, workspace, namespace, service_id: serviceId,
      pipe_name: pipeName, user_sid: info.sid, process: evidence,
    }), { flag: 'wx', mode: 0o600 });
    discoveryCreated = true;
    for (const lock of locks) {
      if (fs.readFileSync(lock.path, 'utf8') !== lock.bytes) throw new Error(`legacy lock changed during drain: ${lock.path}`);
      fs.unlinkSync(lock.path);
    }
    return owner;
  } catch (error) {
    try { await owner.release(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message}; owner cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

function queryOwner(workspace, { namespace = 'controller' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeNameFor(workspace, namespace));
    let input = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('owner readiness query timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'readiness', workspace_key: workspace.key }) + '\n'));
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > MAX_DISCOVERY_BYTES) socket.destroy(new Error('oversized owner response'));
    });
    socket.on('end', () => {
      try {
        const response = JSON.parse(input);
        if (!response.ok || response.workspace_key !== workspace.key || response.namespace !== namespace) {
          throw new Error('owner readiness full-key mismatch or rejected query');
        }
        resolve(response);
      } catch (error) { reject(error); }
    });
  });
}

module.exports = {
  canonicalPath, resolveWorkspace, validateWorkspace, pipeNameFor, acquireWorkspaceOwner,
  assertOwnership, queryOwner, inspectLegacyLocks, getHostEvidence, probeProcess,
};
