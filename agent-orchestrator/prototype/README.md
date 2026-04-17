# Agent Orchestrator — Unit 0 Prototype

A ~200-line Node.js script that validates the core orchestration loop:

1. Parse a manifest YAML.
2. Spawn a visible Claude Code session in a new Windows Terminal tab.
3. Poll for a completion-signal file.
4. Advance to the next phase.

This prototype intentionally does **not** include: prompt injection, crash
recovery, review loops, email notifications, or parallel phases. Those are
Unit 1+ work. Run this against one real 2-phase project first and capture
real-world friction before investing in the full plugin.

## Prerequisites

- Windows 11 with Windows Terminal on `PATH` (verify: `where.exe wt`)
- Node.js ≥ 18 (tested on v22.22.2)
- A Claude Code CLI (this prototype defaults to Microsoft's `agency claude
  --enable-auto-mode` wrapper, configurable in the manifest)

## Install

> **All commands in this README must run from inside `agent-orchestrator\prototype\`.** `package.json` lives here, not at the project root — `npm install` from anywhere else fails with `ENOENT: package.json`.

```powershell
cd C:\Users\dunliu\projects\agent-orchestration\agent-orchestrator\prototype
npm install
```

That pulls in `js-yaml`. No other dependencies.

## Run

From the same directory:

```powershell
node orchestrate-prototype.js manifest-example.yaml
```

The script prints a header, then for each phase:

- Spawns a `wt` tab titled `orch-<phase-id>-<role>` running the configured
  launcher (default: `agency claude --enable-auto-mode` in PowerShell).
- Prints the absolute path of the prompt file for you to paste into the new
  Claude tab.
- Prints the absolute path Claude must write to signal completion.
- Polls every 30 seconds (overridable via `--poll-seconds`) until that file
  appears or the phase timeout elapses.
- Advances to the next phase.

## Manifest format

See [`manifest-example.yaml`](./manifest-example.yaml) for the full example.
Minimum required fields:

| Field | Required | Notes |
|---|---|---|
| `name` | no | Displayed in the header. |
| `workdir` | no | Where spawned tabs start (absolute or relative to manifest). Defaults to the manifest's directory. `prompt_file` and `completion_signal` paths always resolve against the manifest's directory, regardless. |
| `launcher.shell` | no | `powershell` (default) or `cmd`. |
| `launcher.binary` | no | Default `agency claude`. |
| `launcher.auto_mode_flag` | no | Default `--enable-auto-mode`. |
| `phases[].id` | yes | Used in the session name. |
| `phases[].title` | no | Cosmetic. Appears in the tab title. |
| `phases[].timeout_minutes` | no | Default 60. Kills the phase if signal never arrives. |
| `phases[].agent.role` | no | Default `impl`. |
| `phases[].agent.prompt_file` | no | Path to a prompt you'll paste by hand. |
| `phases[].completion_signal` | yes | Path (relative to the manifest) the agent must create to signal done. |

All relative paths resolve against the manifest's directory.

## CLI flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print the `wt` command instead of executing it. No tabs spawned, no polling. Great for checking your manifest. |
| `--poll-seconds N` | Override the 30-second default poll interval. |
| `-h`, `--help` | Usage summary. |

## Idempotency / resume

If a phase's `completion_signal` file already exists when the prototype starts,
that phase is skipped. So if the orchestrator crashes or you Ctrl+C out of it,
just rerun with the same manifest — completed phases are skipped and it picks
up at the first unfinished phase. To force a re-run, delete the corresponding
signal file.

## Smoke test (no Claude burn)

You can validate the loop without spending Claude tokens by simulating
completion manually:

```powershell
# Terminal A
node orchestrate-prototype.js manifest-example.yaml

# Terminal B (after phase-0 tab spawns)
New-Item -ItemType File -Path .\signals\phase-0-impl-complete.md -Force

# Orchestrator should detect the signal within the poll interval and spawn
# phase-1. Repeat for phase-1. After both signals exist, it prints
# "Orchestration finished."
```

Use `--dry-run` to see exactly what `wt` command would be executed without
opening any tabs:

```powershell
node orchestrate-prototype.js manifest-example.yaml --dry-run
```

## What to look for (friction log)

While running this against a real project, capture anything that feels
awkward. Candidates:

- Did `wt` actually open new tabs every time, or did it attach to the wrong
  window?
- Did `agency claude --enable-auto-mode` start cleanly in the spawned tab?
- How painful was pasting the prompt by hand? (Unit 5's SessionStart hook
  fixes this — but measure the pain first.)
- Did Claude reliably write the completion signal file, or did it need more
  prompting?
- Did the 30s poll interval feel too slow or too fast?

Log findings anywhere — a note, a new line in the plan, whatever. They
inform whether Units 1-8, 11 are built as planned or adjusted first.

## Known limitations (intentional)

- **No prompt injection.** You paste the prompt manually. Unit 5.
- **No crash recovery.** If Claude dies, the orchestrator times out. Unit 11.
- **No parallel phases.** Strict sequential execution. Unit 11.
- **No review loop.** One agent per phase. Unit 11.
- **No email notifications.** V1.5.
- **No PID tracking.** Only file-based polling. Unit 8.
- **Agency wrapper compatibility for `--name`, `--plugin-dir`, and hooks is
  not yet validated.** Unit 4.5 spike does this. Until then, the prototype
  intentionally passes neither `--name` nor `--plugin-dir` — it just opens a
  tab and lets the user drive.
