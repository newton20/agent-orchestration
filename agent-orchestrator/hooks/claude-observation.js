#!/usr/bin/env node
'use strict';

const { recordHookObservation, runObservationHookCli } = require('../scripts/attempt-channel');

function recordClaudeObservation(payload, { event, environment } = {}) {
  return recordHookObservation({ engineFamily: 'claude', event, payload, environment });
}

if (require.main === module) runObservationHookCli(recordClaudeObservation);

module.exports = { recordClaudeObservation };
