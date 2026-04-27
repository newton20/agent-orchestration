---
status: pending
priority: p3
issue_id: "025"
tags: [code-review, templates, documentation, unit-7, post-pr-7]
dependencies: []
---

# `templates/README.md` "Open questions for Unit 7" bullet 5 reads as a decided path; lockstep surfaces unstated

## Problem Statement

PR #7 added bullet 5 to `templates/README.md`'s "Open questions for Unit 7" section documenting the `dispatcher_advisories` integer→structured-array evolution gate. Two style/completeness gaps surfaced in /ce:review:

1. **Codex P3:** The section's intro at `templates/README.md:256` says "These are the interpolation edge cases the template author expects Unit 7 to handle — they are **not decided yet**." Bullets 1-4 are framed as actual unresolved questions/options. Bullet 5 (lines 284-291) is written as a **decided** evolution path: "When a second consumer ... appears, evolve..." and "Until then, the integer is sufficient." That style is inconsistent with the rest of the section. Either:
   - Move bullet 5 to "Unit 7 integration notes" (an existing section that holds decided integration choices), OR
   - Rephrase as an actual open question: "**Should `dispatcher_advisories` evolve from integer to structured array?** Defer until a second consumer (Unit 11 dashboard, automated triager) appears; structured shape: ..."

2. **Architecture P3-1:** Bullet 5 does not enumerate the lockstep surfaces a future evolution PR must touch. A future maintainer doing the migration would find them via grep on `dispatcher_advisories`, but the bullet does not pre-declare them. Specifically, the evolution PR must update:
   - `protocol-header.md:64` (the schema line itself, currently `dispatcher_advisories: 0  # integer count, ...`).
   - `protocol-header.md:115-124` (the prose explainer that describes the field as an integer).
   - `qa-prompt.md:57-64` (the Cross-verification block that tells QA to "increment by one").

   Append one sentence to the bullet listing these three lockstep sites.

## Findings

- Codex round (PR #7 review) P3: bullet 5 is filed under "not decided yet" but is written as a decided evolution path.
- /ce:review architecture-strategist (PR #7 round) P3-1: lockstep surfaces (`protocol-header.md:64`, `:115-124`, `qa-prompt.md:57-64`) not enumerated in the evolution bullet; cheap insurance against partial migration.

## Proposed Solutions

### Option A — Rephrase bullet 5 as a question + append lockstep surfaces
Two surgical edits to `templates/README.md` lines 284-291:
1. Lead with a question form: "**Should `dispatcher_advisories` evolve from integer count to structured array?** Defer the structured form until a second consumer (Unit 11 dashboard, automated triager) needs the parseable evidence trail; structured shape will be `dispatcher_advisories: [{row, original_in_handoff, rewritten_in_dispatch}, ...]`. Until then, the integer is sufficient for the single-coord-reads-prose pattern."
2. Append a sentence on lockstep surfaces: "Lockstep surfaces an evolution PR must update: `protocol-header.md:64` (schema line), `protocol-header.md:115-124` (prose explainer), `qa-prompt.md:57-64` (QA Cross-verification block)."

- **Pros**: Both gaps addressed in one edit. Question framing matches bullets 1-4 style. Lockstep surfaces pre-declared.
- **Cons**: Bullet grows ~3 lines (8 → 11).
- **Effort**: Small.
- **Risk**: Low.

### Option B — Move bullet 5 to "Unit 7 integration notes"
Bullets 1-4 remain truly open questions; bullet 5 (decided evolution path) moves to an existing decided-choice section.

- **Pros**: Restores the "Open questions" section invariant ("not decided yet").
- **Cons**: "Unit 7 integration notes" is the wrong home for a "future evolution gate" — Unit 7 doesn't read this. The evolution is for Unit 11 + future dashboard. May need a third section ("Future evolution gates") or just live with the home that exists.
- **Effort**: Small.
- **Risk**: Low.

### Option C — Defer to post-Unit-7 doc-cleanup PR (with todos 020/021/022/023)
Bundle this with the broader simplicity-trim and prose-consistency cleanup.

- **Pros**: One PR for related cleanup.
- **Cons**: Bullet 5 stays in its current state during Unit 7 design; Unit 7 author may misread the framing.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

(awaiting coord triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/README.md` (lines 256, 284-291)

For Option B: also `templates/README.md` at the destination section.

## Acceptance Criteria

- [ ] Bullet 5's framing matches the section's "not decided yet" intro (or it lives in a section whose framing matches its decided-evolution form).
- [ ] A future maintainer planning the evolution PR sees the three lockstep surfaces listed in the same place as the evolution gate.

## Work Log

(empty)

## Resources

- Codex review (PR #7): P3 finding on bullet 5 framing.
- /ce:review architecture-strategist (PR #7 round): P3-1 finding on lockstep surfaces.
- `agent-orchestrator/templates/README.md`
