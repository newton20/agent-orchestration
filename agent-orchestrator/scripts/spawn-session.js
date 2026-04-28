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
 *   spawnSession(opts) -> { pid, command, sessionName, title, spawnedAt }
 *   getSessionPid(name) -> number | null
 *   buildSpawnCommand(opts) -> { command, sessionName, title } (pure)
 *   DEFAULT_LAUNCHER, AGENCY_LAUNCHER  (for reference + tests)
 *
 * PID lookup uses WMI CommandLine matching (not tasklist title matching)
 * so background wt tabs stay discoverable. See getSessionPid for details.
 *
 * Trust boundary. Launcher fields (`binary`, `shell_args`, `auto_mode_flag`,
 * `passthrough_flags`) reach the inner shell verbatim. Treat the launcher
 * block as a trusted config surface. Phase IDs and session names are
 * independently validated upstream (`parse-manifest.js`'s `VALID_ID_RE`).
 *
 * Three more inputs are also trusted, in subtly different ways — name
 * each so a future reader doesn't conclude "everything outside the four
 * launcher fields is validated":
 *   - `windowTarget` is trusted pass-through. Defaults to `'0'` and is
 *     interpolated into `wt -w <windowTarget>` and the rendered command
 *     string with no format guard in V1 (F2 from docs/todos/004 is
 *     deferred to Unit 11).
 *   - Per-call args (`name`, `model`, `pluginDir`, `title`, `workdir`)
 *     are *quoted-not-validated* — defended at the quoting layer by
 *     `q()` / `qPath()` (see `quoteCmd*` / `quotePs*`), NOT by upstream
 *     validation. Phase IDs used as session names are independently
 *     validated by `parse-manifest.js`'s `VALID_ID_RE`; other per-call
 *     args trust the caller to pass sane values.
 *   - The manifest path passed via `--launcher` is itself trusted: the
 *     operator picks the YAML path; spawn-session does no traversal
 *     validation. Higher-layer callers (web UI, API) MUST validate the
 *     path before invoking spawn-session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { validateLauncher } = require('./parse-manifest');

// -------------------- Launcher presets --------------------

// Default ships as direct `claude` invoked by cmd. Lowest dependency
// surface — works on any Windows box with Claude Code + Windows Terminal.
//
// Note: the Unit 0 PROTOTYPE uses `agency claude` + powershell as its
// default because the prototype author's dev environment runs Claude
// through Microsoft's agency wrapper. For Unit 4 (the shippable module)
// the plan explicitly calls for `cmd + claude` as the default and
// `agency` as a named preset (see plan §"Key Technical Decisions" →
// "Session spawning via wt + configurable launcher" and §"Unit 4 …
// Default launcher (direct claude, cmd)"). Agency users set
// `launcher.shell: powershell` + `launcher.binary: agency claude` in
// their manifest (or use `--launcher agency` on the CLI). This
// divergence from the prototype is intentional and documented.
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

// `launcher.binary` is a multi-purpose field. The shapes we handle:
//
//   1. bare command                  "claude"
//   2. program + subcommand          "agency claude"
//   3. exe path, no spaces           "C:\tools\claude.exe"
//   4. exe path with spaces          "C:\Program Files\Claude\claude.exe"
//
// Quote only when the whole string is BOTH path-like AND has whitespace
// (case 4). Everything else stays verbatim. PowerShell uses the call
// operator (`& 'path'`) so a quoted path actually executes instead of
// being emitted as a string literal.
//
// Whitespace immediately after an executable extension (`.exe`/`.cmd`/
// `.bat`/`.com`, possibly with a trailing quote) signals an "exe +
// arguments" boundary rather than a "path with spaces" — leave it
// verbatim so the shell tokenizes the subcommand normally. Manifest
// authors with a path-with-spaces wrapper plus a subcommand should
// pre-quote the exe portion in their `binary` value (the cmd shape
// `"C:\Program Files\X\x.exe" sub`).
function quoteBinary(binary, shell) {
  if (typeof binary !== 'string' || binary === '') return binary;
  const hasPathSep = /[\\/]/.test(binary);
  const hasSpace = /\s/.test(binary);
  if (!(hasPathSep && hasSpace)) return binary;
  if (/\.(exe|cmd|bat|com)["']?\s/i.test(binary)) return binary;
  if (shell === 'powershell') {
    return `& '${binary.replace(/'/g, "''")}'`;
  }
  return `"${binary.replace(/"/g, '""')}"`;
}

// Tokenize a `shell_args` string into argv elements, preserving
// quoted segments (including embedded whitespace). Handles BOTH
// double-quote and single-quote grouping — PowerShell treats `'...'`
// as a literal string, and users write wrapper paths like
// `-File 'C:\Program Files\wrapper.ps1'` as a matter of style.
//
// Used for the argv-form passed to execFileSync; the display-form
// `command` string leaves shell_args inline and relies on the user's
// original quoting.
function tokenizeShellArgs(s) {
  if (!s || typeof s !== 'string') return [];
  const tokens = [];
  let cur = '';
  let quoteChar = null; // null | '"' | "'"
  let consumed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoteChar === null && (c === '"' || c === "'")) {
      quoteChar = c;
      consumed = true;
      continue;
    }
    if (quoteChar !== null && c === quoteChar) {
      quoteChar = null;
      continue;
    }
    if (quoteChar === null && /\s/.test(c)) {
      if (consumed || cur !== '') {
        tokens.push(cur);
        cur = '';
        consumed = false;
      }
      continue;
    }
    cur += c;
    consumed = true;
  }
  if (consumed || cur !== '') tokens.push(cur);
  return tokens;
}

// -------------------- Launcher resolution --------------------

/**
 * Merge a user-provided launcher with the default. Unknown fields pass
 * through (parse-manifest warns; spawnSession just ignores them in
 * command construction). Missing fields inherit from the preset whose
 * shell matches the user's `shell` field — so a partial PowerShell
 * launcher picks up AGENCY_LAUNCHER's `-NoExit -Command` and
 * `--enable-auto-mode` rather than cmd's `/k` + `--permission-mode auto`.
 * Without the per-shell baseline, a partial PowerShell launcher would
 * silently inherit cmd defaults and produce invalid command lines like
 * `powershell /k claude --permission-mode auto`.
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
 * default. A typo like `launcher: false` must not masquerade as "no
 * launcher configured".
 */
function loadLauncherFromManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs))
    throw new Error(`launcher manifest not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  // Pinned to DEFAULT_SCHEMA for parity with the calls in
  // parse-manifest.js (loadManifest + runUpdate) — preserves merge keys
  // (`<<`) and timestamps; making the choice explicit at every site
  // documents intent.
  const parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`launcher manifest must be a YAML object: ${abs}`);
  if (!Object.prototype.hasOwnProperty.call(parsed, 'launcher')) return null;
  // `launcher:` with nothing after it parses to null in YAML. That's
  // ambiguous with "no launcher", so treat a present-but-null value as
  // the error it almost certainly is — explicit null must not silently
  // fall back to defaults.
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
  // discoverable — a custom title without the name prefix would otherwise
  // be undiscoverable.
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
  //      the program.
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

  // Two parallel representations:
  //   `argv` — the argv passed to execFileSync('wt', argv). Each element
  //            is ONE token; Node serializes via MSVC CreateProcess rules
  //            so embedded quotes survive cleanly. This is what we
  //            actually execute.
  //   `command` — a human-readable shell-string rendering for logging,
  //            --dry-run output, and test assertions. Same content, but
  //            NOT the string we execute (going through execSync → cmd.exe
  //            would eat `%` and mangle nested quotes — that path corrupts
  //            both the WMI %--name % filter and any --plugin-dir with
  //            embedded spaces).
  //
  // For the shell part, wt expects the subcommand's argv as separate
  // tokens after `new-tab`. We hand each of {shell-binary, shell-args,
  // innerCmd-as-one-token} as its own wt argv element — wt itself joins
  // them with spaces when it spawns the subcommand, so the quoted-inner
  // values arrive at cmd /k or powershell -Command intact.
  let shellArgv;
  if (shell === 'powershell') {
    const preflags = tokenizeShellArgs(shell_args || '-NoExit -Command');
    shellArgv = ['powershell', ...preflags, innerCmd];
  } else {
    const preflags = tokenizeShellArgs(shell_args || '/k');
    shellArgv = ['cmd', ...preflags, innerCmd];
  }

  const argv = [
    '-w',
    windowTarget,
    'new-tab',
    '--title',
    effectiveTitle,
    '--suppressApplicationTitle',
    '--startingDirectory',
    workdir,
    ...shellArgv,
  ];

  // Render the shell-string form for logging/dry-run. Uses the same
  // quoting rules as before (always-quote paths/title for wt, outer-
  // wrap cmd's innerCmd so the wt→cmd handoff preserves inner quotes).
  // The shell-string is never executed — it's documentation.
  let shellPart;
  if (shell === 'powershell') {
    const preflags = shell_args || '-NoExit -Command';
    shellPart = `powershell ${preflags} "${innerCmd}"`;
  } else {
    const preflags = shell_args || '/k';
    shellPart = `cmd ${preflags} "${innerCmd}"`;
  }
  const command = [
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
  ].join(' ');

  return { command, argv, sessionName, title: effectiveTitle };
}

// -------------------- getSessionPid --------------------

// Finding the PID of a specific tab in `wt -w 0` is hard: tasklist /V
// only surfaces the active tab's window title, so background tabs are
// invisible by title alone. Instead we match on the spawned process's
// COMMAND LINE — every session's inner command contains the
// distinctive `--name orch-<phase>-<role>` flag, and WMI exposes
// CommandLine for every running process regardless of which wt tab is
// foreground.
//
// We use PowerShell's Get-CimInstance Win32_Process (wmic is deprecated
// in Windows 11 24H2+). The filter pushes the LIKE match into CIM so we
// only read back the ProcessId, which keeps output small and parsing
// trivial: one PID per line, no header.

/**
 * Build the PowerShell argv that retrieves PID + CommandLine for every
 * process with `--name` on its command line, as a JSON array.
 *
 * The exact boundary check is done in JS (parsePidLookupOutput) with a
 * regex — not in the WMI filter — because (a) SQL LIKE uses `_` as a
 * wildcard and phase ids allow `_`, and (b) LIKE can't express "the
 * name is followed by whitespace or end-of-line", so `--name foo`
 * wrongly matches `--name foo-bar`.
 *
 * Returned as argv (not a shell string) so getSessionPid can invoke
 * via `execFileSync('powershell', argv)` — which bypasses cmd.exe.
 * cmd.exe eagerly expands `%...%` as environment variables, which
 * would mangle our `%--name %` LIKE filter into an empty string
 * (through execSync, `%--name %` becomes `` because the phantom env
 * var `--name ` doesn't exist).
 *
 * @{...} wraps the CIM result so ConvertTo-Json always emits an array,
 * even for zero or one result. -Depth 1 keeps the output shallow.
 */
function buildPidLookupArgs() {
  const script =
    "@(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--name %'\" " +
    '| Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress -Depth 1';
  return ['-NoProfile', '-NoLogo', '-Command', script];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the JSON CIM output and return the first PID whose CommandLine
 * contains `--name <name>` bounded by whitespace (or end-of-line) on
 * both sides. This avoids the substring-collision issues of WMI LIKE
 * (`_` is a wildcard; suffix-extension false-positives).
 *
 * Matching more than one row is possible (the wrapper + inner claude
 * both carry the --name flag); the first is fine because either dying
 * indicates session loss.
 */
// Heuristic: is the process a shell-wrapper that should NOT be treated
// as the session's primary PID? The bundled launchers intentionally keep
// cmd /k and powershell open after Claude exits so the user can inspect
// output post-mortem. If Unit 8's health check watched the wrapper's
// PID, it'd report the agent alive forever after Claude exits. We detect
// by looking at the first token of the CommandLine (with or without a
// .exe suffix, case-insensitive).
const SHELL_WRAPPERS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe']);

function isShellWrapperCmdline(cmdline) {
  if (typeof cmdline !== 'string') return false;
  const trimmed = cmdline.trim();
  // First token may be a quoted path like `"C:\...\powershell.exe"` —
  // extract through the closing quote if the first char is a quote,
  // else up to the first whitespace. Without the trailing-quote
  // handling, the extracted basename would include the `"` and the
  // wrapper check would miss quoted exe paths.
  let first;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    first = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  } else {
    first = trimmed.split(/\s+/)[0] || '';
  }
  const bare = first.replace(/^.*[\\/]/, '').toLowerCase();
  return SHELL_WRAPPERS.has(bare);
}

