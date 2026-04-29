---
status: pending
priority: p3
issue_id: "065"
tags: [code-review, post-pr-13, ce-review, docs-solutions, institutional-knowledge]
dependencies: []
---

# `docs/solutions/` lacks an entry for the JS replace-special-tokens defect class

PR #13 ce:review's learnings-researcher flagged a documentation
gap: the function-form `String.prototype.replace(re, () => v ?? '')`
pattern was introduced in PR #6 (commit `9a1f927`) to defend
against `$&`/`$1`/`$$`/`$'`/`` $` ``/`$<name>` backreference
interpretation, and re-implemented in PR #13. The pattern lives in
`templates/README.md` "Interpolation contract" and inline code
comments — but no `docs/solutions/` entry institutionalizes the
lesson for future Node JS work.

## Problem Statement

When using `String.prototype.replace(pattern, replacement)` with a
**string** replacement, JavaScript interprets special tokens
(`$&`, `$1`-`$9`, `$$`, `$'`, `` $` ``, `$<name>`) as
backreferences to the match. If user-supplied content contains a
literal `$&`, the replacement silently corrupts.

The fix is the function-form replacement: `replace(pattern, () =>
value)`. Function results are **never** interpreted as
backreferences.

This defect class:

- Has been hit twice in this repo (PR #6 commit `9a1f927`, PR #13
  interpolation reimplementation).
- Affects any Node JS code interpolating user-controlled content
  via `replace()`.
- Has no `docs/solutions/` page summarizing it.
- Is referenced obliquely in `templates/README.md` "Interpolation
  contract" and in code comments, but no canonical write-up
  exists.

## Findings

PR #13 ce:review learnings-researcher:

> "PR #6 fix `9a1f927` introduced the function-form replace
> pattern. PR #13 re-implements it. The pattern is referenced in
> `templates/README.md` 'Interpolation contract' and in code
> comments, but there's no `docs/solutions/` entry
> institutionalizing the lesson. Future Node JS work in this repo
> (and beyond) would benefit from a one-pager on the defect class
> with a 5-line repro and a prevention pattern."

## Proposed Solutions

### Option A — Author `docs/solutions/logic-errors/javascript-string-replace-special-tokens.md`

Create a new solution doc with sections:

- **Defect summary:** What the bug is, in one paragraph.
- **Root cause:** JavaScript's `replace()` with a string
  replacement interprets `$`-prefixed special tokens as
  backreferences.
- **Reproduction:** A 5-line repro showing `$&` in user content
  corrupting the replacement output.
- **Prevention:** Use the function-form replacement: `replace(re,
  () => v ?? '')`. Function results are never interpreted as
  backreferences.
- **Linter rule:** If available (e.g., a custom ESLint rule),
  document it. Otherwise note that the function-form pattern is
  the convention.
- **References:** PR #6 commit `9a1f927`, PR #13 commit history,
  MDN's "Specifying a string as the replacement" and "Specifying
  a function as the replacement" sections.

- **Pros:** Institutionalizes a defect class hit twice. Future
  contributors find the canonical write-up before re-discovering
  it. Cross-references give context. Sets precedent for
  `docs/solutions/logic-errors/` as a category.
- **Cons:** Net new doc. Adds maintenance surface.
- **Effort:** Small (~1 hour to write a tight one-pager).
- **Risk:** None.

### Option B — Add a paragraph to an existing
`docs/solutions/integration-issues/` doc

Find the closest existing solution doc and append a paragraph
documenting the pattern. Lower ceremony than a net-new file.

- **Pros:** No new file. Smaller diff.
- **Cons:** Reduces discoverability. The defect class is
  fundamentally a logic error, not an integration issue —
  miscategorization confuses future readers.
- **Effort:** Trivial.
- **Risk:** Low (mild miscategorization).

### Option C — Defer

`templates/README.md` and code comments cover it. No formal
solutions doc.

- **Pros:** Zero churn.
- **Cons:** Defect class re-discovered on third hit. Pattern lives
  only in load-bearing comments + a section of a much larger doc.
- **Effort:** Zero.
- **Risk:** Low — but real on next reimplementation.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- New file (Option A):
  `agent-orchestrator/docs/solutions/logic-errors/javascript-string-replace-special-tokens.md`
- Cross-reference from
  `agent-orchestrator/templates/README.md` "Interpolation
  contract" section (link out to the new solutions doc).
- Cross-reference from `agent-orchestrator/scripts/generate-prompt.js`
  inline comment defending the function-form pattern.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: solution doc exists with all six sections.
- [ ] If A: includes a 5-line repro showing `$&` in user content
  corrupting a string replacement.
- [ ] If A: prevention section names function-form replace as the
  convention.
- [ ] If A: cross-references PR #6 commit `9a1f927` + PR #13.
- [ ] If A: linked from `templates/README.md` interpolation
  section.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (learnings-researcher). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- PR #6 commit:
  https://github.com/newton20/agent-orchestration/commit/9a1f927
- MDN: `String.prototype.replace()` —
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace
- `agent-orchestrator/templates/README.md` "Interpolation
  contract" section.
