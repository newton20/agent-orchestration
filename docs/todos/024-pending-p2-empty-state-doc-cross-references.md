---
status: pending
priority: p2
issue_id: "024"
tags: [code-review, templates, schema, documentation, unit-7, post-pr-7]
dependencies: []
---

# Empty-state documentation cross-references are missing across the four schema-touching docs

## Problem Statement

PR #7 hardened the empty-state form for `## Decisions` and `## Blockers / open questions` across four documentation surfaces:

1. `protocol-header.md` (schema box L82-89 + prose L100-114)
2. `schema/completion-signal-example.md` (HTML comment + canonicalized Blockers L59-69)
3. `coordinator-briefing.md` (Conventions footer documenting briefing-vs-signal divergence L133-141)
4. `templates/README.md` ("Empty-state rendering" section L174-189 + re-recovery briefing invariant L244-254)

Each surface is internally correct but the cross-references between them are missing or stale. A future maintainer reading any single doc gets the local picture but doesn't know the other three exist. /ce:review surfaced four specific gaps:

1. **agent-native P2-1:** `completion-signal-example.md:64` HTML comment cites `See protocol-header.md L82-89, L100-110.` The cite still resolves but truncates mid-paragraph at "render the section as `- none` (lowercase," dropping the canonicalization clarification (lowercase, no quotes, no trailing punctuation). Update to `L82-89, L100-113`.

2. **architecture P2:** `templates/README.md:244-254` (todo 017's re-recovery briefing invariant) is mis-located for its enforcer. The invariant binds the **orchestrator (Unit 11)**, not the template renderer (Unit 7). README.md is the Unit 7-facing surface. A Unit 11 implementer reading only `recovery-prompt.md:77-98` (the audit step) does not see this constraint. Add a one-line cross-reference inside `recovery-prompt.md` near L77-98 of the form: "The dispatcher contract: on re-recovery, `previous_phase_briefing` MUST equal the prior dispatch's value — see `templates/README.md` section 5."

3. **pattern P2-1:** Briefing-vs-signal divergence is documented in two places with different phrasings: `coordinator-briefing.md:133-141` (briefing side) and `templates/README.md:183-189` (catalog side). Neither names the canonical-`- none` counterpart or links to the briefing rationale. A maintainer editing one site won't know the other exists. Add bidirectional cross-reference.

4. **architecture P3-2:** Add a one-line forward-reference from `protocol-header.md:100-113` (the Decisions partition rule) to `coordinator-briefing.md` Conventions section: "Briefings render the inverse of this — see `coordinator-briefing.md` Conventions" so the duality is visible from either entry point.

## Findings

- /ce:review agent-native-reviewer (PR #7 round) P2-1: stale `L100-110` line-range cite at `completion-signal-example.md:64`.
- /ce:review architecture-strategist (PR #7 round) P2: re-recovery briefing invariant lacks enforcement-site cross-reference.
- /ce:review pattern-recognition-specialist (PR #7 round) P2-1: briefing-vs-signal divergence documented twice with different phrasings; no cross-reference between them.
- /ce:review architecture-strategist (PR #7 round) P3-2: missing forward-reference from `protocol-header.md` Decisions partition to `coordinator-briefing.md` Conventions.

## Proposed Solutions

### Option A — Bundle all four cross-reference fixes into one PR
Five small surgical edits across four files:
1. `completion-signal-example.md:64` — update L100-110 → L100-113.
2. `recovery-prompt.md` near L77-98 — add cross-reference to README §5.
3. `coordinator-briefing.md:133-141` — append link to README L183-189.
4. `templates/README.md:183-189` — append link to coordinator-briefing.md Conventions.
5. `protocol-header.md:100-113` — append forward-reference to coordinator-briefing.md.

- **Pros**: One coherent PR closes all four cross-reference gaps; future maintainers reading any one doc see the others; ~10-15 LOC total.
- **Cons**: Touches 5 files for cross-reference plumbing.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Defer to post-Unit-7 doc-cleanup PR (with todos 020/021/022/023, 012/013)
Land the cross-reference fixes alongside the broader simplicity-trim and prose-consistency cleanup that's already queued.

- **Pros**: One bigger doc-cleanup PR; less PR noise.
- **Cons**: Delays the cross-reference fixes until after Unit 7 lands; Unit 7's prompt-generator will read these docs and benefit from the cross-references being present.
- **Effort**: Small.
- **Risk**: Low — but may invalidate some cite line-numbers if Unit 7 itself shifts the prose during integration.

### Option C — Split: land fix #1 (stale cite) + fix #2 (Unit 11 enforcement-site cross-ref) NOW; defer #3 + #4 + #5 to post-Unit-7
- Fix #1 (stale cite) is a 1-character regression fix.
- Fix #2 (Unit 11 enforcement-site cross-ref) reduces risk of Unit 11 implementer missing the invariant.
- Fixes #3, #4, #5 are forward-references / readability hardening; can wait.

- **Pros**: Closes the highest-value half (regression + enforcer-site); minimal churn; acknowledges that Unit 7's renderer is the immediate consumer of these docs and #1/#2 matter most for its design.
- **Cons**: Two PR cycles for what's logically one cohesive cleanup.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

(awaiting coord triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/schema/completion-signal-example.md` (L64 cite)
- `agent-orchestrator/templates/recovery-prompt.md` (around L77-98)
- `agent-orchestrator/templates/coordinator-briefing.md` (L133-141)
- `agent-orchestrator/templates/README.md` (L183-189)
- `agent-orchestrator/templates/protocol-header.md` (L100-113)

## Acceptance Criteria

- [ ] `completion-signal-example.md:64` HTML comment cite covers the full canonicalization paragraph (L100-113).
- [ ] A Unit 11 implementer reading `recovery-prompt.md:77-98` (audit step) sees a pointer to the re-recovery briefing invariant.
- [ ] A maintainer reading either `coordinator-briefing.md` Conventions OR `templates/README.md:183-189` sees a link to the other side of the briefing-vs-signal divergence.
- [ ] A maintainer reading `protocol-header.md:100-113` (Decisions partition rule) sees a forward-reference to the briefing-side empty-state form.
- [ ] No new variables added to catalog (count stays at 31).

## Work Log

(empty)

## Resources

- /ce:review (PR #7 round): agent-native-reviewer P2-1; architecture-strategist P2 + P3-2; pattern-recognition-specialist P2-1.
- `agent-orchestrator/schema/completion-signal-example.md`
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/coordinator-briefing.md`
- `agent-orchestrator/templates/README.md`
- `agent-orchestrator/templates/protocol-header.md`
