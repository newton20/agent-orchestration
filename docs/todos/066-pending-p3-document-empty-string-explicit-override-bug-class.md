---
status: pending
priority: p3
issue_id: "066"
tags: [code-review, post-pr-13, ce-review, docs-solutions, institutional-knowledge]
dependencies: []
---

# `docs/solutions/` lacks an entry for the empty-string-explicit-override defect class

PR #13 ce:review's learnings-researcher flagged a documentation
gap: codex caught the same defect class three separate times in
PR #13 (rounds 6, 10, 13). Helper functions branching on `typeof x
=== 'string'` (without checking for `''`) treat an empty-string
default as an explicit pre-rendered value and skip the derive-from-
other-input fallback. The fix pattern is `typeof x === 'string' &&
x !== ''`. No solutions doc captures the class.

## Problem Statement

When a function accepts an optional override parameter alongside
inputs it can derive from, a common shape is:

```js
function render(opts) {
  const block = typeof opts.preRendered === 'string'
    ? opts.preRendered
    : deriveFrom(opts.rawInputs);
  return block;
}
```

If a caller passes `preRendered: ''`, the type check passes, the
function returns `''`, and the derive-from-other-input fallback
never runs. Common when `''` is the default param value or a
zero-state sentinel.

PR #13 hit this class three times:

1. **Round 6** — `qaPlaybookBlock` (architecturally related case
   — note that the warning channel can run independently of the
   override channel).
2. **Round 10** — `previousPhaseBriefing`.
3. **Round 13** — `planUnits`.

Fix pattern:

```js
const block = (typeof opts.preRendered === 'string' && opts.preRendered !== '')
  ? opts.preRendered
  : deriveFrom(opts.rawInputs);
```

Three hits in a single PR, no solutions doc. Future contributors
will re-discover it.

## Findings

PR #13 ce:review learnings-researcher:

> "Codex caught the same defect class three times in PR #13
> (rounds 6, 10, 13). Helper functions branching on `typeof x ===
> 'string'` (without checking for `''`) treat an empty-string
> default as an explicit pre-rendered value and skip the derive-
> from-other-input fallback. The fix pattern is `typeof x ===
> 'string' && x !== ''`. Three hits in one PR is a strong signal
> the class needs an institutional write-up."

## Proposed Solutions

### Option A — Author
`docs/solutions/logic-errors/empty-string-explicit-override-bug-class.md`

Create a new solution doc with sections:

- **Defect summary:** Helper functions that branch on `typeof x ===
  'string'` without checking for `''` treat empty-string defaults
  as explicit overrides, skipping derive-from-other-input
  fallbacks.
- **Why it happens:** Default param values share mutation across
  call sites; empty-string is a common zero-state sentinel; the
  type check is a one-liner that looks complete.
- **Three concrete examples from PR #13:**
  - `previousPhaseBriefing` (round 10) — the canonical case.
  - `qaPlaybookBlock` (round 6) — architecturally related; bonus
    tip that the warning channel can run independently of the
    override channel.
  - `planUnits` (round 13) — the third hit, reinforcing the
    pattern.
- **Fix pattern:** `typeof x === 'string' && x !== ''`.
- **Bonus tip:** When the override channel also drives a warning
  channel (e.g., "you supplied X but Y was empty"), the warning
  can run independently of the override decision — splitting them
  catches more drift.
- **References:** PR #13 codex round 6, 10, 13 commits.

- **Pros:** Institutionalizes a class hit 3x in one PR. Future
  helpers can be checked against the pattern. Sets precedent for
  `docs/solutions/logic-errors/` as a category. Pairs naturally
  with todo 065's solutions-doc proposal.
- **Cons:** Net new doc. Maintenance surface.
- **Effort:** Small (~1-2 hours; the three examples need careful
  framing).
- **Risk:** None.

### Option B — Defer

Ship the fixes in PR #13; let the comments in code defend.

- **Pros:** Zero churn beyond what PR #13 already did.
- **Cons:** Class re-discovered on the next helper-with-override.
  Three hits in one PR is the warning sign.
- **Effort:** Zero.
- **Risk:** Medium — class likely to hit again on Unit 11+.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- New file (Option A):
  `docs/solutions/logic-errors/empty-string-explicit-override-bug-class.md`
- Cross-reference from `agent-orchestrator/scripts/generate-prompt.js`
  inline comments at the three fix sites (round 6, 10, 13) — link
  out rather than re-explain.
- Pair with todo 065 (sibling solutions doc on JS replace special
  tokens) — same `docs/solutions/logic-errors/` directory.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: solution doc exists with summary, root cause, three
  examples, fix pattern, bonus tip.
- [ ] If A: each example links back to the corresponding codex
  round in PR #13 commit history.
- [ ] If A: fix pattern explicitly named (`typeof x === 'string'
  && x !== ''`).
- [ ] If A: warning-channel-vs-override-channel separation is
  documented as the bonus tip.
- [ ] If A: linked from inline comments at the three fix sites
  in `generate-prompt.js`.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (learnings-researcher). Coord triage pending.
- **2026-04-29 — corrected via codex round 2 on triage PR** —
  original Technical Details path nested the new solutions doc
  under `agent-orchestrator/docs/solutions/...`, but the
  repository's actual solutions tree is at repo-root
  `docs/solutions/` (sibling to `docs/todos/`). Following the
  original path would create a parallel wrong tree. Corrected to
  `docs/solutions/logic-errors/...`.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- PR #13 codex rounds 6, 10, 13 — see PR commit history for the
  three fix commits.
- Pairing: todo 065 — sibling `docs/solutions/logic-errors/`
  proposal for the JS replace-special-tokens defect class.
- `agent-orchestrator/scripts/generate-prompt.js` — three fix
  sites for `previousPhaseBriefing`, `qaPlaybookBlock`,
  `planUnits`.
