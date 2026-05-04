---
status: ready
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

### Option A — Register listener once outside the loop (recommended)
- Move `signal.addEventListener('abort', handler, {once:true})` to a one-time registration at orchestrator start; the handler invokes a closure-captured per-tick action via a shared mutable reference.
- Pros: one listener total across the lifetime of the orchestrator. Effort: small. Risk: low.

### Option B — AbortController per tick
- Create a fresh AbortController + signal at tick start; explicitly abort/dispose at tick end.
- Pros: clean per-tick lifecycle. Cons: more allocation; signal hand-off to children that span ticks needs care.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Single listener registered at orchestrator start; per-tick state is captured by a closure variable the listener reads. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2952`

## Acceptance Criteria

- [ ] Listener count on the AbortSignal stays at 1 across N ticks.
- [ ] Test: simulate 100 ticks → no MaxListenersExceededWarning fires.
- [ ] Graceful shutdown removes the listener.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
