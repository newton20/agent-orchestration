---
status: ready
priority: p2
issue_id: "096"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, executespawn, runupdate, related-088-093]
dependencies: ["088", "093"]
---

# orchestrate: runUpdate throw inside executeSpawn → duplicate spawn next tick (related to 088 / 093 cluster)

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2511`, `executeSpawn`'s post-spawn `runUpdateFn` call can throw (manifest-status FS error, validation failure, etc.). When it throws after `spawnFn` has already launched the wt tab, the orchestrator never persists `pid` / `started_at` for the spawned session. On the next tick, the role's status is still `pending` (or `spawning`, post-fix-090), so `decideTickActions` re-dispatches and a duplicate spawn fires. Related to the 088 / 093 cluster (atomic write + try-wrap closes the throw class), but worth a dedicated todo because the duplicate-spawn outcome is independently testable and may need its own guard even after 088 / 093 land.

## Findings

- runUpdate throw inside executeSpawn → duplicate spawn next tick.
- Related cluster: 088 (runOneTick uncaught throw) + 093 (runUpdate non-atomic write); landing those reduces but may not fully close this case if any non-FS exception path exists.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

### Option A — try/catch + rollback in executeSpawn (recommended; bundle with 110)
- Wrap the `runUpdateFn` call inside `executeSpawn` with try/catch. On throw, log + revert phase status to prior (typically 'pending') via the shared rollback hook from todo 110.
- Pros: closes the duplicate-spawn case independently of 088/093's atomic-write fix; symmetric with the spawn-failure rollback work in 110/111.
- Effort: small (one try/catch + reuse of the 110 rollback function).

### Option B — Rely on 088/093 atomic-write only
- Accept duplicate-spawn as residual risk; document.
- Pros: zero additional work. Cons: 088/093 only close FS-class throws; non-FS exceptions (validation drift, etc.) still cause duplicate spawn.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Bundle with todo 110 in the cleanup wave; share the rollback hook. Closes the duplicate-spawn outcome regardless of throw class.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2511`

## Acceptance Criteria

- [ ] Test: runUpdate throws after spawn → next tick does NOT re-spawn the same role.
- [ ] Phase status correctly rolled back to prior on throw.
- [ ] Shared rollback hook with todo 110 (DRY).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
