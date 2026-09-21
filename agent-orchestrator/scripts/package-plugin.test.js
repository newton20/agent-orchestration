'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const {
  packagePlugin, installDependencies, assertSupportedNode, parseArgs, INVENTORY_FILENAME, NPM_CI_ARGS,
} = require('./package-plugin');

function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.package-plugin-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const sourceRoot = path.join(checkout, 'plugin');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  const packageJson = {
    name: 'fixture-plugin', version: '1.0.0', private: true,
    dependencies: { 'fixture-dependency': '1.0.0' }, engines: { node: '>=20' },
  };
  const lock = {
    name: packageJson.name, version: packageJson.version, lockfileVersion: 3,
    packages: {
      '': packageJson,
      'node_modules/fixture-dependency': {
        version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz',
        integrity: 'sha512-Zml4dHVyZQ==',
      },
    },
  };
  const files = {
    '.claude-plugin/plugin.json': '{"name":"fixture-plugin"}\n',
    'agency.json': '{"name":"fixture-plugin"}\n',
    'hooks.json': '{"version":1,"hooks":{"sessionStart":[]}}\n',
    'hooks/hooks.json': '{"hooks":{}}\n',
    'hooks/package.json': '{"type":"commonjs"}\n',
    'hooks/run-hook.cmd': '@node "%~dp0session-start.js"\r\n',
    'hooks/session-start.js': 'module.exports = require("../scripts/runtime");\n',
    'scripts/runtime.js': 'module.exports = require("fixture-dependency");\n',
    'scripts/nested/helper.js': 'module.exports = 42;\n',
    'scripts/package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    'scripts/package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
    'templates/prompt.md': 'A runtime prompt.\n',
    'skills/run/SKILL.md': 'A runtime skill.\n',
    'skills/run/references/detail.md': 'Runtime reference.\n',
  };
  for (const [relative, content] of Object.entries(files)) write(sourceRoot, relative, content);
  const installer = async ({ cwd, args, env }) => {
    assert.deepEqual(args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.notEqual(cwd, path.join(sourceRoot, 'scripts'));
    assert.equal(path.basename(cwd), 'scripts');
    assert.equal(env.npm_config_bin_links, 'false');
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'package-lock.json')), fs.readFileSync(path.join(sourceRoot, 'scripts', 'package-lock.json')));
    assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false);
    write(cwd, 'node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","main":"index.js"}\n');
    write(cwd, 'node_modules/fixture-dependency/index.js', 'module.exports = "installed-from-lock";\n');
  };
  return { root, checkout, sourceRoot, output: path.join(root, 'installed plugin'), files, installer };
}

function filesBelow(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesBelow(path.join(root, entry.name), relative) : [relative];
  }).sort();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('packages only runtime components and installs dependencies in the staged artifact', async (t) => {
  const fx = fixture(t);
  const excluded = [
    'README.md', 'docs/private.md', 'prototype/demo.js', 'schema/dev.json',
    '.claude-plugin/.env', '.claude-plugin/credentials.json',
    'scripts/runtime.test.js', 'scripts/runtime.spec.js', 'scripts/runtime.TEST.cjs',
    'scripts/test-support/helper.js', 'scripts/__tests__/helper.js', 'scripts/fixtures/input.json',
    'scripts/.env', 'scripts/.env.production', 'scripts/.npmrc', 'scripts/private.pem',
    'scripts/credentials.json', 'scripts/secrets.json', 'scripts/runtime.js.bak',
    'scripts/node_modules/fixture-dependency/index.js', 'scripts/.cache/data.json',
    'hooks/session-start.test.js', 'hooks/tests/helper.js', 'hooks/secret.json',
    'templates/.env', 'templates/secrets.md', 'skills/run/.git/config',
    'skills/run/test-support/sample.md',
  ];
  for (const relative of excluded) write(fx.sourceRoot, relative, 'DO NOT SHIP\n');
  const originalFiles = filesBelow(fx.sourceRoot);
  const result = await packagePlugin(fx);
  assert.equal(result.output, fx.output);
  assert.equal(result.inventoryPath, path.join(fx.output, INVENTORY_FILENAME));
  assert.equal(fs.existsSync(path.join(fx.output, 'scripts', 'node_modules', 'fixture-dependency', 'index.js')), true);
  for (const [relative, content] of Object.entries(fx.files)) {
    assert.equal(fs.readFileSync(path.join(fx.output, relative), 'utf8'), content, relative);
  }
  for (const relative of excluded) {
    if (relative.startsWith('scripts/node_modules/')) continue;
    assert.equal(fs.existsSync(path.join(fx.output, relative)), false, relative);
  }
  assert.deepEqual(filesBelow(fx.sourceRoot), originalFiles);
  assert.equal(fs.readFileSync(path.join(fx.sourceRoot, 'scripts', 'node_modules', 'fixture-dependency', 'index.js'), 'utf8'), 'DO NOT SHIP\n');
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
});

