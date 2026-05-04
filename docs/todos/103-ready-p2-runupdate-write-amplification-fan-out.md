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

### Option A — Extend _loadedManifest / _loadedStatus seams to runUpdate (recommended)
- Add the same opt-in injection seams from todo 086 to `runUpdate`. Tick-level cache: load once at tick start, pass through all runUpdate calls within the tick.
- Pros: symmetric with checkHealth's batching seams; per-tick load cost drops from O(2N) to O(2). Effort: medium (touches parse-manifest API surface). Risk: low.

### Option B — External caching layer
- Wrap runUpdate in a per-tick cache outside parse-manifest.
- Cons: parse-manifest stays naive; future callers re-introduce write amplification.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Extend the existing `_loadedManifest` / `_loadedStatus` seams to runUpdate. Symmetric with the batching contract Unit 11 already consumes for checkHealth. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1762, 2511`
- Related: todo 086 (Unit 11 batching seams).

## Acceptance Criteria

- [ ] Fan-out tick (N roles): manifest loaded once per tick, not 2N times.
- [ ] runUpdate accepts opt-in `_loadedManifest` / `_loadedStatus` pass-through.
- [ ] orchestrate.js exploits the seams in its tick body.
- [ ] Test: spy on `loadManifest` calls during a 5-role fan-out tick → call count is 1 (not 10).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
