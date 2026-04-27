---
status: pending
priority: p3
issue_id: "023"
tags: [code-review, templates, nits, cross-refs, unit-7]
dependencies: []
---

# Misc cross-refs and nits surfaced by /ce:review on PR #6

## Problem Statement

The /ce:review pass on PR #6 surfaced several individually-small findings that are all P3-priority improvements: catalog-annotation rationale, recovery template cross-refs, dispatcher_advisories example clarity, markdown lint nits. Bundled here as a single follow-up.

## Findings

### N1 — coord_next_actions decoupling rationale missing from catalog (architecture P3-2)
README catalog row for `coord_next_actions` (line 160) describes the new heading and recommend-only semantics, but doesn't pin the variable name as deliberately retained. A future template author may "fix" the divergence by renaming to `coord_dispatched_next_action` and silently break every fixture / caller.

**Fix:** Add to the catalog row: *"The variable name `coord_next_actions` is deliberately retained from the pre-divergence design; it is the internal handle that callers and Unit 7 reference, decoupled from the user-visible `## Dispatched next action` heading. Do not rename without a coordinated update of session-handoff fragment-list + every caller."*

### N2 — Recovery blocked-redispatch contract drift-defense comment (architecture P3-3)
recovery-prompt.md's `## Original prompt context` enumerates "if empty AND role is qa: write `status: blocked`" four times. Each block is intentionally self-contained with slightly different reasons (target missing vs. scope missing vs. playbook missing). A future author updating the redispatch behavior in one place is likely to miss the others.

**Fix:** Add a one-sentence design-intent comment at the top of `## Original prompt context`: *"The four sub-blocks below each describe the same `status: blocked` redispatch outcome; if you change one block's blocked-signal contents, mirror the change across all four."*

### N3 — Original prompt context coord+depends_on corner (agent-native P3-5)
Recovery-prompt's role-conditional says coord-recovery should always proceed because "Coord recoveries have no upstream context by design." That's true today (coordinator-briefing.md doesn't carry `previous_phase_briefing`). Worth saying so explicitly so a future maintainer who adds upstream context to coord briefings notices the recovery template needs the same treatment.

**Fix:** Add a one-line cross-ref to coordinator-briefing.md's frontmatter ("currently no `depends_on` upstream").

### N4 — Recovery audit references heading text without pinning (agent-native P3-6)
recovery-prompt.md:84-85 says "inspect its **Previous phase context** (impl) or **Upstream context** (qa) block." A future rename of either heading silently breaks recovery's audit step.

**Fix:** Either (a) add a comment in impl-prompt.md and qa-prompt.md noting recovery-prompt.md depends on the heading text, or (b) tell the recovery agent to grep for the `{{previous_phase_briefing}}` interpolation by content.

### N5 — dispatcher_advisories non-zero example missing (agent-native P3-7)
qa-prompt.md tells the agent to "increment by one for each rewrite," and completion-signal-example.md shows the default `dispatcher_advisories: 0`. There's no example of a non-zero value.

**Fix:** Add a one-liner to protocol-header.md prose (around L111-120): *"If QA detects two rewrites, the frontmatter line reads `dispatcher_advisories: 2`."* Or a second worked example.

### N6 — Original-prompt preservation cross-ref to README §5 missing (agent-native P3-8)
Recovery template tells agent "if `${role}-prompt.original.md` is missing or unreadable, treat as blocker," but doesn't tell the agent the file is owned by the orchestrator and never written by another agent. A literal-reading agent finding the file mid-write might assume it's their own to fix.

**Fix:** Add a one-liner cross-ref to README §5: *"path-scoped — no other agent reads or writes the `.original.md` suffix."*

### N7 — Markdown lint nit (pattern-recognition)
recovery-prompt.md:356-357 runs two paragraphs together with no blank line between. Markdown renders OK because period+capital is a soft-break, but a blank line would visually separate the if-empty rule from the unconditional Summary directive.

**Fix:** Insert blank line.

## Proposed Solutions

### Option A — Single bundled follow-up PR
Apply N1-N7 in one PR. ~12 lines added across 4 files.

- **Pros**: Single review cycle; coherent "PR #6 cleanup" story.
- **Cons**: 7 small edits to coordinate.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Fold into todo 020/021/022 simplicity-trim PRs
Distribute the items: N1, N5 → todo 022 (README); N2, N3, N4, N6, N7 → todo 020 (recovery-prompt). N5 also touches protocol-header → todo 021.

- **Pros**: Fewer PRs overall; simplicity trim and clarification ride together.
- **Cons**: Couples nits to simplicity decisions.
- **Effort**: Small.
- **Risk**: Low.

### Option C — Defer entirely
- **Pros**: No churn.
- **Cons**: Each individual nit is small but the cumulative drift-defense is real.
- **Effort**: None.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/README.md` (catalog row for `coord_next_actions`)
- `agent-orchestrator/templates/recovery-prompt.md` (multiple lines)
- `agent-orchestrator/templates/impl-prompt.md`, `agent-orchestrator/templates/qa-prompt.md` (heading-text dependency comments — optional)
- `agent-orchestrator/templates/protocol-header.md` (dispatcher_advisories non-zero example)

## Acceptance Criteria

- [ ] coord_next_actions catalog row pins the variable-name retention rationale.
- [ ] Recovery template's `## Original prompt context` has a drift-defense comment.
- [ ] dispatcher_advisories has a non-zero example in protocol-header prose.
- [ ] Markdown lint nit at recovery-prompt.md:356-357 fixed.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): architecture-strategist P3-2/3, agent-native-reviewer P3-5/6/7/8, pattern-recognition-specialist nit
- `agent-orchestrator/templates/README.md`
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/protocol-header.md`
