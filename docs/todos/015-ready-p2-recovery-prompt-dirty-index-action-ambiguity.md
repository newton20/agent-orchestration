---
status: ready
priority: p2
issue_id: "015"
tags: [code-review, templates, recovery, agent-native, unit-7]
dependencies: []
---

# recovery-prompt.md dirty-index step has three small action-ambiguity gaps for literal-reading agents

## Problem Statement

PR #6 introduced a path-scoped, role-conditional dirty-index handling step in `recovery-prompt.md` (pre-resume verification step 3). The /ce:review agent-native pass surfaced three places where a literal-reading agent encounters ambiguity that could lead to wrong action:

1. **Cross-role guidance contradicts QA branch.** The "Document the choice... If both options feel risky, prefer the wip commit" paragraph (recovery-prompt.md:301-308) sits at the same outer indent level as the `**If your role is `qa`:**` and `**If your role is `impl` or `coord`:**` subheads, so a literal-reading agent will read it as applying to all roles. But QA was just told (lines 222-225) it must NOT use preserve-as-wip or discard, and QA records dirty-tree findings under **Playbook row results** (P2 FAIL), not **Decisions**. The "prefer the wip commit" advice is actively misleading for QA.

2. **Discard-branch empty-bucket guards missing.** The TRACKED-OR-STAGED and UNTRACKED steps (recovery-prompt.md:278-294) are presented as a fixed sequence. An agent whose dirty-list contains only one bucket type may run the second command with no arguments (benign on most shells but reads as an error condition), or skip it but feel uncertain whether skipping breaks the contract.

3. **QA-recovery dirty-tree guidance only mentions "scope rows," not "playbook rows."** Recovery-prompt.md:234-237 instructs marking occluded rows `SKIP (reason: occluded by inherited dirty state)`. But qa-prompt.md's Output contract splits results into **Scope row results** AND **Playbook row results**. A QA-recovery whose dirty state occludes a playbook row gets no instruction.

## Findings

- /ce:review agent-native-reviewer (PR #6 round): "The paragraph at L301-308 is at the same outer indent level as the role-conditional subheads. A literal-reading agent will read it as applying to all roles, including QA."
- /ce:review agent-native-reviewer (same): "The three numbered steps under 'Then run the appropriate command per set' present steps 1 (TRACKED-OR-STAGED) and 2 (UNTRACKED) as a fixed sequence. A literal-reading agent whose dirty-list contains only TRACKED-OR-STAGED files may run step 2 with no arguments."
- /ce:review agent-native-reviewer (same): "The QA-recovery dirty-tree guidance only mentions 'scope rows,' not 'playbook rows.' qa-prompt.md's Output contract splits results into both."

## Proposed Solutions

### Option A — Three targeted edits to recovery-prompt.md
1. Move L301-308 inside the `**If your role is `impl` or `coord`:**` branch (indent it under that subhead so it scopes correctly), OR lead the paragraph with "If your role is `impl` or `coord`,…" so the conditional is visible at the line level. Split the universal "prefer `status: blocked` if you can't scope the file list" sentence as a separate role-agnostic paragraph.
2. Prepend each numbered step (1 and 2) with an explicit empty-set guard: "If the X bucket from the classification step is empty, skip this step. Otherwise: …"
3. Replace "scope rows" with "scope or playbook rows" / "rows (scope or playbook)" in recovery-prompt.md:234.

- **Pros**: Three small surgical edits; closes all three ambiguities without restructuring; follows the role-conditional pattern already established.
- **Cons**: Adds ~6 lines.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Defer to the upcoming simplicity-trim follow-up (todo 020)
The recovery-prompt simplicity trim already targets ~30 LOC reduction in step 3 prose. Folding these three fixes into the same trim PR keeps recovery-prompt churn in a single follow-up.

- **Pros**: Less file churn; simplicity reviewer can hold the line on prose budget while fixing the gaps.
- **Cons**: Couples a quality fix to a stylistic cleanup; if the simplicity trim slips, these gaps persist.
- **Effort**: Small.
- **Risk**: Low — but ties shipping of P2 fixes to P3 cleanup timing.

## Recommended Action

**Option A — approved 2026-04-27 by coord.** Three targeted edits to
`recovery-prompt.md`:

1. **Cross-role guidance at L301-308:** move the "Document the choice…
   prefer the wip commit" paragraph INSIDE the `**If your role is
   `impl` or `coord`:**` branch (indent under that subhead) so it
   scopes correctly. Split off the universal "prefer `status: blocked`
   if you can't scope the file list" sentence as a separate
   role-agnostic paragraph at the outer indent.
2. **Empty-bucket guards on L278-294:** prepend each numbered step
   (1 TRACKED-OR-STAGED, 2 UNTRACKED) with an explicit empty-set
   guard: "If the X bucket from the classification step is empty,
   skip this step. Otherwise: …"
3. **Playbook-row coverage on L234:** replace "scope rows" with
   "scope or playbook rows" (or "rows (scope or playbook)") so a
   QA-recovery whose dirty state occludes a playbook row gets the
   same SKIP-marking guidance as for scope rows.

Closes all three literal-reading-agent ambiguities surgically without
restructuring. Adds ~6 LOC.

Option B (defer to simplicity-trim follow-up todo 020) rejected —
couples a P2 quality fix to a P3 stylistic cleanup whose timing is
post-Unit-7. The fixes belong before Unit 7 dispatches.

Dispatch as part of the pre-Unit-7 fixes round 2 PR bundle along
with todos 016, 017, 019.

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/recovery-prompt.md` (lines 234, 278-294, 301-308)

**Database changes:** None.

## Acceptance Criteria

- [ ] A literal-reading qa-recovery agent does not encounter "prefer the wip commit" advice that contradicts the QA contract.
- [ ] An impl/coord-recovery agent with only one bucket type (TRACKED-OR-STAGED only, or UNTRACKED only) has unambiguous skip guidance.
- [ ] QA-recovery handles a dirty state occluding a playbook row the same way it handles a dirty state occluding a scope row.

## Work Log

(empty)

## Resources

- /ce:review (PR #6 ce:review): agent-native-reviewer findings P2-1, P2-2, P2-3
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/qa-prompt.md` (Output contract reference)