test('a moved package resolves its own dependencies without the source checkout', async (t) => {
  const fx = fixture(t);
  await packagePlugin(fx);
  const moved = path.join(fx.root, 'relocated package');
  fs.renameSync(fx.output, moved);
  fs.rmSync(fx.checkout, { recursive: true });
  const result = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]))', path.join(moved, 'hooks', 'session-start.js')], {
    cwd: fx.root, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'installed-from-lock');
});

test('inventory is sorted, hashes every delivered file, and is stable across output names and mtimes', async (t) => {
  const fx = fixture(t);
  const first = await packagePlugin(fx);
  for (const file of filesBelow(fx.sourceRoot)) fs.utimesSync(path.join(fx.sourceRoot, file), 1, 1);
  const second = await packagePlugin({ ...fx, output: path.join(fx.root, 'another output') });
  assert.deepEqual(fs.readFileSync(first.inventoryPath), fs.readFileSync(second.inventoryPath));
  const inventory = JSON.parse(fs.readFileSync(first.inventoryPath, 'utf8'));
  assert.deepEqual(Object.keys(inventory), ['version', 'algorithm', 'files']);
  assert.equal(inventory.version, 1);
  assert.equal(inventory.algorithm, 'sha256');
  assert.deepEqual(inventory, first.inventory);
  assert.deepEqual(inventory.files.map(file => file.path), filesBelow(fx.output).filter(file => file !== INVENTORY_FILENAME));
  for (const file of inventory.files) {
    const bytes = fs.readFileSync(path.join(fx.output, file.path));
    assert.deepEqual(file, { path: file.path, size: bytes.length, sha256: hash(bytes) });
  }
  assert.equal(fs.readFileSync(first.inventoryPath, 'utf8').includes(fx.root), false);
  assert.equal(fs.readFileSync(first.inventoryPath, 'utf8').includes('timestamp'), false);
  write(fx.sourceRoot, 'scripts/runtime.js', 'module.exports = "changed";\n');
  const third = await packagePlugin({ ...fx, output: path.join(fx.root, 'changed output') });
  assert.notDeepEqual(first.inventory, third.inventory);
});

test('rejects nonabsolute, overlapping and checkout-contained outputs before installation', async (t) => {
  const fx = fixture(t);
  let installs = 0;
  for (const output of [
    'relative-output', '', fx.sourceRoot, fx.checkout, fx.root,
    path.join(fx.sourceRoot, 'dist'), path.join(fx.checkout, 'elsewhere'),
  ]) {
    await assert.rejects(packagePlugin({ ...fx, output, installer: async () => installs++ }), /absolute|overlap|checkout|outside/i, output);
  }
  assert.equal(installs, 0);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('refuses existing files and directories without changing them', async (t) => {
  const fx = fixture(t);
  for (const kind of ['file', 'directory']) {
    const output = path.join(fx.root, kind);
    if (kind === 'file') fs.writeFileSync(output, 'keep');
    else fs.mkdirSync(output);
    await assert.rejects(packagePlugin({ ...fx, output }), /exist/i);
    assert.equal(fs.lstatSync(output).isDirectory(), kind === 'directory');
    if (kind === 'file') assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
  }
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'directory', 'file']);
});

test('requires an existing safe output parent and leaves missing parents untouched', async (t) => {
  const fx = fixture(t);
  const parent = path.join(fx.root, 'missing');
  await assert.rejects(packagePlugin({ ...fx, output: path.join(parent, 'output') }), /parent|ENOENT|exist/i);
  assert.equal(fs.existsSync(parent), false);
});

test('failed installers remove owned staging and never publish or change source', async (t) => {
  const fx = fixture(t);
  let staging;
  await assert.rejects(packagePlugin({
    ...fx,
    installer: async ({ cwd }) => {
      staging = path.dirname(cwd);
      write(cwd, 'node_modules/partial/index.js', 'partial');
      throw new Error('injected npm ci failure');
    },
  }), /injected npm ci failure/);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(fx.output), false);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
  assert.equal(fs.existsSync(path.join(fx.sourceRoot, 'scripts', 'node_modules')), false);
  await packagePlugin(fx);
});

test('publishes only after install completes and preserves an output created while installing', async (t) => {
  const fx = fixture(t);
  await assert.rejects(packagePlugin({
    ...fx,
    installer: async (request) => {
      assert.equal(fs.existsSync(fx.output), false);
      await fx.installer(request);
      fs.mkdirSync(fx.output);
      fs.writeFileSync(path.join(fx.output, 'other-owner'), 'keep');
    },
  }), /exist/i);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
  assert.equal(fs.readFileSync(path.join(fx.output, 'other-owner'), 'utf8'), 'keep');
});

