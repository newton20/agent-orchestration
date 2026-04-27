---
status: pending
priority: p2
issue_id: "018"
tags: [code-review, templates, unit-7, validator]
dependencies: []
---

# Re-declaration convention has no compile-time enforcement; transitive drift is silently possible

## Problem Statement

PR #6 documented a manual re-declaration convention in `templates/README.md` Interpolation contract: when template X inlines template Y via `{{var}}`, X must re-declare every Y-declared variable in X's own frontmatter. Today's cases: `qa-prompt.md` and `recovery-prompt.md` both inline `qa-playbook-prompt.md` and re-declare `test_commands_block`. The convention is well-documented and the catalog hygiene around `test_commands_block` (entry on README line 146) flags both re-declarers.

The architectural soundness concern is the **transitive-drift failure mode** that Unit 7's validator does NOT catch:

If a future PR adds, say, `optional: [test_commands_block, environment_overrides_block]` to `qa-playbook-prompt.md` but only updates `qa-prompt.md`'s frontmatter (forgetting `recovery-prompt.md`), Unit 7's per-template validator passes both files (each is internally consistent), the catalog table can be updated or not, and `recovery-prompt.md` silently dispatches with a missing-from-frontmatter variable that interpolates as empty when QA-recovery is dispatched. The render does not fail; the playbook just silently loses the override.

The README acknowledges the risk and points at the deferred `inlines:` option (todo 011 Option C). That's the right design move for V1. But two concrete improvements would lower the floor of the failure mode without taking on the heavier `inlines:` machinery.

## Findings

- /ce:review architecture-strategist (PR #6) P2-2: "Manual re-declaration convention has no compile-time enforcement floor; transitive drift is silently possible. Unit 7's per-template validator passes both files (each is internally consistent), the catalog table can be updated or not, and recovery-prompt.md silently dispatches with a missing-from-frontmatter variable that interpolates as empty when QA-recovery is dispatched."

## Proposed Solutions

### Option A — Unit 7 lint warning (not error) on transitive mismatch
Have Unit 7's lint compute "templates that pass `qa_playbook_block` to a child" (today: qa-prompt.md, recovery-prompt.md) and check that their frontmatter unions contain the playbook's own optional set. Emit a WARNING (not an error) on mismatch, with a hint to re-declare.

- **Pros**: One-shot check at lint time; doesn't require `inlines:` key; catches the most common drift mode.
- **Cons**: Hardcodes the qa_playbook_block special-casing in Unit 7; adds maintenance when a new nested-template case appears.
- **Effort**: Medium (Unit 7 design change).
- **Risk**: Low.

### Option B — CI test fixture for transitive flow
Add a representative qa-recovery fixture that asserts `test_commands_block` actually flows through to the rendered playbook output. A single integration test pinning the contract makes drift loud.

- **Pros**: Tests the actual end-to-end flow; doesn't require validator-level changes.
- **Cons**: Test-only — drift can still ship if the test isn't updated alongside playbook changes.
- **Effort**: Small (one fixture + one test in scripts/).
- **Risk**: Low.

### Option C — Promote `inlines:` frontmatter key (todo 011 Option C)
Extend the frontmatter contract: a template that recursively renders another template lists the inlined templates under a new `inlines:` key. Unit 7's validator validates the union of all transitively-required vars.

- **Pros**: Most general fix; works for arbitrary nesting depth; mechanizes the union check.
- **Cons**: Adds a third frontmatter key; heavier contract for a problem the manual convention solves with one-line cost per nested template.
- **Effort**: Medium.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected files:**
- For Option A: future `agent-orchestrator/scripts/generate-prompt.js` (Unit 7) — design-doc note for now.
- For Option B: future test fixture in `agent-orchestrator/scripts/`.
- For Option C: all template frontmatters that inline (today: `qa-prompt.md`, `recovery-prompt.md`).

## Acceptance Criteria

- [ ] A future PR that adds a new optional var to `qa-playbook-prompt.md` and forgets to update either re-declarer fails CI loudly (not silently mis-renders).

## Work Log

(empty)

## Resources

- /ce:review (PR #6): architecture-strategist P2-2
- `docs/todos/011-ready-p2-template-frontmatter-transitive-vars.md` (Option C deferral)
- `agent-orchestrator/templates/README.md` (re-declaration convention)
