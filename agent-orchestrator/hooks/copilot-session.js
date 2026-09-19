#!/usr/bin/env node
'use strict';

const { recordHookObservation, runObservationHookCli } = require('../scripts/attempt-channel');

function recordCopilotObservation(payload, { event, environment } = {}) {
  return recordHookObservation({ engineFamily: 'copilot', event, payload, environment });
}

if (require.main === module) runObservationHookCli(recordCopilotObservation);

module.exports = { recordCopilotObservation };
