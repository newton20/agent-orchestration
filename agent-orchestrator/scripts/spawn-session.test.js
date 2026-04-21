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
  buildPidLookupArgs,
  parsePidLookupOutput,
  tokenizeShellArgs,
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

test('spawnSession: invokes runner with (program, argv), returns metadata', () => {
  const calls = [];
  const result = spawnSession({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\work',
    model: 'sonnet',
    _runner: (program, argv) => {
      calls.push({ program, argv });
    },
    _tasklistRunner: () => '',
    _now: () => '2026-04-20T12:00:00.000Z',
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].program, 'wt');
  assert.ok(Array.isArray(calls[0].argv));
  assert.strictEqual(calls[0].argv[0], '-w');
  assert.strictEqual(calls[0].argv[1], '0');
  assert.strictEqual(calls[0].argv[2], 'new-tab');
  assert.strictEqual(result.sessionName, 'orch-phase-0-impl');
  assert.strictEqual(result.title, 'orch-phase-0-impl');
  assert.strictEqual(result.spawnedAt, '2026-04-20T12:00:00.000Z');
  assert.strictEqual(result.pid, null); // empty tasklist → null
  assert.strictEqual(typeof result.command, 'string');
  assert.ok(Array.isArray(result.argv));
});

// Codex P1 round 9: the argv passed to execFileSync must keep each
// token discrete so Node's MSVC-style quoting preserves embedded `"`
// inside the innerCmd (e.g. --plugin-dir "C:\Program Files\ao").
test('buildSpawnCommand: argv keeps innerCmd as a single element', () => {
  const { argv } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    pluginDir: 'C:\\Program Files\\ao',
  });
  // Everything before `cmd` is wt-level args; from `cmd` onward is the
  // subshell invocation.
  const cmdIdx = argv.indexOf('cmd');
  assert.ok(cmdIdx > 0, `expected 'cmd' in argv: ${JSON.stringify(argv)}`);
  assert.strictEqual(argv[cmdIdx + 1], '/k');
  const innerCmd = argv[cmdIdx + 2];
  // The innerCmd is ONE argv element — Node escapes its internal quotes
  // via MSVC rules when serializing for CreateProcess.
  assert.match(innerCmd, /^claude --permission-mode auto --name orch-a /);
  assert.match(innerCmd, /--plugin-dir "C:\\Program Files\\ao"/);
  // No wt-level tokens leak into innerCmd.
  assert.ok(!/--title|--startingDirectory|--suppressApplicationTitle/.test(innerCmd));
});

test('buildSpawnCommand: argv does NOT include `wt` (execFileSync passes it as program)', () => {
  const { argv } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
  });
  assert.notStrictEqual(argv[0], 'wt');
  assert.strictEqual(argv[0], '-w');
});

