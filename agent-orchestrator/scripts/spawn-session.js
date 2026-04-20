#!/usr/bin/env node
/**
 * spawn-session.js — open a new Windows Terminal tab running an
 * interactive Claude Code session with a specific `orch-*` session name.
 *
 * The orchestrator (Unit 11, future) calls spawnSession() per phase/role
 * to bring up one visible, user-steerable Claude tab per agent. This
 * module handles ONLY the spawn — prompt injection happens via the
 * SessionStart hook (Unit 5) once launcher-compat is confirmed in Unit 4.5.
 *
 * Two launcher configurations ship out of the box:
 *
 *   Default (direct claude, cmd shell):
 *     wt -w 0 new-tab --title "..." --suppressApplicationTitle
 *        --startingDirectory "..." cmd /k claude --name ...
 *
 *   Agency (Microsoft wrapper, PowerShell):
 *     wt -w 0 new-tab --title "..." --suppressApplicationTitle
 *        --startingDirectory "..." powershell -NoExit -Command
 *        "agency claude --enable-auto-mode --name ..."
 *
 * --suppressApplicationTitle is ALWAYS present: Unit 0 dogfood proved tab
 * titles revert to "PowerShell"/"Claude Code" within seconds otherwise,
 * defeating the `orch-<phase>-<role>` naming scheme the hook depends on.
 *
 * CLI (thin wrapper around spawnSession):
 *   spawn-session.js --name <name> --workdir <dir>
 *                    [--model <id>] [--title <s>] [--plugin-dir <dir>]
 *                    [--launcher <manifest.yaml>] [--dry-run]
 *
 * Exits 0 on success, 1 on validation or spawn error.
 *
 * Exports:
 *   spawnSession(opts) -> { pid, command, sessionName, spawnedAt }
 *   getSessionPid(name) -> number | null
 *   buildSpawnCommand(opts) -> { command, sessionName, title } (pure)
 *   DEFAULT_LAUNCHER, AGENCY_LAUNCHER  (for reference + tests)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const { validateLauncher } = require('./parse-manifest');

// -------------------- Launcher presets --------------------

// Default ships as direct `claude` invoked by cmd. Lowest dependency
// surface — works on any Windows box with Claude Code + Windows Terminal.
const DEFAULT_LAUNCHER = Object.freeze({
  shell: 'cmd',
  binary: 'claude',
  auto_mode_flag: '--permission-mode auto',
  shell_args: '/k',
  passthrough_flags: [],
});

// Microsoft `agency` wrapper, invoked by PowerShell. Documented as the
// first alternative because this repo's own coord runs Claude this way.
// Unit 4.5 spike verifies whether SessionStart hooks fire under this path.
const AGENCY_LAUNCHER = Object.freeze({
  shell: 'powershell',
  binary: 'agency claude',
  auto_mode_flag: '--enable-auto-mode',
  shell_args: '-NoExit -Command',
  passthrough_flags: [],
});

// -------------------- Quoting --------------------

// cmd (cmd.exe) uses double-quotes to group arguments containing spaces
// and special characters. Embedded double-quotes double to "" inside a
// quoted run. Conditional: bare tokens (no whitespace / metachars) are
// left unquoted, which is both cleaner output and identical semantics.
function quoteCmd(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '""';
  if (/[\s"&<>|^%]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Force double-quoting regardless of contents. Used for path-typed
// arguments (workdir, pluginDir, title) where users may later hit a path
// with spaces and the extra quotes cost nothing when they don't.
function quoteCmdAlways(value) {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

// PowerShell receives the inner command as a single double-quoted string
// passed to `-Command`. Inside that double-quoted string, we MUST use
// single-quotes for values so spaces don't split arguments and so the
// outer double-quoted boundary survives. Embedded single-quotes double
// to '' — the PowerShell convention for literal strings.
function quotePs(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return "''";
  if (/[\s'"`$]/.test(s) || s.includes('\\')) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

// Force single-quoting inside a PowerShell -Command scriptblock, same
// rationale as quoteCmdAlways.
function quotePsAlways(value) {
  if (value === null || value === undefined) return "''";
  const s = String(value);
  return `'${s.replace(/'/g, "''")}'`;
}

// `launcher.binary` is a dual-purpose field: it might be a bare command
// ("claude"), a "program + arg" string ("agency claude"), or an absolute
// executable path that may contain spaces ("C:\Program Files\Claude\claude.exe").
// If we unconditionally quote, "agency claude" becomes a single token the
// shell can't find. If we never quote, "C:\Program Files\..." splits at the
// first space. Heuristic: only quote when the string contains a path
// separator AND whitespace — the telltale of case 3. For PowerShell we
// also prefix the call operator (`& 'path'`) so the quoted path is
// executed rather than emitted as a string literal.
function quoteBinary(binary, shell) {
  if (typeof binary !== 'string' || binary === '') return binary;
  const hasPathSep = /[\\/]/.test(binary);
  const hasSpace = /\s/.test(binary);
  if (!(hasPathSep && hasSpace)) return binary;
  if (shell === 'powershell') {
    return `& '${binary.replace(/'/g, "''")}'`;
  }
  return `"${binary.replace(/"/g, '""')}"`;
}

// -------------------- Launcher resolution --------------------

/**
 * Merge a user-provided launcher with the default. Unknown fields pass
 * through (parse-manifest warns; spawnSession just ignores them in
 * command construction). Missing fields inherit from the preset whose
 * shell matches the user's `shell` field — so a partial PowerShell
 * launcher picks up AGENCY_LAUNCHER's `-NoExit -Command` and
 * `--enable-auto-mode` rather than cmd's `/k` + `--permission-mode auto`.
 * Addresses codex P2: cross-shell default bleed would produce invalid
 * command lines like `powershell /k claude --permission-mode auto`.
 *
 * If `launcher` is `null`/`undefined`, returns DEFAULT_LAUNCHER.
 * If `launcher` is a preset alias string ('default' | 'agency'),
 * returns the corresponding preset. Anything else is validated via
 * validateLauncher() from parse-manifest.
 */
