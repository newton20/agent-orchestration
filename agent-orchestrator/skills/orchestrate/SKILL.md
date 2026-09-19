---
name: orchestrate
description: Run V1 multi-session phased builds from a YAML manifest, or inspect V2 state without production worker dispatch. V1 spawns visible Claude Code sessions, monitors file signals, runs review loops, and recovers from crashes in an external Node.js process.
argument-hint: "[manifest.yaml path | --resume]"
---

# /orchestrate — Multi-session phased-build orchestrator

This skill is a **thin entry point**. It does NOT run the orchestration
loop inside this Claude session. Instead it:

1. Validates the manifest exists and is well-formed.
2. Runs `npm install` in `scripts/` if `node_modules/` is missing.
3. Starts `node scripts/orchestrate.js <manifest>` as a separate
   Node.js process.

The orchestrator is the Node.js process at
[`scripts/orchestrate.js`](../../scripts/orchestrate.js). It re-reads
all state from disk on every tick and uses zero of this Claude
session's context window — by design. A `/loop` inside Claude would
exhaust the context after ~90 polling ticks; the external process has
no such limit.

## Steps

First identify the manifest schema and any existing canonical state.
The launch instructions below describe V1. V2 manifests or persisted V2
state use the separate foundation path and report `live_dispatch_disabled`;
they do not launch production Claude or Copilot workers.

For V2, distinguish accepted state, projection diagnostics, and worker
reports from live engine acceptance. Do not report a successful live build
from an exit code or readiness response alone. Do not inject an engine
through `_fixtureAdapter`, remove the live-test skips, or broaden
permissions to make a run start. Native correlation, immutable executable
binding, runtime adapter integration, and authorized live acceptance are
still outstanding.

The offline package is built with `npm run package:plugin -- --output`
and a new absolute directory outside the source checkout. It includes
locked runtime dependencies but not Node. Package loading does not perform
an npm install. A packaged installation with missing dependencies is an
invalid artifact to rebuild, not a reason to silently alter installed files.
The developer dependency-install step below applies to a source checkout.
See `agent-orchestrator\README.md` in the source repository for the complete
packaging invocation.

When the user invokes this skill with a manifest path:

1. **Ensure dependencies are installed.** This MUST run before any
   other Node script invocation — `parse-manifest.js` requires
   `js-yaml` at module-load time and will throw a `Cannot find module`
   error on a fresh checkout if `node_modules/` is missing.

   PowerShell (Windows default):

   ```powershell
   Push-Location "$env:CLAUDE_PLUGIN_ROOT/scripts"
   if (-not (Test-Path node_modules)) { npm install }
   Pop-Location
   ```

   Bash (non-Windows or git-bash):

   ```bash
   cd "$CLAUDE_PLUGIN_ROOT/scripts" && (test -d node_modules || npm install)
   ```

   The first run on a fresh checkout installs; subsequent runs skip.

2. **Validate the manifest.**

   PowerShell:

   ```powershell
   node "$env:CLAUDE_PLUGIN_ROOT/scripts/parse-manifest.js" <manifest.yaml>
   ```

   Bash:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/parse-manifest.js" <manifest.yaml>
   ```

   If the JSON output's `valid` field is `false`, surface every error
   under `errors[]` to the user verbatim. Do NOT proceed — the
   orchestrator refuses an invalid manifest, so let the user fix the
   manifest first.

3. **Start the orchestrator process.**

   PowerShell:

   ```powershell
   node "$env:CLAUDE_PLUGIN_ROOT/scripts/orchestrate.js" <manifest.yaml>
   # or for a resumed run after a crash / machine restart:
   node "$env:CLAUDE_PLUGIN_ROOT/scripts/orchestrate.js" --resume <manifest.yaml>
   ```

   Bash:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/orchestrate.js" <manifest.yaml>
   # or for a resumed run after a crash / machine restart:
   node "$CLAUDE_PLUGIN_ROOT/scripts/orchestrate.js" --resume <manifest.yaml>
   ```

   Tell the user:

   > Orchestrator started. Monitor `docs/orchestration/` for phase
   > artifacts; press Ctrl+C in this terminal to stop the orchestrator.

   The orchestrator writes structured logs to stderr and runs until
   every phase reaches a terminal status (`completed` / `failed` /
   `blocked`).

## V1 CLI flags

The orchestrator accepts:

