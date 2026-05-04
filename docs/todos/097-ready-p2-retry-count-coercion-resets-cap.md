---
status: ready
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

### Option A — Strict integer validation; reject corrupt as blocked (recommended)
- Validate `retry_count` via `Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_RETRIES`.
- Corrupt state (`'two'`, `2.5`, `null`, `-1`, `> MAX_RETRIES`) → set phase `status: blocked` with structured error; do NOT silently coerce.
- Pros: corrupt state surfaces explicitly; bypasses no longer possible. Effort: small. Risk: low.

### Option B — Silent coercion (current); document
- Accept the foot-gun; document the coercion rules.
- Cons: corrupt state grants up to 3 extra retries beyond cap.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Strict integer validation. Corrupt retry_count is operator-visible state, not a silent default. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1562`

## Acceptance Criteria

- [ ] `retry_count: "two"` → status: blocked; structured error mentions field name + observed value.
- [ ] `retry_count: 2.5` → rejected (float).
- [ ] `retry_count: 2` → accepted (existing behavior).
- [ ] `retry_count: -1` or `> MAX_RETRIES` → rejected.
- [ ] `retry_count: null` (missing field) → defaults to 0 (NOT blocked — this is the legitimate fresh-spawn case).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
