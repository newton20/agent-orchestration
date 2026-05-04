---
status: pending
priority: p2
issue_id: "095"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, abort-signal, listener-leak]
dependencies: []
---

# orchestrate: AbortSignal listener leak in main loop — accumulates ~720 listeners over 24h idle

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2952`, the main loop registers `addEventListener('abort', …, {once:true})` on the AbortSignal each tick without removing previously registered listeners. `{once:true}` only auto-removes when the abort actually fires, not on tick rotation. Over 24h of idle polling (default tick cadence ~120s), ~720 listeners accumulate on the same signal — Node's MaxListenersExceededWarning fires at 11 by default, and the signal carries unbounded references to closed-over per-tick state.

## Findings

- AbortSignal listener leak in main loop: `addEventListener('abort', …, {once:true})` accumulates ~720 listeners over 24h idle.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2952`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
