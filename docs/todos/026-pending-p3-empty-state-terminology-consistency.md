---
status: pending
priority: p3
issue_id: "026"
tags: [code-review, templates, schema, documentation, post-pr-7]
dependencies: []
---

# Empty-state form is described as "literal" in some docs and "canonical" in others

## Problem Statement

PR #7 introduced the canonical empty-state form `- none` (lowercase, no quotes, no trailing punctuation) for `## Decisions` and `## Blockers / open questions` across the protocol contract, while keeping the briefing-side descriptive placeholders (`(no decisions captured)`, `(no open questions)`, `(no warnings)`) deliberately divergent. Two adjacent terms describe the empty-state forms and are not used consistently:

- **"literal"** — used in `templates/README.md:153,184-185` for the briefing-side `(no decisions captured)` form: "Always renders; empty state is `(no decisions captured)` literal." and "render an explicit literal placeholder rather than empty prose."
- **"canonical"** — used in `coordinator-briefing.md:135` and `schema/completion-signal-example.md:60` for the body-schema `- none` form: "the completion-signal schema's canonical `- none` form."

A maintainer skimming for "what's the official empty form?" sees two different adjectives across files. Neither is wrong — both forms are literal AND canonical for their respective contexts — but the inconsistency makes it harder to grep or reason about.

This finding was flagged P2 by the pattern-recognition reviewer but explicitly noted as "Mild — not a fix-now item." Captured here for post-Unit-7 doc-cleanup consideration.

## Findings

- /ce:review pattern-recognition-specialist (PR #7 round) P2-2: term inconsistency between "literal" (briefing side) and "canonical" (body-schema side). Mild; not fix-now.

## Proposed Solutions

### Option A — Use "canonical literal" everywhere
Both forms are canonical AND literal. Standardize on the compound term where both senses matter:
- `templates/README.md:153,184-185` → "render the canonical literal placeholder `(no decisions captured)`"
- `coordinator-briefing.md:135` → "the completion-signal schema's canonical literal `- none` form"
- `schema/completion-signal-example.md:60` → "the canonical literal empty-state form"

- **Pros**: One vocabulary across all four docs; greppable; semantically accurate (both meanings hold).
- **Cons**: Slightly longer; "canonical literal" reads stilted in some sentences.
- **Effort**: Small (~5 LOC across 3 files).
- **Risk**: Low.

### Option B — Use "literal" everywhere; drop "canonical"
"Canonical" implies "the one true form among alternatives" — but for both empty-state forms, there are no alternatives any more (PR #7 removed them). "Literal" is enough.

- **Pros**: Shorter; "the literal `- none` form" / "the literal `(no decisions captured)` form" both read naturally.
- **Cons**: Loses the "this is the agreed empty form, not just any literal" connotation.
- **Effort**: Small.
- **Risk**: Low.

### Option C — Use "canonical" for body-schema, "descriptive literal" for briefing
Disambiguate the two contexts: body-schema `- none` is canonical (parser input); briefing `(no decisions captured)` is descriptive literal (human read).

- **Pros**: Captures the briefing-vs-signal duality at the term level.
- **Cons**: "Descriptive literal" is two words doing one job; readers may not parse the duality from the adjective alone.
- **Effort**: Small.
- **Risk**: Low.

### Option D — Defer until post-Unit-7 doc-cleanup PR
Bundle with todos 012/013/020/021/022/023 broader prose consistency cleanup.

- **Pros**: One coordinated polish pass.
- **Cons**: Stays inconsistent during Unit 7 design.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

(awaiting coord triage; reviewer flagged "Mild — not a fix-now item." so Option D is reasonable)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/README.md` (lines 153, 184-185)
- `agent-orchestrator/templates/coordinator-briefing.md` (line 135)
- `agent-orchestrator/schema/completion-signal-example.md` (line 60)

## Acceptance Criteria

- [ ] One consistent vocabulary across all four docs that touch the empty-state form.
- [ ] A maintainer grepping for the empty-state form finds it under one term.

## Work Log

(empty)

## Resources

- /ce:review pattern-recognition-specialist (PR #7 round): P2-2.
- `agent-orchestrator/templates/README.md`
- `agent-orchestrator/templates/coordinator-briefing.md`
- `agent-orchestrator/schema/completion-signal-example.md`
