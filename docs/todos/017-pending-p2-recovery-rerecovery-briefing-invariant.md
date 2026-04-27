---
status: pending
priority: p2
issue_id: "017"
tags: [code-review, templates, recovery, unit-7]
dependencies: []
---

# Re-recovery audit step has unstated invariant about `previous_phase_briefing` stability across crash chain

## Problem Statement

PR #6's original-prompt preservation contract (templates/README.md §5) is well-designed for the FIRST crash: orchestrator copies `${role}-prompt.md` → `${role}-prompt.original.md` if-not-exists, then overwrites with the recovery prompt. The "if-not-exists" idempotency guard correctly preserves the FIRST non-recovery prompt across re-recovery chains.

The trust-chain gap is in the audit step's semantics on the SECOND recovery. When recovery-prompt.md's audit reads `${role}-prompt.original.md` (the FIRST non-recovery prompt) and inspects its `## Previous phase context` block, it compares against the briefing the SECOND recovery dispatch passed via `{{previous_phase_briefing}}`. These should be the same data, but they are now compared two crashes apart — the orchestrator might legitimately have changed the briefing between recoveries (e.g., a new upstream completed in the interim). The audit cannot distinguish that legitimate update from "second-recovery dispatcher dropped context."

This is not a bug in the V1 design — it's an unstated assumption that *recovery dispatches preserve `previous_phase_briefing` across a re-recovery chain unchanged*. That assumption is reasonable and probably correct (Unit 7 will re-render with the same depends_on inputs), but it's not written down anywhere. If Unit 7 ever adds "refresh upstream briefing on recovery dispatch," the audit step starts producing false-positive blocks.

## Findings

- /ce:review architecture-strategist (PR #6) P2-3: "Recovery trust chain has a gap when the original prompt was a recovery prompt itself (re-recovery case). The trust-chain gap is in the audit step's semantics on the second recovery... The audit cannot distinguish a legitimate update from 'second-recovery dispatcher dropped context.'"

## Proposed Solutions

### Option A — Document the invariant in README §5
Add one sentence to templates/README.md's section 5 (Original-prompt preservation contract): *"On a re-recovery dispatch, the `previous_phase_briefing` passed to the recovery prompt MUST equal the briefing from the most-recent prior recovery dispatch (or, if none, the original dispatch). The recovery template's audit step compares against `${role}-prompt.original.md` — drift between the original and a re-recovery's briefing will produce a false `status: blocked`."*

- **Pros**: One sentence; pins Unit 7's contract to the audit step's assumption; future-proofs against well-meaning "refresh briefing on recovery" PRs.
- **Cons**: Documentation only — no enforcement.
- **Effort**: Small.
- **Risk**: Low.

### Option B — Snapshot the briefing alongside the original prompt
Have Unit 7 write `${role}-prompt.original.briefing.md` (or include the briefing in `${role}-prompt.original.md`'s rendered content) on the FIRST preservation, then have recovery's audit compare the CURRENT briefing against that snapshot rather than re-parsing the original prompt's `## Previous phase context` block.

- **Pros**: Eliminates the unstated invariant; audit becomes a direct equality check.
- **Cons**: Adds a second preserved-artifact path; slightly more complex Unit 7 contract.
- **Effort**: Medium.
- **Risk**: Low.

### Option C — Allow briefing drift; remove the audit step's "block on non-empty original briefing" rule
Recovery's audit currently blocks when the original was non-empty AND the recovery briefing is empty. Replace that rule with "If your CURRENT briefing is empty AND the original briefing was non-empty, look up the recovery checkpoint and `git status` for evidence of partial impl work; if you can confirm the original briefing's design invariants were respected, proceed; otherwise block."

- **Pros**: More permissive; handles legitimate briefing refresh.
- **Cons**: Makes the audit step squishier; harder for the agent to follow; loses the "missing context = blocked" tripwire that the codex P2 (round 6) put in place.
- **Effort**: Medium.
- **Risk**: Medium (loses safety property).

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected files:**
- `agent-orchestrator/templates/README.md` (section 5, around line 242)
- Possibly `agent-orchestrator/templates/recovery-prompt.md` (audit step at lines 77-98)

## Acceptance Criteria

- [ ] A future Unit 7 contributor knows whether `previous_phase_briefing` may legitimately drift across recovery dispatches.
- [ ] The recovery template's audit step does not produce false-positive `status: blocked` on legitimate re-recovery.

## Work Log

(empty)

## Resources

- /ce:review (PR #6): architecture-strategist P2-3
- `agent-orchestrator/templates/README.md`
- `agent-orchestrator/templates/recovery-prompt.md`
