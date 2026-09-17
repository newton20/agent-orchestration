'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

function runtimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-u1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'checkout');
  fs.mkdirSync(workdir);
  execFileSync('git', ['init', '--quiet', workdir]);
  const manifestPath = path.join(workdir, 'manifest.yaml');
  const manifest = {
    schema_version: 2,
    name: 'foundation',
    workdir: '.',
    defaults: { engine: 'agency-copilot' },
    phases: [{ id: 'p1', agent: { role: 'impl' }, completion_signal: 'done.md' }],
  };
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  return { root, workdir, manifestPath, manifest, runtimeRoot: path.join(root, 'private-runtime') };
}

module.exports = { runtimeFixture };