function resolveLauncher(launcher) {
  if (launcher === null || launcher === undefined) return { ...DEFAULT_LAUNCHER };
  if (typeof launcher === 'string') {
    const alias = launcher.toLowerCase();
    if (alias === 'default') return { ...DEFAULT_LAUNCHER };
    if (alias === 'agency') return { ...AGENCY_LAUNCHER };
    throw new Error(
      `unknown launcher alias "${launcher}" — known: default, agency, or supply a full object`
    );
  }
  const { errors } = validateLauncher(launcher);
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`invalid launcher: ${msg}`);
  }
  // Baseline defaults per shell — cmd and powershell want different
  // shell_args / auto_mode_flag defaults. User-supplied fields override.
  const baseline =
    launcher.shell === 'powershell' ? AGENCY_LAUNCHER : DEFAULT_LAUNCHER;
  return { ...baseline, ...launcher };
}

/**
 * Load a launcher block from a manifest YAML file on disk. Used by the
 * CLI wrapper when the caller points at `manifest.yaml` instead of
 * supplying the block inline. Returns `null` only when the `launcher`
 * key is absent — any present-but-malformed value (e.g. `launcher: false`
 * or `launcher: ""`) is returned verbatim so resolveLauncher's validator
 * can surface the real error rather than silently falling back to the
 * default. Addresses codex P2: a typo like `launcher: false` must not
 * masquerade as "no launcher configured".
 */
function loadLauncherFromManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs))
    throw new Error(`launcher manifest not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`launcher manifest must be a YAML object: ${abs}`);
  if (!Object.prototype.hasOwnProperty.call(parsed, 'launcher')) return null;
  // `launcher:` with nothing after it parses to null in YAML. That's
  // ambiguous with "no launcher", so treat a present-but-null value as
  // the error it almost certainly is (codex P2: explicit null must not
  // silently fall back to defaults).
  if (parsed.launcher === null)
    throw new Error(
      `launcher manifest has an explicit null launcher at ${abs} — ` +
        `either remove the key entirely or provide an object. ` +
        `(YAML parses bare "launcher:" as null.)`
    );
  return parsed.launcher;
}

// -------------------- Command construction --------------------

/**
 * Pure builder — returns the exact wt command string that would be
 * passed to execSync, plus the computed sessionName and title. Callers
 * use this directly in --dry-run and tests.
 *
 * Required: name, workdir. Everything else is optional.
 *
 * The Claude invocation is:
 *   <binary> <auto_mode_flag> --name <name> \
 *     [--model <model>] [--plugin-dir <pluginDir>] <passthrough_flags>
 *
 * For cmd shell: `cmd <shell_args> <invocation>` — cmd tokenizes directly.
 * For powershell shell: `powershell <shell_args> "<invocation>"` — the
 * invocation is a single double-quoted argument to -Command; inside, values
 * are single-quoted.
 */
function buildSpawnCommand({
  name,
  workdir,
  model = null,
  title = null,
  pluginDir = null,
  launcher = null,
  windowTarget = '0',
}) {
  if (!name || typeof name !== 'string' || name.trim() === '')
    throw new Error('spawnSession: `name` is required (non-empty string)');
  if (!workdir || typeof workdir !== 'string' || workdir.trim() === '')
    throw new Error('spawnSession: `workdir` is required (non-empty string)');

  const resolved = resolveLauncher(launcher);
  const {
    shell,
    binary,
    auto_mode_flag,
    shell_args,
    passthrough_flags,
  } = resolved;

  // getSessionPid matches tab rows in tasklist by window-title prefix,
  // so the session name MUST be the leading substring of the tab title.
  // The prototype follows the same convention (`${name} — ${title}`). If
  // the caller supplied a custom title that doesn't already start with
  // name, prepend it with an em-dash separator so the PID lookup stays
  // discoverable. Codex P2: custom titles without the name prefix were
  // previously undiscoverable.
  const sessionName = name;
  let effectiveTitle;
  if (!title) effectiveTitle = sessionName;
  else if (title === sessionName || title.startsWith(sessionName + ' '))
    effectiveTitle = title;
  else effectiveTitle = `${sessionName} — ${title}`;

  // Quoter depends on which shell the inner command lands inside.
  // Simple tokens use conditional quoting (cleaner output); path-typed
  // args use always-quote so users with spaces-in-paths never hit a
  // silent regression.
  const q = shell === 'powershell' ? quotePs : quoteCmd;
  const qPath = shell === 'powershell' ? quotePsAlways : quoteCmdAlways;

  // Build inner Claude invocation as tokens. `binary` may contain a
  // space in two very different ways:
  //   1. "agency claude" — program + first arg. Pass verbatim so the
  //      shell tokenizes it at runtime.
  //   2. "C:\\Program Files\\Claude\\claude.exe" — a single path with
  //      a space. Must be quoted or the shell runs "C:\\Program" as
  //      the program. Codex P2.
  // Heuristic: if the binary contains a path separator AND whitespace,
  // it's case 2 and needs quoting. Otherwise it's case 1 (or a bare
  // word) and stays verbatim.
  const innerTokens = [quoteBinary(binary, shell)];
  if (auto_mode_flag) innerTokens.push(auto_mode_flag);
  innerTokens.push('--name', q(name));
  if (model) innerTokens.push('--model', q(model));
  if (pluginDir) innerTokens.push('--plugin-dir', qPath(pluginDir));
  if (Array.isArray(passthrough_flags)) {
    for (const f of passthrough_flags) innerTokens.push(f);
  }
  const innerCmd = innerTokens.filter((t) => t !== '').join(' ');

  // Serialize the shell invocation. shell_args is a flat string so it
  // survives "-NoExit -Command" as one logical flag pair without splitting
  // the PowerShell literal command-block boundary.
  let shellPart;
  if (shell === 'powershell') {
    const preflags = shell_args || '-NoExit -Command';
    // Wrap the inner command in DOUBLE quotes so PowerShell's -Command
    // receives it as a single scriptblock argument. Inner values are
    // already single-quoted by quotePs, so no nesting conflict.
    shellPart = `powershell ${preflags} "${innerCmd}"`;
  } else {
    const preflags = shell_args || '/k';
    shellPart = `cmd ${preflags} ${innerCmd}`;
  }

  // wt args: always double-quote path/title values so users with spaces
  // in their project paths work out of the box. wt itself is consumed by
  // Windows — double-quotes are the right grouping regardless of which
  // shell wt hands off to.
  const wtParts = [
    'wt',
    '-w',
    windowTarget,
    'new-tab',
    '--title',
    quoteCmdAlways(effectiveTitle),
    '--suppressApplicationTitle',
    '--startingDirectory',
    quoteCmdAlways(workdir),
    shellPart,
  ];

  const command = wtParts.join(' ');
  return { command, sessionName, title: effectiveTitle };
}

// -------------------- getSessionPid --------------------

// Sample Windows `tasklist /V /FO CSV` row:
//   "WindowsTerminal.exe","12345","Console","1","45,678 K","Running","...","0:00:01","orch-phase-0-impl — Scaffold"
// We match on the trailing "Window Title" column, not the process name,
// because the session's PID may be tied to any of: WindowsTerminal, cmd,
// powershell, claude, or a wrapper process — all we care about is which
// PID owns a window titled `orch-*`.
const TASKLIST_WINDOW_TITLE_INDEX_HINT = 8;

/**
 * Parse Windows `tasklist /V /FO CSV` output and return the first PID
 * whose Window Title starts with `name`. Exposed for tests; consumers
 * use getSessionPid().
 *
 * CSV rows look like: "img","pid","sess","sessN","mem","status","user","time","title"
 * The title may contain commas and quotes. We split on `","` after
 * stripping the outer quotes, which is sufficient because tasklist
 * escapes embedded quotes by doubling them — which we don't rely on
 * inside the title.
 */
function parseTasklistCsv(stdout, name) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const line of lines) {
    // Strip leading/trailing quote; split on "," to get columns.
    if (!line.startsWith('"')) continue;
    const cols = line
      .slice(1, line.endsWith('"') ? -1 : undefined)
      .split('","');
    if (cols.length < TASKLIST_WINDOW_TITLE_INDEX_HINT + 1) continue;
    const pidRaw = cols[1];
    const titleCol = cols[cols.length - 1];
    if (!pidRaw || !/^\d+$/.test(pidRaw)) continue;
    if (typeof titleCol === 'string' && titleCol.startsWith(name)) {
      return parseInt(pidRaw, 10);
    }
  }
  return null;
}

/**
 * Return the PID of the spawned Windows Terminal tab whose title starts
 * with `name`, or `null` if no match. Injectable runner makes this
 * testable without shelling out.
 */
function getSessionPid(name, { _runner } = {}) {
  if (!name || typeof name !== 'string') return null;
  const runner =
    _runner ||
    ((cmd) =>
      execSync(cmd, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }));
  let out;
  try {
    out = runner('tasklist /V /FO CSV /NH');
  } catch (_) {
    return null;
  }
  return parseTasklistCsv(out, name);
}

// -------------------- spawnSession --------------------

/**
 * Spawn a visible Claude tab. Returns metadata for the caller (the
 * orchestrator) to record in manifest-status.yaml.
 *
 * `_runner` is the injection seam for tests — pass a stub that captures
 * the command string instead of shelling out. Production callers omit it.
 */
function spawnSession({
  name,
  workdir,
  model = null,
  title = null,
  pluginDir = null,
  launcher = null,
  windowTarget = '0',
  _runner,
  _tasklistRunner,
  _now,
}) {
  const { command, sessionName, title: resolvedTitle } = buildSpawnCommand({
    name,
    workdir,
    model,
    title,
    pluginDir,
    launcher,
    windowTarget,
  });

  const runner = _runner || ((cmd) => execSync(cmd, { stdio: 'ignore' }));
  runner(command);

  const now =
    typeof _now === 'function'
      ? _now()
      : new Date().toISOString();

  // PID lookup is best-effort: the tab may not be registered yet when
  // this returns. Orchestrator callers retry via getSessionPid() later.
  const pid = getSessionPid(sessionName, { _runner: _tasklistRunner });

  return { pid, command, sessionName, title: resolvedTitle, spawnedAt: now };
}

// -------------------- CLI --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  spawn-session.js --name <name> --workdir <dir>',
      '                   [--model <id>] [--title <s>] [--plugin-dir <dir>]',
      '                   [--launcher <manifest.yaml | default | agency>] [--dry-run]',
      '',
      '  --name         Required. Session name (becomes --name on Claude and the',
      '                 wt tab title prefix). Must be unique per phase/role.',
      '  --workdir      Required. wt --startingDirectory.',
      '  --launcher     Manifest YAML path, "default", or "agency". Defaults to',
      '                 "default" (cmd /k claude).',
      '  --dry-run      Print the wt command without spawning a tab.',
      '',
      'Exit codes: 0 = success, 1 = validation/spawn error.',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  const out = {
    name: null,
    workdir: null,
    model: null,
    title: null,
    pluginDir: null,
    launcher: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--name':
        out.name = argv[++i];
        break;
      case '--workdir':
        out.workdir = argv[++i];
        break;
      case '--model':
        out.model = argv[++i];
        break;
      case '--title':
        out.title = argv[++i];
        break;
      case '--plugin-dir':
        out.pluginDir = argv[++i];
        break;
      case '--launcher':
        out.launcher = argv[++i];
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  if (!out.name) fail('--name is required (see --help)');
  if (!out.workdir) fail('--workdir is required (see --help)');
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write(`spawn-session: ${msg}\n`);
  process.exit(code);
}

function main() {
  const args = parseCliArgs(process.argv);

  // `launcher` arg is a path unless it matches a preset alias.
  let launcherArg = args.launcher;
  if (
    launcherArg &&
    launcherArg !== 'default' &&
    launcherArg !== 'agency' &&
    fs.existsSync(launcherArg)
  ) {
    try {
      launcherArg = loadLauncherFromManifest(launcherArg);
    } catch (e) {
      fail(e.message);
    }
  }

  if (args.dryRun) {
    let built;
    try {
      built = buildSpawnCommand({
        name: args.name,
        workdir: args.workdir,
        model: args.model,
        title: args.title,
        pluginDir: args.pluginDir,
        launcher: launcherArg,
      });
    } catch (e) {
      fail(e.message);
    }
    process.stdout.write(
      JSON.stringify({ ok: true, dryRun: true, ...built }, null, 2) + '\n'
    );
    return;
  }

  let result;
  try {
    result = spawnSession({
      name: args.name,
      workdir: args.workdir,
      model: args.model,
      title: args.title,
      pluginDir: args.pluginDir,
      launcher: launcherArg,
    });
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  spawnSession,
  getSessionPid,
  buildSpawnCommand,
  resolveLauncher,
  loadLauncherFromManifest,
  parseTasklistCsv,
  quoteCmd,
  quoteCmdAlways,
  quotePs,
  quotePsAlways,
  quoteBinary,
  DEFAULT_LAUNCHER,
  AGENCY_LAUNCHER,
};
