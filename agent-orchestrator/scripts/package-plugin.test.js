'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');
const timers = require('node:timers/promises');
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
    'dashboard/index.html': '<!doctype html><script src="/app.js" defer></script><link rel="stylesheet" href="/styles.css">\n',
    'dashboard/app.js': '"use strict";\n',
    'dashboard/styles.css': 'body { color: black; }\n',
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

function renameFailure(code = 'EPERM') {
  return Object.assign(new Error(`injected ${code}: rename staging to output`), { code, syscall: 'rename' });
}

function publicationRetry(t, fx, { platform = 'win32', onAttempt = () => {}, onWait = () => {} } = {}) {
  const state = {
    now: 0, attempts: [], waits: [], installs: 0,
    lockPath: path.join(path.dirname(fx.output), `.${path.basename(fx.output)}.package.lock`),
  };
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', platformDescriptor));
  t.mock.method(performance, 'now', () => state.now);
  t.mock.method(timers, 'setTimeout', async delay => {
    state.waits.push(delay);
    state.now += delay;
    await onWait(state);
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination !== fx.output) return rename(source, destination);
    state.staging = source;
    state.attempts.push(state.now);
    assert.equal(fs.existsSync(state.lockPath), true, 'publication lock must remain held');
    onAttempt(state);
    return rename(source, destination);
  });
  const installer = fx.installer;
  fx.installer = async request => {
    state.installs++;
    await installer(request);
  };
  return state;
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
    'dashboard/app.test.js', 'dashboard/app.spec.js', 'dashboard/test-support/input.js',
    'dashboard/.env', 'dashboard/credentials.json', 'dashboard/app.js.map',
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
  for (const filename of ['index.html', 'app.js', 'styles.css']) {
    assert.equal(fs.readFileSync(path.join(moved, 'dashboard', filename), 'utf8'), fx.files[`dashboard/${filename}`]);
  }
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
  assert.deepEqual(inventory.files.filter(file => file.path.startsWith('dashboard/')).map(file => file.path),
    ['dashboard/app.js', 'dashboard/index.html', 'dashboard/styles.css']);
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

test('retries transient Windows final-rename EPERM without repeating installation', async (t) => {
  const fx = fixture(t);
  const state = publicationRetry(t, fx, { onAttempt: state => {
    if (state.attempts.length <= 2) throw renameFailure();
  } });
  const result = await packagePlugin(fx);
  assert.deepEqual(state.attempts, [0, 50, 150]);
  assert.deepEqual(state.waits, [50, 100]);
  assert.equal(state.installs, 1);
  assert.equal(result.output, fx.output);
  assert.equal(fs.existsSync(result.inventoryPath), true);
  assert.equal(fs.existsSync(state.staging), false);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
});

