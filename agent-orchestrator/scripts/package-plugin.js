#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');

const INVENTORY_FILENAME = 'package-inventory.json';
const NPM_CI_ARGS = Object.freeze(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
const COMPONENTS = ['.claude-plugin', 'agency.json', 'hooks', 'scripts', 'templates', 'skills'];
const OPTIONAL_FILES = ['hooks.json'];
const REQUIRED_FILES = ['.claude-plugin/plugin.json', 'agency.json', 'scripts/package.json', 'scripts/package-lock.json'];
const EXCLUDED_NAMES = /^(?:node_modules|tests?|__tests__|test-support|fixtures?|__fixtures__|coverage|secrets?|credentials?)(?:[._-]|$)/i;
const TEST_NAME = /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i;
const EXTENSIONS = {
  scripts: new Set(['.js', '.cjs', '.mjs', '.json']),
  hooks: new Set(['.js', '.cjs', '.mjs', '.json', '.cmd', '.bat', '.ps1', '.sh']),
  templates: new Set(['.md', '.txt', '.json', '.yaml', '.yml']),
  skills: new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.cjs', '.mjs', '.ps1', '.cmd', '.sh']),
};

function assertSupportedNode(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 20) {
    throw new Error(`Node.js 20 or newer is required (found ${version || 'unknown'}).`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const resolved = path.resolve(value);
  if (process.platform === 'win32') {
    const segments = value.slice(path.parse(value).root.length).split(/[\\/]/);
    if (/^\\\\[?.]\\/.test(value) || segments.some(segment =>
      (segment !== '.' && segment !== '..') &&
      (/[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))) {
      throw new Error(`Unsafe Windows ${label} path: ${value}`);
    }
  }
  return resolved;
}

function canonical(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent, child) {
  const relative = path.relative(canonical(parent), canonical(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeEntry(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
      canonical(fs.realpathSync.native(file)) !== canonical(file)) {
    throw new Error(`Unsafe symlink or reparse path: ${file}`);
  }
  return stat;
}

function safePath(file) {
  const parsed = path.parse(file);
  let current = parsed.root;
  let stat = safeEntry(current);
  for (const segment of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    stat = safeEntry(current);
  }
  return stat;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function checkoutRoot(sourceRoot) {
  for (let current = sourceRoot; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    if (exists(marker)) {
      safeEntry(marker);
      return current;
    }
    if (path.dirname(current) === current) return sourceRoot;
  }
}

function assertOutputAbsent(output) {
  if (exists(output)) throw new Error(`Output already exists: ${output}`);
}

function excluded(name) {
  return name.startsWith('.') || EXCLUDED_NAMES.test(name) || TEST_NAME.test(name);
}

function copyComponent(source, destination, component, relative = '') {
  const stat = safeEntry(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const name of fs.readdirSync(source).sort()) {
      if (excluded(name)) continue;
      copyComponent(path.join(source, name), path.join(destination, name), component, relative ? `${relative}/${name}` : name);
    }
    return;
  }
  const include = component === 'agency.json' || OPTIONAL_FILES.includes(component) ||
    (component === '.claude-plugin' ? relative === 'plugin.json' : EXTENSIONS[component].has(path.extname(source).toLowerCase()));
  if (include) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read required JSON ${file}: ${error.message}`);
  }
}

function validateInputs(sourceRoot) {
  for (const relative of REQUIRED_FILES) {
    const file = path.join(sourceRoot, relative);
    if (!safePath(file).isFile()) throw new Error(`Required runtime file is missing: ${file}`);
  }
  for (const component of COMPONENTS.filter(name => name !== 'agency.json')) {
    if (!safePath(path.join(sourceRoot, component)).isDirectory()) throw new Error(`Required component is not a directory: ${component}`);
  }
  const manifest = readJson(path.join(sourceRoot, 'scripts', 'package.json'));
  const lock = readJson(path.join(sourceRoot, 'scripts', 'package-lock.json'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages['']) {
    throw new Error('A committed npm lockfile with a packages inventory (version 2 or 3) is required.');
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '') continue;
    if (!name.startsWith('node_modules/') || name.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
        /[\\:]/.test(name) || !entry || entry.link || typeof entry.version !== 'string' ||
        typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://') ||
        typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+(?:\s|$)/.test(entry.integrity)) {
      throw new Error(`Lockfile dependency must use a pinned HTTPS archive with integrity, not a local link: ${name}`);
    }
  }
  return { manifest, lock };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inventoryFor(root) {
  const files = [];
  function visit(directory, prefix = '') {
    safeEntry(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = safeEntry(file);
      if (stat.isDirectory()) visit(file, relative);
      else files.push({ path: relative, size: stat.size, sha256: digest(file) });
    }
  }
  visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, algorithm: 'sha256', files };
}

function validateInstalledDependencies(scripts, manifest, lock) {
  for (const name of Object.keys(manifest.dependencies || {})) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) throw new Error(`Runtime dependency is missing from the lockfile: ${name}`);
    const directory = path.join(scripts, 'node_modules', name);
    if (!isWithin(path.join(scripts, 'node_modules'), directory) || !exists(directory)) {
      throw new Error(`Runtime dependency was not installed into the package: ${name}`);
    }
    safePath(directory);
    const installed = readJson(path.join(directory, 'package.json'));
    if (installed.version !== entry.version) throw new Error(`Installed runtime dependency differs from the lockfile: ${name}`);
  }
}

function installerEnvironment() {
  return {
    ...process.env, NODE_PATH: '',
    npm_config_bin_links: 'false',
    npm_config_package_lock: 'true',
    npm_config_install_strategy: 'hoisted',
    npm_config_update_notifier: 'false',
  };
}

async function installDependencies({ cwd, args = NPM_CI_ARGS, env = process.env }) {
  if (JSON.stringify(args) !== JSON.stringify(NPM_CI_ARGS)) throw new Error('Only the pinned npm ci arguments are supported.');
  // Windows cannot exec a .cmd directly. The shell command is constant; paths travel only through cwd/env.
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `npm.cmd ${NPM_CI_ARGS.join(' ')}`] : [...NPM_CI_ARGS];
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`npm ci failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ci failed (exit ${result.status}, signal ${result.signal || 'none'}): ${String(result.stderr || '').trim()}`);
}

/**
 * Build outside the checkout. The existing output parent must be a real directory.
 * installer({ cwd, args, env }) is the test seam; production always runs npm ci.
 * The inventory hashes every payload file, excluding the inventory itself.
 */
async function packagePlugin({ output, sourceRoot = path.resolve(__dirname, '..'), installer = installDependencies } = {}) {
  assertSupportedNode();
  sourceRoot = absolutePath(sourceRoot, 'Source');
  output = absolutePath(output, 'Output');
  if (!safePath(sourceRoot).isDirectory()) throw new Error('Source must be a directory.');
  const checkout = checkoutRoot(sourceRoot);
  if (isWithin(checkout, output) || isWithin(output, sourceRoot)) {
    throw new Error('Output must be outside the source checkout and must not overlap the source.');
  }
  const parent = path.dirname(output);
  if (!safePath(parent).isDirectory()) throw new Error('Output parent must be an existing directory.');
  assertOutputAbsent(output);
  const { manifest, lock } = validateInputs(sourceRoot);
  const lockPath = path.join(parent, `.${path.basename(output)}.package.lock`);
  let lockFd;
  let staging;
  try {
    lockFd = fs.openSync(lockPath, 'wx', 0o600);
    staging = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.stage-`));
    for (const component of COMPONENTS) {
      copyComponent(path.join(sourceRoot, component), path.join(staging, component), component);
    }
    for (const file of OPTIONAL_FILES) {
      if (exists(path.join(sourceRoot, file))) copyComponent(path.join(sourceRoot, file), path.join(staging, file), file);
    }
    const scripts = path.join(staging, 'scripts');
    const pinned = ['package.json', 'package-lock.json'].map(name => ({ file: path.join(scripts, name), sha256: digest(path.join(scripts, name)) }));
    await installer({ cwd: scripts, args: [...NPM_CI_ARGS], env: installerEnvironment() });
    for (const input of pinned) {
      safePath(input.file);
      if (digest(input.file) !== input.sha256) throw new Error(`Installer changed pinned input: ${path.basename(input.file)}`);
    }
    const inventory = inventoryFor(staging);
    validateInstalledDependencies(scripts, manifest, lock);
    fs.writeFileSync(path.join(staging, INVENTORY_FILENAME), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    safePath(parent);
    safePath(staging);
    assertOutputAbsent(output);
    fs.renameSync(staging, output);
    staging = undefined;
    return { output, inventoryPath: path.join(output, INVENTORY_FILENAME), inventory };
  } finally {
    try {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        fs.unlinkSync(lockPath);
      }
    }
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output') throw new Error('Usage: node package-plugin.js --output absolutePath');
  return { output: absolutePath(argv[1], 'Output') };
}

module.exports = { packagePlugin, installDependencies, assertSupportedNode, parseArgs, INVENTORY_FILENAME, NPM_CI_ARGS };

if (require.main === module) {
  Promise.resolve().then(() => {
    assertSupportedNode();
    return packagePlugin(parseArgs(process.argv.slice(2)));
  }).then(result => {
    process.stdout.write(`Packaged plugin: ${result.output}\nSHA256 inventory: ${result.inventoryPath}\n`);
  }).catch(error => {
    process.stderr.write(`Packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
