---
status: pending
priority: p3
issue_id: "060"
tags: [code-review, post-pr-13, ce-review, templates, agent-native, prose-flow]
dependencies: []
---

# Empty `prior_phase_dirs` leaves the "Each path above" prose dangling

PR #13 ce:review agent-native-reviewer noted that when a phase has
no upstream dependencies, the rendered protocol header's prose
sentence "Each path above points at an upstream phase's completion
signal" refers to nothing — the bullet body is empty. Minor agent
friction; the parenthetical "(empty if this phase has no upstream
dependencies)" handles the case, but the next paragraph still
addresses an empty antecedent.

## Problem Statement

`agent-orchestrator/templates/protocol-header.md:34-39` renders the
following when `prior_phase_dirs` is empty:

```
- **Prior phase outputs you may read (one per line; empty if this phase has no upstream dependencies):**


Each path above points at an upstream phase's completion signal. Read
them before starting work.
```

Two issues:

1. There's a blank line where paths would go (correctly empty).
2. The follow-up sentence "Each path above points at an upstream
   phase's completion signal" has no antecedent. An LLM agent may
   pause to reconcile the contradiction or interpret it as a
   missing render.

The parenthetical inside the bullet does the lifting, but the
prose flow is unpolished.

## Findings

PR #13 ce:review agent-native-reviewer P3:

> "Empty-state rendering for `prior_phase_dirs` leaves the prose
> sentence 'Each path above points at an upstream phase's
> completion signal' dangling — there's no path above. The bullet
> parenthetical handles the case but the next paragraph
> doesn't. Either reflow the prose to be empty-safe ('Read each
> path before starting work — if the bullet above is empty, this
> phase has no upstream dependencies') or render a sentinel
> placeholder like `(no upstream dependencies)` matching the
> coord empty-state pattern."

## Proposed Solutions

### Option A — Reflow the prose to be empty-safe

Replace the full paragraph at
`agent-orchestrator/templates/protocol-header.md:38-40` (NOT just
line 38; the absolute-path instruction at line 40 is load-bearing
and must be preserved — codex round 7 caught the original
triage's reflow dropping it):

```
Read each path before starting work. If the bullet above is empty,
this phase has no upstream dependencies — proceed directly. Paths
are absolute — do not interpret relative paths against your
shell's cwd for protocol files.
```

- **Pros:** Single template edit. Reads correctly in both empty
  and non-empty cases. No conditional rendering needed. Preserves
  the absolute-path invariant the existing paragraph carries.
- **Cons:** Slightly more words; agent has to read a conditional
  sentence even when the case is obvious.
- **Effort:** Trivial.
- **Risk:** None — load-bearing absolute-path instruction is
  retained.

### Option B — Defer

`agent-orchestrator/templates/README.md` "Empty-state rendering"
guidance: "The surrounding template has been written to read
correctly in that case." Today's template arguably satisfies that
because the parenthetical inside the bullet announces the case.
The dangling-antecedent issue is real but subordinate.

- **Pros:** Zero churn.
- **Cons:** Polish gap persists.
- **Effort:** Zero.
- **Risk:** None.

### Option C — Use a sentinel placeholder

Render `(no upstream dependencies)` (matching the coord empty-state
pattern in EMPTY_STATE_PLACEHOLDERS) when `prior_phase_dirs` is
empty. The "Each path above" prose then refers to the sentinel
literal — still dangling, but textually grounded.

- **Pros:** Consistent with coord empty-state pattern. Visible
  anchor for the prose.
- **Cons:** Requires a new entry in EMPTY_STATE_PLACEHOLDERS, a
  README catalog update, and a test update. Lockstep edit. Doesn't
  fully fix the antecedent problem (the prose still says "path"
  but renders "(no upstream dependencies)").
- **Effort:** Small.
- **Risk:** Low.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected file (Option A):
  `agent-orchestrator/templates/protocol-header.md:38-39`
- No script-side change for Option A.
- Option C requires `agent-orchestrator/scripts/generate-prompt.js`
  EMPTY_STATE_PLACEHOLDERS update + README catalog edit.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: rendered output for an empty `prior_phase_dirs` reads
  coherently end-to-end.
- [ ] If C: empty-state sentinel matches coord pattern; lockstep
  test references the new placeholder.
- [ ] No regressions in the non-empty case.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (agent-native-reviewer P3). Coord triage pending.
- **2026-04-29 — corrected via codex round 7 on triage PR** —
  original Option A reflow replaced only the dangling sentence
  and silently dropped the load-bearing absolute-path
  instruction at line 40 of protocol-header.md ("Paths are
  absolute — do not interpret relative paths against your
  shell's cwd for protocol files"). Codex correctly noted this
  would either leave that line orphaned or strand a protocol
  invariant. Rewrote the proposed reflow to span the full
  paragraph (lines 38-40) and include the absolute-path
  instruction in the new wording.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/templates/protocol-header.md:34-39`
- `agent-orchestrator/templates/README.md` "Empty-state rendering"
  decision.
- Coord empty-state placeholder pattern in
  `agent-orchestrator/scripts/generate-prompt.js`
  EMPTY_STATE_PLACEHOLDERS.
