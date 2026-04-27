---
status: ready
priority: p2
issue_id: "016"
tags: [code-review, templates, schema, completion-signal, unit-7]
dependencies: []
---

# `## Decisions` body section has three plausible empty-state renderings; partition rule vs Design calls is ambiguous

## Problem Statement

PR #6 added a `## Decisions` body section to the completion-signal schema in `protocol-header.md`. Two ambiguities were surfaced by /ce:review:

1. **Empty-state canonical form is ambiguous.** Three different forms appear across the artifacts:
   - protocol-header.md:106 prose says "render the section as `- none`"
   - protocol-header.md:82-84 inline schema box says `- (or: "none")`
   - completion-signal-example.md:54-57 doesn't show an empty-state form (both example bullets are populated)
   - coordinator-briefing.md `## Decisions` section uses literal `(no decisions captured)` placeholder via Unit 7 substitution
   
   A literal-reading agent producing an empty-decisions signal has at least three plausible renderings to choose from. Unit 7's parser will need to handle all three.

2. **Partition rule vs `## Design calls the next phase should know about` is soft.** Protocol-header prose (lines 100-109) says Decisions are "choices that affect the next agent's options but are not invariants the next agent must preserve (those go under **Design calls**)." But two of three example bullets are actually borderline — "chose Option B from todo 011 over Option A because…" could be a design invariant if Option B implies a structural commitment; "ran tests with `--shard 2/3` instead of full suite because of timeout" could be a Blocker if the unsharded suite was the contract.

## Findings

- /ce:review agent-native-reviewer (PR #6 round): "The inline schema box at protocol-header.md:82-84 also shows two forms — `- <decision 1> — <why>` and `- (or: 'none')` — which is fine as a teach-by-example but is a different render than the prose at L106 prescribes (`- none`)."
- /ce:review agent-native-reviewer: "A literal-reading agent producing an empty-decisions signal has three plausible renderings to choose from: `- none`, `- (or: 'none')`, or no bullet at all."
- /ce:review architecture-strategist P3-1: "There IS a soft overlap with `## Design calls`. The recovery-prompt.md correctly directs dirty-index decisions to `## Decisions` — that flow is clean. The risk is the impl agent reaching for `## Decisions` for things that should be `## Design calls`."

## Proposed Solutions

### Option A — Pick one canonical empty-form and propagate
- Pick `- none` (matches protocol-header.md:106 prose; shortest; parser-friendly).
- Update the inline schema box at protocol-header.md:82-84 to use `- none` instead of `- (or: "none")`.
- Add a second worked example to completion-signal-example.md (or a comment in the existing example) showing the empty-Decisions form.
- Optionally align coordinator-briefing's `(no decisions captured)` with `- none` parity, OR document the divergence (briefing carries different empty-state semantics from the body schema).
- Tighten partition rule with one sharper sentence: *"If the next agent could pick a different choice and still ship correctly, it goes here. If the next agent would break shipped invariants by picking a different choice, it goes under **Design calls**."*

- **Pros**: One canonical form removes parser branches; partition rule sharpening is one sentence; fully addresses both findings.
- **Cons**: Touches 3 files (protocol-header, completion-signal-example, optionally coord-briefing). Slight churn.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Document all three forms as equivalent, define parser contract
- Leave existing prose; add a Unit 7 parser note that all three forms (`- none`, `- (or: "none")`, empty section) are valid and parsed as "no decisions."
- Don't change the partition rule prose (accept that `## Decisions` and `## Design calls` have a soft overlap).

- **Pros**: No template churn.
- **Cons**: Pushes complexity to Unit 7's parser; future agents continue picking inconsistent forms; partition ambiguity persists.
- **Effort**: Small (Unit 7 design-doc note only).
- **Risk**: Medium (parser-level fix can rot when a fourth form appears).

## Recommended Action

**Option A — approved 2026-04-27 by coord.** Pick `- none` as the
canonical empty-state form (matches protocol-header.md:106 prose; is
shortest; is parser-friendly). Three propagation edits + one prose
sharpening:

1. **Update protocol-header.md:82-84 inline schema box** — replace
   `- (or: "none")` with `- none` so the inline schema and the prose
   at L106 agree.
2. **Add an empty-state worked example** to
   `schema/completion-signal-example.md`. Either a second `## Decisions`
   block showing the empty case, or a comment near the existing
   populated example pointing at the canonical empty-state form.
3. **Sharpen the partition rule** at protocol-header.md:100-109. Add
   one sentence: *"If the next agent could pick a different choice
   and still ship correctly, it goes here. If the next agent would
   break shipped invariants by picking a different choice, it goes
   under **Design calls**."*
4. **Briefing-side parity** (`coordinator-briefing.md`'s
   `(no decisions captured)` placeholder): align with `- none` for
   parity, OR document the divergence explicitly. Coord prefers
   alignment for parser uniformity — pick `- none` here too unless
   the briefing-side prose truly needs the descriptive form.

Removes parser branches in Unit 7 and gives literal-reading agents a
single canonical answer to "how do I render empty Decisions."

Option B (document all three forms as equivalent) rejected — pushes
complexity to Unit 7's parser AND lets the inconsistency rot when a
fourth form appears. One canonical form is the right move.

Dispatch as part of the pre-Unit-7 fixes round 2 PR bundle along
with todos 015, 017, 019.

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/protocol-header.md` (lines 82-84, 100-109)
- `agent-orchestrator/schema/completion-signal-example.md` (lines 51-57; consider adding empty-state example)
- Possibly `agent-orchestrator/templates/coordinator-briefing.md` (briefing-side `(no decisions captured)` parity)

## Acceptance Criteria

- [ ] A literal-reading agent producing an empty-Decisions completion signal has exactly one canonical form to pick.
- [ ] An impl agent reaching for `## Decisions` vs `## Design calls` can decide using a single sharp partition rule.
- [ ] Unit 7's completion-signal parser doesn't need to handle multiple equivalent empty-state forms.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): agent-native-reviewer P2-4 + architecture-strategist P3-1
- `agent-orchestrator/templates/protocol-header.md`
- `agent-orchestrator/schema/completion-signal-example.md`
