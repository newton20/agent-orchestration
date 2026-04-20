#!/usr/bin/env node
// Unit 4.5 spike — dump the SessionStart hook's env + stdin to disk so
// we can see exactly what Claude Code exposes (session name? plugin dir?
// hook payload?) across direct `claude` vs `agency claude` launchers.
// Outputs `{}` so Claude sees no additionalContext — this must be a
// no-op for the session itself.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dumpPath = path.join(os.homedir(), '.claude-hook-spike-dump.txt');

let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (_) { /* empty */ }

const block = [
  '===== hook fired at ' + new Date().toISOString() + ' =====',
  'cwd: ' + process.cwd(),
  'argv: ' + JSON.stringify(process.argv),
  'env:',
  JSON.stringify(process.env, null, 2),
  'stdin (' + stdin.length + ' bytes):',
  stdin || '(empty)',
  '',
].join('\n');

try {
  fs.appendFileSync(dumpPath, block);
} catch (_) {
  // Fail silent — the hook must not break the session.
}

process.stdout.write('{}');
