---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, templates, catalog, documentation, unit-6]
dependencies: []
---

# templates/README.md catalog cleanups (Type column, grouping rationale, recovery enum, open-questions location)

## Problem Statement

PR #5 ce-review surfaced a cluster of small ergonomic / consistency findings on `agent-orchestrator/templates/README.md`. Each is independently small but together they make the catalog harder to maintain than it needs to be.

## Findings

### F1 — `recovery` enum value defined but never consumed in V1
- Location: `templates/README.md:84` — `role` enum lists `impl | qa | coord | recovery`. Catalog itself notes `recovery` is reserved for V1.5. A V1 validator built off this catalog accepts `role: recovery` but no template path consumes it. YAGNI — a hole carved for a future requirement that will need to change shape anyway.
- Source: simplicity review (P2-S1)

### F2 — "Open questions for Unit 7" section embedded in catalog (32 lines)
- Location: `templates/README.md:176-207`
- Section is forward-looking design notes for Unit 7, not instruction for anyone reading Unit 6 templates today. Unit 7 will rediscover them when its design doc is written.
- Source: simplicity review (P2-S2)

### F3 — Five sub-tables could be one table with a `Scope` column
- Location: `templates/README.md:81-134` (Universal / Impl-specific / QA-specific / Coord-specific / Recovery-specific)
- A single table with columns `Name | Scope | Type | Purpose` would be ~10 lines shorter and let a reader confirm a variable's scope with one search.
- Source: simplicity review (P2-S3) — judgment call; readability arguably even.

### F4 — Type column inconsistent
- `string` vs `string enum` vs `absolute path` vs `block` vs `block (newline-joined ...)` vs `ISO 8601 UTC string` vs `ISO 8601 UTC string | null`.
- Source: pattern-recognition review (P3-5)

### F5 — Variable ordering rule not stated
- Within each group, vars appear roughly in template-order, but the rule isn't documented. Next author may sort alphabetically and the catalog drifts.
- Source: pattern-recognition review (P3-6)

### F6 — Catalog parsing is regex-fragile
- README at line 159-161 says Unit 7's "initial implementation can regex the tables." Markdown tables are fragile under edits.
- Source: architecture review (P3-A1)

### F7 — Catalog already past JSON-mirror threshold (22 vars; 31 by ce-review's count)
- README itself (line 195) says "JSON mirror pays for itself once >~15 variables or once a second consumer exists." Count is past threshold; Unit 7 is the second consumer.
- Source: learnings-researcher

### F8 — `block` variable formatting under-specified
- `prior_phase_dirs`, `completed_checkpoints_block`, `output_paths`, `remaining_work_block` are typed `block`. The contract should state explicitly: "Producer formats as markdown bullet list (`- /abs/path`, one per line)" or "Producer joins with `\n`; consumer template embeds inside a code fence." Without this, markdown can collapse newlines into a single paragraph.
- Source: architecture review (P3)

## Proposed Solutions

Pick a consolidated cleanup PR that addresses F1–F8 together (low coupling between findings; each is a small isolated edit). Suggested ordering by leverage:

1. F2 — Move open questions to a separate `docs/todos/` file or delete (largest LOC reduction).
2. F4 — Pin Type column to one of {string, path, block} only; relegate empty/null annotations to Purpose.
3. F1 — Drop `recovery` from enum, keep one sentence: "V1.5 may add a distinct `recovery` analyst role; V1 a respawned session keeps its original role."
4. F8 — Document `block` formatting contract in catalog header.
5. F5 — One-sentence ordering rule under "Variable catalog (authoritative)" header.
6. F3 — Optional: collapse to single table with Scope column (judgment call).
7. F6 / F7 — When Unit 7 lands, materialize `templates/variables.json` mirror (pays its way once Unit 7 needs it).

## Recommended Action

(filled during triage — likely a follow-up cleanup PR after Unit 7 lands; non-blocking for Unit 6 merge)

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/README.md` (most changes here)
- New: `docs/todos/<NN>-unit-7-open-questions.md` if F2 takes the "move-not-delete" path
- Future: `agent-orchestrator/templates/variables.json` for F7

## Acceptance Criteria

- [ ] Type column uses a closed vocabulary (e.g., {string, path, block}).
- [ ] Variable-ordering rule documented.
- [ ] `recovery` enum value either dropped or moved to a clearly-flagged "reserved" footnote.
- [ ] Unit-7-specific design notes live somewhere other than the catalog.

## Work Log

(empty)

## Resources

- PR #5 ce-review round: simplicity review (F1-F3), pattern-recognition (F4-F5), architecture (F6, F8), learnings-researcher (F7)
- `agent-orchestrator/templates/README.md`
