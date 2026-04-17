#!/usr/bin/env node
// Unit 0 prototype: parse a manifest, spawn Claude Code sessions via `wt`,
// poll for completion signal files, advance phases sequentially.
// Intentionally ~200 lines — no prompt injection, no recovery, no review loop.
// Validates the spawn + poll + advance core before we build the full plugin.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const DEFAULT_POLL_SEC = 30;
const DEFAULT_TIMEOUT_MIN = 60;
const DEFAULT_LAUNCHER = {
  shell: 'powershell',
  binary: 'agency claude',
  auto_mode_flag: '--enable-auto-mode',
};

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}
function die(msg, code = 1) {
  console.error(`\nFATAL: ${msg}\n`);
  process.exit(code);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const args = { manifest: null, dryRun: false, pollSec: DEFAULT_POLL_SEC };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--poll-seconds') args.pollSec = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node orchestrate-prototype.js <manifest.yaml> [--dry-run] [--poll-seconds N]\n' +
          '  --dry-run       Print spawn commands instead of executing them.\n' +
          '  --poll-seconds  Completion-signal poll interval (default 30).'
      );
      process.exit(0);
    } else if (!a.startsWith('-')) args.manifest = a;
    else die(`Unknown flag: ${a}`);
  }
  if (!args.manifest) die('Usage: node orchestrate-prototype.js <manifest.yaml>');
  return args;
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) die(`Manifest not found: ${manifestPath}`);
  let manifest;
  try {
    manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    die(`Failed to parse manifest YAML: ${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object') die('Manifest must be a YAML object');
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0)
    die('Manifest must define a non-empty `phases` array');
  manifest.phases.forEach((p, i) => {
    if (!p.id) die(`phases[${i}] is missing required field \`id\``);
    if (!p.completion_signal) die(`phases[${i}] (${p.id}) is missing \`completion_signal\``);
  });
  return manifest;
}

function buildSpawnCommand({ phase, launcher, spawnCwd }) {
  const role = phase.agent?.role || 'impl';
  const sessionName = `orch-${phase.id}-${role}`;
  const title = phase.title ? `${sessionName} — ${phase.title}` : sessionName;
  const inner = `${launcher.binary} ${launcher.auto_mode_flag}`.trim();
  // --suppressApplicationTitle keeps our --title visible even after the inner
  // shell / Claude UI tries to overwrite the tab title via escape sequences.
  // -NoExit / /k keep the tab open after the inner process exits, so the
  // user can inspect agent output post-mortem.
  if (launcher.shell === 'powershell') {
    return [
      'wt',
      '-w', '0',
      'new-tab',
      '--title', `"${title}"`,
      '--suppressApplicationTitle',
      '--startingDirectory', `"${spawnCwd}"`,
      'powershell', '-NoExit', '-Command', `"${inner}"`,
    ].join(' ');
  }
  return [
    'wt',
    '-w', '0',
    'new-tab',
    '--title', `"${title}"`,
    '--suppressApplicationTitle',
    '--startingDirectory', `"${spawnCwd}"`,
    'cmd', '/k', inner,
  ].join(' ');
}

function spawnPhase({ phase, launcher, spawnCwd, dryRun }) {
  const cmd = buildSpawnCommand({ phase, launcher, spawnCwd });
  const role = phase.agent?.role || 'impl';
  const sessionName = `orch-${phase.id}-${role}`;
  log(`Spawning ${sessionName}`);
  log(`  wt command: ${cmd}`);
  if (dryRun) {
    log('  [--dry-run] skipping actual spawn');
    return;
  }
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch (e) {
    die(`wt spawn failed for ${sessionName}: ${e.message}`);
  }
  log(`  Tab opened. Claude session starting under ${launcher.binary}.`);
}

