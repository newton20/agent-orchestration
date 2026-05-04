---
status: complete
priority: p1
issue_id: "090"
tags: [unit-11, orchestrate, recovery, resume, signal-handling, post-pr-19, ce-review]
dependencies: []
---

# orchestrate: SIGTERM during spawn→runUpdate window strands tab; --resume re-spawns duplicate

## Problem Statement

Between `spawnFn` returning at `orchestrate.js:2371-2519` (the Claude tab is now running) and the subsequent `runUpdate` call that persists `pid` + `started_at` to manifest-status, there is a brief window where SIGTERM / Ctrl+C / orchestrator crash kills the orchestrator while the spawned tab keeps running. Without persisted state, `--resume` doesn't see `status: running` for that role and re-spawns a duplicate session — wrong-prompt-to-wrong-agent + double resource use + orphaned heartbeat racing.

## Findings

1. `executeSpawn` at `orchestrate.js:2371-2519` — `spawnFn` is called BEFORE any state is persisted.
2. The window is bounded by Node.js await-resume latency between `spawnFn` resolution and `runUpdate` execution — typically 1-10ms, but stretches under load and during signal handling.
3. `--resume` decision logic (`orchestrate.js:1033-1180` area) checks `status: running` to decide whether to re-spawn; if status is still `pending` at resume time, the role gets dispatched again.
4. Codex round 17 P1 fix already addressed the related "spawn fails → matching persist is skipped" case at `orchestrate.js:1670-1690`; the remaining SIGTERM-during-success-window is uncovered.

## Proposed Solutions

*Option A (recommended) — pre-spawn `spawning` marker*: persist a `status: 'spawning'` marker (or a `.dispatched-<sessionName>` sentinel file in the protocol dir) BEFORE `spawnFn` is called. On `--resume`, treat `spawning` phases as recoverable and reconcile against the live PID snapshot before deciding spawn vs noop.
- Pros: closes the window deterministically. Effort: small. Touch is at executeSpawn entry/exit + resume-path reconciliation.
- Cons: adds a transient state to the manifest-status state machine (currently: pending / running / completed / failed / blocked).

*Option B — atomic spawn+persist via spawn-session changes*: refactor spawn-session to take a "post-spawn hook" that runs synchronously after the wt tab is launched but before `spawnSession` returns; the orchestrator persists in the hook.
- Pros: no new state. Effort: medium-large (touches spawn-session). Risk: medium (cross-module).
- Cons: reaches into spawn-session for an orchestrator concern.

## Recommended Action

_Pending triage._ Coord lean: Option A.

## Technical Details

- `agent-orchestrator/scripts/orchestrate.js:2371-2519` — executeSpawn.
- `agent-orchestrator/scripts/orchestrate.js:2624-2647` — resume entry point.
- `agent-orchestrator/scripts/orchestrate.js:1033-1180` — pollAllPhases status interpretation.

## Acceptance Criteria

- [ ] Test: `_spawnSession` records dispatch, then orchestrator is signal-killed mid-tick (simulated by injecting a throw between spawn and persist). Restart with `--resume`. Assert no duplicate spawn for the same `(phase, role)`.
- [ ] Test: `--resume` over a manifest-status with `status: 'spawning'` and no live PID → orchestrator treats as crashed and recovers (retry_count incremented).

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `09dd710` (initial /ce:review round 1 — P1s 088-092 closed).

**Resolution:** Pre-spawn `status: 'spawning'` marker persisted in `executeSpawn` before `spawnFn` is called. `decideTickActions` reconciliation pass added to interpret `spawning` markers on `--resume`: live-PID match → promote to `running`; no live PID → treat as crashed and recover (retry_count incremented). Closes the SIGTERM-during-spawn-window class.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Adversarial reviewer: adv-1.
