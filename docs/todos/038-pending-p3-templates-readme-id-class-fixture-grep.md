---
status: pending
priority: p3
issue_id: "038"
tags: [code-review, post-pr-11, ce-review, templates, hooks, cross-module-coupling, test-coverage]
dependencies: []
---

# templates/README.md `phase_id` row is the prose-enforced 3rd ID-class site — close it with a fixture grep test

PR #11 closed todo 030 by adding a back-pointer in
`templates/README.md:122` (the `phase_id` row) and enumerating all
three ID-class sites in `hooks/README.md`'s "Contract invariants"
section. PR #11 ce:review's agent-native + architecture reviewers both
noted that this third site is now **prose-enforced** — explicitly
called out as the weak link in `hooks/README.md:60-65`:

> "the templates/README.md row is currently prose-enforced."

A future contributor renaming `[A-Za-z0-9._-]+` will get an
immediate CI failure for the regex pair (lockstep test from PR #11)
but silent drift on the templates README.

## Problem Statement

Three sites encode the ID character class `[A-Za-z0-9._-]+`:

1. `agent-orchestrator/scripts/parse-manifest.js:82` — `VALID_ID_RE`
2. `agent-orchestrator/hooks/session-start.js:34` — `FLAG_NAME_RE`
3. `agent-orchestrator/templates/README.md:122` — `phase_id` catalog row

PR #11 added a CI lockstep test for #1↔#2 (todo 027). Site #3 still
relies on a contributor reading either back-pointer (in the catalog
row itself, or the inventory in `hooks/README.md` Contract invariants).
A `git grep '[A-Za-z0-9._-]+'` would find all three sites today, but
nothing prevents site #3 from drifting when a contributor edits sites
#1+#2 and updates the regex lockstep test but forgets the prose
catalog.

## Findings

PR #11 ce:review:

- **Agent-native (P3-1):** "templates/README.md `phase_id` row is
  prose-only — explicitly noted in hooks/README.md as 'currently
  prose-enforced'. Future agent or human renaming
  `[A-Za-z0-9._-]+` gets a CI failure for the regex pair but silent
  drift on the templates README. Calibrated: this is exactly the
  third site that a `grep -F '[A-Za-z0-9._-]+'` lockstep test would
  catch trivially, but adding a fixture-grep test post-freeze is
  gold-plating. The disclosure in the prose ('currently
  prose-enforced') is the right V1 move..."
- **Architecture-strategist (implicit):** the existing Contract
  invariants enumeration is correct, but the "currently
  prose-enforced" hedge is an admission that the invariant has
  enforcement gaps.

## Proposed Solutions

### Option A — Derived-class fixture test in `scripts/parse-manifest.test.js`

Extend the lockstep test added by todo 027 with a second assertion
that **derives the expected character class from the live
`VALID_ID_RE`** and asserts `templates/README.md` contains exactly
that derived string. The derivation matters: a hard-coded literal
(`assert.ok(readme.includes('[A-Za-z0-9._-]+'))`) would silently
pass if a contributor changed both regexes to a new class and
updated the lockstep test but forgot the README — the literal
they're looking for is still in the README, so the test passes
while the drift went undetected. Deriving from the regex closes
this loop.

```js
test('templates/README.md `phase_id` row encodes the live VALID_ID_RE character class', () => {
  // VALID_ID_RE is exported and shaped as /^<class>$/
  // Strip the anchors to get the class as a literal string.
  const expectedClass = VALID_ID_RE.source.replace(/^\^|\$$/g, '');
  const readme = fs.readFileSync(
    path.resolve(__dirname, '..', 'templates', 'README.md'), 'utf8'
  );
  assert.ok(
    readme.includes(expectedClass),
    `templates/README.md must encode the live VALID_ID_RE class ` +
    `\`${expectedClass}\` verbatim. If you changed VALID_ID_RE, ` +
    `also update templates/README.md:122 — see hooks/README.md ` +
    `Contract invariants and docs/todos/006 / 030 / 038.`
  );
});
```

- **Pros:** Closes the prose-only gap with a ~10 LOC test. Catches
  the actual drift scenario this todo guards against (regex
  changed, README forgotten) — the hard-coded-literal form would
  silently pass on that exact failure mode. Same
  failure-message-cite-the-todo pattern as todo 027's lockstep
  test.
- **Cons:** The derivation `replace(/^\^|\$$/g, '')` assumes the
  live `VALID_ID_RE` is anchored exactly with `^...$`. If a future
  refactor unanchors the regex, the derivation breaks — but that
  refactor would itself be the right time to revisit the test
  shape.
- **Effort:** Trivial (~10 LOC).
- **Risk:** Low.

### Option B — Derive both regexes from a shared exported character-class string

The structural fix the original todo 006 enumerated as Option A:
extract a shared `ID_CHAR_CLASS = '[A-Za-z0-9._-]+'` constant,
build both regexes from it (`new RegExp('^' + ID_CHAR_CLASS + '$')`),
and have the lockstep test reduce to a tautology. Templates README
could include the constant via comment-time substitution at scaffold
build time, or stay prose-pinned.

- **Pros:** Single source of truth for the character class.
  Eliminates drift entirely.
- **Cons:** Restructures the original todo 006 decision (Option B
  was chosen over Option A for cold-start cost reasons). The
  templates README is hand-authored markdown; substitution adds
  scaffolding the surface doesn't currently have.
- **Effort:** Medium.
- **Risk:** Medium — touches the cross-module test-time vs runtime
  boundary that PR #11 was careful about.

### Option C — Defer indefinitely (V1-freeze)

Per the agent-native reviewer's "fixture-grep test post-freeze is
gold-plating" framing, accept the prose-enforced state and move on.
The disclosure in `hooks/README.md` ("currently prose-enforced") is
the documentation-side mitigation.

- **Pros:** Zero churn. Aligned with V1-freeze.
- **Cons:** The third site remains the weak link until something
  forces a redesign.
- **Effort:** Zero.
- **Risk:** Low — the only failure mode is a contributor missing
  the back-pointer, which the prose layout already mitigates.

## Recommended Action

**Triage: leave for post-Unit-7 doc cleanup PR.** Both reviewers
classified this as a P3 prose-polish-with-defense-in-depth concern.
Option A is cheap (~6 LOC, zero behavior risk) and is the natural
extension of todo 027's pattern; if a post-Unit-7 doc cleanup PR is
already touching `parse-manifest.test.js`, fold Option A in. Option
B is overengineering for V1. Option C is the V1-freeze default.

If neither cleanup PR materializes before Unit 11 dispatches, fold
Option A into the Unit 11 PR's test additions — Unit 11 will be
adding writer-side tests anyway, so a 6-line fixture grep is
cost-free at that point.

## Technical Details

- Affected file (Option A): `agent-orchestrator/scripts/parse-manifest.test.js`
- Or alternatively (Option A): a new sibling fixture-grep test file.
- No production code change.
- Test count delta: +1.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A or B: editing the regex character class without
  correspondingly updating `templates/README.md` causes a CI
  failure. Specifically: a test in which `VALID_ID_RE` is changed
  to a new class but the README still contains only the old class
  literal must FAIL — not silently pass on a hard-coded-literal
  grep.
- [ ] If A: the assertion DERIVES the expected class from
  `VALID_ID_RE.source` (e.g.
  `VALID_ID_RE.source.replace(/^\^|\$$/g, '')`) rather than
  hard-coding `[A-Za-z0-9._-]+` as a literal. Hard-coded-literal
  form is **NOT** acceptable as enforcement because it cannot
  detect the exact drift scenario this todo is meant to guard
  against.
- [ ] If A: failure message points back to the lockstep cluster
  documentation and tells the editor to update
  `templates/README.md:122`.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (agent-native + architecture). Coord deferred per V1-freeze.
- **2026-04-28 — corrected via codex on triage PR** — original
  Option A proposed a hard-coded literal grep
  (`readme.includes('[A-Za-z0-9._-]+')`). Codex correctly noted
  this would silently pass in the exact drift scenario this todo
  guards against: a contributor changing both regexes and the
  lockstep test to a new class but forgetting the README — the
  old literal is still present, so the literal-grep test passes
  while drift is undetected. Rewrote Option A to *derive* the
  expected class from `VALID_ID_RE.source` (stripping the `^...$`
  anchors) so the test fails when source and README diverge.
  Updated Acceptance Criteria to disallow the hard-coded-literal
  form.

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 027 (closed by PR #11): the regex-pair lockstep test that
  this todo extends to the documentation surface.
- Todo 030 (closed by PR #11): the back-pointer + Contract
  invariants enumeration that establishes templates/README.md as
  the third site.
- Todo 006 (closed): the original enforcement-pattern decision
  that picked Option B (mutually-pointing comments) over Option A
  (shared constant).
