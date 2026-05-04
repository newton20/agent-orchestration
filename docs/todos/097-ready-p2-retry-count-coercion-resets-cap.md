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

### Option A — Strict shape validation; over-budget hits the normal recovery-budget-exhausted path, not blocked (recommended)
- Validate `retry_count` via `Number.isInteger(parsed) && parsed >= 0`. Shape-malformed values (`'two'`, `2.5`, `-1`) → phase `status: blocked` with structured error.
- **`retry_count > MAX_RETRIES` is NOT corrupt** — it can be legitimate historical state (e.g., a prior run used `--max-recovery-retries 5` and the operator restarted under default `=3`). That value flows through normal validation as a well-formed integer; the budget comparison happens later inside `decideRecoveryAction`, which interprets "over budget" as "recovery exhausted, halt the phase" (per the existing recovery contract). Do NOT short-circuit it as `blocked` at validation time.
- **Distinguish absent field from explicit null:** if the `retry_count` key is absent from the YAML object (`!('retry_count' in status)`), default to 0 (legitimate fresh-spawn case). If the key is present with explicit `null`, treat as shape-corrupt and block; do NOT silently coerce.
- Pros: corrupt SHAPE state surfaces explicitly; legitimate over-budget historical state flows through the documented recovery-budget-exhausted path; bypasses no longer possible. Effort: small. Risk: low.

### Option B — Silent coercion (current); document
- Accept the foot-gun; document the coercion rules.
- Cons: corrupt state grants up to 3 extra retries beyond cap.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Strict integer validation. Corrupt retry_count is operator-visible state, not a silent default. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1562`

## Acceptance Criteria

- [ ] `retry_count: "two"` → status: blocked at validation (shape-corrupt); structured error mentions field name + observed value.
- [ ] `retry_count: 2.5` → rejected at validation (shape-corrupt; not an integer).
- [ ] `retry_count: 2` → accepted at validation (existing behavior).
- [ ] `retry_count: -1` → rejected at validation (shape-corrupt; negative integer).
- [ ] **`retry_count: 5` when `MAX_RETRIES = 3`** → accepted at validation (well-formed integer); flows through to `decideRecoveryAction`, which detects over-budget and applies the existing recovery-budget-exhausted policy (halt phase). NOT blocked at validation.
- [ ] **Field absent from YAML** (key not present in the manifest-status object) → defaults to 0 (legitimate fresh-spawn case; NOT blocked).
- [ ] **Field present with explicit `retry_count: null`** → blocked (shape-corrupt). The validator must distinguish absence (`!('retry_count' in status)`) from explicit null (`status.retry_count === null`).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
