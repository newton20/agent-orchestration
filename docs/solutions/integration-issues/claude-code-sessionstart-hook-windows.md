---
title: Claude Code SessionStart hooks on Windows — what works, what doesn't
category: integration-issues
date: 2026-04-20
tags:
  - claude-code
  - hooks
  - windows
  - plugins
  - session-start
related_prs:
  - "newton20/agent-orchestration#3"
source: docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md (Unit 4.5 spike)
---

# Claude Code SessionStart hooks on Windows

Empirical findings from running a SessionStart-hook env-dump spike
against Claude Code v2.1.116 on Windows 11, under three launch paths:
direct `claude` from cmd, direct `claude` from PowerShell, and
Microsoft's `agency claude --enable-auto-mode` wrapper from
PowerShell. Captures what's actually exposed to the hook, what's not,
and the execution-environment gotchas that silently break naive hook
scripts.

## Problem

We wanted a Claude Code plugin that spawns visible, named tabs in
Windows Terminal (e.g. `orch-phase-0-impl`) and uses a SessionStart
hook to auto-inject a role-specific prompt into each session based on
its name. The design assumed three things:

1. The hook fires reliably across launchers including the agency wrapper.
2. The `--name <session-name>` flag is exposed to the hook so it can
   branch on session identity.
3. Registering the hook via `<plugin-dir>/hooks/hooks.json` and
   launching with `claude --plugin-dir <path>` activates the hook.

Running a real SessionStart spike (script: dump `process.env` +
stdin, append to `$HOME/.claude-hook-spike-dump.txt`, output `{}`)
invalidated two of those assumptions and exposed execution-environment
gotchas that silently swallowed the hook on the first attempt.

## Root cause findings

### 1. `--name` is NEVER exposed to the SessionStart hook

Across all three launchers, the session name passed via `--name
orch-test-spike` does NOT appear in:

- Any env variable — no `CLAUDE_SESSION_NAME`, no wrapper var
- `process.argv` — only the node binary + hook script path
- The stdin JSON payload — shape is
  `{session_id, transcript_path, cwd, hook_event_name, source, model}`
  where `session_id` is an opaque UUID Claude generates at start, not
  the user-supplied name

`grep -c orch-test-spike` on the full env+stdin dump across all three
tests = 0. The `--name` value reaches Claude Code (tab title reflects
it) but never crosses into the hook's execution context.

**Design implication:** Name-based session-to-prompt routing in
SessionStart hooks is not viable. The hook must either consume
per-session state the orchestrator writes to a known filesystem
location before spawn (flag-file pattern), or use something else
available in the payload — `session_id` (unknowable pre-spawn),
`transcript_path` (also contains `session_id`), or `cwd` (requires
per-session working directories, which `wt --startingDirectory`
supports but complicates the orchestrator).

### 2. Claude Code runs hook commands through Git Bash on Windows, not cmd.exe

The hook error observed on the first attempt:

```
SessionStart:startup hook error
Failed with non-blocking status code: /usr/bin/bash:
line 1: C:Usersdunliuprojectsagent-orchestrationagent-orchestratorspikeshooksrun-spike.cmd: command not found
```

Note the collapsed path (`C:Usersdunliu...`). The settings.json had:

```json
"command": "C:\\Users\\dunliu\\...\\run-spike.cmd"
```

Which JSON-parses to `C:\Users\dunliu\...\run-spike.cmd`. Bash then
interprets each `\U`, `\d`, `\p`, etc. as a C-style escape sequence,
silently eating the backslashes and producing `C:Usersdunliu...`.
Result: "command not found."

**Fix:** Use forward slashes in the command path. Windows accepts them
natively and bash doesn't mangle them:

```json
"command": "C:/Users/dunliu/.../run-spike.cmd"
```

This constraint applies to `hooks/hooks.json` in a plugin AND to
project/user `settings.json` hook entries. The superpowers-style
`.cmd` wrapper still works (bash can exec `.cmd` files on Windows),
but the path to the wrapper must be forward-slash.

### 3. `--plugin-dir <path>` did not reliably activate hooks

The spike was originally designed to run the hook via a self-contained
mini-plugin loaded with `claude --plugin-dir <path-to-spikes>`. The
directory had the canonical layout (`.claude-plugin/plugin.json` +
`hooks/hooks.json` + wrapper script). Claude started the session
cleanly — tab title reflected `--name`, auto mode engaged — but the
hook never fired and no approval prompt appeared. Same result under
all three launchers.

