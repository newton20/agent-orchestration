/**
 * Unit 4 test suite. Uses node:test (built-in).
 * Run: npm test   (from agent-orchestrator/scripts/)
 *
 * Tests never actually spawn wt tabs — execSync is replaced by an
 * injected runner that captures the command string. The tasklist
 * fixture exercises the real CSV parser against canned output.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  spawnSession,
  getSessionPid,
  buildSpawnCommand,
  resolveLauncher,
  loadLauncherFromManifest,
  buildPidLookupCommand,
  parsePidLookupOutput,
  quoteCmd,
  quotePs,
  quoteBinary,
  DEFAULT_LAUNCHER,
  AGENCY_LAUNCHER,
} = require('./spawn-session');

// -------------------- buildSpawnCommand — default launcher --------------------

test('default launcher: cmd /k claude command shape', () => {
  const { command, sessionName, title } = buildSpawnCommand({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\projects\\test',
    model: 'sonnet',
    pluginDir: 'C:\\plugins\\agent-orchestrator',
  });
  assert.strictEqual(sessionName, 'orch-phase-0-impl');
  assert.strictEqual(title, 'orch-phase-0-impl');
  assert.match(command, /^wt -w 0 new-tab /);
  assert.match(command, /--suppressApplicationTitle/);
  assert.match(command, /--title "orch-phase-0-impl"/);
  assert.match(command, /--startingDirectory "C:\\projects\\test"/);
  assert.match(command, /cmd \/k "claude --permission-mode auto /);
  assert.match(command, /--name orch-phase-0-impl/);
  assert.match(command, /--model sonnet/);
  assert.match(command, /--plugin-dir "C:\\plugins\\agent-orchestrator"/);
  // The inner command is wrapped in outer double-quotes so cmd's /k
  // quote-stripping preserves any "quoted executable path" verbatim.
  assert.ok(command.endsWith('"'), `expected trailing " for cmd /k wrap: ${command}`);
});

test('agency launcher: powershell -NoExit -Command "agency claude ..."', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\work',
    model: 'sonnet',
    pluginDir: 'C:\\plugins\\ao',
    launcher: AGENCY_LAUNCHER,
  });
  assert.match(command, /^wt -w 0 new-tab /);
  assert.match(command, /--suppressApplicationTitle/);
  assert.match(command, /powershell -NoExit -Command "agency claude --enable-auto-mode /);
  // Inside the PowerShell -Command string, values are single-quoted.
  assert.match(command, /--name orch-phase-0-impl/);
  assert.match(command, /--model sonnet/);
  assert.match(command, /--plugin-dir 'C:\\plugins\\ao'/);
  // Outer closing double-quote for the PowerShell -Command scriptblock.
  assert.ok(command.endsWith('"'), `expected trailing double quote, got: ${command}`);
});

// -------------------- --suppressApplicationTitle presence --------------------

test('--suppressApplicationTitle is ALWAYS present (default launcher)', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\x',
  });
  assert.ok(command.includes('--suppressApplicationTitle'));
});

test('--suppressApplicationTitle is ALWAYS present (agency launcher)', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\x',
    launcher: AGENCY_LAUNCHER,
  });
  assert.ok(command.includes('--suppressApplicationTitle'));
});

test('--suppressApplicationTitle is ALWAYS present (custom launcher omitting it in passthrough)', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\x',
    launcher: {
      shell: 'cmd',
      binary: 'claude',
      auto_mode_flag: '',
      shell_args: '/k',
      passthrough_flags: ['--dangerously-skip-permissions'],
    },
  });
  assert.ok(command.includes('--suppressApplicationTitle'));
  assert.ok(command.includes('--dangerously-skip-permissions'));
});

// -------------------- Path quoting --------------------

test('workdir with spaces is double-quoted for wt', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\Program Files\\My Project',
  });
  assert.match(command, /--startingDirectory "C:\\Program Files\\My Project"/);
});

test('pluginDir with spaces is quoted (cmd: double, powershell: single)', () => {
  const cmdCase = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    pluginDir: 'C:\\Program Files\\ao',
  });
  assert.match(cmdCase.command, /--plugin-dir "C:\\Program Files\\ao"/);

  const psCase = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    pluginDir: 'C:\\Program Files\\ao',
    launcher: AGENCY_LAUNCHER,
  });
  assert.match(psCase.command, /--plugin-dir 'C:\\Program Files\\ao'/);
});

test('title with spaces is double-quoted at wt layer', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    title: 'orch-a — My Phase',
    workdir: 'C:\\w',
  });
  assert.match(command, /--title "orch-a — My Phase"/);
});

test('quoteCmd escapes embedded double quotes to ""', () => {
  assert.strictEqual(quoteCmd('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(quoteCmd('plain'), 'plain');
  assert.strictEqual(quoteCmd(''), '""');
});

test('quotePs escapes embedded single quotes to ""', () => {
  assert.strictEqual(quotePs("it's"), "'it''s'");
  assert.strictEqual(quotePs('plain'), 'plain');
  assert.strictEqual(quotePs(''), "''");
  // Backslashes (e.g. Windows paths) force quoting even without spaces.
  assert.strictEqual(quotePs('C:\\plugins\\ao'), "'C:\\plugins\\ao'");
});

// -------------------- Launcher validation --------------------

test('resolveLauncher: null/undefined returns DEFAULT_LAUNCHER', () => {
  assert.deepStrictEqual(resolveLauncher(null), { ...DEFAULT_LAUNCHER });
  assert.deepStrictEqual(resolveLauncher(undefined), { ...DEFAULT_LAUNCHER });
});

test('resolveLauncher: "default" and "agency" aliases resolve to presets', () => {
  assert.deepStrictEqual(resolveLauncher('default'), { ...DEFAULT_LAUNCHER });
  assert.deepStrictEqual(resolveLauncher('agency'), { ...AGENCY_LAUNCHER });
});

test('resolveLauncher: unknown alias throws', () => {
  assert.throws(
    () => resolveLauncher('pwsh'),
    /unknown launcher alias/
  );
});

test('resolveLauncher: invalid shell rejected via parse-manifest.validateLauncher', () => {
  assert.throws(
    () => resolveLauncher({ shell: 'bash', binary: 'claude' }),
    /launcher\.shell: must be one of powershell \| cmd/
  );
});

test('resolveLauncher: empty binary rejected', () => {
  assert.throws(
    () => resolveLauncher({ shell: 'cmd', binary: '   ' }),
    /launcher\.binary: must be a non-empty string/
  );
});

test('resolveLauncher: non-array passthrough_flags rejected', () => {
  assert.throws(
    () => resolveLauncher({ shell: 'cmd', binary: 'claude', passthrough_flags: 'oops' }),
    /launcher\.passthrough_flags: must be an array of strings/
  );
});

test('resolveLauncher: non-object launcher rejected', () => {
  assert.throws(() => resolveLauncher(42), /launcher: must be an object/);
  assert.throws(() => resolveLauncher([]), /launcher: must be an object/);
});

test('resolveLauncher: partial override merges on top of default', () => {
  const merged = resolveLauncher({ shell: 'cmd', binary: 'claude-next' });
  // Inherits the default auto_mode_flag and shell_args from DEFAULT_LAUNCHER.
  assert.strictEqual(merged.auto_mode_flag, DEFAULT_LAUNCHER.auto_mode_flag);
  assert.strictEqual(merged.shell_args, DEFAULT_LAUNCHER.shell_args);
  assert.strictEqual(merged.binary, 'claude-next');
});

// Codex P2: partial powershell launcher must NOT inherit cmd-style defaults.
test('resolveLauncher: partial powershell launcher inherits agency defaults (codex P2)', () => {
  const merged = resolveLauncher({ shell: 'powershell', binary: 'agency claude' });
  assert.strictEqual(merged.auto_mode_flag, AGENCY_LAUNCHER.auto_mode_flag);
  assert.strictEqual(merged.shell_args, AGENCY_LAUNCHER.shell_args);
  // Regression: make sure we do NOT get cmd's "/k" here.
  assert.notStrictEqual(merged.shell_args, DEFAULT_LAUNCHER.shell_args);
});

test('buildSpawnCommand: partial powershell launcher produces valid PS cmdline', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: { shell: 'powershell', binary: 'agency claude' },
  });
  // Must NOT contain `/k` (cmd flag) — must contain `-NoExit -Command`.
  assert.ok(!/\/k /.test(command), `unexpected /k in ${command}`);
  assert.match(command, /powershell -NoExit -Command "agency claude --enable-auto-mode /);
});

// -------------------- buildSpawnCommand — arg validation --------------------

test('buildSpawnCommand: missing name throws', () => {
  assert.throws(() => buildSpawnCommand({ workdir: 'C:\\x' }), /name.*required/);
  assert.throws(() => buildSpawnCommand({ name: '', workdir: 'C:\\x' }), /name.*required/);
});

test('buildSpawnCommand: missing workdir throws', () => {
  assert.throws(() => buildSpawnCommand({ name: 'orch-a' }), /workdir.*required/);
});

test('buildSpawnCommand: passthrough_flags land in the inner command', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: {
      shell: 'cmd',
      binary: 'claude',
      auto_mode_flag: '--permission-mode auto',
      shell_args: '/k',
      passthrough_flags: ['--dangerously-skip-permissions', '--verbose'],
    },
  });
  assert.match(command, /--dangerously-skip-permissions/);
  assert.match(command, /--verbose/);
});

test('buildSpawnCommand: windowTarget controls wt -w value', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    windowTarget: 'new',
  });
  assert.match(command, /^wt -w new new-tab /);
});

test('buildSpawnCommand: omits --model and --plugin-dir when not provided', () => {
  const { command } = buildSpawnCommand({ name: 'orch-a', workdir: 'C:\\w' });
  assert.ok(!/--model/.test(command), 'should not include --model');
  assert.ok(!/--plugin-dir/.test(command), 'should not include --plugin-dir');
});

// -------------------- spawnSession: full wiring via injected runner --------------------

test('spawnSession: invokes runner with built command, returns metadata', () => {
  const calls = [];
  const result = spawnSession({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\work',
    model: 'sonnet',
    _runner: (cmd) => {
      calls.push(cmd);
    },
    _tasklistRunner: () => '',
    _now: () => '2026-04-20T12:00:00.000Z',
  });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /^wt -w 0 new-tab /);
  assert.strictEqual(result.sessionName, 'orch-phase-0-impl');
  assert.strictEqual(result.title, 'orch-phase-0-impl');
  assert.strictEqual(result.spawnedAt, '2026-04-20T12:00:00.000Z');
  assert.strictEqual(result.pid, null); // empty tasklist → null
  assert.strictEqual(typeof result.command, 'string');
});

test('spawnSession: returns pid when pid-lookup fixture matches', () => {
  // Get-CimInstance stdout is just one PID per line, no header.
  const fixture = '4321\r\n';
  const result = spawnSession({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    _runner: () => {},
    _tasklistRunner: () => fixture,
    _now: () => '2026-04-20T12:00:00.000Z',
  });
  assert.strictEqual(result.pid, 4321);
});

test('spawnSession: propagates launcher validation errors', () => {
  assert.throws(
    () =>
      spawnSession({
        name: 'orch-a',
        workdir: 'C:\\w',
        launcher: { shell: 'fish', binary: 'claude' },
        _runner: () => {},
      }),
    /invalid launcher/
  );
});

// -------------------- pid lookup command + parser --------------------

// Codex P1: tasklist /V only surfaces the active tab's title under
// wt -w 0, so background tabs are undiscoverable by window title.
// We match on --name <session> in the process CommandLine via WMI.
test('buildPidLookupCommand: emits a Get-CimInstance WMI query with --name <name>', () => {
  const cmd = buildPidLookupCommand('orch-phase-0-impl');
  assert.match(cmd, /^powershell -NoProfile -NoLogo -Command /);
  assert.match(cmd, /Get-CimInstance Win32_Process -Filter /);
  assert.match(cmd, /CommandLine LIKE '%--name orch-phase-0-impl%'/);
  assert.match(cmd, /Select-Object -ExpandProperty ProcessId/);
});

test('buildPidLookupCommand: escapes single quotes in the name', () => {
  // Defensive: name validation elsewhere already rejects these, but the
  // escape keeps injection impossible if someone bypasses validation.
  const cmd = buildPidLookupCommand("orch-a'; evil");
  assert.match(cmd, /%--name orch-a''; evil%/);
});

test('parsePidLookupOutput: parses single PID line', () => {
  assert.strictEqual(parsePidLookupOutput('4321\r\n'), 4321);
  assert.strictEqual(parsePidLookupOutput('  777  \n'), 777);
});

test('parsePidLookupOutput: returns first PID when multiple (wrapper + child)', () => {
  // When the session uses `agency claude`, both the agency wrapper and
  // the claude child can carry --name on their CommandLine — so CIM
  // returns multiple PIDs. Either one dying means session loss, so the
  // first is fine.
  assert.strictEqual(parsePidLookupOutput('1111\r\n2222\r\n'), 1111);
});

test('parsePidLookupOutput: empty / no-match input returns null', () => {
  assert.strictEqual(parsePidLookupOutput(''), null);
  assert.strictEqual(parsePidLookupOutput('\r\n\r\n'), null);
  assert.strictEqual(parsePidLookupOutput(null), null);
});

test('parsePidLookupOutput: ignores non-numeric lines', () => {
  // If Get-CimInstance errors (e.g. CIM service unavailable) it writes
  // text to stdout before the PID. We skip non-numeric lines.
  const stdout =
    'Get-CimInstance : Access denied\r\nProcessId\r\n--------\r\n4242\r\n';
  assert.strictEqual(parsePidLookupOutput(stdout), 4242);
});

// -------------------- getSessionPid (injected runner) --------------------

test('getSessionPid: uses injected runner, invokes the WMI command', () => {
  const calls = [];
  const pid = getSessionPid('orch-x', {
    _runner: (cmd) => {
      calls.push(cmd);
      return '9999\r\n';
    },
  });
  assert.strictEqual(pid, 9999);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /Get-CimInstance Win32_Process/);
  assert.match(calls[0], /CommandLine LIKE '%--name orch-x%'/);
});

test('getSessionPid: returns null when runner throws', () => {
  const pid = getSessionPid('orch-x', {
    _runner: () => {
      throw new Error('tasklist not found');
    },
  });
  assert.strictEqual(pid, null);
});

test('getSessionPid: returns null for empty/invalid name', () => {
  assert.strictEqual(getSessionPid('', { _runner: () => '' }), null);
  assert.strictEqual(getSessionPid(null, { _runner: () => '' }), null);
});

// -------------------- loadLauncherFromManifest --------------------

function writeManifestTmp(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-session-load-'));
  const p = path.join(dir, 'manifest.yaml');
  fs.writeFileSync(p, contents);
  return p;
}

test('loadLauncherFromManifest: missing key returns null', () => {
  const p = writeManifestTmp('name: x\nphases:\n  - id: p\n');
  assert.strictEqual(loadLauncherFromManifest(p), null);
});

test('loadLauncherFromManifest: valid launcher block returns object', () => {
  const p = writeManifestTmp(
    'name: x\nlauncher:\n  shell: cmd\n  binary: claude\nphases:\n  - id: p\n'
  );
  const l = loadLauncherFromManifest(p);
  assert.deepStrictEqual(l, { shell: 'cmd', binary: 'claude' });
});

// Codex P2: a typo like `launcher: false` or `launcher: ""` must NOT be
// silently coerced to "no launcher" — the value must round-trip so
// resolveLauncher's validator rejects it.
test('loadLauncherFromManifest: falsy launcher round-trips (codex P2)', () => {
  const falseP = writeManifestTmp('name: x\nlauncher: false\nphases:\n  - id: p\n');
  assert.strictEqual(loadLauncherFromManifest(falseP), false);
  const emptyP = writeManifestTmp('name: x\nlauncher: ""\nphases:\n  - id: p\n');
  assert.strictEqual(loadLauncherFromManifest(emptyP), '');
});

test('resolveLauncher: rejects launcher: false from a manifest (codex P2)', () => {
  // loadLauncherFromManifest returns false; resolveLauncher must surface it.
  assert.throws(
    () => resolveLauncher(false),
    /invalid launcher.*must be an object/
  );
});

// Codex P2 round 2: explicit `launcher: null` in a manifest must error,
// not silently fall back to DEFAULT_LAUNCHER via resolveLauncher(null).
test('loadLauncherFromManifest: explicit null rejected (codex P2)', () => {
  const p = writeManifestTmp('name: x\nlauncher:\nphases:\n  - id: p\n');
  assert.throws(
    () => loadLauncherFromManifest(p),
    /explicit null launcher/
  );
});

test('loadLauncherFromManifest: explicit "launcher: null" rejected (codex P2)', () => {
  const p = writeManifestTmp('name: x\nlauncher: null\nphases:\n  - id: p\n');
  assert.throws(
    () => loadLauncherFromManifest(p),
    /explicit null launcher/
  );
});

// -------------------- quoteBinary (codex P2 round 2) --------------------

test('quoteBinary: bare command unquoted', () => {
  assert.strictEqual(quoteBinary('claude', 'cmd'), 'claude');
  assert.strictEqual(quoteBinary('claude', 'powershell'), 'claude');
});

test('quoteBinary: "agency claude" (program + arg) stays verbatim', () => {
  assert.strictEqual(quoteBinary('agency claude', 'cmd'), 'agency claude');
  assert.strictEqual(quoteBinary('agency claude', 'powershell'), 'agency claude');
});

test('quoteBinary: path with spaces quoted per shell', () => {
  const p = 'C:\\Program Files\\Claude\\claude.exe';
  assert.strictEqual(quoteBinary(p, 'cmd'), `"${p}"`);
  assert.strictEqual(quoteBinary(p, 'powershell'), `& '${p}'`);
});

test('quoteBinary: path without spaces unquoted', () => {
  const p = 'C:\\tools\\claude.exe';
  assert.strictEqual(quoteBinary(p, 'cmd'), p);
  assert.strictEqual(quoteBinary(p, 'powershell'), p);
});

test('buildSpawnCommand: path-with-spaces binary launches correctly (cmd)', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: {
      shell: 'cmd',
      binary: 'C:\\Program Files\\Claude\\claude.exe',
      auto_mode_flag: '',
      shell_args: '/k',
    },
  });
  // Binary itself is quoted AND the entire inner command is wrapped in
  // outer double-quotes so cmd's /k quote-stripping leaves the binary
  // path's quotes intact (codex P2 round 5).
  assert.match(
    command,
    /cmd \/k ""C:\\Program Files\\Claude\\claude\.exe" --name orch-a/
  );
});

test('buildSpawnCommand: path-with-spaces binary launches correctly (powershell)', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: {
      shell: 'powershell',
      binary: 'C:\\Program Files\\Claude\\claude.exe',
      auto_mode_flag: '',
      shell_args: '-NoExit -Command',
    },
  });
  // PowerShell needs the call operator `&` to actually execute a quoted path.
  assert.match(
    command,
    /powershell -NoExit -Command "& 'C:\\Program Files\\Claude\\claude\.exe' --name orch-a/
  );
});

// Codex P2 round 3: custom titles that don't begin with `name` must be
// auto-prefixed so getSessionPid (title-prefix matcher) stays correct.
test('buildSpawnCommand: custom title without name prefix gets prefixed (codex P2)', () => {
  const { title, command } = buildSpawnCommand({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    title: 'Scaffold monorepo',
  });
  assert.strictEqual(title, 'orch-phase-0-impl — Scaffold monorepo');
  assert.match(command, /--title "orch-phase-0-impl — Scaffold monorepo"/);
});

test('buildSpawnCommand: custom title already starting with name is preserved', () => {
  const { title } = buildSpawnCommand({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    title: 'orch-phase-0-impl',
  });
  assert.strictEqual(title, 'orch-phase-0-impl');
});

test('buildSpawnCommand: custom title "<name> — <suffix>" is preserved verbatim', () => {
  const { title } = buildSpawnCommand({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    title: 'orch-phase-0-impl — Feature X',
  });
  assert.strictEqual(title, 'orch-phase-0-impl — Feature X');
});

test('spawnSession end-to-end: custom title auto-prefixed, pid lookup still matches', () => {
  // Pid lookup is now command-line-based, so the title change doesn't
  // matter — as long as `--name <session>` is on the spawned command
  // line, CIM returns the pid.
  const result = spawnSession({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    title: 'Scaffold',
    _runner: () => {},
    _tasklistRunner: () => '8888\r\n',
    _now: () => '2026-04-20T12:00:00.000Z',
  });
  assert.strictEqual(result.title, 'orch-phase-0-impl — Scaffold');
  assert.strictEqual(result.pid, 8888);
});

test('buildSpawnCommand: "agency claude" binary is still emitted unquoted', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: AGENCY_LAUNCHER,
  });
  assert.match(command, /"agency claude --enable-auto-mode/);
  assert.ok(!/"& 'agency claude'/.test(command));
});
