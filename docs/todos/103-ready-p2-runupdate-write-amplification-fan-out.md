---
status: ready
priority: p2
issue_id: "103"
tags: [unit-11, orchestrate, post-pr-19, ce-review, performance, runupdate, write-amplification]
dependencies: []
---

# orchestrate: runUpdate write amplification — re-loads + re-validates manifest 2N times per fan-out tick

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1762, 2511`, each `runUpdate` call re-loads and re-validates `manifest.yaml` + `manifest-status.yaml` from disk. On a fan-out tick that updates N roles (mark_phase_running for each, post-spawn persist for each), this becomes 2N disk-loads + 2N validation passes per tick. Per todo 086, the existing `_loadedManifest` / `_loadedStatus` injection seams allow callers to pre-load and pass through; orchestrate.js doesn't yet exploit them inside the runUpdate path.

## Findings

- runUpdate write amplification: re-loads + re-validates manifest 2N times per fan-out tick.
- /ce:review reviewer attribution: performance.

## Proposed Solutions

### Option A — Extend _loadedManifest / _loadedStatus seams to runUpdate, with mutable shared instance contract (recommended)
- Add the same opt-in injection seams from todo 086 to `runUpdate`. Tick-level cache: load once at tick start, pass through all runUpdate calls within the tick.
- **Critical contract:** the cached `_loadedStatus` MUST be a SINGLE mutable instance shared across all runUpdate calls within the tick. Each runUpdate mutates the cached object in place and writes the updated YAML to disk. Subsequent runUpdates within the same tick read the latest in-memory state, NOT a snapshot. Without this contract, later writes start from the stale tick-start snapshot and overwrite earlier mutations from the same fan-out (losing `pid`, `started_at`, `review_stage`, retry-count updates from sibling roles in the same tick).
- The `_loadedManifest` cache is read-only (manifest.yaml does not mutate within a tick), so the same caveat does not apply there.
- Pros: symmetric with checkHealth's batching seams; per-tick load cost drops from O(2N) to O(2). Effort: medium (touches parse-manifest API surface). Risk: low if the mutable-shared-instance contract is implemented correctly; medium if it isn't.

### Option B — External caching layer with explicit reload-and-merge after each write
- Wrap runUpdate in a per-tick cache outside parse-manifest. After each write, the wrapper either reloads the freshly-written YAML or merges in the just-written delta.
- Cons: parse-manifest stays naive; future callers re-introduce write amplification. More wrapper bookkeeping than Option A; reload-after-write defeats the optimization.

### Option C — Defer; accept O(2N) per tick
- Document as known cost. Cons: codex performance reviewer flagged this as a real bottleneck for fan-out heavy phases.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex round 8 to add the mutable-shared-instance contract.** Extend the existing `_loadedManifest` / `_loadedStatus` seams to runUpdate. The implementer MUST implement `_loadedStatus` as a single mutable shared object across all runUpdates within a tick — testing must specifically verify that two runUpdates in the same tick (mark_phase_running for role A, post-spawn persist for role B) preserve each other's mutations. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1762, 2511`
- Related: todo 086 (Unit 11 batching seams).

## Acceptance Criteria

- [ ] Fan-out tick (N roles): manifest loaded once per tick, not 2N times.
- [ ] runUpdate accepts opt-in `_loadedManifest` / `_loadedStatus` pass-through.
- [ ] orchestrate.js exploits the seams in its tick body.
- [ ] Test: spy on `loadManifest` calls during a 5-role fan-out tick → call count is 1 (not 10).
- [ ] **Test: mutation preservation across cached runUpdates within a single tick.** Sequence: (a) tick start; (b) load `_loadedStatus`; (c) runUpdate(role-A, {pid: 1234}); (d) runUpdate(role-B, {started_at: ...}); (e) read final manifest-status.yaml from disk → BOTH role-A's pid AND role-B's started_at are present. If role-B's update started from the cached pre-(c) snapshot, role-A's pid would be lost — that test must FAIL the broken implementation.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