function parsePidLookupOutput(stdout, name) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  if (!name || typeof name !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_) {
    return null;
  }
  if (parsed === null || parsed === undefined) return null;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  // Boundary check on both sides: the leading group accepts an
  // optional opening single- or double-quote so quoted forms in WMI
  // CommandLine output (`--name "orch phase 0"`, `--name 'orch phase 0'`)
  // match cleanly. The trailing group matches whitespace, end-of-line,
  // or a closing quote — required for the `cmd /k "claude --name orch-a"`
  // shape WMI reports verbatim. Without these boundaries, suffix-
  // collisions like `orch-a` vs `orch-a-review` would false-match.
  const re = new RegExp(
    `(?:^|\\s)--name\\s+(?:['"])?${escapeRegex(name)}(?=\\s|$|['"])`
  );

  // Two-pass: prefer non-wrapper matches (the claude / agency binary)
  // so Unit 8's health check watches something that actually dies when
  // Claude exits. Fall back to any match if only the wrapper is visible.
  let wrapperPid = null;
  for (const row of rows) {
    const pid = Number(row && row.ProcessId);
    const cmdline = row && row.CommandLine;
    if (!Number.isInteger(pid)) continue;
    if (typeof cmdline !== 'string') continue;
    if (!re.test(cmdline)) continue;
    if (!isShellWrapperCmdline(cmdline)) return pid;
    if (wrapperPid === null) wrapperPid = pid;
  }
  return wrapperPid;
}

