---
status: pending
priority: p2
issue_id: "110"
tags: [unit-11, orchestrate, post-pr-19, re-codex-round-2, recovery, spawn-failure, spawning-marker]
dependencies: []
---

# orchestrate: prior-state restoration on spawn failure — `spawning` marker stays set when executeSpawn fails

## Problem Statement

PR #19's fix for P1 todo 090 added a pre-spawn `status: 'spawning'`
marker before `executeSpawn` calls `spawnFn`. This closes the
SIGTERM-during-spawn-window class. **However**: when `executeSpawn`
itself fails (e.g., spawn-session throws, the wt tab launch fails, the
flag-write fails), the marker has already been written and the
spawn never completed. The marker stays as `'spawning'` despite no live
process having been launched.

On the next tick, the reconciliation pass finds:
- no live PID for `(phase, role)` in the snapshot
- manifest-status `status: 'spawning'`

This is the **ambiguous state**: did the orchestrator crash mid-spawn
(treat as crashed → recover), or did the spawn itself fail (treat
as never-spawned → re-dispatch)? Without a rollback hook, the marker
remains until reconciliation eventually classifies it as crashed —
but that path adds an unnecessary retry-count increment for what is
actually a fresh-spawn failure.

The fix is symmetric with todo 111: any spawn-path failure (executeSpawn
throws, EFLAGTIMEOUT, etc.) should roll the marker back to its prior
status (typically `pending`).

## Findings

- `executeSpawn` failure leaves `status: 'spawning'` marker stranded; reconciliation can't distinguish fresh-spawn-failed from orchestrator-crashed-mid-spawn without expensive heuristics.
- Surfaced by re-codex Round 2 of PR #19 — held off the P1 gate as P2 because the existing reconciliation eventually classifies the stranded marker (just with a wasted retry).
- Symmetric with todo 111 (EFLAGTIMEOUT rollback path).

## Proposed Solutions

_(To be drafted during coord triage round; the re-codex Round 2 brief did not propose options.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (`executeSpawn` body — pre-spawn marker write site + post-failure rollback hook; precise lines TBD — see PR #19 re-codex Round 2 emergent findings).
- Related: todo 090 (closed) — pre-spawn `'spawning'` marker introduced.
- Related: todo 111 (this batch) — EFLAGTIMEOUT rollback path.

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 090 (P1 — SIGTERM during spawn window).