test('persistent Windows EPERM exhausts a five-second monotonic budget and cleans owned files', async (t) => {
  const fx = fixture(t);
  const originalError = renameFailure();
  const state = publicationRetry(t, fx, { onAttempt: state => {
    throw state.attempts.length === 1 ? originalError : renameFailure();
  } });
  await assert.rejects(packagePlugin(fx), error => error === originalError);
  assert.deepEqual(state.attempts, [0, 50, 150, 350, 750, 1250, 1750, 2250, 2750, 3250, 3750, 4250, 4750]);
  assert.deepEqual(state.waits, [50, 100, 200, 400, 500, 500, 500, 500, 500, 500, 500, 500, 250]);
  assert.equal(state.now, 5000);
  assert.equal(state.installs, 1);
  assert.equal(fs.existsSync(fx.output), false);
  assert.equal(fs.existsSync(state.staging), false);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('non-EPERM rename failures remain immediate on Windows', async (t) => {
  for (const code of ['EACCES', 'ENOENT', 'EXDEV']) {
    await t.test(code, async t => {
      const fx = fixture(t);
      const originalError = renameFailure(code);
      const state = publicationRetry(t, fx, { onAttempt: () => { throw originalError; } });
      await assert.rejects(packagePlugin(fx), error => error === originalError);
      assert.deepEqual(state.attempts, [0]);
      assert.deepEqual(state.waits, []);
      assert.equal(state.installs, 1);
      assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
    });
  }
});

test('a non-EPERM failure after a retry propagates immediately', async (t) => {
  const fx = fixture(t);
  const fatalError = renameFailure('EACCES');
  const state = publicationRetry(t, fx, { onAttempt: state => {
    throw state.attempts.length === 1 ? renameFailure() : fatalError;
  } });
  await assert.rejects(packagePlugin(fx), error => error === fatalError);
  assert.deepEqual(state.attempts, [0, 50]);
  assert.deepEqual(state.waits, [50]);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('EPERM remains fail-fast off Windows', async (t) => {
  const fx = fixture(t);
  const originalError = renameFailure();
  const state = publicationRetry(t, fx, {
    platform: 'linux', onAttempt: () => { throw originalError; },
  });
  await assert.rejects(packagePlugin(fx), error => error === originalError);
  assert.deepEqual(state.attempts, [0]);
  assert.deepEqual(state.waits, []);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('the publication lock excludes another installer throughout backoff', async (t) => {
  const fx = fixture(t);
  let competingInstalls = 0;
  const state = publicationRetry(t, fx, {
    onAttempt: state => { if (state.attempts.length === 1) throw renameFailure(); },
    onWait: async state => {
      assert.equal(fs.existsSync(state.lockPath), true);
      await assert.rejects(packagePlugin({ ...fx, installer: async () => competingInstalls++ }), /exist|progress|lock/i);
      assert.equal(fs.existsSync(state.staging), true);
      assert.equal(fs.existsSync(fx.output), false);
    },
  });
  await packagePlugin(fx);
  assert.deepEqual(state.attempts, [0, 50]);
  assert.equal(competingInstalls, 0);
  assert.equal(state.installs, 1);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
});

test('outputs appearing during rename backoff are preserved untouched', async (t) => {
  for (const kind of ['file', 'empty directory', 'populated directory']) {
    await t.test(kind, async t => {
      const fx = fixture(t);
      const state = publicationRetry(t, fx, {
        onAttempt: () => { throw renameFailure(); },
        onWait: () => {
          if (kind === 'file') fs.writeFileSync(fx.output, 'keep');
          else fs.mkdirSync(fx.output);
          if (kind === 'populated directory') write(fx.output, 'other-owner', 'keep');
        },
      });
      await assert.rejects(packagePlugin(fx), /Output already exists/);
      assert.deepEqual(state.attempts, [0]);
      assert.deepEqual(state.waits, [50]);
      if (kind === 'file') assert.equal(fs.readFileSync(fx.output, 'utf8'), 'keep');
      else assert.deepEqual(fs.readdirSync(fx.output), kind === 'empty directory' ? [] : ['other-owner']);
      if (kind === 'populated directory') assert.equal(fs.readFileSync(path.join(fx.output, 'other-owner'), 'utf8'), 'keep');
      assert.equal(fs.existsSync(state.staging), false);
      assert.deepEqual(fs.readdirSync(fx.root).sort(), ['checkout', 'installed plugin']);
    });
  }
});

test('retry safety-check EPERM is not treated as a rename failure', async (t) => {
  const fx = fixture(t);
  const safetyError = Object.assign(new Error('cannot inspect staging'), { code: 'EPERM' });
  const lstat = fs.lstatSync;
  const state = publicationRetry(t, fx, {
    onAttempt: () => { throw renameFailure(); },
    onWait: state => {
      t.mock.method(fs, 'lstatSync', (file, ...args) => {
        if (file === state.staging) throw safetyError;
        return lstat(file, ...args);
      });
    },
  });
  await assert.rejects(packagePlugin(fx), error => error === safetyError);
  assert.deepEqual(state.attempts, [0]);
  assert.deepEqual(state.waits, [50]);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
});

test('staging junction replacement during backoff is rejected without touching its target', async (t) => {
  const fx = fixture(t);
  const external = path.join(fx.root, 'external');
  const parked = path.join(fx.root, 'parked-stage');
  write(external, 'other-owner', 'keep');
  const state = publicationRetry(t, fx, {
    onAttempt: () => { throw renameFailure(); },
    onWait: state => {
      fs.renameSync(state.staging, parked);
      fs.symlinkSync(external, state.staging, 'junction');
    },
  });
  await assert.rejects(packagePlugin(fx), /unsafe|symlink|reparse/i);
  assert.deepEqual(state.attempts, [0]);
  assert.deepEqual(fs.readdirSync(external), ['other-owner']);
  assert.equal(fs.readFileSync(path.join(external, 'other-owner'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(fx.output), false);
  assert.equal(fs.existsSync(state.staging), false);
  assert.equal(fs.existsSync(state.lockPath), false);
  assert.equal(fs.existsSync(path.join(parked, INVENTORY_FILENAME)), true);
});

test('parent junction replacement during backoff cannot redirect publication or cleanup', async (t) => {
  const fx = fixture(t);
  const parent = path.join(fx.root, 'publish');
  const parked = path.join(fx.root, 'parked-parent');
  const external = path.join(fx.root, 'external');
  fs.mkdirSync(parent);
  fs.mkdirSync(external);
  fx.output = path.join(parent, 'installed plugin');
  const state = publicationRetry(t, fx, {
    onAttempt: () => { throw renameFailure(); },
    onWait: state => {
      fs.mkdirSync(parked);
      // Windows blocks renaming an ancestor of the open publication lock.
      for (const name of fs.readdirSync(parent)) {
        fs.renameSync(path.join(parent, name), path.join(parked, name));
      }
      fs.rmdirSync(parent);
      fs.symlinkSync(external, parent, 'junction');
      write(external, `${path.basename(state.staging)}/other-owner`, 'keep');
      fs.writeFileSync(path.join(external, path.basename(state.lockPath)), 'foreign lock');
    },
  });
  await assert.rejects(packagePlugin(fx), /unsafe|symlink|reparse/i);
  assert.deepEqual(state.attempts, [0]);
  assert.equal(fs.readFileSync(path.join(external, path.basename(state.staging), 'other-owner'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(external, path.basename(state.lockPath)), 'utf8'), 'foreign lock');
  assert.equal(fs.existsSync(fx.output), false);
  assert.equal(fs.existsSync(path.join(parked, path.basename(state.staging), INVENTORY_FILENAME)), true);
});

test('scheduler resuming at or beyond the deadline cannot trigger another rename', async (t) => {
  for (const resumedAt of [5000, 6000]) {
    await t.test(String(resumedAt), async t => {
      const fx = fixture(t);
      const originalError = renameFailure();
      const state = publicationRetry(t, fx, {
        onAttempt: () => { throw originalError; },
        onWait: state => { state.now = resumedAt; },
      });
      await assert.rejects(packagePlugin(fx), error => error === originalError);
      assert.deepEqual(state.attempts, [0]);
      assert.deepEqual(state.waits, [50]);
      assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
    });
  }
});

test('retry checks consuming the remaining deadline cannot trigger another rename', async (t) => {
  const fx = fixture(t);
  const originalError = renameFailure();
  const lstat = fs.lstatSync;
  const state = publicationRetry(t, fx, {
    onAttempt: () => { throw originalError; },
    onWait: state => {
      state.now = 4999;
      t.mock.method(fs, 'lstatSync', (file, ...args) => {
        if (file === state.staging) state.now = 5000;
        return lstat(file, ...args);
      });
    },
  });
  await assert.rejects(packagePlugin(fx), error => error === originalError);
  assert.deepEqual(state.attempts, [0]);
  assert.deepEqual(state.waits, [50]);
  assert.equal(state.now, 5000);
  assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
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

test('requires every dashboard asset before installation or publication', async (t) => {
  for (const filename of ['index.html', 'app.js', 'styles.css']) {
    const fx = fixture(t);
    fs.unlinkSync(path.join(fx.sourceRoot, 'dashboard', filename));
    let installs = 0;
    await assert.rejects(packagePlugin({ ...fx, installer: async request => {
      installs++;
      await fx.installer(request);
    } }), /required|missing|ENOENT/i);
    assert.equal(installs, 0);
    assert.deepEqual(fs.readdirSync(fx.root), ['checkout']);
  }
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
