---
status: ready
priority: p2
issue_id: "011"
tags: [code-review, templates, unit-7, variable-contract, unit-6]
dependencies: []
---

# Template frontmatter incomplete under nesting: qa-prompt.md doesn't declare `test_commands_block` even though qa-playbook needs it

## Problem Statement

`agent-orchestrator/templates/qa-prompt.md` declares:
```
required: [phase_id, pr_or_branch_under_test, qa_scope_rows, qa_playbook_block, completion_signal_path]
optional: [previous_phase_briefing]
```

But rendering qa-prompt requires first rendering `qa-playbook-prompt.md` (which is then inlined as `{{qa_playbook_block}}`). qa-playbook declares `optional: [test_commands_block]`. A Unit 7 caller examining qa-prompt's frontmatter cannot tell that `test_commands_block` is also part of the variable surface needed to render qa-prompt.

The frontmatter loses its property of "everything I need to render this template" the moment two-pass interpolation is introduced.

## Findings

- Architecture review (PR #5 ce-review): "qa-prompt.md frontmatter does NOT mention test_commands_block, but rendering qa-prompt requires first rendering qa-playbook-prompt.md."
- This will become more painful as more templates nest (any future "prepended" or "inlined" template fragment).

## Proposed Solutions

### Option A — qa-prompt re-declares transitive vars
Add `test_commands_block` to qa-prompt's `optional` list. Duplicate declaration, but keeps frontmatter authoritative for callers.

- **Pros**: Trivial; frontmatter-as-complete-declaration property preserved.
- **Cons**: Manual sync — easy to forget when adding new playbook variables.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Unit 7 transitively flattens dependencies
Document in `templates/README.md` the Unit 7 contract: "If template X inlines template Y as `{{var}}`, X's effective variable surface is the union of X's frontmatter and Y's frontmatter." Unit 7 implements that union when validating.

- **Pros**: No template-author burden; correct by construction.
- **Cons**: Unit 7 needs to know which `{{var}}` is a "rendered template" vs. a regular block. Could use a frontmatter convention like `inlines: [qa_playbook_block]` to mark recursive vars.
- **Effort**: Medium (Unit 7 design change).
- **Risk**: Low.

### Option C — Add explicit `inlines:` frontmatter key
Extend the frontmatter contract: a template that recursively renders another template lists the inlined templates under a new `inlines:` key. Unit 7 validates the union of all transitively-required vars.

- **Pros**: Explicit; lints cleanly; supports arbitrary nesting depth.
- **Cons**: Adds a third frontmatter key beyond `required` / `optional`. Slightly heavier contract.
- **Effort**: Medium.
- **Risk**: Low.

## Recommended Action

**Option A — approved 2026-04-26 by coord.** Add `test_commands_block`
to `qa-prompt.md`'s `optional` frontmatter list. Document the
re-declaration convention in `templates/README.md`: when template X
inlines template Y via `{{var}}`, X must re-declare every var Y
declares in X's own frontmatter. Sharp-edge note: the convention is
manual sync — if a third nested template ever appears, revisit
Option C (`inlines:` frontmatter key) to mechanize.

Option C (explicit `inlines:` key) is the more general fix but
heavier contract for a single nesting case. Defer until justified.
Option B (Unit 7 transitively flattens) requires Unit 7 to know
which `{{var}}` is a rendered-template vs. a regular block —
either via the `inlines:` key (= Option C) or a naming convention
(brittle). Option A keeps Unit 7's validator simple: union of
`required` + `optional` is the complete variable surface. No
cleverness.

Dispatch as part of the pre-Unit-7 template-fixes PR bundle along
with todos 009, 010, 014.

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/qa-prompt.md` (frontmatter)
- `agent-orchestrator/templates/README.md` (Unit 7 contract documentation)
- Future: Unit 7 (`scripts/generate-prompt.js`) validator

## Acceptance Criteria

- [ ] A Unit 7 caller can determine the full variable surface needed to render qa-prompt by reading qa-prompt's frontmatter alone (or by following an explicitly-declared inline chain).
- [ ] The convention generalizes to other future template-nesting scenarios.

## Work Log

(empty)

## Resources

- PR #5 ce-review round: architecture review (P2-A1)
- `agent-orchestrator/templates/qa-prompt.md`
- `agent-orchestrator/templates/qa-playbook-prompt.md`
- `agent-orchestrator/templates/README.md`
