---
status: pending
priority: p3
issue_id: "064"
tags: [code-review, post-pr-13, ce-review, scripts, simplicity, indirection]
dependencies: []
---

# `EMPTY_STATE_PLACEHOLDERS` loop + `camelCaseKey` add indirection for 3 cases

PR #13 ce:review code-simplicity-reviewer flagged that the
empty-state placeholder application uses a constant + a helper +
a loop for what amounts to three explicit assignments. Inlining
saves ~5-7 LOC and eliminates `camelCaseKey` (a function used
exactly once).

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:128-132` defines:

```js
const EMPTY_STATE_PLACEHOLDERS = {
  PRIOR_PHASE_DIRS: '(no upstream dependencies)',
  COORD_BLOCK: '(no coord)',
  QA_BLOCK: '(no qa)',
};
```

Lines 638-646 apply the placeholders via a loop with the helper
`camelCaseKey()`:

```js
for (const [k, v] of Object.entries(EMPTY_STATE_PLACEHOLDERS)) {
  const optKey = camelCaseKey(k);
  if (!opts[optKey]) opts[optKey] = v;
}
```

Lines 651-653 define `camelCaseKey()`:

```js
function camelCaseKey(snakeUpper) {
  return snakeUpper.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
}
```

Three placeholders, one helper, one loop. Hardcoded form:

```js
if (!opts.priorPhaseDirs) opts.priorPhaseDirs = EMPTY_STATE_PLACEHOLDERS.PRIOR_PHASE_DIRS;
if (!opts.coordBlock) opts.coordBlock = EMPTY_STATE_PLACEHOLDERS.COORD_BLOCK;
if (!opts.qaBlock) opts.qaBlock = EMPTY_STATE_PLACEHOLDERS.QA_BLOCK;
```

Saves ~5-7 LOC, eliminates `camelCaseKey`, removes the implicit
SNAKE_CASE→camelCase coupling between the constant key and the
opt key.

The `EMPTY_STATE_PLACEHOLDERS` constant itself stays — it's
referenced by the lockstep test ensuring the README→behavior chain
holds.

## Findings

PR #13 ce:review code-simplicity-reviewer P3:

> "`EMPTY_STATE_PLACEHOLDERS` + the loop + `camelCaseKey` add
> indirection for 3 cases. Hardcoded form (3 explicit
> assignments referencing `EMPTY_STATE_PLACEHOLDERS.X`) saves ~5-7
> LOC and eliminates `camelCaseKey` (a function used exactly
> once). Keep the constant — it's referenced by the lockstep
> test. Inline the loop."

## Proposed Solutions

### Option A — Inline the assignments; delete `camelCaseKey`

1. Replace lines 638-646 with three explicit `if (!opts.X) opts.X
   = EMPTY_STATE_PLACEHOLDERS.X;` assignments.
2. Delete `camelCaseKey()` at lines 651-653.
3. Keep `EMPTY_STATE_PLACEHOLDERS` constant unchanged.

- **Pros:** Reduces LOC. Eliminates a one-use helper. Removes the
  implicit SNAKE_CASE→camelCase coupling. Lockstep test continues
  to anchor the constant.
- **Cons:** Adding a fourth placeholder later requires adding a
  fourth `if` line (vs the loop's zero-edit growth). For ≤5
  placeholders, this is the simpler shape.
- **Effort:** Trivial.
- **Risk:** Low — tests catch any missed assignment.

### Option B — Defer

The loop is functional; the helper is small. V1-freeze posture
leaves indirection in place.

- **Pros:** Zero churn.
- **Cons:** One-use helper persists; loop overhead for 3 cases.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected file:
  `agent-orchestrator/scripts/generate-prompt.js`
  - Lines 128-132: keep `EMPTY_STATE_PLACEHOLDERS` constant.
  - Lines 638-646: replace loop with explicit assignments.
  - Lines 651-653: delete `camelCaseKey()`.
- Lockstep test (in `generate-prompt.test.js`) referencing
  `EMPTY_STATE_PLACEHOLDERS` should remain green; it tests the
  constant, not the loop.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: three explicit assignments; loop and helper removed.
- [ ] If A: `EMPTY_STATE_PLACEHOLDERS` constant unchanged;
  lockstep test green.
- [ ] If A: full suite green; behavior identical for all three
  empty-state cases (verified by existing tests).

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (code-simplicity-reviewer P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:128-132`
- `agent-orchestrator/scripts/generate-prompt.js:638-646`
- `agent-orchestrator/scripts/generate-prompt.js:651-653`
- Lockstep test: `agent-orchestrator/scripts/generate-prompt.test.js`
  (search for `EMPTY_STATE_PLACEHOLDERS`).
