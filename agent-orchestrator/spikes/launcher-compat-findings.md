# Unit 4.5 — SessionStart hook + launcher compatibility findings

Status: **COMPLETE — run 2026-04-20.**

Ran all three tests via settings.json-registered hook (pivoted from
`--plugin-dir` after observing plugin-dir hook registration wasn't
activating). Results identical across all three launcher paths.

## Verdict

**Hook fires under every launcher** (direct claude from cmd, agency
from PowerShell, direct claude from PowerShell). The agency wrapper
does NOT block or suppress SessionStart hooks.

**`--name` is NOT exposed to the hook via any channel** — not in env
vars, not in the stdin JSON payload, not in `argv`. The session is
identified only by a random `session_id` UUID that the orchestrator
cannot predict before spawn.

**Unit 5 reshape: flag-file fallback is mandatory.** The plan's
original name-based detection design (SessionStart reads
`CLAUDE_SESSION_NAME`, matches `orch-<phase>-<role>`, loads prompt) is
not viable. Unit 5 must use the flag-file protocol from the plan's
Unit 4.5 decision matrix "row 3".

## How the spike was actually run

The plan originally called for loading a mini-plugin via
`--plugin-dir agent-orchestrator/spikes`. That turned out to be
unreliable for hook activation on this machine — Claude started the
session but the hook never fired (no error, no dump). Pivoted to
registering the hook in `<repo>/.claude/settings.json` directly. With
that, Claude prompted once to approve the hook, then fired it on
every subsequent session start.

Side-finding worth capturing: **Claude Code on Windows executes hook
commands through Git Bash (`/usr/bin/bash`), not `cmd.exe`.** The
initial command string used backslashes (`C:\Users\...`) which bash
interpreted as C-escapes and collapsed to `C:Users...` → `command not
found`. Fixed by using forward slashes (`C:/Users/...`) which Windows
accepts natively and bash doesn't mangle. This constraint means the
superpowers-style `.cmd` wrapper is still fine (bash can exec .cmd
files), but the **command path in settings.json must use forward
slashes**, and hook authors should assume the execution shell is bash.

## Env-dump location

`%USERPROFILE%\.claude-hook-spike-dump.txt` — cleaned up post-run.

## Findings

### Test 1 — direct claude from cmd

_Launch command:_ `claude --name orch-test-spike` (from
`C:\Users\dunliu\projects\agent-orchestration`, cmd.exe)

_Hook fired?_ **YES** at `2026-04-21T03:38:46.451Z`.

_Relevant env vars:_

```
CLAUDE_CODE_ENTRYPOINT = "cli"
CLAUDE_CODE_USE_POWERSHELL_TOOL = "1"
CLAUDE_ENV_FILE = "C:\Users\dunliu\.claude\session-env\<session_id>\sessionstart-hook-0.sh"
CLAUDE_PROJECT_DIR = "C:/Users/dunliu/projects/agent-orchestration"
```

No `CLAUDE_SESSION_NAME` or equivalent. `grep -c orch-test-spike` on
the full env dump = 0.

_Stdin payload (340 bytes):_

```json
{
  "session_id": "ce5486ae-fdd4-4b0f-9b30-f8d5f311634a",
  "transcript_path": "C:\\Users\\dunliu\\.claude\\projects\\C--Users-dunliu-projects-agent-orchestration\\ce5486ae-fdd4-4b0f-9b30-f8d5f311634a.jsonl",
  "cwd": "C:\\Users\\dunliu\\projects\\agent-orchestration",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-7[1m]"
}
```

_Session name reachable?_ **NO** — not via any env var, not in stdin
JSON. Only opaque `session_id` UUID.

### Test 2 — agency claude from PowerShell

_Launch command:_ `agency claude --enable-auto-mode --name orch-test-spike`
(from the same repo dir, PowerShell)

_Hook fired?_ **YES** at `2026-04-21T03:45:43.821Z`.

_Relevant env vars:_ same `CLAUDE_*` set as Test 1, PLUS agency-
specific vars surfacing that the launch went through the wrapper:

```
AGENCY_LOG_SESSION_DIR = "C:\Users\dunliu\.agency\logs\session_20260420_204533_35796"
AGENCY_OPERATION_ID = "00-cec889e343cfc1e1e914334ae6e518e7-ec209deed404e15c-00"
AGENCY_REPO_DIR = "C:/Users/dunliu/projects/agent-orchestration"
```

`AGENCY_*` vars could be used by the hook to detect "am I under the
agency wrapper" if that ever mattered, but they do NOT encode the
session name.

