'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cases = [
  'selected engine version, installed capability preflight and clean packaged plugin load',
  'visible startup and exact user-task submission with independent engine process/session correlation',
  'user steering while active and a controlled new-session /resume retry',
  'coordinator restart without replay and cooperative release without descendant-closure guesses',
];

for (const engine of ['claude', 'agency-claude', 'agency-copilot']) {
  for (const scenario of cases) {
    test(`LIVE ACCEPTANCE: ${engine}: ${scenario}`, {
      skip: 'No live authorization or separately reviewed engine evidence. Offline fixtures do not satisfy acceptance.',
    }, () => {
      // Removing the skip cannot turn an unimplemented acceptance procedure into a pass.
      assert.fail('Implement an evidence-validated, explicitly authorized live procedure before enabling this test.');
    });
  }
}
