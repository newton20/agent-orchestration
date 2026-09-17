'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { runtimeFixture } = require('./test-support/runtime-fixture');
const W = require('./workspace-owner');

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
  const current = W.resolveWorkspace(__dirname);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const primary = W.resolveWorkspace(path.dirname(common));
  assert.notEqual(current.key, primary.key, 'existing linked worktree differs from the main checkout');
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
