'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const childProcess = require('node:child_process');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const W = require('./workspace-owner');

test('U2 real competing processes respect live checkout claims and durable unresolved reservations after owner shutdown', { timeout: 60000 }, async (t) => {
  const fx = runtimeFixture(t);
  const workspace = W.resolveWorkspace(fx.workdir);
  let owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  const identity = { manifest_path: fx.manifestPath, run_id: 'run', phase_id: 'p1', role: 'qa', review_iteration: 0, attempt_id: 'attempt' };
  W.reserveCheckout(owner, identity);
  assert.throws(() => W.reserveCheckout(owner, { ...identity, attempt_id: 'other' }), /unresolved/);
  assert.throws(() => W.releaseCheckout(owner, { ...identity, attempt_id: 'other' }), /different/);
  for (const held of [true, false]) {
    if (!held) await owner.release();
    const child = fork(path.join(__dirname, 'test-support', 'owner-child.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    });
    await once(child, 'message');
    const reply = once(child, 'message');
    child.send({ workdir: fx.workdir, runtimeRoot: fx.runtimeRoot });
    const [result] = await reply;
    assert.equal(result.acquired, false);
    assert.equal(result.code, 'ELOCKED');
    if (!held) assert.match(result.error, /unresolved attempt reservation/);
    await exited;
  }
  owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot, reservationContext: identity });
  assert.equal(W.readCheckoutReservation(owner).attempt_id, identity.attempt_id);
  W.releaseCheckout(owner, identity);
  await owner.release();
  owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  assert.equal(W.readCheckoutReservation(owner), null);
});

