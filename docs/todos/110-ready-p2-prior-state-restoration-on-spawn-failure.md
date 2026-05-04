---
status: ready
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

### Option A — Shared rollback hook for executeSpawn failure (recommended)
- Add a try/catch wrapper around `executeSpawn` body. On any throw (spawnFn, runUpdate, flag-write), call a shared `rollbackSpawningMarker(phaseId, role, priorStatus)` helper that reverts the manifest-status `status` field from `'spawning'` to its prior value.
- Pros: clean; symmetric with todo 111's EFLAGTIMEOUT case; one rollback site to test. Effort: small. Risk: low.
- Bundle: this todo + 111 ship together with the shared hook.

### Option B — Reconciliation logic absorbs stranded markers
- Let stranded `'spawning'` eventually resolve via the existing reconciliation pass.
- Cons: adds an unnecessary retry-count increment for what is actually fresh-spawn-failed.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex round 1 of PR #22 to remove 096 from the bundling.** Shared rollback hook with todo 111 only. Bundle both in PR #23 cleanup wave. NOTE: todo 096 (runUpdate-throw → duplicate-spawn) is **explicitly NOT** in this bundle — that case requires the marker to be **left intact** (the spawn HAPPENED), not rolled back. See 096's revised RA. Two sites converge on this rollback hook (110's executeSpawn-throws + 111's EFLAGTIMEOUT).

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (`executeSpawn` body — pre-spawn marker write site + post-failure rollback hook; precise lines TBD — see PR #19 re-codex Round 2 emergent findings).
- Related: todo 090 (closed) — pre-spawn `'spawning'` marker introduced.
- Related: todo 111 (this batch) — EFLAGTIMEOUT rollback path.

## Acceptance Criteria

- [ ] executeSpawn throws (spawnFn / runUpdate / flag-write) → status reverts to prior (typically 'pending').
- [ ] Next tick: phase re-eligible for spawn (not stuck in 'spawning').
- [ ] Retry count NOT incremented on fresh-spawn-failure (this is not a recovery scenario).
- [ ] Shared `rollbackSpawningMarker` helper reused by todo 111 only (NOT 096 — 096 leaves the marker intact because the spawn launched successfully; rolling back there would orphan the live tab).
- [ ] Precise line number filled in this todo's Technical Details (was TBD).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 090 (P1 — SIGTERM during spawn window).
