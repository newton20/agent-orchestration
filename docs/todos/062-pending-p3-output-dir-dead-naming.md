---
status: pending
priority: p3
issue_id: "062"
tags: [code-review, post-pr-13, ce-review, scripts, pattern, dead-code]
dependencies: []
---

# `outputDir` alias survives after codex round 12 collapse

PR #13 codex round 12 collapsed `outputDir` and `phaseDir` into a
single concept (they were always the same path; the duplication was
historical). The collapse landed correctly in the option parser
and most use sites, but a local alias `const outputDir = o.phaseDir`
remains and is read at three call sites. Dead-but-not-removed
indirection.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:725`:

```js
// codex round 12: phaseDir is the canonical output destination;
// outputDir was an obsolete duplicate that pointed to the same place.
// Keep the explanatory block at lines 716-724; drop the alias.
const outputDir = o.phaseDir;
```

Use sites at lines 778, 781 read `outputDir` instead of `o.phaseDir`
directly. The alias adds no value — `o.phaseDir` is already the
single source of truth — and risks future readers thinking they're
distinct values.

The 8-line explanatory comment at 716-724 documenting *why* the
collapse happened is genuinely load-bearing (a future engineer
might re-introduce the duplication without it) and should stay.

## Findings

PR #13 ce:review pattern-recognition-specialist P3:

> "After codex round 12 collapsed `outputDir` into `phaseDir`,
> the local alias `const outputDir = o.phaseDir` at line 725 is
> dead naming. Three use sites read it (lines 778, 781). Dropping
> the alias and replacing with `o.phaseDir` saves nothing
> functionally but eliminates the false suggestion that two
> distinct concepts exist. Keep the 8-line explanatory comment at
> 716-724 — that's load-bearing institutional memory."

## Proposed Solutions

### Option A — Delete the alias; update use sites

1. Remove `const outputDir = o.phaseDir;` at line 725.
2. Replace `outputDir` with `o.phaseDir` at lines 778 and 781 (and
   any other use sites a sweep finds).
3. Keep the comment block at 716-724 verbatim.

- **Pros:** Removes dead naming. Future readers see one concept,
  not two. The comment block still documents the collapse for any
  future engineer tempted to re-introduce a duplicate.
- **Cons:** Touches 3-4 lines in a hot script. Test sweep needed
  to confirm no fixtures match `outputDir` literally.
- **Effort:** Trivial.
- **Risk:** Low (compiler/tests catch any missed reference).

### Option B — Defer

V1-freeze posture: leave the alias in place. The codex defense at
716-724 already prevents accidental re-introduction.

- **Pros:** Zero churn.
- **Cons:** Dead naming ages into the codebase.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected file (Option A):
  `agent-orchestrator/scripts/generate-prompt.js`
  - Line 725: delete the alias.
  - Lines 778, 781: replace `outputDir` with `o.phaseDir`.
  - Lines 716-724: keep the comment block.
- Sweep `agent-orchestrator/scripts/generate-prompt.js` and
  `agent-orchestrator/scripts/generate-prompt.test.js` for any
  remaining `outputDir` references.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: alias and all reads removed; tests green.
- [ ] If A: comment block at 716-724 preserved verbatim.
- [ ] If A: no `outputDir` literal remains in `generate-prompt.js`
  outside the comment block.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (pattern-recognition-specialist P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:716-781`
- Codex round 12 (PR #13 commit history) — original collapse
  rationale.
