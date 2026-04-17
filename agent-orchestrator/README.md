# agent-orchestrator

A Claude Code plugin that runs multi-phase, multi-session builds without
manual copy-paste between windows. You write a YAML manifest describing
phases and agent roles. The orchestrator spawns visible Claude Code sessions
in Windows Terminal tabs, polls a file-drop protocol for completion signals,
handles QA↔impl review loops, recovers from crashes, and notifies you when
things land or need a decision.

## Current status

| Unit | What | Status |
|---|---|---|
| 0 | Shell-script prototype (spawn + poll + advance) | **Done** — see [`prototype/`](./prototype/) |
| 0.5 | README + manifest reference | **Done** — you're reading it |
| 1 | Plugin scaffold (`.claude-plugin/`, stub skills) | Pending |
| 2 | Manifest parser + validator | Pending |
| 3 | File-protocol scaffolding | Pending |
| 4 | Session spawner (Node.js) | Pending |
| 4.5 | SessionStart hook + agency launcher spike | Pending |
| 5 | SessionStart hook for prompt injection | Pending |
| 6 | Protocol header + prompt templates | Pending |
| 7 | Template-based prompt generator | Pending |
| 8 | Health checker (PID + timeout + heartbeat) | Pending |
| 11 | Main orchestrator (Node.js process, `/orchestrate` skill) | Pending |
| 9, 10, 12 | Recovery analyst, email, `--init` | V1.5 (deferred) |

Full plan: [`../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`](../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md).

## Try it now (prototype)

The prototype proves the core loop works. It has real functionality — it
spawns Claude sessions, polls for completion signals, and advances phases
sequentially. It's intentionally dumb about prompt injection, recovery, and
review loops; those arrive with later units.

```powershell
cd C:\path\to\agent-orchestration\agent-orchestrator\prototype
npm install
node orchestrate-prototype.js manifest-example.yaml
```

Details, CLI flags, and a no-Claude smoke test: [`prototype/README.md`](./prototype/README.md).

## Architecture (once V1 ships)

```
User ── /orchestrate ──► Claude Code session (thin skill entry point)
                         │
                         └─► spawns ──► orchestrate.js (stateless Node process)
                                        │
                                        ├─► reads manifest.yaml + manifest-status.yaml every 2m
                                        ├─► generates prompts via generate-prompt.js (templates)
                                        ├─► spawns Claude sessions via wt + SessionStart hook
                                        ├─► polls docs/orchestration/ for completion signals
                                        ├─► tracks PIDs + timeouts for crash detection
                                        └─► writes runtime state to manifest-status.yaml
```

The orchestrator runs as an **external Node.js process**, not inside a
Claude session. This keeps the context window clean — the orchestrator
re-reads all state from disk each tick, accumulating nothing. It only calls
`claude -p` for operations that genuinely need LLM reasoning (V1 uses no
LLM in the main loop).

## Prerequisites

- Windows 11 with Windows Terminal on `PATH` (`where.exe wt`)
- Node.js ≥ 18 (tested on v22.22.2)
- Claude Code CLI, invoked directly or via a wrapper (this project supports
  Microsoft's `agency claude --enable-auto-mode` out of the box)

## Docs

- [`prototype/README.md`](./prototype/README.md) — prototype quick-start and CLI flags
- [`docs/manifest-reference.md`](./docs/manifest-reference.md) — every manifest field, type, default, and meaning
- [`../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`](../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md) — implementation plan, review findings, decisions

## Friction log from Unit 0

Notes captured while running the prototype against the first smoke test.
These inform Units 1–11 as they land.

- `npm install` must run from `agent-orchestrator\prototype\`, not repo
  root. Missing cwd surfaced as `ENOENT: package.json`. Documented in the
  prototype README.
- Windows Terminal clobbers `--title` because PowerShell and Claude emit
  OSC title escapes. Fixed by adding `--suppressApplicationTitle` to the
  `wt` command. Unit 4 should carry this forward.
- Spawned tabs stay open across phase advances by design (so you can
  inspect prior agents). This means a long run leaves N tabs around. Unit
  11 should consider optional auto-close after phase success, or at least
  a "close all completed" helper.
- The 30-second poll interval feels fine for smoke testing. Revisit if
  real phases produce signal files quickly — worst case, missing the
  signal by <30s adds negligible latency to a multi-hour build.
- The no-Claude smoke path (`New-Item -ItemType File -Path ... -Force`)
  proved very useful for iterating on the orchestrator without burning
  tokens. Keeping that affordance in Unit 11's real orchestrator is worth
  the effort.

## License

Internal project. Not yet published.
