---
status: pending
priority: p3
issue_id: "063"
tags: [code-review, post-pr-13, ce-review, scripts, simplicity, comment-density]
dependencies: []
---

# `generate-prompt.js` is heavy with "codex round N caught X" archaeology

PR #13 ce:review code-simplicity-reviewer flagged that
`generate-prompt.js` carries inline "codex round N caught X"
comments at many sites. The round numbers describe the defect that
produced the line; once a reader understands the invariant, the
round number is dead weight. Anyone wanting the original commit can
get it via `git blame`. The JSDoc header re-explains rationale that
already lives in templates/README.md.

## Problem Statement

Comment archaeology sites in
`agent-orchestrator/scripts/generate-prompt.js`:

- Lines 9-11, 64-84 — JSDoc header re-explains contract that lives
  in `templates/README.md`.
- Line 198 — "codex round 4 caught X."
- Lines 583-590 — multi-line round-by-round defense.
- Lines 716-724 — `outputDir`/`phaseDir` collapse rationale (this
  one is load-bearing — see todo 062).
- Lines 776-785 — round-numbered defense block.
- Lines 807-812 — ditto.
- Lines 925-928 — ditto.
- Line 993 — single-line round comment.

Round numbers are temporal markers that lose meaning once the PR
ships. The *invariants* they protect are load-bearing; the round
numbers themselves are not. Estimated savings if trimmed: ~15-25
LOC.

## Findings

PR #13 ce:review code-simplicity-reviewer P3:

> "Inline 'codex round N' comments are valuable during the PR but
> dead weight once shipped. The invariant (e.g., 'use function-form
> replace to defend against $&') is load-bearing; the round number
> is not — `git blame` recovers the commit if anyone needs the
> archaeology. Trim to single-line invariant statements and keep
> the genuinely load-bearing comments (charCount UTF-8 explanation,
> coerce-then-check defenses). Don't strip everything — V1-freeze
> values defenders. Strip the round numbers."

## Proposed Solutions

### Option A — Trim round numbers; keep invariant statements

Sweep `generate-prompt.js`. For each "codex round N caught X" site:

- If the comment encodes a load-bearing invariant (e.g., function-
  form replace defends against `$&`; coerce-then-check defends
  against type drift), keep the invariant text and strip the
  round number.
- If the comment is pure archaeology with no invariant payload,
  delete it. `git blame` recovers the commit.

Estimated savings: ~15-25 LOC.

- **Pros:** Reduces visual noise. Preserves all load-bearing
  defenders. Future readers see the invariant without the round-
  number distraction.
- **Cons:** Subjective line-by-line judgment. Mistakes risk
  removing a defender. Requires a careful pass.
- **Effort:** Medium (slow read-through).
- **Risk:** Medium — requires care to not delete a load-bearing
  comment.

### Option B — Trim round numbers but keep all comment text

Mechanical sweep: replace "codex round N caught" → "Defends:" or
similar, preserving every comment body. Drops the temporal markers
without touching the invariants.

- **Pros:** Lower-risk than Option A. Mechanical regex sweep.
- **Cons:** Smaller LOC win (~5 LOC instead of ~25). Some comments
  become awkward without their original frame.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Defer entirely (V1-freeze posture)

Comments are not bugs. V1-freeze values defenders even when verbose.
Leave it.

- **Pros:** Zero churn. Maximum defender preservation.
- **Cons:** File reads as round-by-round combat log instead of
  shipped code.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected file:
  `agent-orchestrator/scripts/generate-prompt.js`
- No production behavior change.
- Pair with todo 062 (`outputDir` alias removal) — both touch the
  same file, same comment-cleanup pass.
- Tests should remain green; if a test asserts on a comment string,
  it's mis-targeted and should be revised.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A or B: round numbers removed from all sites except where
  load-bearing context demands them (none expected).
- [ ] If A: load-bearing invariants preserved (charCount UTF-8
  explanation, coerce-then-check, function-form replace, etc.).
- [ ] If A: 716-724 collapse comment preserved (per todo 062).
- [ ] Test suite remains green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (code-simplicity-reviewer P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js`
- Pairing: todo 062 (`outputDir` dead alias).
- `agent-orchestrator/templates/README.md` — canonical contract
  rationale that the JSDoc header partially duplicates.
