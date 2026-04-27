---
status: pending
priority: p2
issue_id: "019"
tags: [code-review, templates, schema, completion-signal, unit-7, future-evolution]
dependencies: []
---

# `dispatcher_advisories` integer field has no structured-evidence trail; document the evolution path

## Problem Statement

PR #6 introduced a `dispatcher_advisories: <int>` field in completion-signal frontmatter. The integer-count design is internally consistent across all three places (frontmatter declaration in protocol-header.md:64, qa-prompt.md instruction to increment, schema example default of 0), and the coupling is good.

The architectural concern is the information-density ceiling of the integer count. The contract today: "QA increments per detected dispatched-row rewrite, surfaces detail in **Advisories** body section." The frontmatter signals existence and count; the prose carries the evidence. That bridge works only as long as the coord (or a downstream automated triager) reads both. Concretely:

- A coord that filters `dispatcher_advisories > 0` across a phase tree and routes to a dispatcher-bug investigation has only the count — it cannot tell whether the 3 advisories are the same root cause or three independent issues, nor which scope rows were rewritten, without re-opening each completion signal and parsing prose.
- If Unit 7's validator (or a future Unit 11 dashboard) wants to aggregate dispatcher-bug signals across phases, it would need a second parse pass over `## Advisories` body sections — which are free-form markdown bullets, not structured data.

A structured `dispatcher_advisories: [{row: "P3", original_in_impl_prompt: "${VAR}/path", rewritten_in_dispatch: "/abs/path"}, ...]` array would give the coord and any future dashboard a parseable evidence trail in the same place as the existence signal, with no additional QA effort.

## Findings

- /ce:review architecture-strategist (PR #6) P2-1: "The architectural concern is not the V1 coupling but the information-density ceiling of the integer count... A structured array would give the coord and any future dashboard a parseable evidence trail in the same place as the existence signal."

## Proposed Solutions

### Option A — Document the evolution path as an Open question for Unit 7
Add to templates/README.md's "Open questions for Unit 7" section: *"Should `dispatcher_advisories` evolve from integer count to structured array once a second consumer (Unit 11 dashboard, automated triager) exists?"*

This puts the future evolution path on record without churning the V1 schema. The integer is sufficient for the V1 single-coord-reads-prose pattern.

- **Pros**: One-line addition; preserves V1 simplicity; signals to future maintainers that the integer is a known evolution gate.
- **Cons**: Documentation only — no schema change.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Promote to structured array in this iteration
Change the field from `dispatcher_advisories: 0` to `dispatcher_advisories: []`. Update protocol-header.md schema, qa-prompt.md increment instruction, completion-signal-example.md default, and any Unit 7 parser stubs.

- **Pros**: Avoids future migration; structured evidence available immediately.
- **Cons**: Heavier V1 contract; QA agents must produce structured records (more agent burden); no current consumer needs the structure.
- **Effort**: Medium.
- **Risk**: Low.

### Option C — Hybrid: integer count + optional structured array
Keep `dispatcher_advisories: <int>` as required, add `dispatcher_advisory_details: [...]` as optional. QA produces the count for V1; Unit 11 dashboard or automated triager opts in to the structured details when ready.

- **Pros**: V1 simplicity preserved; future consumers have a reserved slot.
- **Cons**: Two related fields with overlapping semantics; future drift risk if the count and details disagree.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/README.md` (Open questions for Unit 7 section)
- For Option B: `agent-orchestrator/templates/protocol-header.md`, `agent-orchestrator/templates/qa-prompt.md`, `agent-orchestrator/schema/completion-signal-example.md`

## Acceptance Criteria

- [ ] A future maintainer encountering the integer field knows whether structured evolution is planned or rejected.
- [ ] The V1 contract works for the current single-coord pattern.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): architecture-strategist P2-1
- `agent-orchestrator/templates/protocol-header.md` (lines 64, 111-120)
- `agent-orchestrator/templates/qa-prompt.md` (lines 48-64)
- `agent-orchestrator/schema/completion-signal-example.md`
