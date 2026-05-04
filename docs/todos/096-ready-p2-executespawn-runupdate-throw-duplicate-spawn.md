---
status: ready
priority: p2
issue_id: "096"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, executespawn, runupdate, related-088-093]
dependencies: ["088", "093"]
---

# orchestrate: runUpdate throw inside executeSpawn → duplicate spawn next tick (related to 088 / 093 cluster)

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2511`, `executeSpawn`'s post-spawn `runUpdateFn` call can throw (manifest-status FS error, validation failure, etc.) AFTER `spawnFn` has already launched the wt tab. The orchestrator never persists `pid` / `started_at` for the (now live) session. Post-fix-090, the pre-spawn `status: 'spawning'` marker has already been written, so the next tick's `decideTickActions` reconciliation pass (orchestrate.js:1062-1106, added in PR #19 fix commit `09dd710`) is the natural recovery seam — it sees `'spawning'` + a live PID match and adopts the session without re-spawning.

The case here is **distinct from todo 110/111**: there the spawn never started, so the marker must be rolled back to `'pending'`. Here the spawn DID start, so the marker must be **left intact** so reconciliation can adopt the live session next tick. Sharing 110/111's `rollbackSpawningMarker` helper here would orphan the live tab and trigger duplicate dispatch — the opposite of the intended fix. Worth a dedicated todo so the leave-marker-intact rule is explicit and a future maintainer doesn't reflexively wire the rollback helper at this catch site.

## Findings

- runUpdate throw inside executeSpawn (post-spawnFn) leaves the spawned tab live with no persisted pid/started_at.
- Post-fix-090: the `'spawning'` marker is already written before `spawnFn`. On next tick, the reconciliation pass at orchestrate.js:1062-1106 detects `'spawning'` + live PID and adopts → transitions to `'running'`, persists pid lazily. No duplicate spawn IF the marker is left intact.
- Pre-fix-090 codepath (no marker): status would still be `pending` and `decideTickActions` would re-dispatch → duplicate spawn. Now obsolete on main but the original concern.
- Related cluster: 088 (runOneTick uncaught throw) + 093 (runUpdate non-atomic write) reduce throw frequency; they don't substitute for the explicit leave-marker-intact rule here.
- **Distinct from 110/111**: those rollback `'spawning'` → `'pending'` because spawn never happened. Here spawn HAPPENED, so we must NOT rollback.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

### Option A — try/catch with no-op on throw; LEAVE the spawning marker intact (recommended; do NOT share rollback with 110/111)
- Wrap the post-spawn `runUpdateFn` call inside `executeSpawn` with try/catch. On throw: log the error, BUT do NOT touch manifest-status. The pre-spawn `'spawning'` marker remains; next tick's reconciliation (orchestrate.js:1062-1106) adopts the live session and persists pid then.
- Explicitly distinct from todo 110/111: those rollback `'spawning'` → `'pending'` because the spawn never happened. Here the spawn HAPPENED, so we must NOT rollback — that would orphan the live tab and trigger duplicate dispatch.
- Pros: closes duplicate-spawn at one site; reuses 090's reconciliation seam (no new state machine); symmetrical-but-opposite with 110/111 (rollback vs leave-intact decided by whether the spawn launched).
- Effort: small (one try/catch + a clarifying comment that the marker is intentionally left intact).
- Risk: low.

### Option B — Rely on 088/093 atomic-write only
- Accept duplicate-spawn as residual risk; document.
- Pros: zero additional work. Cons: 088/093 only close FS-class throws; non-FS exceptions (validation drift, etc.) still throw, and without the explicit leave-marker-intact comment future maintainers may reflexively add a rollback that re-introduces the bug.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex round 1 to remove rollback-sharing with 110/111.** Bundle in PR #23 cleanup wave. The fix is **try/catch with no-op on throw** (leave the `'spawning'` marker; reconciliation adopts next tick). Implementer must NOT call the 110/111 `rollbackSpawningMarker` helper — that helper applies only when the spawn didn't launch. A code comment at the catch site should make this explicit so future maintainers don't "fix" the no-op by adding a rollback.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2511`

## Acceptance Criteria

- [ ] Test: runUpdate throws after `spawnFn` returned → orchestrator logs the error and does NOT touch manifest-status. The `'spawning'` marker remains.
- [ ] Test: next tick's `decideTickActions` reconciliation (orchestrate.js:1062-1106) sees `'spawning'` + live PID → transitions to `'running'`, persists pid. No duplicate spawn.
- [ ] Code comment at the catch site explains why the marker is intentionally left intact (distinguishes from 110/111 rollback path).
- [ ] No call to `rollbackSpawningMarker` (or any equivalent) on this code path.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
