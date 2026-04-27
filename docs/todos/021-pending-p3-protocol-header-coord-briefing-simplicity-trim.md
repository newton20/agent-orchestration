---
status: pending
priority: p3
issue_id: "021"
tags: [code-review, templates, protocol-header, coord-briefing, simplicity, prose]
dependencies: []
---

# protocol-header.md and coordinator-briefing.md can be trimmed ~35 LOC without losing safety

## Problem Statement

PR #6's protocol-header.md and coordinator-briefing.md additions include several paragraphs whose content is more useful for the future template author than for the runtime agent. The /ce:review code-simplicity pass identified ~35 LOC of trim opportunities that don't lose safety:

1. **protocol-header.md:100-109** — `## Decisions` explanatory paragraph (10 lines). Could be 3: definition + examples one-liner + empty-state rule.
2. **protocol-header.md:111-120** — `dispatcher_advisories` rationale paragraph (10 lines). Already encoded in the inline frontmatter comment at L64. Trim to 2 lines or remove.
3. **coordinator-briefing.md:8-18** — docblock section enumeration (11 lines). Auto-documenting via headings; trim to 3 lines.
4. **coordinator-briefing.md:126-131** — Conventions footer divergence paragraph (third statement of the same fact already in docblock + inline note). Remove.
5. **qa-prompt.md:101-110** — Scope-boundary "the boundary is X not Y" defensive clarification. Trim to 2 lines.

The agent reads these documents on every dispatch. Every line costs prompt tokens.

## Findings

- /ce:review code-simplicity-reviewer (PR #6) findings 13-18: "Documentation paragraph in a prompt the agent reads every dispatch. Every line costs prompt tokens and reading time across thousands of dispatches."
- /ce:review code-simplicity-reviewer: "Triple-redundant. The reader sees this every dispatch." (re: coord-briefing divergence note)

## Proposed Solutions

### Option A — Apply all 5 trims in a single follow-up PR
- **Pros**: ~35 LOC saved; coord-briefing dedup reduces three-way redundancy to one location.
- **Cons**: 5 edits across 3 files; need to verify the inline frontmatter comments and one-line distinctions still convey the contract.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Apply only coord-briefing dedup (#3 + #4)
Coord-briefing has the same fact stated three times (docblock, inline note, footer). Trim two of three. ~14 LOC.

- **Pros**: Single-file change; cleanest single-fact dedup.
- **Cons**: Leaves protocol-header verbosity (#1, #2) untouched.
- **Effort**: Small.
- **Risk**: Low.

### Option C — Defer entirely
- **Pros**: No follow-up churn.
- **Cons**: Per-dispatch token cost persists.
- **Effort**: None.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/protocol-header.md` (lines 100-120)
- `agent-orchestrator/templates/coordinator-briefing.md` (lines 8-18, 126-131)
- `agent-orchestrator/templates/qa-prompt.md` (lines 101-110)

CRITICAL — must NOT remove:
- The `## Decisions` body section itself (codex P2 round 13 — closes the section-doesn't-exist gap)
- The `## Dispatched next action` heading and its recommend-only authority
- `dispatcher_advisories` inline frontmatter declaration

## Acceptance Criteria

- [ ] No fact stated three times; one canonical location each.
- [ ] Per-dispatch prompt token cost reduced.
- [ ] Render check still passes.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): code-simplicity-reviewer findings 13-18
- `agent-orchestrator/templates/protocol-header.md`
- `agent-orchestrator/templates/coordinator-briefing.md`
- `agent-orchestrator/templates/qa-prompt.md`
