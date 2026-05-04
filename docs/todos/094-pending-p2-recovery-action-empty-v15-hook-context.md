---
status: pending
priority: p2
issue_id: "094"
tags: [unit-11, orchestrate, post-pr-19, ce-review, recovery, v15-hook, diagnostic-context]
dependencies: []
---

# orchestrate: recovery action never populates priorPid / lastHeartbeatTimestamp / remainingWorkBlock / completedCheckpointsBlock — V1.5 hook surface ships empty diagnostic context

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1582`, the recovery-action builder leaves several diagnostic-context fields unpopulated: `priorPid`, `lastHeartbeatTimestamp`, `remainingWorkBlock`, and `completedCheckpointsBlock`. The V1.5 recovery-analyst hook surface is designed to consume those fields; shipping them empty means the hook receives no context with which to reason about the prior session. Cross-reviewer corroboration (maintainability + correctness) promoted this finding — both flagged the same gap from independent angles.

## Findings

- Recovery action never populates `priorPid`, `lastHeartbeatTimestamp`, `remainingWorkBlock`, `completedCheckpointsBlock` — V1.5 hook surface ships empty diagnostic context.
- /ce:review reviewer attribution: maintainability + correctness (cross-promoted, anchor 75→100).

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1582`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
