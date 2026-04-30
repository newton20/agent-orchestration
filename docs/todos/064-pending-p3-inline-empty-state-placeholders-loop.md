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

`agent-orchestrator/scripts/generate-prompt.js:128-132` defines (the
ACTUAL constant — codex on triage caught the original triage's
example using invented names like `PRIOR_PHASE_DIRS`/`COORD_BLOCK`/
`QA_BLOCK` that do not exist in the source):

```js
const EMPTY_STATE_PLACEHOLDERS = Object.freeze({
  decisions_block: '(no decisions captured)',
  open_questions_block: '(no open questions)',
  warnings_block: '(no warnings)',
});
```

The keys are `snake_case` (matching the rendered `{{var}}` names in
the templates), not `SNAKE_UPPER`. The opts surface uses `camelCase`
(`decisionsBlock`, `openQuestionsBlock`, `warningsBlock`).

Lines 638-646 apply the placeholders via a loop with the helper
`camelCaseKey()` translating `decisions_block` → `decisionsBlock`:

```js
for (const [name, placeholder] of Object.entries(EMPTY_STATE_PLACEHOLDERS)) {
  const optsKey = camelCaseKey(name);
  const v = opts[optsKey];
  if (v === undefined || v === null || (typeof v === 'string' && v === '')) {
    ctx[name] = placeholder;
  } else {
    ctx[name] = String(v);
  }
}
```

Lines 651-653 define `camelCaseKey()`:

```js
function camelCaseKey(snake) {
  return snake.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}
```

Three placeholders, one helper, one loop. Hardcoded form:

```js
const decisions = opts.decisionsBlock;
ctx.decisions_block = (decisions == null || decisions === '')
  ? EMPTY_STATE_PLACEHOLDERS.decisions_block : String(decisions);
const openQ = opts.openQuestionsBlock;
ctx.open_questions_block = (openQ == null || openQ === '')
  ? EMPTY_STATE_PLACEHOLDERS.open_questions_block : String(openQ);
const warns = opts.warningsBlock;
ctx.warnings_block = (warns == null || warns === '')
  ? EMPTY_STATE_PLACEHOLDERS.warnings_block : String(warns);
```

Saves ~3-5 LOC, eliminates `camelCaseKey`, removes the implicit
snake_case→camelCase coupling between the constant key and the
opts key. The constant `EMPTY_STATE_PLACEHOLDERS` stays — it is
referenced by the lockstep test (`every real template parses + has
valid required/optional shape` style guard at
`generate-prompt.test.js`).

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

1. Replace lines 638-646 with three explicit assignments using the
   actual key names (`decisions_block`, `open_questions_block`,
   `warnings_block`) — see the "hardcoded form" example in the
   Problem Statement above for the exact shape.
2. Delete `camelCaseKey()` at lines 651-653.
3. Keep `EMPTY_STATE_PLACEHOLDERS` constant unchanged.

- **Pros:** Reduces LOC. Eliminates a one-use helper. Removes the
  implicit snake_case→camelCase coupling. Lockstep test continues
  to anchor the constant.
- **Cons:** Adding a fourth placeholder later requires adding a
  fourth assignment block (vs the loop's zero-edit growth). For
  ≤5 placeholders, this is the simpler shape.
- **Effort:** Trivial (~6 LOC delta after the rewrite).
- **Risk:** Low — existing tests for empty-state handling
  (`coord empty decisionsBlock renders "(no decisions captured)"`
  etc.) catch any missed assignment.

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
- **2026-04-29 — corrected via codex on triage PR** — original
  Problem Statement and Option A used invented placeholder names
  (`PRIOR_PHASE_DIRS`, `COORD_BLOCK`, `QA_BLOCK`) that do not
  exist in the actual `EMPTY_STATE_PLACEHOLDERS` constant. The
  real keys are `decisions_block`, `open_questions_block`, and
  `warnings_block` (snake_case to match rendered `{{var}}`
  names). Implementing the original sketch would have targeted
  nonexistent keys and missed the actual coord placeholders.
  Rewrote the Problem Statement with the actual constant
  contents and rewrote the hardcoded-form sketch to use real
  key names plus the proper non-empty check (matching the
  current loop's `(v === undefined || v === null || (typeof v
  === 'string' && v === ''))` shape).

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:128-132`
- `agent-orchestrator/scripts/generate-prompt.js:638-646`
- `agent-orchestrator/scripts/generate-prompt.js:651-653`
- Lockstep test: `agent-orchestrator/scripts/generate-prompt.test.js`
  (search for `EMPTY_STATE_PLACEHOLDERS`).
