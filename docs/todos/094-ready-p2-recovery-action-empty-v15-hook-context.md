---
status: ready
priority: p2
issue_id: "094"
tags: [unit-11, orchestrate, post-pr-19, ce-review, recovery, v15-hook, diagnostic-context]
dependencies: []
---

# orchestrate: recovery action never populates priorPid / lastHeartbeatTimestamp / remainingWorkBlock / completedCheckpointsBlock — V1.5 hook surface ships empty diagnostic context

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1582`, the recovery-action builder leaves several diagnostic-context fields unpopulated: `priorPid`, `lastHeartbeatTimestamp`, `remainingWorkBlock`, and `completedCheckpointsBlock`. The V1.5 recovery-analyst hook surface is designed to consume those fields; shipping them empty means the hook receives no context with which to reason about the prior session. Cross-reviewer corroboration (maintainability + correctness) promoted this finding — both flagged the same gap from independent angles.

**Source-mapping note (post-codex round 9):** `manifest-status.yaml` does NOT have a top-level `completed_phases` field. Completed phase state lives in the `status.phases` map (where each phase entry's `status` is `'completed'`) and is also evidenced by completion-signal artifacts (`{role}-complete.md`, `qa-verdict.json`) on disk. The implementer should source `completedCheckpointsBlock` from those existing artifacts (iterate `status.phases` for `status: 'completed'` entries; optionally enrich with completion-signal frontmatter), NOT invent a new top-level `completed_phases` field.

## Findings

- Recovery action never populates `priorPid`, `lastHeartbeatTimestamp`, `remainingWorkBlock`, `completedCheckpointsBlock` — V1.5 hook surface ships empty diagnostic context.
- /ce:review reviewer attribution: maintainability + correctness (cross-promoted, anchor 75→100).

## Proposed Solutions

### Option A — Populate the 4 fields from existing data sources (recommended)
- `priorPid` from `manifest-status.yaml`'s per-role `pid` field at recovery-action build time.
- `lastHeartbeatTimestamp` from `heartbeat.jsonl` tail (already parsed by check-health; pass through).
- `remainingWorkBlock` from plan-units extraction filtered to non-completed unit IDs.
- `completedCheckpointsBlock` from completion-signal scan + iteration of `status.phases` entries with `status: 'completed'`. (NOT from a top-level `completed_phases` field — that field does not exist; codex round 9 caught the original RA's incorrect source citation.)
- Pros: data is already in scope at the build site; closes the V1.5 hook contract gap before Unit 9 lands. Effort: medium. Risk: low.

### Option B — Defer to V1.5 (Unit 9 owns when LLM step lands)
- Leave the 4 fields empty in V1; document as Unit 9 design responsibility.
- Pros: zero work now. Cons: V1 ships a hook with empty contract; Unit 9 implementer must add data sourcing AND the LLM call.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Populate all 4 fields at the recovery-action builder. Sources are already loaded at the call site (manifest-status, heartbeat, plan, completion-signal scan). When source data is absent (e.g., no heartbeat written yet), set explicit `null` rather than omitting the key. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1582`

## Acceptance Criteria

- [ ] Recovery action populates `priorPid`, `lastHeartbeatTimestamp`, `remainingWorkBlock`, `completedCheckpointsBlock` when source data is available.
- [ ] When source data is absent, fields are explicit `null` (not undefined / omitted).
- [ ] **Source: `completedCheckpointsBlock` is built by iterating `status.phases` entries with `status: 'completed'`** (and optionally enriching with completion-signal frontmatter from `{role}-complete.md` + `qa-verdict.json`). NOT from a top-level `completed_phases` field — that field does not exist in current manifest-status schema.
- [ ] Test: recovery action with full source data → all 4 fields populated.
- [ ] Test: recovery action with no heartbeat → `lastHeartbeatTimestamp: null`; other fields still populated.
- [ ] Test: recovery action when 2 phases have already completed → `completedCheckpointsBlock` reflects both, sourced from `status.phases` iteration.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