/**
 * Return a PID for the spawned session, or `null` if none found.
 * Matches on `--name <session-name>` in the process command line (NOT
 * the window title — wt tabs share a window and only expose the active
 * tab's title). Injectable runner makes this testable without shelling
 * out.
 *
 * Caveat: if multiple sessions share the same name, the first-returned
 * PID is used. Our session naming scheme (`orch-<phase>-<role>`)
 * guarantees uniqueness per-phase-per-role.
 */
function getSessionPid(name, { _runner } = {}) {
  if (!name || typeof name !== 'string') return null;
  // _runner is invoked with (program, argv) so tests can verify both.
  // Default uses execFileSync — which does NOT go through cmd.exe, so
  // `%` in the WMI filter survives unmolested.
  const runner =
    _runner ||
    ((program, argv) =>
      execFileSync(program, argv, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }));
  let out;
  try {
    out = runner('powershell', buildPidLookupArgs());
  } catch (_) {
    return null;
  }
  return parsePidLookupOutput(out, name);
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
  const { command, argv, sessionName, title: resolvedTitle } = buildSpawnCommand({
    name,
    workdir,
    model,
    title,
    pluginDir,
    launcher,
    windowTarget,
  });

  // Injectable runner receives (program, argv) so it matches getSessionPid
  // and so tests can assert on each arg individually. Default uses
  // execFileSync which does NOT go through cmd.exe — critical for
  // preserving nested double quotes through the wt → subshell handoff.
  // Routing through execSync → cmd.exe corrupts `--plugin-dir
  // "C:\Program Files\..."` before wt ever sees it.
  const runner =
    _runner || ((program, args) => execFileSync(program, args, { stdio: 'ignore' }));
  runner('wt', argv);

  const now =
    typeof _now === 'function'
      ? _now()
      : new Date().toISOString();

  // PID lookup is best-effort: the tab may not be registered yet when
  // this returns. Orchestrator callers retry via getSessionPid() later.
  const pid = getSessionPid(sessionName, { _runner: _tasklistRunner });

  return { pid, command, argv, sessionName, title: resolvedTitle, spawnedAt: now };
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
  buildPidLookupArgs,
  parsePidLookupOutput,
  tokenizeShellArgs,
  quoteCmd,
  quoteCmdAlways,
  quotePs,
  quotePsAlways,
  quoteBinary,
  DEFAULT_LAUNCHER,
  AGENCY_LAUNCHER,
};