test('rejects concurrent publishers for one output and cleans only its own staging', async (t) => {
  const fx = fixture(t);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = packagePlugin({ ...fx, installer: async (request) => { await hold; await fx.installer(request); } });
  try {
    await assert.rejects(packagePlugin(fx), /exist|progress|lock/i);
    assert.equal(fs.existsSync(fx.output), false);
  } finally {
    release();
  }
  await first;
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
});

test('rejects missing metadata, missing lockfiles and local linked dependencies before installation', async (t) => {
  for (const missing of ['agency.json', '.claude-plugin/plugin.json', 'scripts/package-lock.json']) {
    const fx = fixture(t);
    fs.unlinkSync(path.join(fx.sourceRoot, missing));
    await assert.rejects(packagePlugin(fx), /required|missing|ENOENT/i);
    assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
  }
  const fx = fixture(t);
  const lockPath = path.join(fx.sourceRoot, 'scripts', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/fixture-dependency'] = { resolved: '../../outside', link: true };
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  await assert.rejects(packagePlugin(fx), /lock|link|local|integrity/i);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('rejects installer mutation of pinned inputs and missing installed runtime dependencies', async (t) => {
  const fx = fixture(t);
  for (const filename of ['package-lock.json', 'package.json']) {
    await assert.rejects(packagePlugin({
      ...fx, installer: async request => {
        await fx.installer(request);
        fs.appendFileSync(path.join(request.cwd, filename), '\n');
      },
    }), /changed|modified|mutat/i);
    assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
  }
  await assert.rejects(packagePlugin({ ...fx, installer: async () => {} }), /dependency|dependencies|node_modules/i);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('rejects junctions in source paths, output ancestors and installed dependencies', async (t) => {
  const fx = fixture(t);
  const external = path.join(fx.root, 'external');
  fs.mkdirSync(external);
  write(external, 'payload.js', 'do not follow');
  const sourceAlias = path.join(fx.root, 'source-alias');
  fs.symlinkSync(fx.sourceRoot, sourceAlias, 'junction');
  await assert.rejects(packagePlugin({ ...fx, sourceRoot: sourceAlias }), /symlink|reparse|unsafe/i);
  const outputAlias = path.join(fx.root, 'output-alias');
  fs.symlinkSync(external, outputAlias, 'junction');
  await assert.rejects(packagePlugin({ ...fx, output: path.join(outputAlias, 'package') }), /symlink|reparse|unsafe/i);
  const runtimeAlias = path.join(fx.sourceRoot, 'scripts', 'linked');
  fs.symlinkSync(external, runtimeAlias, 'junction');
  await assert.rejects(packagePlugin(fx), /symlink|reparse|unsafe/i);
  fs.unlinkSync(runtimeAlias);
  await assert.rejects(packagePlugin({
    ...fx, installer: async request => {
      await fx.installer(request);
      fs.symlinkSync(external, path.join(request.cwd, 'node_modules', 'linked'), 'junction');
    },
  }), /symlink|reparse|unsafe/i);
  assert.equal(fs.existsSync(fx.output), false);
  assert.deepEqual(fs.readdirSync(external), ['payload.js']);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'external', 'output-alias', 'source-alias']);
});

test('enforces Node 20 minimum and accepts only the documented CLI arguments', () => {
  for (const version of ['18.20.0', '19.9.0', 'garbage', '']) assert.throws(() => assertSupportedNode(version), /Node.*20/i);
  for (const version of ['20.0.0', '22.5.0', '24.14.0']) assert.doesNotThrow(() => assertSupportedNode(version));
  const output = path.resolve(__dirname, 'not-created');
  assert.deepEqual(parseArgs(['--output', output]), { output });
  for (const args of [[], ['--output'], ['--output', 'relative'], ['--source', output], ['--output', output, '--output', output]]) {
    assert.throws(() => parseArgs(args), /usage|output|absolute|argument/i);
  }
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'package-plugin.js'), '--output', 'relative'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute|usage/i);
});

test('default installer propagates npm execution and exit failures with the pinned ci flags', async (t) => {
  const cwd = path.resolve(__dirname);
  const requests = [];
  const stub = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    requests.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  });
  await installDependencies({ cwd, args: [...NPM_CI_ARGS], env: { PATH: process.env.PATH } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.cwd, cwd);
  assert.equal(requests[0].options.windowsHide, true);
  assert.match(requests[0].args.join(' '), /ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  stub.mock.mockImplementation(() => ({ status: 17, stderr: 'injected registry failure' }));
  await assert.rejects(installDependencies({ cwd, args: [...NPM_CI_ARGS], env: process.env }), /npm ci.*17|registry failure/i);
  stub.mock.mockImplementation(() => ({ status: null, error: Object.assign(new Error('npm missing'), { code: 'ENOENT' }) }));
  await assert.rejects(installDependencies({ cwd, args: [...NPM_CI_ARGS], env: process.env }), /npm missing|ENOENT/i);
});
