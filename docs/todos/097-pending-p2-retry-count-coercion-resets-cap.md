---
status: pending
priority: p2
issue_id: "097"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, retry-count, type-coercion, recovery]
dependencies: []
---

# orchestrate: non-integer retry_count silently coerces to 0 — corrupt state grants 3 fresh retries beyond cap

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1562`, the retry-count read path silently coerces non-integer values to `0`. String-numeric `'2'` parses, but float `2.5` collapses to `2` (or `0`, depending on path), `null` collapses to `0`, and a corrupted manifest-status with `retry_count: "two"` similarly collapses. Once the value collapses, the retry cap (3 by spec) effectively grants 3 fresh retries on top of whatever has already happened — the corrupt-state path bypasses the convergence guard.

## Findings

- Non-integer retry_count silently coerces to 0 (string-numeric `'2'`, float `2.5`, null collapse) → corrupt state grants 3 fresh retries beyond cap.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1562`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
