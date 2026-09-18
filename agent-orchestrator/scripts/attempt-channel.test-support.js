'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { canonicalPath } = require('./workspace-owner');

function attemptFixture(t, engine = 'agency-copilot') {
  const directory = path.resolve(`.u3-channel-fixture-${randomUUID()}`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = canonicalPath(directory);
  const identity = { run_id: 'run-a', phase_id: 'phase-a', role: 'impl', review_iteration: 0, attempt_id: randomUUID() };
  const artifacts = path.join(root, 'docs', 'orchestration', 'runs', identity.run_id,
    'phases', identity.phase_id, identity.role, '0', identity.attempt_id);
  fs.mkdirSync(artifacts, { recursive: true });
  const prompt = path.join(artifacts, 'impl-prompt.md');
  const promptText = 'Perform the accepted assignment. Do not change any other phase.\n';
  fs.writeFileSync(prompt, promptText);
  const attempt = {
    ...identity, engine, access: 'mutating', workdir: root, model: null, status: 'launching',
    intent: {
      launch_token: randomUUID(), session_name: `orch-${identity.attempt_id}`,
      prompt_text: promptText, prompt_sha256: createHash('sha256').update(promptText).digest('hex'),
    },
    artifacts: { directory: artifacts, prompt }, observations: {},
    launch_host: { hostname: 'test-host', host_boot_id: 'test-boot' },
    reservation: { state: 'held' },
  };
  return { root, attempt };
}

module.exports = { attemptFixture };
