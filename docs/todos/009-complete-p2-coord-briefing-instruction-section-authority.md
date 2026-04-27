---
status: complete
priority: p2
issue_id: "009"
tags: [code-review, templates, coord, session-handoff-coupling, unit-6]
dependencies: []
---

# coordinator-briefing.md `## Instructions` heading collides with session-handoff `Instructions` semantics

## Problem Statement

`agent-orchestrator/templates/coordinator-briefing.md` and `~/.claude/skills/session-handoff/references/message-templates.md` both ship a section called `## Instructions`, but the section means different things in each artifact:

- **coordinator-briefing**: `## Instructions` carries `{{coord_next_actions}}` — a *recommended* next action the coord may diverge from with reason (per `coordinator-briefing.md:84-90`).
- **session-handoff `brief`**: `## Instructions` carries the user's `INSTRUCTIONS` parameter verbatim, treated as authoritative directive (per `references/message-templates.md:188-204`).

A coord-agent that reads either artifact and treats `## Instructions` with the wrong authority semantics will misroute work. The PR claims shape-compatibility ("a coordinator reading either should not be able to tell them apart" — `coordinator-briefing.md:11-13`) but the same heading-name carries different authority by design.

The PR's only enforcement is the prose pact in `coordinator-briefing.md:11-13` ("If you extend the section list below, also extend the session-handoff skill's fragment list so the two stay aligned"). No test asserts the shapes match. The session-handoff skill lives in a separate repo (`C:\Users\dunliu\projects\claude-skills`) under independent version control — drift will be silent.

## Findings

- Architecture review (PR #5 ce-review round): "Same section name, different authority semantics. A coord reading a 'you decide whether to follow' block as an 'authoritative user directive' misroutes work."
- Agent-native review (same round): coord briefing's `## Instructions` divergence-recording instruction is unimplementable as written (the coord's downstream artifacts via `impl-prompt.md` or session-handoff don't have a Decisions output section).
- Pattern-recognition review (P3-A2): coord-briefing section ordering also diverges from session-handoff `brief` primary slotting (Instructions appears at section 7 instead of after Open questions).

## Proposed Solutions

### Option A — Rename the heading to disambiguate
Change `## Instructions` in `coordinator-briefing.md` to `## Dispatched next action` (or similar) so the heading itself signals the lower authority. Update the matching variable name in the catalog if helpful.

- **Pros**: One-line change; eliminates the authority-semantics confusion at the source; preserves session-handoff's `Instructions` semantics for users who read both.
- **Cons**: Diverges from session-handoff structurally — readers who memorized session-handoff's section order will look for `## Instructions` and find none.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Add upstream-coupling note + version pin
Keep the heading. Add a `## Upstream coupling` note in `coordinator-briefing.md` or `templates/README.md` naming the upstream skill path and a SHA / version comment of the message-templates.md being mirrored. Add a TODO: when `~/.claude/skills/session-handoff` updates, manually verify shape parity.

- **Pros**: Preserves the "indistinguishable" goal; documents the coupling explicitly.
- **Cons**: Doesn't fix the authority-semantics confusion, only documents it. Manual parity check will rot.
- **Effort**: Small.
- **Risk**: Medium (silent drift).

### Option C — Add a parity test
Defer to Unit 7 or beyond: extract section heading list from message-templates.md as a fixture, write a node:test that compares coord-briefing.md's heading list against it, fail CI on drift.

- **Pros**: Catches drift automatically; works even if both repos evolve independently.
- **Cons**: Cross-repo dependency in test — needs a path or fetched copy of the upstream skill. Adds CI complexity.
- **Effort**: Medium.
- **Risk**: Low.

## Recommended Action

**Option A — approved 2026-04-26 by coord.** Rename
`coordinator-briefing.md`'s `## Instructions` heading to
`## Dispatched next action` (and rename `coord_next_actions` →
`coord_dispatched_next_action` in the catalog if that improves
clarity, otherwise keep the variable name unchanged for minimal
churn). The "indistinguishable from session-handoff" goal was
always going to be a prose pact, not a guarantee — making the
heading distinct is more honest and eliminates the authority-
semantics confusion at the source.

This change ALSO closes todo 014 F2 (coord has nowhere to record
divergence): drop the unimplementable "record divergence under your
own Decisions block" instruction together with the rename. The
revised section reads as recommend-only, no implementation gap to
patch.

Option B (upstream coupling note + version pin) rejected — silent
drift remains the failure mode; documentation alone doesn't fix
it. Option C (parity test) rejected for V1 — cross-repo dependency
in CI is heavy for a problem Option A solves at the source.

Dispatch as part of the pre-Unit-7 template-fixes PR bundle along
with todos 010, 011, 014.

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/coordinator-briefing.md` (sections 7 + 8 + the "Conventions" footer)
- `agent-orchestrator/templates/README.md` (catalog entry for `coord_next_actions`)
- Possibly: `agent-orchestrator/scripts/` (new parity-check test)

**Database changes**: None.

**Cross-cutting**: This issue is the templates-side mirror of upstream skill drift; addressing it likely requires aligning with the session-handoff skill's maintainer.

## Acceptance Criteria

- [ ] A coord-agent reading either coordinator-briefing.md output or session-handoff `brief coord` output cannot mistake recommend-only content for authoritative content.
- [ ] The chosen mitigation is documented in `templates/README.md` so future template authors know the constraint.
- [ ] Optional: a CI check or fixture catches future shape drift.

## Work Log

(empty)

## Resources

- PR #5 ce-review round: architecture review
- `~/.claude/skills/session-handoff/references/message-templates.md` (upstream skill — sections 188-204)
- `agent-orchestrator/templates/coordinator-briefing.md` (in-repo template)