function printPromptHandoff({ phase, workdir }) {
  const promptRel = phase.agent?.prompt_file;
  if (promptRel) {
    const promptAbs = path.resolve(workdir, promptRel);
    log(`  >>> Paste the contents of this file into the new Claude tab:`);
    log(`        ${promptAbs}`);
    if (!fs.existsSync(promptAbs)) {
      log(`  WARN: prompt file does not exist yet — create it before the agent idles.`);
    }
  } else {
    log(`  >>> No prompt_file in manifest — brief the agent manually in the new tab.`);
  }
  const signalAbs = path.resolve(workdir, phase.completion_signal);
  log(`  >>> Agent must signal completion by creating:`);
  log(`        ${signalAbs}`);
}

async function waitForCompletion({ phase, workdir, pollSec }) {
  const signalAbs = path.resolve(workdir, phase.completion_signal);
  const timeoutMin = phase.timeout_minutes || DEFAULT_TIMEOUT_MIN;
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  log(`Polling for ${path.basename(signalAbs)} every ${pollSec}s (timeout: ${timeoutMin}m)`);
  log(`  Smoke-test shortcut (simulate completion from another terminal):`);
  log(`    New-Item -ItemType File -Path "${signalAbs}" -Force`);
  while (true) {
    if (fs.existsSync(signalAbs)) {
      log(`Completion signal detected: ${signalAbs}`);
      return;
    }
    if (Date.now() > deadline) {
      die(
        `Phase ${phase.id} timed out after ${timeoutMin}m. ` +
          `Signal never appeared at ${signalAbs}. ` +
          `Inspect the Claude tab, then rerun to resume (existing signals are skipped).`
      );
    }
    const remainingMin = Math.max(1, Math.round((deadline - Date.now()) / 60000));
    log(`  ...still waiting (${remainingMin}m remaining)`);
    await sleep(pollSec * 1000);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestAbs = path.resolve(args.manifest);
  const workdir = path.dirname(manifestAbs);
  const manifest = loadManifest(manifestAbs);
  const launcher = { ...DEFAULT_LAUNCHER, ...(manifest.launcher || {}) };
  // spawnCwd = where spawned tabs start. Defaults to manifest dir. Override
  // via manifest.workdir (absolute or relative to the manifest file). Paths
  // in the manifest (prompt_file, completion_signal) always resolve against
  // the manifest dir — not spawnCwd.
  const spawnCwd = manifest.workdir
    ? path.resolve(workdir, manifest.workdir)
    : workdir;

  log(`Agent Orchestrator — Unit 0 prototype`);
  log(`  Project:   ${manifest.name || '(unnamed)'}`);
  log(`  Manifest:  ${manifestAbs}`);
  log(`  Paths in:  ${workdir}`);
  log(`  Spawn cwd: ${spawnCwd}${spawnCwd === workdir ? ' (same as manifest dir)' : ''}`);
  log(`  Launcher:  ${launcher.shell} → ${launcher.binary} ${launcher.auto_mode_flag}`);
  log(`  Phases:    ${manifest.phases.map((p) => p.id).join(' → ')}`);
  if (args.dryRun) log(`  Mode:      --dry-run (no tabs spawned)`);

  process.on('SIGINT', () => {
    log('Ctrl+C received — orchestrator exiting. Spawned Claude tabs keep running.');
    process.exit(130);
  });

  let spawned = 0;
  let skipped = 0;
  for (const phase of manifest.phases) {
    log('');
    log(`=== Phase ${phase.id}${phase.title ? ` — ${phase.title}` : ''} ===`);
    const signalAbs = path.resolve(workdir, phase.completion_signal);
    fs.mkdirSync(path.dirname(signalAbs), { recursive: true });
    if (fs.existsSync(signalAbs)) {
      log(`Skipping ${phase.id}: completion signal already present at ${signalAbs}`);
      skipped++;
      continue;
    }
    spawnPhase({ phase, launcher, spawnCwd, dryRun: args.dryRun });
    printPromptHandoff({ phase, workdir });
    if (args.dryRun) {
      log('  [--dry-run] skipping completion polling');
      continue;
    }
    await waitForCompletion({ phase, workdir, pollSec: args.pollSec });
    spawned++;
    log(`Phase ${phase.id} complete.`);
  }

  log('');
  log(`Orchestration finished. Spawned ${spawned} phase(s), skipped ${skipped} already-complete phase(s).`);
}

main().catch((e) => die(e.stack || e.message));
