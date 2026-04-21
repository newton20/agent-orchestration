---
title: Spawning Windows Terminal tabs from Node.js — quoting, PIDs, and cmd.exe quirks
category: integration-issues
date: 2026-04-20
tags:
  - nodejs
  - windows-terminal
  - cmd
  - powershell
  - child-process
  - wmi
related_prs:
  - "newton20/agent-orchestration#3"
source: agent-orchestrator/scripts/spawn-session.js (Unit 4)
---

# Spawning Windows Terminal tabs from Node.js

Non-obvious findings from building `spawn-session.js`, a Node.js
module that opens visible Claude Code sessions in Windows Terminal
tabs under two launcher configurations (`cmd /k claude` and
`powershell -NoExit -Command "agency claude ..."`). Validated across
13 rounds of codex review before merge.

## Problem

`wt new-tab ...` looks simple to spawn from Node — it's just a CLI.
In practice, the chain `Node → cmd.exe → wt → (cmd|powershell) →
claude` inserts three layers of shell interpretation between your
argv and the actual program, each with its own quoting rules. Any
path with a space, any value with a `%`, and any nested quoted
argument is a potential ambush. Additionally, `tasklist` for PID
lookup is broken in a non-obvious way for wt multi-tab windows.

The concrete failures encountered and fixed:

1. `execSync(commandString)` went through `cmd.exe /d /s /c` and
   mangled nested double quotes inside `cmd /k "..."` invocations.
2. `cmd /k "C:\Program Files\Claude\claude.exe" --name orch-a`
   executed `C:\Program` as the program because `cmd /k` strips quotes
   when it sees more than two.
3. WMI `LIKE '%--name orch-a%'` filters got eaten by cmd.exe's `%`
   environment-variable expansion when passed via `execSync`.
4. `tasklist /V /FI` only reports the ACTIVE tab's window title under
   `wt -w 0`; background tabs were undiscoverable by title-match.
5. Tokenizing `shell_args: "-NoExit -File 'C:\Program Files\wrapper.ps1'"`
   with `split(/\s+/)` dropped the quoting and split the wrapper path.
6. `launcher.binary` is dual-purpose ("claude" vs "agency claude" vs
   `C:\Program Files\X\x.exe claude`) — naive quoting breaks at least
   one of the three shapes.

## Root causes

### A. Don't go through cmd.exe for argv that contains quotes or `%`

Node's `execSync(cmd_string, ...)` on Windows wraps your command in
`cmd.exe /d /s /c "<your-string>"`. The outer cmd layer:

- Eagerly expands `%NAME%` as env vars. Non-existent vars (or ones
  whose "name" contains special characters) become empty string. WMI
  LIKE filter `%--name %` becomes literally ``. No match.
- Applies `/s` quote-stripping rules: strips the outermost quote pair,
  passing the rest through to your real command. With nested quotes,
  this can eat the wrong pair.

**Fix:** Use `execFileSync(program, argv)` and hand Windows Terminal
each argument as its own argv element. Node serializes the argv for
CreateProcess using MSVC rules — each arg with whitespace gets
automatically `\"`-escaped. No cmd.exe in the chain. `%` survives
unmolested; nested quotes arrive at `wt` exactly as authored.

```js
const { execFileSync } = require('child_process');
const argv = [
  '-w', '0', 'new-tab',
  '--title', 'orch-phase-0-impl',
  '--suppressApplicationTitle',
  '--startingDirectory', workdir,
  'cmd', '/k', innerCmd,  // innerCmd is ONE argv element, even with internal quotes
];
execFileSync('wt', argv, { stdio: 'ignore' });
```

### B. `cmd /k` has a quote-stripping quirk

When cmd.exe's `/k` (or `/c`) sees its argument, it applies these
rules (documented in `cmd /?`):

> Rule 1: preserved if exactly 2 quotes, no special chars between
> them, whitespace between, and the quoted string names an executable.
> Rule 2 (fallback): strip the first and last quote.

For our spawn case `cmd /k "C:\Program Files\Claude\claude.exe"
--name orch-a`, there are 2 quotes but the quoted string isn't JUST
an executable (it has trailing args). Rule 1 fails. Rule 2 strips
outer quotes → `C:\Program Files\Claude\claude.exe --name orch-a` →
cmd runs `C:\Program` (program name stops at first space).

**Fix:** Wrap the ENTIRE inner command in outer double quotes when
generating the cmd subshell argument. This gives cmd 4+ quotes → Rule 1
fails → Rule 2 strips only the outermost pair → inner quoted exe path
survives.

```
Before: cmd /k "C:\Program Files\Claude\claude.exe" --name orch-a
After:  cmd /k ""C:\Program Files\Claude\claude.exe" --name orch-a"
```

### C. `--suppressApplicationTitle` on every `wt new-tab` invocation

Without `--suppressApplicationTitle`, tab titles revert to
"PowerShell" / "Claude Code" within seconds of the shell / app
emitting OSC title escapes. For named-tab workflows this is fatal.
Add it unconditionally:

```
wt -w 0 new-tab --title "orch-phase-0-impl" --suppressApplicationTitle ...
```

### D. `tasklist /V` cannot see background wt tab titles

`wt -w 0` spawns all tabs inside a single Windows Terminal process.
Only the currently-focused tab's title is exposed via
`tasklist /V /FO CSV`. Background tabs — the common case for an
orchestrator managing many sessions — are invisible by title.

