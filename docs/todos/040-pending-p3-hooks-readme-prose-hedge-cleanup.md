---
status: pending
priority: p3
issue_id: "040"
tags: [code-review, post-pr-11, ce-review, hooks, simplicity, docs]
dependencies: []
---

# `hooks/README.md` Contract invariants — strip stale-on-arrival "added by 027" / "currently" prose hedges

PR #11 ce:review's code-simplicity-reviewer flagged that the new
`hooks/README.md` "Contract invariants" wording leaks implementation
history ("added by `docs/todos/027`") and a hedge ("currently
prose-enforced") into a contract block.

## Problem Statement

`agent-orchestrator/hooks/README.md:60-65`:

> The cross-module consistency between the two regexes is enforced
> by a node:test assertion in `../scripts/parse-manifest.test.js`
> (added by `docs/todos/027`); the templates/README.md row is
> currently prose-enforced.

Two cosmetic issues:

1. **"added by `docs/todos/027`"** — git archaeology embedded in a
   contract page. Once PR #11 lands, the historical-anchor parens
   become noise. A reader of the contract page does not need to
   know which todo introduced a given enforcement; they need to
   know **what is enforced and how**.
2. **"currently prose-enforced"** — the hedge is meaningful *only*
   if there's a roadmap to upgrade enforcement. If todo 038
   (fixture grep test) doesn't land, "currently" stays in the doc
   forever and reads like "we know this is weak but we haven't
   fixed it yet."

The simplicity reviewer's framing:

> "These are exactly the kind of prose-tightening V1-freeze tells
> us to defer. Naming it for the post-Unit-7 sweep, not blocking."

## Findings

PR #11 ce:review code-simplicity-reviewer P3:

> "`hooks/README.md:55-65` invariant description leaks 'added by
> 027' / 'currently prose-enforced' implementation history into
> the contract block... Once the PR lands, the 'added by 027'
> parenthetical and 'currently' hedge are stale-on-arrival.
> Future cleanup (not blocking): drop the parenthetical and
> 'currently' — they're git-archaeology noise on a contract page.
> Keep the load-bearing distinction (test-enforced vs
> prose-enforced)."

## Proposed Solutions

### Option A — Strip both hedges; keep the test-vs-prose distinction

Rewrite the bullet to:

> The cross-module consistency between the two regexes is enforced
> by a node:test assertion in `../scripts/parse-manifest.test.js`;
> the templates/README.md row is prose-enforced.

(Drops "added by `docs/todos/027`" and "currently".)

- **Pros:** Tightest contract prose. Drops 7 words. Reader of the
  contract page sees what they need to act on.
- **Cons:** Loses the historical pointer to todo 027 — but that
  pointer also exists in the lockstep test's source comment
  (`parse-manifest.test.js:638-641` cites `docs/todos/006 + 027`).
  Not a real loss.
- **Effort:** Trivial (1-line edit).
- **Risk:** None.

### Option B — Keep "currently"; drop only the parenthetical

If the project does intend to land todo 038 (Option A: fixture
grep test for templates/README.md), "currently" remains
forward-compatible. Keep it; drop only the git-archaeology
parenthetical.

- **Pros:** Preserves the "this will improve" signal.
- **Cons:** "Currently" reads as TODO-flavored prose if todo 038
  doesn't land. The contract page is not the right place for
  forward-compatible hedges; the todo is.
- **Effort:** Trivial.
- **Risk:** None.

### Option C — Defer indefinitely

Leave both hedges in. Acceptable per V1-freeze.

- **Pros:** Zero churn.
- **Cons:** Contract page reads like a changelog.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

**Triage: leave for post-Unit-7 doc cleanup PR.** Pure prose-polish,
explicitly deferred per V1-freeze. If a future PR is touching
`hooks/README.md` for unrelated work, fold Option A in
opportunistically (1-line edit). Don't dispatch a dedicated PR.

If todo 038 promotes to "ready" and lands a fixture grep test,
the bullet's wording will need to change anyway (drop "the
templates/README.md row is prose-enforced" entirely) — at that
point this todo collapses into the same edit.

## Technical Details

- Affected file: `agent-orchestrator/hooks/README.md` (Contract
  invariants section, lines 60-65).
- No code change.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: contract page does not contain "added by `docs/todos/027`" or "currently".
- [ ] If B: contract page does not contain "added by `docs/todos/027`".

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (code-simplicity-reviewer P3). Coord deferred per V1-freeze.

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 030 (closed by PR #11): the contract-invariants enumeration
  this prose lives in.
- Todo 038 (related): fixture grep test for templates/README.md ID
  class. If 038 lands, this todo collapses into the same edit.
