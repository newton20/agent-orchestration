---
status: pending
priority: p3
issue_id: "022"
tags: [code-review, templates, readme, simplicity, prose]
dependencies: [012]
---

# templates/README.md narrative paragraphs can be trimmed ~21 LOC

## Problem Statement

PR #6 added several Unit 7 integration notes to templates/README.md. Some are necessary (the original-prompt preservation contract is load-bearing). Others duplicate facts already encoded in the catalog or pseudocode. The /ce:review code-simplicity pass identified ~21 LOC of trim opportunities:

1. **L64-69** — "Concrete example" paragraph for re-declaration convention. The catalog row for `test_commands_block` already names every template that re-declares it. Remove.
2. **L79-85** — Concatenation note item 4: "For recovery-prompt.md when role is qa, do the same playbook pre-render and pass through `test_commands_block` override." Could be ~3 lines: "Same as qa-prompt + test_commands_block pass-through."
3. **L217-242** — Original-prompt preservation contract narrative. The pseudocode `if not exists` already encodes the one-shot semantics. Could be ~7 lines instead of ~12.

Note: this todo is somewhat redundant with the existing **todo 012** (templates README catalog cleanup). Coordinate the trim with that todo's planned cleanup.

## Findings

- /ce:review code-simplicity-reviewer (PR #6) findings 10-12: "Catalog row IS the concrete example." / "Same as qa-prompt is enough." / "Pseudocode encodes the one-shot semantics."

## Proposed Solutions

### Option A — Fold into todo 012 (templates README catalog cleanup)
Todo 012 is already planned for post-Unit-7 doc cleanup. Add these trims to its scope.

- **Pros**: One coordinated cleanup PR; avoids fighting with todo 012's catalog ergonomic changes.
- **Cons**: Defers the trim by one cycle.
- **Effort**: Small (added to existing planned work).
- **Risk**: Low.

### Option B — Apply trims in a standalone follow-up PR
- **Pros**: Faster reduction.
- **Cons**: Risks merge conflict with todo 012's planned changes.
- **Effort**: Small.
- **Risk**: Low–medium (conflict risk).

### Option C — Defer entirely
- **Pros**: No churn.
- **Cons**: README narrative inflates without bound across future Unit 7 contract additions.
- **Effort**: None.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected file:** `agent-orchestrator/templates/README.md` (lines 64-69, 79-85, 217-242)

CRITICAL — must NOT remove:
- The original-prompt preservation pseudocode itself (codex P2 round 9 — closes the contract gap)
- The re-declaration convention's rule statement (todo 011 contract)
- The Concatenation rule for `qa-prompt.md` AND `recovery-prompt.md` qa-recovery (codex P2 round 6 — closes the playbook-rendering gap)

## Acceptance Criteria

- [ ] No fact in templates/README.md stated twice in the body of two different sections (catalog table + prose paragraph).
- [ ] Unit 7 author still has all the contract information they need to implement.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): code-simplicity-reviewer findings 10-12
- `docs/todos/012-pending-p3-templates-readme-catalog-cleanup.md` (related)
- `agent-orchestrator/templates/README.md`
