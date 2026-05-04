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
SIGTERM-during-spawn-window class. **However**: when the spawn-launch
path fails BEFORE `spawnFn` successfully returns (spawn-session throws
the wt tab launch failure, the pre-spawn flag-write fails, etc.), the
marker has already been written and the spawn never produced a live
process. The marker stays as `'spawning'` despite no live process having
been launched.

On the next tick, the reconciliation pass finds:
- no live PID for `(phase, role)` in the snapshot
- manifest-status `status: 'spawning'`

This is the **ambiguous state**: did the orchestrator crash mid-spawn
(treat as crashed → recover), or did the spawn itself fail (treat
as never-spawned → re-dispatch)? Without a rollback hook, the marker
remains until reconciliation eventually classifies it as crashed —
but that path adds an unnecessary retry-count increment for what is
actually a fresh-spawn failure.

The fix is **scoped to spawn-launch-path failures only** — it is
symmetric with todo 111 (EFLAGTIMEOUT during the flag-consume window).
It explicitly does **NOT** cover the post-spawn `runUpdate` throw
case in todo 096, where `spawnFn` has already returned successfully
and the wt tab is live: rolling the marker back there would orphan
the live tab and trigger duplicate dispatch on the next tick. See
todo 096's revised RA for the leave-marker-intact rule that applies
to that distinct path.

## Findings

- Pre-spawnFn-launch failure (spawnFn-throws-before-launch, pre-spawn flag-write throws) leaves `status: 'spawning'` marker stranded; reconciliation can't distinguish fresh-spawn-failed from orchestrator-crashed-mid-spawn without expensive heuristics.
- Surfaced by re-codex Round 2 of PR #19 — held off the P1 gate as P2 because the existing reconciliation eventually classifies the stranded marker (just with a wasted retry).
- **Scope:** this todo covers ONLY the cases where the spawn never produced a live tab (spawnFn-throws-before-launch, pre-spawn flag-write throws). The orphan tab from those failures does not exist, so rolling the marker back to `'pending'` is safe — there's no orphan to consume the next-tick fresh flag.
- **EFLAGTIMEOUT is OUT OF 110's scope:** that case lands in todo 111 because the orphan tab IS alive and rolling back to `'pending'` without 099's token-binding restores the cross-tick wrong-prompt bug. 111 carries the 099 dependency precisely for that reason.
- **Scope exclusion:** post-spawn `runUpdate`-throws (todo 096) are NOT in this case — those happen after `spawnFn` returned successfully, so the marker must be left intact for reconciliation to adopt the live session. See 096.

## Proposed Solutions

### Option A — Shared rollback hook for pre-spawnFn-launch failures only (recommended)
- Add a try/catch wrapper around the **pre-spawnFn-launch** portion of `executeSpawn`. On a throw from `spawnFn` itself (before it returns) or from a flag-write that runs before `spawnFn`, call a shared `rollbackSpawningMarker(phaseId, role, priorStatus)` helper that reverts the manifest-status `status` field from `'spawning'` to its prior value.
- **Explicitly excludes EFLAGTIMEOUT from 110's call sites.** EFLAGTIMEOUT happens AFTER `spawnFn` has already launched a tab (the wt tab is alive; only the consume-side flag never disappeared in time). Rolling back at that point makes the next tick eligible to write a fresh `.pending-*` while the orphan tab is still alive — re-introducing the cross-tick wrong-prompt bug. EFLAGTIMEOUT lands in 111 only, which carries the 099 dependency for the cross-tick token binding.
- **Explicitly excludes** the post-spawn `runUpdate`-throw case (todo 096): when `spawnFn` already returned successfully (the wt tab is live) and a subsequent `runUpdate` throws, the marker must be **left intact** so the next tick's reconciliation can adopt the live session. Adding the rollback there would orphan the live tab and trigger duplicate dispatch — exactly the bug 096 warns against.
- Pros: clean; one rollback site to test; safe to land WITHOUT 099 because the cases in 110's scope don't leave a live orphan tab. Effort: small. Risk: low.
- Bundle: this todo (110) introduces the helper. 111 calls it from the EFLAGTIMEOUT branch and additionally depends on 099. 096 explicitly does NOT call it.

### Option B — Reconciliation logic absorbs stranded markers
- Let stranded `'spawning'` eventually resolve via the existing reconciliation pass.
- Cons: adds an unnecessary retry-count increment for what is actually fresh-spawn-failed.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex rounds 1+10 to scope the rollback to pre-spawnFn-launch failures only.** Bundle in PR #23 cleanup wave. Three explicit scope decisions:

1. **EFLAGTIMEOUT moves to 111 only** — 110's helper is callable from there, but the call site itself (with the 099 cross-tick token check as a prerequisite) lives in 111.
2. **post-spawn `runUpdate`-throws (todo 096) do NOT call this helper** — leave-marker-intact rule applies (the spawn launched).
3. **110 has no 099 dependency** because none of the cases in 110's scope leaves a live orphan tab; the rollback is safe to apply standalone for the pre-spawnFn-launch failure paths.

110 introduces the `rollbackSpawningMarker` helper and calls it from the pre-spawnFn-launch try/catch site. 111 calls the same helper from the EFLAGTIMEOUT site (paired with 099's token binding). 096 calls neither.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (`executeSpawn` body — pre-spawn marker write site + post-failure rollback hook; precise lines TBD — see PR #19 re-codex Round 2 emergent findings).
- Related: todo 090 (closed) — pre-spawn `'spawning'` marker introduced.
- Related: todo 111 (this batch) — EFLAGTIMEOUT rollback path.

## Acceptance Criteria

- [ ] executeSpawn throws on the **pre-spawnFn-launch path** (spawnFn-throws-before-launch, pre-spawn flag-write throws) → status reverts to prior (typically `'pending'`) via `rollbackSpawningMarker`.
- [ ] **EFLAGTIMEOUT does NOT call rollbackSpawningMarker from this todo's call sites.** EFLAGTIMEOUT is 111's call site (with 099 dependency). The test must verify 110-only landing does NOT roll back EFLAGTIMEOUT cases — those cases stay stranded until 111+099 land together.
- [ ] **Post-spawn `runUpdate` throw (todo 096) does NOT call rollbackSpawningMarker** — the test must verify the marker remains `'spawning'` after such a throw, so reconciliation can adopt the live tab on the next tick.
- [ ] Next tick: phase re-eligible for spawn (not stuck in `'spawning'`) when the spawn never launched (110's scope).
- [ ] Retry count NOT incremented on fresh-spawn-failure (this is not a recovery scenario).
- [ ] Shared `rollbackSpawningMarker` helper reused by todo 111 only (NOT 096 — see Option A note).
- [ ] Precise line number filled in this todo's Technical Details (was TBD).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 090 (P1 — SIGTERM during spawn window).