test('spawnSession: returns pid when pid-lookup fixture matches', () => {
  const fixture = JSON.stringify([
    { ProcessId: 4321, CommandLine: 'claude --name orch-phase-0-impl --model sonnet' },
  ]);
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

// Codex P1 → P2 round 7: lookup now retrieves PID + CommandLine for
// every process with `--name` on its cmdline and filters in JS so
// phase-id underscores (SQL wildcard) and suffix collisions
// (orch-a vs orch-a-review) can't false-match.
test('buildPidLookupArgs: emits argv array (bypasses cmd.exe % expansion)', () => {
  const argv = buildPidLookupArgs();
  assert.ok(Array.isArray(argv));
  assert.deepStrictEqual(
    argv.slice(0, 3),
    ['-NoProfile', '-NoLogo', '-Command']
  );
  const script = argv[3];
  assert.match(script, /Get-CimInstance Win32_Process -Filter /);
  // Broad LIKE; exact boundary is checked in JS.
  assert.match(script, /CommandLine LIKE '%--name %'/);
  assert.match(script, /Select-Object ProcessId, CommandLine/);
  assert.match(script, /ConvertTo-Json -Compress -Depth 1/);
  // No shell-level `%` doubling — we rely on execFileSync skipping cmd.exe.
});

test('parsePidLookupOutput: exact --name boundary match (JSON array)', () => {
  const stdout = JSON.stringify([
    { ProcessId: 1111, CommandLine: 'claude --name orch-phase-1-impl --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-phase-1-impl'), 1111);
});

test('parsePidLookupOutput: single-object result (ConvertTo-Json compact form)', () => {
  // PowerShell's ConvertTo-Json emits a scalar object (not an array)
  // when given a single item; @(...) wraps it, but be defensive.
  const stdout = JSON.stringify({
    ProcessId: 2222,
    CommandLine: 'agency claude --name orch-x --model sonnet',
  });
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-x'), 2222);
});

test('parsePidLookupOutput: rejects suffix-extension collisions (codex P2 round 7)', () => {
  // `orch-phase-1-impl` must NOT match `orch-phase-1-impl-review`.
  const stdout = JSON.stringify([
    { ProcessId: 7001, CommandLine: 'claude --name orch-phase-1-impl-review --model sonnet' },
    { ProcessId: 7002, CommandLine: 'claude --name orch-phase-1-impl --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-phase-1-impl'), 7002);
  assert.strictEqual(
    parsePidLookupOutput(stdout, 'orch-phase-1-impl-review'),
    7001
  );
});

test('parsePidLookupOutput: underscore in name (SQL LIKE wildcard) matches exactly', () => {
  // `_` is a SQL LIKE wildcard; naive LIKE filtering would also match
  // `orch-aXimpl`. Our JS regex matches only literal underscores.
  const stdout = JSON.stringify([
    { ProcessId: 8001, CommandLine: 'claude --name orch-a_impl --model sonnet' },
    { ProcessId: 8002, CommandLine: 'claude --name orch-aZimpl --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a_impl'), 8001);
});

test('parsePidLookupOutput: prefers non-shell-wrapper over wrapper (codex P1 round 10)', () => {
  // cmd /k and powershell -NoExit outlive Claude on purpose (keeps the
  // tab open post-exit). Tracking the wrapper PID would make Unit 8
  // report the agent alive forever after /exit or a crash.
  const stdout = JSON.stringify([
    { ProcessId: 1111, CommandLine: 'cmd /k claude --name orch-a --model sonnet' },
    { ProcessId: 2222, CommandLine: 'claude.exe --name orch-a --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 2222);
});

test('parsePidLookupOutput: skips powershell wrapper in favor of agency/claude child', () => {
  const stdout = JSON.stringify([
    {
      ProcessId: 3333,
      CommandLine:
        'powershell -NoExit -Command "agency claude --enable-auto-mode --name orch-a"',
    },
    { ProcessId: 4444, CommandLine: 'agency.exe claude --name orch-a' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 4444);
});

// Codex P2 round 13: first token may be a quoted absolute path like
// `"C:\Windows\System32\powershell.exe" -NoExit ...`. isShellWrapperCmdline
// must strip through the closing quote before basename extraction.
test('parsePidLookupOutput: quoted wrapper-exe path still recognized (codex P2 round 13)', () => {
  const stdout = JSON.stringify([
    {
      ProcessId: 6001,
      CommandLine:
        '"C:\\Windows\\System32\\powershell.exe" -NoExit -Command "agency claude --name orch-a"',
    },
    {
      ProcessId: 6002,
      CommandLine: 'claude.exe --name orch-a --model sonnet',
    },
  ]);
  // The child claude.exe should win; the quoted powershell.exe path
  // must be correctly classified as a wrapper.
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 6002);
});

test('parsePidLookupOutput: quoted wrapper falls back as last-resort', () => {
  const stdout = JSON.stringify([
    {
      ProcessId: 6001,
      CommandLine:
        '"C:\\Windows\\System32\\powershell.exe" -NoExit -Command "agency claude --name orch-a"',
    },
  ]);
  // No non-wrapper visible yet → wrapper PID returned (spawn race window).
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 6001);
});

test('parsePidLookupOutput: falls back to wrapper PID if no child visible yet', () => {
  // During spawn window, only the wrapper may be up. Better to return
  // SOMETHING than null so the orchestrator can retry later.
  const stdout = JSON.stringify([
    { ProcessId: 5555, CommandLine: 'cmd /k claude --name orch-a --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 5555);
});

test('parsePidLookupOutput: returns first non-wrapper PID when multiple children (agency wrapper + claude)', () => {
  // The agency wrapper's process and the claude child process both carry
  // --name on their CommandLine. Both count as non-shell-wrappers; the
  // first wins. Either dying = session loss.
  const stdout = JSON.stringify([
    { ProcessId: 1111, CommandLine: 'agency claude --name orch-a --model sonnet' },
    { ProcessId: 2222, CommandLine: 'claude.exe --name orch-a --model sonnet' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 1111);
});

test('parsePidLookupOutput: empty / null / unparseable input returns null', () => {
  assert.strictEqual(parsePidLookupOutput('', 'orch-a'), null);
  assert.strictEqual(parsePidLookupOutput(null, 'orch-a'), null);
  assert.strictEqual(parsePidLookupOutput('not-json', 'orch-a'), null);
  assert.strictEqual(parsePidLookupOutput('[]', 'orch-a'), null);
});

// Codex P2 round 12: wrapper command lines quote the whole inner
// command when --name is the last flag (`cmd /k "claude --name orch-a"`).
// WMI reports the CommandLine verbatim including the closing quote.
test('parsePidLookupOutput: matches when --name is followed by closing quote (codex P2 round 12)', () => {
  const stdout = JSON.stringify([
    // Wrapper only — child not up yet. Regex must accept the closing ".
    { ProcessId: 1234, CommandLine: 'cmd /k "claude --name orch-a"' },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 1234);
});

test('parsePidLookupOutput: matches when --name is followed by closing single-quote', () => {
  const stdout = JSON.stringify([
    {
      ProcessId: 4567,
      CommandLine: "powershell -Command 'agency claude --name orch-a'",
    },
  ]);
  assert.strictEqual(parsePidLookupOutput(stdout, 'orch-a'), 4567);
});

test('parsePidLookupOutput: null parsed (CIM returned no rows) → null', () => {
  // PowerShell ConvertTo-Json emits "null" when the input array is
  // empty AND the @(...) wrapper is missing. Defensive.
  assert.strictEqual(parsePidLookupOutput('null', 'orch-a'), null);
});

// -------------------- getSessionPid (injected runner) --------------------

test('getSessionPid: uses injected runner with (program, argv), applies boundary regex', () => {
  const calls = [];
  const stdout = JSON.stringify([
    { ProcessId: 9999, CommandLine: 'claude --name orch-x --model sonnet' },
  ]);
  const pid = getSessionPid('orch-x', {
    _runner: (program, argv) => {
      calls.push({ program, argv });
      return stdout;
    },
  });
  assert.strictEqual(pid, 9999);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].program, 'powershell');
  assert.ok(Array.isArray(calls[0].argv));
  assert.deepStrictEqual(calls[0].argv.slice(0, 3), [
    '-NoProfile',
    '-NoLogo',
    '-Command',
  ]);
  assert.match(calls[0].argv[3], /Get-CimInstance Win32_Process/);
});

test('getSessionPid: returns null when runner throws', () => {
  const pid = getSessionPid('orch-x', {
    _runner: () => {
      throw new Error('powershell not found');
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

// Codex P2 round 10: `binary: "C:\Program Files\Agency\agency.exe claude"`
// — path with spaces PLUS a subcommand. Quote only the exe portion.
test('quoteBinary: path-with-spaces + subcommand splits at .exe (cmd)', () => {
  const b = 'C:\\Program Files\\Agency\\agency.exe claude';
  assert.strictEqual(
    quoteBinary(b, 'cmd'),
    '"C:\\Program Files\\Agency\\agency.exe" claude'
  );
});

test('quoteBinary: path-with-spaces + subcommand splits at .exe (powershell)', () => {
  const b = 'C:\\Program Files\\Agency\\agency.exe claude';
  assert.strictEqual(
    quoteBinary(b, 'powershell'),
    "& 'C:\\Program Files\\Agency\\agency.exe' claude"
  );
});

test('quoteBinary: exe subcommand form without path-spaces stays verbatim', () => {
  // `claude.exe --foo` — no path separator, no meaningful quoting needed.
  const b = 'claude.exe --foo';
  assert.strictEqual(quoteBinary(b, 'cmd'), b);
  assert.strictEqual(quoteBinary(b, 'powershell'), b);
});

// -------------------- tokenizeShellArgs (codex P2 round 11) --------------------

test('tokenizeShellArgs: simple whitespace split', () => {
  assert.deepStrictEqual(tokenizeShellArgs('-NoExit -Command'), [
    '-NoExit',
    '-Command',
  ]);
  assert.deepStrictEqual(tokenizeShellArgs('/k'), ['/k']);
  assert.deepStrictEqual(tokenizeShellArgs(''), []);
  assert.deepStrictEqual(tokenizeShellArgs(null), []);
});

test('tokenizeShellArgs: preserves single-quoted path (PowerShell style, codex P2 round 12)', () => {
  // PowerShell users naturally write literals with single quotes.
  assert.deepStrictEqual(
    tokenizeShellArgs("-NoExit -File 'C:\\Program Files\\wrapper.ps1'"),
    ['-NoExit', '-File', 'C:\\Program Files\\wrapper.ps1']
  );
});

test('tokenizeShellArgs: single and double quotes do not interact inside each other', () => {
  // Inside single quotes, a `"` is literal. Inside double quotes, a `'` is literal.
  assert.deepStrictEqual(
    tokenizeShellArgs(`-Arg1 'foo"bar' -Arg2 "baz'qux"`),
    ['-Arg1', 'foo"bar', '-Arg2', "baz'qux"]
  );
});

test('tokenizeShellArgs: preserves quoted path with spaces (codex P2 round 11)', () => {
  // Without quote-aware tokenizing, -File "C:\Program Files\..." would
  // split at the first space inside the path and land the wrapper
  // script under a nonexistent path. Quotes are stripped in the output
  // so Node's CreateProcess serializer re-quotes cleanly.
  assert.deepStrictEqual(
    tokenizeShellArgs('-NoExit -File "C:\\Program Files\\wrapper.ps1"'),
    ['-NoExit', '-File', 'C:\\Program Files\\wrapper.ps1']
  );
});

test('tokenizeShellArgs: empty quoted segment produces an empty token', () => {
  // For completeness: `-Command ""` should keep the empty argument.
  assert.deepStrictEqual(tokenizeShellArgs('-Command ""'), ['-Command', '']);
});

test('tokenizeShellArgs: multiple consecutive spaces collapse', () => {
  assert.deepStrictEqual(tokenizeShellArgs('  -a   -b  '), ['-a', '-b']);
});

test('buildSpawnCommand: quoted path in shell_args survives into argv (codex P2 round 11)', () => {
  const { argv } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: {
      shell: 'powershell',
      binary: 'pwsh',
      auto_mode_flag: '',
      shell_args: '-NoExit -File "C:\\Program Files\\wrapper.ps1"',
    },
  });
  // Find the shell-wrapper portion: 'powershell', '-NoExit', '-File',
  // 'C:\\Program Files\\wrapper.ps1', innerCmd.
  const psIdx = argv.indexOf('powershell');
  assert.ok(psIdx >= 0);
  assert.deepStrictEqual(argv.slice(psIdx, psIdx + 4), [
    'powershell',
    '-NoExit',
    '-File',
    'C:\\Program Files\\wrapper.ps1',
  ]);
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
  const fixture = JSON.stringify([
    { ProcessId: 8888, CommandLine: 'claude --name orch-phase-0-impl --model sonnet' },
  ]);
  const result = spawnSession({
    name: 'orch-phase-0-impl',
    workdir: 'C:\\w',
    title: 'Scaffold',
    _runner: () => {},
    _tasklistRunner: () => fixture,
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
