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
  parseTasklistCsv,
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
  assert.match(command, /cmd \/k claude --permission-mode auto/);
  assert.match(command, /--name orch-phase-0-impl/);
  assert.match(command, /--model sonnet/);
  assert.match(command, /--plugin-dir "C:\\plugins\\agent-orchestrator"/);
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

test('spawnSession: returns pid when tasklist fixture matches', () => {
  const fixture = [
    '"cmd.exe","4321","Console","1","5,000 K","Running","user","0:00:00","orch-phase-0-impl — Scaffold"',
  ].join('\r\n');
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

// -------------------- tasklist CSV parsing --------------------

test('parseTasklistCsv: matches by window-title prefix', () => {
  const stdout = [
    '"WindowsTerminal.exe","10000","Console","1","30,000 K","Running","u","0:00:10","Windows Terminal"',
    '"cmd.exe","12345","Console","1","5,000 K","Running","u","0:00:01","orch-phase-0-impl"',
    '"cmd.exe","22222","Console","1","5,000 K","Running","u","0:00:01","orch-phase-1-impl — Build feature"',
  ].join('\r\n');
  assert.strictEqual(parseTasklistCsv(stdout, 'orch-phase-0-impl'), 12345);
  assert.strictEqual(parseTasklistCsv(stdout, 'orch-phase-1-impl'), 22222);
  assert.strictEqual(parseTasklistCsv(stdout, 'orch-phase-99'), null);
});

test('parseTasklistCsv: empty / non-matching input returns null', () => {
  assert.strictEqual(parseTasklistCsv('', 'orch-a'), null);
  assert.strictEqual(parseTasklistCsv('INFO: No tasks are running', 'orch-a'), null);
  assert.strictEqual(parseTasklistCsv(null, 'orch-a'), null);
});

test('parseTasklistCsv: ignores rows without numeric PIDs', () => {
  const stdout =
    '"cmd.exe","PID","Console","1","-","Running","user","-","orch-header-row"\r\n' +
    '"cmd.exe","777","Console","1","1,000 K","Running","user","0:00:01","orch-real-row"\r\n';
  assert.strictEqual(parseTasklistCsv(stdout, 'orch-header-row'), null);
  assert.strictEqual(parseTasklistCsv(stdout, 'orch-real-row'), 777);
});

// -------------------- getSessionPid (injected runner) --------------------

test('getSessionPid: uses injected runner, returns parsed PID', () => {
  const fixture =
    '"cmd.exe","9999","Console","1","5,000 K","Running","u","0:00:01","orch-x"\r\n';
  const calls = [];
  const pid = getSessionPid('orch-x', {
    _runner: (cmd) => {
      calls.push(cmd);
      return fixture;
    },
  });
  assert.strictEqual(pid, 9999);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /tasklist.*\/V.*CSV/);
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
  // Binary itself is quoted so cmd runs the full path, not "C:\Program".
  assert.match(
    command,
    /cmd \/k "C:\\Program Files\\Claude\\claude\.exe" --name orch-a/
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

test('buildSpawnCommand: "agency claude" binary is still emitted unquoted', () => {
  const { command } = buildSpawnCommand({
    name: 'orch-a',
    workdir: 'C:\\w',
    launcher: AGENCY_LAUNCHER,
  });
  assert.match(command, /"agency claude --enable-auto-mode/);
  assert.ok(!/"& 'agency claude'/.test(command));
});