_Stdin payload (340 bytes):_ same shape as Test 1 — only `session_id`
differs (`8fb7f6b2-a71a-48c3-8436-f8b52ea0a535`).

_Session name reachable?_ **NO** — identical result to Test 1.
`--name` survives to Claude Code (tab title shows `orch-test-spike`)
but never reaches the hook.

_`--plugin-dir` survived?_ N/A — tests run via settings.json hook
registration instead of plugin-dir. But given the hook DOES fire under
agency, we can assume `--plugin-dir` would also survive; that's a
secondary question Unit 5 can verify when it lands.

### Test 3 — direct claude from PowerShell

_Launch command:_ `claude --name orch-test-spike` (same repo dir,
PowerShell)

_Hook fired?_ **YES** at `2026-04-21T03:50:43.286Z`.

_Relevant env vars:_ same `CLAUDE_*` set as Test 1. No agency vars
(PowerShell shell, but no agency wrapper). `CLAUDE_CODE_USE_POWERSHELL_TOOL = "1"`
is present under ALL three launchers including cmd — this is a
user-set env var that Claude Code exports on start, not a shell-
specific signal.

_Stdin payload:_ same shape; `session_id = c47a52e6-4a9a-4c8e-9116-1542298cdf65`.

_Session name reachable?_ **NO** — identical result.

## Decision matrix (filled in)

| Scenario | Session name available? | Hook fires? | Plan path |
|---|---|---|---|
| Direct claude (Test 1), name in env | **NO** | **YES** | ~~Use name-based detection~~ → flag-file |
| Agency (Test 2), name survives, hook fires | **NO** | **YES** | Flag-file — agency is otherwise compatible |
| Agency (Test 2), name lost | **YES (name is always lost)** | **YES** | **Flag-file fallback** ← ALL THREE LAUNCHERS |
| Agency (Test 2), hook doesn't fire | N/A | N/A — hook DOES fire | Not applicable |

**Applicable row: row 3 for every launcher.** Name is never
available; hook always fires.

## Implications for Unit 5

Unit 5 (SessionStart hook for prompt injection) cannot use
`process.env.CLAUDE_SESSION_NAME` because no such variable exists.
The design must be:

1. **Orchestrator (Unit 11) writes a flag file before spawn.**
   Immediately before the `wt new-tab ...` call in `spawnSession()`,
   write `docs/orchestration/.pending-<session-name>` containing the
   prompt content (or a pointer to `docs/orchestration/phases/<phase-id>/<role>-prompt.md`).

2. **Hook scans for `.pending-*` files on startup.** Reads
   `CLAUDE_PROJECT_DIR` from env (confirmed present in all three
   tests), looks under `$CLAUDE_PROJECT_DIR/docs/orchestration/` for
   any `.pending-*` file younger than a configurable TTL (e.g. 60s
   — the spawn-to-hook latency is well under 1s in practice, but 60s
   accommodates clock skew and manual-debug scenarios).

3. **Hook reads the first match, deletes it atomically, injects the
   prompt content** as `additionalContext` in the output JSON. If
   multiple `.pending-*` files exist, the oldest wins and the
   orchestrator will see its flag file disappear; the orchestrator
   can then confirm the right session consumed the prompt via some
   sentinel in the prompt content.

4. **Stale-file handling.** The orchestrator already has a retry-
   with-backoff design. Flag files older than TTL are stale (either
   from a spawn that failed, or from a previous failed hook run) and
   ignored; the orchestrator's retry eventually succeeds.

5. **Race conditions.** Two orchestrator-spawned sessions starting
   very close in time will each find ONE `.pending-*` file. As long
   as the orchestrator writes each flag file atomically (tmp + rename)
   and the hook deletes atomically (fs.renameSync to a unique temp
   path, then read), the "first hook to delete wins" invariant holds.

## Configuration files used

- Hook registration: `<repo>/.claude/settings.json` (temporary spike
  artifact, deleted post-run).
- Hook wrapper: `agent-orchestrator/spikes/hooks/run-spike.cmd`
  invoked `node ../hook-env-spike.js`.
- Hook command in settings.json: forward-slash absolute path to the
  wrapper, bare (no `cmd /c` prefix needed when Claude invokes via
  bash).

## Cleanup

- [x] `%USERPROFILE%\.claude-hook-spike-dump.txt` — removed.
- [x] `<repo>/.claude/settings.json` — removed (not committed to
  the repo; was a one-off spike artifact).
- [x] The spike plugin skeleton (`spikes/.claude-plugin/`, `spikes/hooks/`,
  `spikes/hook-env-spike.js`, etc.) is kept in the tree so Unit 5 can
  reuse the wrapper pattern when it builds the real prompt-injection
  hook.