test('U1 identities collapse subdirectories, casing and junctions, not separate Git worktrees', (t) => {
  const fx = runtimeFixture(t);
  const sub = path.join(fx.workdir, 'sub');
  fs.mkdirSync(sub);
  const alias = path.join(fx.root, 'alias');
  fs.symlinkSync(fx.workdir, alias, 'junction');
  const identity = W.resolveWorkspace(fx.workdir);
  assert.deepEqual(W.resolveWorkspace(sub), identity);
  assert.deepEqual(W.resolveWorkspace(alias), identity);
  if (process.platform === 'win32') assert.deepEqual(W.resolveWorkspace(sub.toUpperCase()), identity);
  assert.throws(() => W.resolveWorkspace(path.join(fx.root, 'missing')), /resolve|exist/i);
  assert.throws(() => W.resolveWorkspace(fx.root), /worktree|Git/i);
  const linked = path.join(fx.root, 'linked');
  const common = path.join(fx.workdir, '.git');
  const metadata = path.join(common, 'worktrees', 'linked');
  fs.mkdirSync(linked);
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${metadata}\n`);
  fs.writeFileSync(path.join(metadata, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(metadata, 'gitdir'), `${path.join(linked, '.git')}\n`);
  fs.copyFileSync(path.join(common, 'HEAD'), path.join(metadata, 'HEAD'));
  const shared = execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  assert.equal(W.canonicalPath(shared), W.canonicalPath(common));
  assert.notEqual(W.resolveWorkspace(linked).key, identity.key, 'shared Git metadata must not merge distinct checkout claims');
});

test('U1 legacy directory identities require positive non-Git evidence and retain Git identity', async (t) => {
  const fx = runtimeFixture(t);
  const directory = W.resolveWorkspace(fx.root, { allowNonGit: true });
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.key, W.canonicalPath(fx.root));
  assert.throws(() => W.validateWorkspace(directory), /invalid/);
  const alias = path.join(fx.root, 'directory-alias');
  fs.symlinkSync(fx.root, alias, 'junction');
  assert.deepEqual(W.resolveWorkspace(alias, { allowNonGit: true }), directory);
  assert.deepEqual(W.resolveWorkspace(fx.workdir, { allowNonGit: true }), W.resolveWorkspace(fx.workdir));
  assert.throws(() => W.resolveWorkspace(path.join(fx.root, 'missing'), { allowNonGit: true }), /identity|exist/i);
  const owner = await W.acquireWorkspaceOwner(directory, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  assert.equal((await W.queryOwner(directory)).workspace_key, directory.key);
  await assert.rejects(W.acquireWorkspaceOwner(directory, { _runtimeRoot: fx.runtimeRoot }), { code: 'ELOCKED' });
  execFileSync('git', ['init', '--quiet', fx.root]);
  const initialized = W.resolveWorkspace(fx.root);
  assert.equal(initialized.key, directory.key);
  assert.equal(W.pipeNameFor(initialized), owner.pipeName);
  await assert.rejects(W.acquireWorkspaceOwner(initialized, { _runtimeRoot: fx.runtimeRoot }), { code: 'ELOCKED' });
});

test('U1 non-Git fallback rejects ambiguous Git failures and malformed ancestor metadata', (t) => {
  const fx = runtimeFixture(t);
  const options = { allowNonGit: true };
  const original = childProcess.execFileSync;
  for (const fields of [
    { code: 'ENOENT' }, { code: 'EACCES' }, { code: 'ETIMEDOUT', signal: 'SIGTERM' },
    { status: 128, stderr: "fatal: detected dubious ownership in repository at 'checkout'" },
    { status: 128, stderr: 'fatal: unknown error' },
    { status: 1, stderr: 'fatal: not a git repository (or any of the parent directories): .git' },
    { status: 128, stdout: 'unexpected output', stderr: 'fatal: not a git repository (or any of the parent directories): .git' },
  ]) {
    const probe = t.mock.method(childProcess, 'execFileSync', (command, ...args) => {
      if (command !== 'git') return original(command, ...args);
      throw Object.assign(new Error('injected Git probe failure'), fields);
    });
    assert.throws(() => W.resolveWorkspace(fx.root, options), /Git|identity/);
    assert.equal(probe.mock.callCount(), 1, 'must not silently bypass the Git probe');
    probe.mock.restore();
  }
  const child = path.join(fx.root, 'non-git-child');
  fs.mkdirSync(child);
  for (const marker of ['directory', 'file']) {
    const git = path.join(fx.root, '.git');
    if (marker === 'directory') fs.mkdirSync(git);
    else fs.writeFileSync(git, 'gitdir: missing-target\n');
    assert.throws(() => W.resolveWorkspace(child, options), /Git|identity/);
    if (marker === 'directory') fs.rmdirSync(git);
    else fs.unlinkSync(git);
  }
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (path.basename(file) === '.git') throw Object.assign(new Error('denied ancestor metadata'), { code: 'EACCES' });
    return lstat(file, ...args);
  });
  assert.throws(() => W.resolveWorkspace(child, options), /denied ancestor metadata/);
});

test('U1 new reservation manifest identities use full resolved platform-normalized paths', async (t) => {
  const fx = runtimeFixture(t);
  const owner = await W.acquireWorkspaceOwner(W.resolveWorkspace(fx.workdir), { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  const identity = { manifest_path: fx.manifestPath, run_id: 'run', phase_id: 'p1', role: 'impl', review_iteration: 0, attempt_id: 'attempt' };
  const reservation = W.reserveCheckout(owner, identity);
  const expected = process.platform === 'win32' ? path.resolve(fx.manifestPath).toLowerCase() : path.resolve(fx.manifestPath);
  assert.equal(reservation.manifest_path, expected);
  assert.throws(() => W.reserveCheckout(owner, { ...identity, manifest_path: path.join(fx.root, 'other', 'manifest.yaml') }), /unresolved/);
  W.releaseCheckout(owner, identity);
});

test('U1 old mixed-case reservation survives restart and identical reservation reconciliation', { skip: process.platform !== 'win32' }, async (t) => {
  const fx = runtimeFixture(t);
  const workspace = W.resolveWorkspace(fx.workdir);
  let owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  const identity = { manifest_path: fx.manifestPath.toUpperCase(), run_id: 'run', phase_id: 'p1', role: 'impl', review_iteration: 0, attempt_id: 'attempt' };
  const reservation = W.reserveCheckout(owner, identity);
  const file = path.join(path.dirname(path.dirname(owner.discoveryPath)), 'reservation.json');
  fs.writeFileSync(file, JSON.stringify({ ...reservation, manifest_path: identity.manifest_path }));
  await owner.release();
  const context = { ...identity, manifest_path: fx.manifestPath.toLowerCase() };
  await assert.rejects(W.acquireWorkspaceOwner(workspace, {
    _runtimeRoot: fx.runtimeRoot, reservationContext: { ...context, manifest_path: path.join(fx.root, 'manifest.yaml') },
  }), { code: 'ELOCKED' });
  owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot, reservationContext: context });
  assert.equal(W.reserveCheckout(owner, context).manifest_path, context.manifest_path);
  assert.equal(W.readCheckoutReservation(owner).manifest_path, context.manifest_path);
  W.releaseCheckout(owner, context);
});

test('U1 owner requires a kernel handle; readiness is read-only and discovery is private', async (t) => {
  const fx = runtimeFixture(t);
  const workspace = W.resolveWorkspace(fx.workdir);
  const owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  assert.doesNotThrow(() => W.assertOwnership(owner, workspace));
  assert.throws(() => W.assertOwnership({ ...owner }, workspace), /ownership|owner/i);
  owner.setReadiness('live_dispatch_disabled');
  const readiness = await W.queryOwner(workspace);
  assert.equal(readiness.status, 'live_dispatch_disabled');
  assert.equal(readiness.workspace_key, workspace.key);
  assert.equal(readiness.service_id, owner.serviceId);
  assert.ok(!JSON.stringify(readiness).includes('capability'));
  const record = JSON.parse(fs.readFileSync(owner.discoveryPath, 'utf8'));
  assert.equal(record.workspace_key, workspace.key);
  assert.equal(record.process.pid, process.pid);
  assert.ok(Object.hasOwn(record.process, 'creation_time'));
  assert.ok(Object.hasOwn(record.process, 'host_boot_id'));
  if (process.platform === 'win32') {
    const acl = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$a=[IO.File]::GetAccessControl('${owner.discoveryPath.replace(/'/g, "''")}'); @($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8' });
    const identities = JSON.parse(acl);
    assert.ok([identities].flat().every((sid) => sid === record.user_sid), 'only the current user has an ACL grant');
  }
  await owner.release();
  assert.throws(() => W.assertOwnership(owner, workspace), /ownership|owner/i);
  const successor = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => successor.release());
  await owner.release();
  assert.ok(fs.existsSync(successor.discoveryPath));
  await assert.rejects(W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot }), /owner|bind|contention/i);
});

test('U1 actual Windows concurrent processes bind exclusively; process death releases the pipe', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const fx = runtimeFixture(t);
  const sub = path.join(fx.workdir, 'sub');
  fs.mkdirSync(sub);
  const alias = path.join(fx.root, 'alias');
  fs.symlinkSync(sub, alias, 'junction');
  const children = [0, 1].map(() => fork(path.join(__dirname, 'test-support', 'owner-child.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });
  await Promise.all(children.map((child) => once(child, 'message')));
  const results = children.map((child) => once(child, 'message').then(([message]) => message));
  children.forEach((child, i) => child.send({ workdir: i ? alias : fx.workdir, runtimeRoot: fx.runtimeRoot }));
  const replies = await Promise.all(results);
  assert.equal(replies.filter((reply) => reply.acquired).length, 1, JSON.stringify(replies));
  const winner = children[replies.findIndex((reply) => reply.acquired)];
  assert.equal((await W.queryOwner(W.resolveWorkspace(alias))).status, 'live_dispatch_disabled');
  const exited = once(winner, 'exit');
  winner.kill();
  await exited;
  const successor = await W.acquireWorkspaceOwner(W.resolveWorkspace(sub), { _runtimeRoot: fx.runtimeRoot });
  t.after(() => successor.release());
  assert.ok(successor);
});

test('U1 discovery collision fails closed and namespace claims remain independent', async (t) => {
  const fx = runtimeFixture(t);
  const workspace = W.resolveWorkspace(fx.workdir);
  const owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  const record = JSON.parse(fs.readFileSync(owner.discoveryPath, 'utf8'));
  fs.writeFileSync(owner.discoveryPath, JSON.stringify({ ...record, workspace_key: 'different-full-key' }));
  await owner.release();
  await assert.rejects(W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot }), /collision|mismatch/i);
  const dashboard = await W.acquireWorkspaceOwner(workspace, { namespace: 'dashboard', _runtimeRoot: fx.runtimeRoot });
  await dashboard.release();
});

test('U1 legacy drain inspects every lock; unknown/live blocks, death or reboot permits drain', (t) => {
  const fx = runtimeFixture(t);
  const paths = ['primary.lock', 'workdir.lock'].map((name) => path.join(fx.root, name));
  const host = { hostname: 'host', host_boot_id: 'boot-new' };
  const old = { pid: 42, hostname: 'host', host_boot_id: 'boot-new', startedAt: '2026-09-17T01:00:00Z' };
  paths.forEach((file) => fs.writeFileSync(file, JSON.stringify(old)));
  for (const state of ['live', 'unknown']) {
    assert.throws(() => W.inspectLegacyLocks(paths, { host, probeProcess: () => ({ state }) }), /legacy.*(live|unknown)|drain/i);
  }
  assert.equal(W.inspectLegacyLocks(paths, { host, probeProcess: () => ({ state: 'dead' }) }).length, 2);
  fs.writeFileSync(paths[0], JSON.stringify({ ...old, host_boot_id: 'boot-old' }));
  fs.writeFileSync(paths[1], JSON.stringify({ ...old, host_boot_id: 'boot-old' }));
  assert.equal(W.inspectLegacyLocks(paths, { host, probeProcess: () => ({ state: 'unknown' }) }).length, 2);
  assert.throws(() => W.inspectLegacyLocks(paths, { host: { ...host, host_boot_id: null }, probeProcess: () => ({ state: 'unknown' }) }), /unknown|drain/i);
  fs.writeFileSync(paths[1], '{broken');
  assert.throws(() => W.inspectLegacyLocks(paths, { host }), /legacy|corrupt/i);
});

test('round2 legacy lock candidates deduplicate physical aliases and fail closed on lookup errors', (t) => {
  const fx = runtimeFixture(t);
  const alias = path.join(fx.root, 'lock-alias');
  fs.symlinkSync(fx.workdir, alias, 'junction');
  const file = path.join(fx.workdir, '.orchestrator.lock');
  const bytes = JSON.stringify({ hostname: 'host', pid: 42 });
  fs.writeFileSync(file, bytes);
  let probes = 0;
  const options = { host: { hostname: 'host' }, probeProcess() { probes++; return { state: 'dead' }; } };
  const paths = [file, path.join(alias, '.orchestrator.lock'), path.join(fx.root, 'missing.lock')];
  if (process.platform === 'win32') paths.push(file.toUpperCase());
  const drained = W.inspectLegacyLocks(paths, options);
  assert.deepEqual(drained, [{ path: W.canonicalPath(file), bytes }]);
  assert.equal(probes, 1);
  const original = fs.realpathSync.native;
  const lookup = t.mock.method(fs.realpathSync, 'native', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('lookup denied'), { code: 'EACCES' });
    return original(target, ...args);
  });
  assert.throws(() => W.inspectLegacyLocks([file], options), /lookup denied/);
  lookup.mock.restore();
});

test('U1 legacy drain compares hostnames without case and distinguishes corrupt records from contention', (t) => {
  const fx = runtimeFixture(t);
  const file = path.join(fx.root, 'legacy.lock');
  const host = { hostname: 'Host-Name', host_boot_id: 'boot-new' };
  const previous = { pid: 42, hostname: 'HOST-NAME', host_boot_id: 'boot-new', creation_time: '2026-09-17T01:00:00Z' };
  fs.writeFileSync(file, JSON.stringify(previous));
  for (const state of ['live', 'unknown']) {
    assert.throws(() => W.inspectLegacyLocks([file], { host, probeProcess: () => ({ state }) }), { code: 'ELOCKED' });
  }
  assert.equal(W.inspectLegacyLocks([file], { host, probeProcess: () => ({ state: 'dead' }) }).length, 1);
  assert.equal(W.inspectLegacyLocks([file], { host, probeProcess: () => ({ state: 'live', creation_time: '2026-09-17T02:00:00Z' }) }).length, 1);
  fs.writeFileSync(file, JSON.stringify({ ...previous, host_boot_id: 'boot-old' }));
  assert.equal(W.inspectLegacyLocks([file], { host, probeProcess: () => assert.fail('reboot is decisive') }).length, 1);
  assert.throws(() => W.inspectLegacyLocks([file], {
    host: { ...host, hostname: 'different-host' }, probeProcess: () => assert.fail('foreign PID must not be probed'),
  }), { code: 'ELOCKED' });
  for (const malformed of ['{broken', 'null', '{}', '{"pid":42,"hostname":7}']) {
    fs.writeFileSync(file, malformed);
    assert.throws(() => W.inspectLegacyLocks([file], { host }), (error) => /corrupt/.test(error.message) && error.code !== 'ELOCKED');
  }
});

test('U1 independent checkout owners coexist and failed discovery cannot retain the pipe', async (t) => {
  const fx = runtimeFixture(t);
  const other = runtimeFixture(t);
  fs.writeFileSync(fx.runtimeRoot, 'not a directory');
  const workspace = W.resolveWorkspace(fx.workdir);
  await assert.rejects(W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot }));
  fs.unlinkSync(fx.runtimeRoot);
  const owners = await Promise.all([fx, other].map((fixture) =>
    W.acquireWorkspaceOwner(W.resolveWorkspace(fixture.workdir), { _runtimeRoot: fixture.runtimeRoot })));
  t.after(async () => { for (const owner of owners) await owner.release(); });
  assert.notEqual(owners[0].pipeName, owners[1].pipeName);
  assert.notEqual((await W.queryOwner(workspace)).service_id, (await W.queryOwner(owners[1].workspace)).service_id);
});

test('U1 readiness endpoint rejects malformed and mutation requests without losing ownership', async (t) => {
  const fx = runtimeFixture(t);
  const workspace = W.resolveWorkspace(fx.workdir);
  const owner = await W.acquireWorkspaceOwner(workspace, { _runtimeRoot: fx.runtimeRoot });
  t.after(() => owner.release());
  for (const request of [null, { type: 'pause', role: 'operator', workspace_key: workspace.key }, { type: 'readiness', workspace_key: 'wrong' }]) {
    const result = await new Promise((resolve, reject) => {
      const socket = net.createConnection(owner.pipeName);
      let bytes = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
      socket.on('data', (chunk) => { bytes += chunk; });
      socket.on('end', () => resolve(JSON.parse(bytes)));
    });
    assert.equal(result.ok, false);
  }
  assert.doesNotThrow(() => W.assertOwnership(owner, workspace));
});

test('U1 real host boot and process creation evidence is recorded on supported Windows', { skip: process.platform !== 'win32' }, () => {
  const evidence = W.getHostEvidence();
  assert.equal(evidence.observation, 'complete', JSON.stringify(evidence));
  assert.ok(Number.isFinite(Date.parse(evidence.host_boot_id)));
  assert.ok(Number.isFinite(Date.parse(evidence.creation_time)));
});
