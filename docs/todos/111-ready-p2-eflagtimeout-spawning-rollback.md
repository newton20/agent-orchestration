---
status: ready
priority: p2
issue_id: "111"
tags: [unit-11, orchestrate, post-pr-19, re-codex-round-2, flag-consume, timeout, spawning-marker]
dependencies: ["099", "110"]
---

# orchestrate: EFLAGTIMEOUT 'spawning' rollback — flag-consume timeout leaves marker stranded

## Problem Statement

When the flag-consume loop times out (`EFLAGTIMEOUT`) on a phase whose
manifest-status is in `'spawning'` state (set by the pre-spawn marker
from todo 090), the orchestrator does not roll back the marker. The
next tick sees stale `'spawning'`. Symmetric with todo 110 — the
reconciliation pass can eventually classify it, but the symptom is the
same: extra retry-count increment for a state the spawn-path could
have rolled back cleanly.

Per the re-codex Round 2 finding, this case and the executeSpawn-
itself-throws case (todo 110) should be handled by the **same**
rollback mechanism: any spawn-path failure path rolls the
`'spawning'` marker back to its prior status before returning control
to the main loop. EFLAGTIMEOUT is the second-most-likely failure mode
after spawnFn-throws, so the rollback hook needs to fire from both
sites.

## Findings

- EFLAGTIMEOUT during a tick whose phase is in `'spawning'` state does not roll back the marker.
- Symmetric with todo 110 (executeSpawn-throws); coord lean is to handle both via a shared rollback hook.
- Surfaced by re-codex Round 2 of PR #19 — held off the P1 gate as P2 for the same reason as 110.

## Proposed Solutions

### Option A — Reuse todo 110's shared rollback hook (recommended)
- On EFLAGTIMEOUT during a phase in `'spawning'` state, call the same `rollbackSpawningMarker(phaseId, role, priorStatus)` helper introduced by todo 110.
- Pros: one rollback function; symmetric handling across spawn-path failures. Effort: trivial (one helper call). Risk: low.

### Option B — Defer until 110 lands; ship as a no-op until then
- Wait for 110's hook to exist; no separate work.
- Cons: 111 stays open as bookkeeping while 110 is in flight.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex round 8 to add 099 dependency.** Bundle with todo 110 (rollback hook) AND todo 099 (cross-tick poison-pill via out-of-band token binding) in PR #23 cleanup wave. The shared 110 hook IS the rollback implementation; this todo's site (EFLAGTIMEOUT branch) calls it. **Critical sequencing:** 099 MUST land before or alongside 111 — otherwise EFLAGTIMEOUT-then-rollback re-makes the role eligible for the next tick's spawn, but the orphan tab from the timed-out spawn is still alive. Without 099's token binding, the next tick's fresh `.pending-*` flag is consumable by that orphan, restoring the cross-tick wrong-prompt-to-wrong-agent bug. With 099 in place, the orphan's argv-token can't match the new flag's file-token, so the orphan's hook filters the fresh flag out → safe to roll back and re-dispatch.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (EFLAGTIMEOUT handling site within the spawn / flag-consume path; precise lines TBD — see PR #19 re-codex Round 2 emergent findings).
- Related: todo 090 (closed) — pre-spawn `'spawning'` marker introduced.
- Related: todo 110 (this batch) — prior-state restoration on spawn failure (sibling rollback site).
- Related: todo 099 (P2) — EFLAGTIMEOUT poison-pill cross-tick semantic; same call-site cluster.

## Acceptance Criteria

- [ ] EFLAGTIMEOUT during 'spawning' state → status rolled back via shared `rollbackSpawningMarker` from todo 110.
- [ ] Next tick re-dispatches if conditions met.
- [ ] No retry-count increment (fresh-spawn failure, not recovery).
- [ ] **099's token-binding is in place** before 111's rollback enables re-dispatch. Test: EFLAGTIMEOUT, rollback to pending, next tick writes fresh `.pending-*` with NEW token. The orphan tab from the timed-out spawn (with its OLD argv-token) cannot consume the fresh flag (099's pre-rename token filter rejects it).
- [ ] Cross-reference: 099 (cross-tick token binding) and 111 (marker rollback) land in the same dispatch — closing 111 without 099 re-introduces the cross-tick wrong-prompt bug.
- [ ] Precise line number filled in this todo's Technical Details (was TBD).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 090 (P1 — SIGTERM during spawn window).
- Related pending todo: 099 (P2 — EFLAGTIMEOUT poison-pill intra-tick only).