**Workaround that did work:** Register the hook in the project's
`.claude/settings.json` (not `settings.local.json` — the latter also
did not activate the hook on this Claude version). Claude then
prompted once to approve the hook and fired it on every subsequent
start.

**Open question for Claude Code maintainers:** whether `--plugin-dir`
auto-activation of hooks is intentional (maybe only
`enabledPlugins`-listed plugins get their hooks registered?) or a
version-specific regression. In either case, **shipping a plugin with
hooks on Windows should expect users to install via the regular
plugin-install flow, not `--plugin-dir`.**

## Working solution (what the hook sees)

When the hook IS registered correctly (project `settings.json` with a
forward-slash command path), it fires reliably under every launcher
tested. The execution context:

**Env vars common across all three launchers:**

```
CLAUDE_CODE_ENTRYPOINT   = "cli"
CLAUDE_ENV_FILE          = "<user>\.claude\session-env\<session_id>\sessionstart-hook-0.sh"
CLAUDE_PROJECT_DIR       = "<forward-slash absolute path of project>"
CLAUDE_CODE_USE_POWERSHELL_TOOL = "1"   # if the user has set this in their settings
```

**Stdin JSON (340 bytes in the spike's case):**

```json
{
  "session_id": "ce5486ae-fdd4-4b0f-9b30-f8d5f311634a",
  "transcript_path": "<user>\\.claude\\projects\\<project-slug>\\<session_id>.jsonl",
  "cwd": "<project dir>",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-7[1m]"
}
```

`source` values observed: `startup` (fresh session) — the hook
matcher `startup|clear|compact` documented in superpowers matches the
full set of SessionStart trigger sources.

**Agency-specific extras:** Under the `agency claude` wrapper,
`AGENCY_LOG_SESSION_DIR`, `AGENCY_OPERATION_ID`, `AGENCY_REPO_DIR`
env vars are also exposed. Useful for detecting the wrapper presence;
does not carry the session name.

## Prevention / prescriptions

For anyone writing SessionStart hooks for a Claude Code plugin
targeting Windows:

1. **Always use forward slashes** in `command` paths in both
   `hooks/hooks.json` (plugin-scope) and `settings.json` (user/project
   scope). Assume the executing shell is bash.

2. **Do not rely on `--name` reaching the hook.** Route per-session
   state through the filesystem (flag files in a known project-
   relative location, or per-session working directories). Read
   `CLAUDE_PROJECT_DIR` from env to anchor the path — it's reliably
   present.

3. **Ship plugins with hooks via the normal install flow, not
   `--plugin-dir` testing.** `--plugin-dir` may not activate hooks
   reliably across Claude versions; users get a quiet no-op.

4. **Flag-file race protection:** if using the flag-file pattern,
   atomic write (`tmp + rename`) on the orchestrator side and atomic
   delete (`renameSync` to a unique temp path before read) on the hook
   side. Enforces "first hook to delete wins" for concurrent spawns.

5. **`.cmd` wrapper scripts still work** on Windows because bash can
   exec `.cmd` files, but the superpowers polyglot trick (bash
   here-doc inside a `.cmd`) is now unnecessary — a simple `.cmd` that
   calls `node` directly works. If you take this route, remember the
   wrapper PATH resolution: `%~dp0` expands to the wrapper's directory
   inside cmd context, which is correct whether it was launched by
   bash or cmd.

## Verification

Spike reproduced the findings with a 36-line Node.js hook that dumps
env + stdin to `$HOME/.claude-hook-spike-dump.txt`. Three launch
commands, three `hook fired at <timestamp>` blocks, zero hits of
`orch-test-spike` in the combined dump. See
[`agent-orchestrator/spikes/launcher-compat-findings.md`](../../../agent-orchestrator/spikes/launcher-compat-findings.md)
in the repo for the verbatim findings doc.

## Related

- PR: [newton20/agent-orchestration#3](https://github.com/newton20/agent-orchestration/pull/3)
- Plan section: Unit 4.5 in
  `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
- Reference plugin that hooks correctly on Windows:
  `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/hooks/`
  (uses the bash-polyglot `.cmd` pattern; its hooks.json command uses
  `${CLAUDE_PLUGIN_ROOT}` substitution with forward-compatible quoting)
