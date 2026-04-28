---
status: pending
priority: p3
issue_id: "041"
tags: [code-review, post-pr-11, ce-review, scripts, simplicity, test-coverage]
dependencies: []
---

# Lockstep test's `.source.slice(1)` regex composition is clever-not-obvious

PR #11 closed todo 027 by adding a node:test assertion that pins
`FLAG_NAME_RE.source === '^\\.pending-' + VALID_ID_RE.source.slice(1)`.
PR #11 ce:review's code-simplicity-reviewer noted the assertion is
correct but requires the reader to trace the regex composition in
their head.

## Problem Statement

`agent-orchestrator/scripts/parse-manifest.test.js:644-650`:

```js
assert.strictEqual(
  FLAG_NAME_RE.source,
  '^\\.pending-' + VALID_ID_RE.source.slice(1),
  'FLAG_NAME_RE.source must be "^\\.pending-" prepended to VALID_ID_RE.source ' +
    '(minus its leading ^). Update both regexes together — see ' +
    'docs/todos/006 / 027 and hooks/README.md Contract invariants.'
);
```

The `.source.slice(1)` strips the leading `^` from `VALID_ID_RE.source`
(which is `'^[A-Za-z0-9._-]+$'`) so it can be reglued onto `'^\\.pending-'`,
yielding `'^\\.pending-[A-Za-z0-9._-]+$'` which equals `FLAG_NAME_RE.source`.

A reader has to:
1. Know `.source` returns the regex pattern as a string.
2. Notice the `.slice(1)` is dropping the `^`.
3. Reconstruct what `'^\\.pending-' + that` produces.
4. Mentally compare to `FLAG_NAME_RE.source`.

The error message is excellent and walks the reader through it, but
the assertion itself reads as a riddle on first scan.

## Findings

PR #11 ce:review code-simplicity-reviewer P3:

> "`parse-manifest.test.js:644-650` regex composition is
> clever-not-obvious. The `.source.slice(1)` strips the leading
> `^` from `VALID_ID_RE.source` so it can be reglued onto
> `'^\\.pending-'`. Correct, but a reader has to trace this in
> their head. An alternative is to pin the shared character class
> as an exported string and have both regexes derive from it (the
> canonical solution to the duplication). That's the docs/todos/006
> enforcement-pattern decision and out of scope here. Within
> current scope: the test as-written is acceptable."

## Proposed Solutions

### Option A — Extract the inner character class via regex match

Instead of slice arithmetic, use a regex to pull out the
character-class portion of each `.source` and compare those:

```js
const CLASS_RE = /\[[^\]]+\]\+/;
const validClass = VALID_ID_RE.source.match(CLASS_RE)?.[0];
const flagClass = FLAG_NAME_RE.source.match(CLASS_RE)?.[0];
assert.ok(validClass, 'VALID_ID_RE source must contain a [...]+ character class');
assert.strictEqual(validClass, flagClass);
```

- **Pros:** No string-arithmetic riddle. Pattern reviewer reads as
  "extract the class, compare classes."
- **Cons:** ~6 LOC vs current 2 LOC. Adds a meta-regex (`/\[[^\]]+\]\+/`)
  that itself encodes assumptions about the regex shape. If a future
  regex uses `+?` or `*` instead of `+`, the meta-regex breaks
  silently. Trades one cleverness for another.
- **Effort:** Small.
- **Risk:** Low (catches the same drift; meta-regex is straightforward).

### Option B — Inline a comment explaining the slice

Keep the current 2-LOC assertion; add a 1-line comment above
documenting what `.slice(1)` does:

```js
// Strip the leading ^ from VALID_ID_RE.source so it concatenates
// cleanly onto the FLAG_NAME_RE prefix.
assert.strictEqual(
  FLAG_NAME_RE.source,
  '^\\.pending-' + VALID_ID_RE.source.slice(1),
  ...
);
```

- **Pros:** Trivial. Preserves the minimal assertion shape.
- **Cons:** Comment-as-documentation when the failure-message
  string already explains the same thing. Reader who hits a CI
  failure already gets the explanation; reader scanning the test
  pre-failure gets it from the comment. Minor net win.
- **Effort:** Trivial.
- **Risk:** None.

### Option C — Restructure both regexes from a shared character class

The structural fix: extract `const ID_CHAR_CLASS = '[A-Za-z0-9._-]+';`
to a shared module, then `const VALID_ID_RE = new RegExp('^' + ID_CHAR_CLASS + '$');`
and `const FLAG_NAME_RE = new RegExp('^\\.pending-' + ID_CHAR_CLASS + '$');`.
The lockstep test reduces to a tautology (or removes entirely).

This is exactly the Option A from todo 006 (closed) that was rejected
in favor of mutually-pointing prose comments due to cold-start
budget concerns. Re-litigating that decision is out of scope here.

- **Pros:** Eliminates the slice arithmetic entirely. Single source
  of truth.
- **Cons:** Reverses todo 006's enforcement-pattern decision.
  Touches the cross-module test-time vs runtime boundary. Possibly
  invalidates the lockstep test (which is exactly the load-bearing
  artifact PR #11 added).
- **Effort:** Medium.
- **Risk:** Medium — restructures a decision the project already
  reasoned through.

### Option D — Defer indefinitely

The simplicity reviewer's verdict was "the test as-written is
acceptable." Per V1-freeze, leave it.

- **Pros:** Zero churn.
- **Cons:** Future readers continue to trace `.slice(1)` mentally.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

**Triage: leave for post-Unit-7 doc cleanup PR (Option B if any).**
The simplicity reviewer explicitly classified this as
acceptable-as-written. Option A trades string arithmetic for
meta-regex magic — not obviously better. Option C reverses a closed
decision. If a post-Unit-7 cleanup PR is touching this test for
unrelated work, fold Option B (1-line comment) in opportunistically.
Otherwise, defer.

## Technical Details

- Affected file (Option A or B):
  `agent-orchestrator/scripts/parse-manifest.test.js:644-650`
- No production code change.
- Test count unchanged.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: assertion uses character-class extraction; equivalent
  drift detection.
- [ ] If B: a comment explains the `.slice(1)` operation.
- [ ] Tests still 158 green.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (code-simplicity-reviewer P3). Coord deferred per V1-freeze.

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 027 (closed by PR #11): the lockstep test this todo
  refines.
- Todo 006 (closed): the enforcement-pattern decision that
  rejected the shared-character-class restructure (Option C
  here).
