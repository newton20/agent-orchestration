---
status: pending
priority: p2
issue_id: "098"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, convergence, startup-grace, tri-state]
dependencies: []
---

# orchestrate: tri-state convergence — startup_grace doesn't reset counter; flap pattern bypasses 'consecutive' semantic

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1353`, the tri-state convergence counter (per todo 071's contract: two consecutive `lookup_failed` past startup-grace = crash) does not reset the counter when a poll returns `startup_grace`. A flap pattern of `lookup_failed → startup_grace → lookup_failed` reaches counter = 2 even though the failures are not actually consecutive. The 'consecutive' semantic is silently violated; recoveries trigger one tick earlier than the contract specifies.

## Findings

- Tri-state convergence: `startup_grace` doesn't reset counter; flap pattern bypasses 'consecutive' semantic.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1353`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