| Flag | Default | Purpose |
|---|---|---|
| `<manifest.yaml>` | (required) | Path to the manifest. Validated before the loop starts. |
| `--resume` | off | Read `manifest-status.yaml`, skip completed phases, respawn crashed agents. Use after a machine restart or orchestrator kill. |
| `--once` | off | Run a single tick then exit. Useful for testing. |
| `--max-ticks <n>` | unlimited | Exit after N ticks. Pairs with `--once` for CI. |
| `--active-interval-ms <n>` | 30000 | Poll cadence when at least one phase is `running`. |
| `--idle-interval-ms <n>` | 120000 | Poll cadence when nothing is running (e.g. all phases blocked on user input). |
| `--max-recovery-retries <n>` | 3 | Per-phase crash-retry budget. Past the budget, the phase is marked `failed`. |
| `--converge-n <n>` | 3 | Consecutive `pidAlive: null` readings (past startup grace) before recovery fires. |
| `--startup-grace-ms <n>` | 60000 | Forwarded to `check-health`'s `startupGraceMs`. Within this window, `pidAlive: null` is treated as "still spawning," not as a crash. |
| `--review-loop-max-iterations <n>` | 3 | Per-phase impl↔QA review-loop cap. Past the cap, the phase is marked `failed` and escalated. |
| `--plugin-dir <path>` | `../` (this plugin) | Source directory for the templates copy that scaffold-protocol writes into the operator-visible `docs/orchestration/templates/`. |
| `--project-name <s>` | `manifest.name` | Substituted into `{{project_name}}` in every prompt. |
| `--dry-run` | off | Render prompts and log actions without spawning sessions or writing flag files. |
| `--skip-scaffold` | off | Skip the scaffold-protocol pre-flight (advanced; assumes the operator already laid out `docs/orchestration/`). |

Exit codes: `0` (every phase completed), `1` (one or more phases
failed, or fatal error), `2` (lockfile contention — another
orchestrator is already running against this manifest).

## What the V1 orchestrator does

Per tick (every 30 seconds when active, 2 minutes when idle):

1. Re-read `manifest.yaml` + `manifest-status.yaml` from disk. The
   files are the single source of truth — the orchestrator
   accumulates no state across ticks beyond a transient diagnostic
   counter for tri-state convergence (see [`references/review-loop.md`](./references/review-loop.md)).
2. For each `pending` phase whose `depends_on` are `completed`:
   render prompts via `generate-prompt`, write `.pending-<sessionName>`
   flag files (consumed by the SessionStart hook), spawn sessions via
   `wt new-tab`, persist `started_at` + `pid` to manifest-status,
   transition to `running`.
3. For each `running` phase: call `check-health` per role, detect
   completion signals, recover crashed agents up to the retry budget,
   advance review loops on QA verdicts.
4. When every phase reaches a terminal status, print a summary and
   exit.

The orchestrator never calls `claude -p`. V1 is template-only; V1.5's
recovery-analyst LLM step is deferred (see plan §V1.5 Deferred Units).

## V1 file locations under `<manifestDir>/docs/orchestration/`

| Path | Purpose |
|---|---|
| `phases/<phase-id>/` | Per-phase artifacts (prompts, completion signals, heartbeats) |
| `phases/<phase-id>/<role>-prompt.md` | Rendered prompt (one per role per dispatch) |
| `phases/<phase-id>/<role>-prompt.original.md` | Preserved original on first recovery (idempotent across re-recoveries) |
| `phases/<phase-id>/<role>-complete.md` | Completion signal — orchestrator polls for this |
| `phases/<phase-id>/qa-verdict.json` | Optional structured QA verdict (preferred over qa-complete.md frontmatter when present) |
| `phases/<phase-id>/heartbeat.jsonl` | Append-only heartbeat log (advisory liveness signal) |
| `templates/` | Live copy of role templates (operator-editable) |
| `logs/events.jsonl` | Future: per-tick event log |
| `.pending-<sessionName>` | Hook flag file — written before spawn, consumed by SessionStart hook |
| `.orchestrator.lock` | PID + start time of the running orchestrator. Refuses second instance. |

## References

- [`references/review-loop.md`](./references/review-loop.md) — impl↔QA
  review cycle, qa-verdict.json schema, escalation policy.

## See also

- [Manifest reference](../../docs/manifest-reference.md) — every manifest field.
- [Unit 0 prototype](../../prototype/README.md) — the original
  shell-script prototype the orchestrator productionizes.
- [Implementation plan](../../../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md)
  — Unit 11 spec, including the 10 design decisions documented in
  `scripts/orchestrate.js`.