**Fix:** Match on the process command line instead of the window
title. Every spawned session's command line includes `--name
<session-name>`. WMI exposes CommandLine for every process. Use
PowerShell's `Get-CimInstance Win32_Process` (wmic is deprecated in
Windows 11 24H2+):

```js
function buildPidLookupArgs() {
  const script =
    '@(Get-CimInstance Win32_Process -Filter ' +
    "\"CommandLine LIKE '%--name %'\" " +
    '| Select-Object ProcessId, CommandLine) ' +
    '| ConvertTo-Json -Compress -Depth 1';
  return ['-NoProfile', '-NoLogo', '-Command', script];
}
```

Match boundary exactly in JS (not in the WMI LIKE filter — `_` is a
LIKE wildcard, and `%--name orch-a%` also matches `--name
orch-a-review`):

```js
const re = new RegExp(
  `(?:^|\\s)--name\\s+${escapeRegex(name)}(?=\\s|$|['"])`
);
```

### E. Shell wrappers (cmd /k, powershell -NoExit) outlive the target

`cmd /k` and `powershell -NoExit` are intentionally kept open after
Claude exits so the user can inspect post-mortem output. If the
orchestrator tracks the wrapper PID, it thinks the session is alive
forever.

**Fix:** In the WMI result, prefer rows whose first CommandLine token
is NOT `cmd` or `powershell` (the claude/agency child). Fall back to
the wrapper PID only if no child is visible yet (spawn race window).

```js
function isShellWrapperCmdline(cmdline) {
  const trimmed = cmdline.trim();
  let first;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    first = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  } else {
    first = trimmed.split(/\s+/)[0] || '';
  }
  const bare = first.replace(/^.*[\\/]/, '').toLowerCase();
  return SHELL_WRAPPERS.has(bare);  // {cmd, cmd.exe, powershell, powershell.exe}
}
```

### F. Quote-aware `shell_args` tokenization

Users write `shell_args: -NoExit -File "C:\Program Files\wrapper.ps1"`
(or with single quotes in PowerShell idiom). A naive `split(/\s+/)`
drops the quoting and splits the wrapper path. Tokenizer must handle
both double and single quotes without cross-activation (a `"` inside
`'...'` is literal and vice versa):

```js
function tokenizeShellArgs(s) {
  const tokens = [];
  let cur = '', quoteChar = null, consumed = false;
  for (const c of s) {
    if (quoteChar === null && (c === '"' || c === "'")) {
      quoteChar = c; consumed = true; continue;
    }
    if (quoteChar !== null && c === quoteChar) { quoteChar = null; continue; }
    if (quoteChar === null && /\s/.test(c)) {
      if (consumed || cur !== '') { tokens.push(cur); cur = ''; consumed = false; }
      continue;
    }
    cur += c; consumed = true;
  }
  if (consumed || cur !== '') tokens.push(cur);
  return tokens;
}
```

### G. Dual-purpose `launcher.binary` needs an .exe-boundary split

The `binary` field has to cover three shapes:
- `claude` (bare command)
- `agency claude` (program + subcommand)
- `C:\Program Files\Agency\agency.exe claude` (path-with-spaces + subcommand)

Quote the whole string → breaks cases 1 and 2. Never quote → breaks
case 3. Heuristic that works: split at `.exe ` when present, quote the
exe portion only. For PowerShell, use the call operator `&` so the
quoted path actually executes:

```js
function quoteBinary(binary, shell) {
  const exeSplit = binary.match(/^(.+\.exe)\s+(.+)$/i);
  if (exeSplit && /[\\/]/.test(exeSplit[1]) && /\s/.test(exeSplit[1])) {
    return shell === 'powershell'
      ? `& '${exeSplit[1].replace(/'/g, "''")}' ${exeSplit[2]}`
      : `"${exeSplit[1].replace(/"/g, '""')}" ${exeSplit[2]}`;
  }
  const hasPathSep = /[\\/]/.test(binary);
  const hasSpace = /\s/.test(binary);
  if (!(hasPathSep && hasSpace)) return binary;
  return shell === 'powershell'
    ? `& '${binary.replace(/'/g, "''")}'`
    : `"${binary.replace(/"/g, '""')}"`;
}
```

## Prevention

1. **Default to `execFileSync(program, argv)`** for any command that
   mixes shells. Only use `execSync(string)` for commands you fully
   control the quoting of (e.g., a single no-args binary).

2. **Always include `--suppressApplicationTitle`** on `wt new-tab`
   when tab titles matter.

3. **Never match PIDs by window title** for multi-tab wt workflows.
   Use WMI CommandLine matching with a JS-side boundary regex, and
   filter out shell wrappers (cmd/powershell) in favor of the real
   child.

4. **`ConvertTo-Json` emits a scalar, not an array, for single-result
   pipelines.** Wrap with `@(...)` to force array form:
   `@(... | Select-Object X,Y) | ConvertTo-Json -Compress -Depth 1`.

5. **WMI LIKE filters are loose on purpose.** `_` is a single-char
   wildcard; substring matches ignore word boundaries. Do broad
   filtering in WMI and precise filtering in JS.

6. **Test path-with-spaces on every quoting code path.** `C:\Program
   Files\*` is not a theoretical edge case on Windows; users really
   do install Claude there.

## Verification

`spawn-session.js` + 127 tests (`node --test`) in
`agent-orchestrator/scripts/`. Tests mock `execFileSync` via an
injected runner and cover: both launchers, `--suppressApplicationTitle`
presence, path quoting under both shells, launcher validation,
WMI output parsing (array, scalar, empty, noise), suffix-collision
rejection, shell-wrapper filtering, quoted-path exe binaries, single-
and double-quoted shell_args.

## Related

- PR: [newton20/agent-orchestration#3](https://github.com/newton20/agent-orchestration/pull/3)
  (Unit 4 session-spawner module + Unit 4.5 hook spike)
- Source: `agent-orchestrator/scripts/spawn-session.js`
- Codex review history: 13 rounds before merge; every round surfaced
  one or two of the findings above. See commits under `feat/unit-4-and-4.5`
  branch for the sequence.
