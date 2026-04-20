# Unit 4.5 — SessionStart hook + launcher compatibility findings

Status: **template — awaiting coord to run the three launch commands below.**

This document captures what Claude Code exposes to a SessionStart hook
under three launcher configurations. The answers decide whether Unit 5's
prompt-injection mechanism can use `--name`-based detection (the design
in the plan) or must fall back to the flag-file protocol.

## How to run the spike

1. From the repo root, confirm the spike plugin loads:
   ```
   dir agent-orchestrator\spikes\.claude-plugin\plugin.json
   dir agent-orchestrator\spikes\hooks\hooks.json
   ```

2. Pick an **absolute path** for `--plugin-dir` that points at
   `agent-orchestrator\spikes`. All three tests below use the same path
   — only the launcher shell + binary change.

3. Run the three launch commands (one at a time, any order). Each opens
   a Claude Code session. Let the hook fire (SessionStart runs
   immediately), type `/exit` to close the session, and copy the
   env-dump file out of `%USERPROFILE%` before the next test (each run
   appends, so you can also diff between runs if you prefer).

4. Fill in the three `### Test N` sections below with the relevant
   chunks of the dump — `env.CLAUDE_PLUGIN_ROOT`, any field containing
   `orch-test-spike`, the stdin JSON payload — then fill in the
   **Decision matrix** at the bottom.

## Env-dump location

Every hook invocation appends a dated block to:

```
%USERPROFILE%\.claude-hook-spike-dump.txt
```

(The script is `agent-orchestrator/spikes/hook-env-spike.js`; it writes
to `os.homedir() + .claude-hook-spike-dump.txt` unconditionally.)

## The three launch commands

Replace `C:\path\to\agent-orchestration` with the repo root on your box.

### Test 1 — Direct `claude` from cmd (baseline)

Open **cmd.exe** and run:

```
claude --plugin-dir "C:\path\to\agent-orchestration\agent-orchestrator\spikes" --name orch-test-spike
```

Goal: baseline. Does the hook fire at all? Does `--name` land in env or
stdin? What's the shape of the hook JSON payload?

### Test 2 — Agency wrapper from PowerShell

Open **PowerShell** and run:

```
agency claude --enable-auto-mode --plugin-dir "C:\path\to\agent-orchestration\agent-orchestrator\spikes" --name orch-test-spike
```

Goal: the critical one. The `agency` wrapper is the actual runtime on
this machine. Does `--name` survive the wrapper? Does `--plugin-dir`?
Does the hook even fire under auto-mode?

### Test 3 — Direct `claude` from PowerShell

Open **PowerShell** and run:

```
claude --plugin-dir "C:\path\to\agent-orchestration\agent-orchestrator\spikes" --name orch-test-spike
```

Goal: isolates the shell variable from the wrapper variable. If Test 1
works and Test 3 works but Test 2 doesn't, the fault is with `agency`.
If Test 1 works and Test 3 doesn't, the hook is sensitive to the
invoking shell.

## Findings

### Test 1 — direct claude from cmd

_Hook fired?_ **{TODO: yes / no}**

_Relevant env vars:_

```
TODO: paste CLAUDE_PLUGIN_ROOT and any CLAUDE_* var from the dump
```

_Stdin payload:_

```
TODO: paste the JSON stdin block from the dump (or "(empty)")
```

_Session name reachable?_ **{TODO: yes / no — via which field}**

### Test 2 — agency claude from PowerShell

_Hook fired?_ **{TODO: yes / no}**

_Relevant env vars:_

```
TODO: paste CLAUDE_PLUGIN_ROOT and any CLAUDE_* var
```

_Stdin payload:_

```
TODO: paste the JSON stdin block
```

_Session name reachable?_ **{TODO: yes / no — via which field}**

_`--plugin-dir` survived?_ **{TODO: yes / no}**

### Test 3 — direct claude from PowerShell

_Hook fired?_ **{TODO: yes / no}**

_Relevant env vars:_

```
TODO: paste CLAUDE_PLUGIN_ROOT and any CLAUDE_* var
```

_Stdin payload:_

```
TODO: paste the JSON stdin block
```

_Session name reachable?_ **{TODO: yes / no — via which field}**

## Decision matrix (reproduced from plan §Unit 4.5)

| Scenario | Session name available? | Hook fires? | Plan path |
|---|---|---|---|
| Direct claude (Test 1), name in env | **{TODO}** | **{TODO}** | Use name-based detection (Unit 5 as designed) |
| Agency (Test 2), name survives, hook fires | **{TODO}** | **{TODO}** | Same as above, launcher config just swaps binary |
| Agency (Test 2), name lost | **{TODO}** | **{TODO}** | Flag-file fallback: orchestrator writes `.pending-{name}` before spawn |
| Agency (Test 2), hook doesn't fire | **{N/A}** | **{TODO}** | Escalate: prompt-as-first-message mode (orchestrator pastes prompt as first user message, manual) |

_Which row applies?_ **{TODO — coord fills in after running the tests}**

## Implications for Unit 5

Unit 5 (`SessionStart hook for prompt injection`) will read from whichever
mechanism Test 2 validates:

- **Row 1/2 (name in env):** Unit 5 reads
  `process.env.CLAUDE_SESSION_NAME` (or whichever var the dump reveals),
  matches `orch-{phase-id}-{role}`, loads
  `docs/orchestration/phases/{phase-id}/{role}-prompt.md`, returns it
  as `additionalContext`.

- **Row 3 (name lost, flag-file fallback):** Unit 5 scans
  `docs/orchestration/.pending-*` on startup, picks the first match
  younger than 60s, deletes it atomically, returns its content. The
  orchestrator writes the flag file immediately before `wt` spawn in
  Unit 4's `spawnSession()`.

- **Row 4 (hook doesn't fire under agency):** Unit 5 becomes a no-op on
  agency, and the orchestrator instead copies the prompt to the
  clipboard / injects as first user message. We document agency as
  partially unsupported and recommend direct `claude` for orchestrated
  sessions.

## Cleanup

After filling in the findings, coord can:
- `del %USERPROFILE%\.claude-hook-spike-dump.txt` (safe — only written by this spike)
- Leave `agent-orchestrator/spikes/` in the tree — Unit 5 will reuse the
  wrapper pattern; only the findings doc rot-resistantly captures what
  we learned.
