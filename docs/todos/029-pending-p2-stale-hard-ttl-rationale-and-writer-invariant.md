---
status: pending
priority: p2
issue_id: "029"
tags: [code-review, post-pr-9, ce-review, hooks, unit-11, docs, plan-update]
dependencies: []
---

# STALE_HARD_TTL_MS source-comment rationale + plan §1083 update + writer atomic-rename invariant

PR #9 added `STALE_HARD_TTL_MS = 10 * FLAG_TTL_MS` (10 minutes) for the
two-tier TTL GC. Three ce:review agents flagged related gaps in the
contract documentation that are worth addressing as one bundle.

## Problem Statement

Three related gaps surfaced by PR #9 ce:review:

1. **Source-comment thin on the 10× ratio.** `session-start.js:23-29`
   says "10 × FLAG_TTL_MS ⇒ 600_000 ms / 10 minutes — long enough for
   a user to inspect a failed spawn, short enough to keep the candidate
   scan bounded." The pattern-recognition agent noted that the
   rationale for 10× *specifically* (vs 5× or 30×) lives only in
   `docs/todos/005:108-125`. A future tuner reading the source will see
   "10 minutes is reasonable" but not the framing that justifies the
   10× multiplier — making the constant feel arbitrary.

2. **Plan §1083-1090 enumerates 4-element exported surface; actual is
   5.** `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
   says the hook's lockstep export is `{ runHook, FLAG_TTL_MS,
   MAX_FLAG_BYTES, FLAG_NAME_RE }`. PR #9 added `STALE_HARD_TTL_MS` to
   the exports (`session-start.js:157-163`). A Unit 11 implementer
   reading the plan first gets a stale surface description.

3. **Writer-side atomic write-then-rename invariant is undocumented.**
   The `hooks/README.md` "Contract invariants" section (added by PR #9
   for the regex pair + two-tier TTL) doesn't mention that Unit 11
   writers MUST place `.pending-<id>` files via atomic write-then-
   rename. Without atomic write, the hook's `statSync` could see a
   0-byte mid-write file with mtime "now" and pass the freshness gate
   only to fail size-guard or read mid-stream. The architecture-
   strategist agent flagged this as the only load-bearing-but-undocumented
   writer-side invariant.

## Findings

- **Pattern-recognition (P2-2):** "The 10× ratio rationale is under-
  explained at the source. A future editor tuning this constant after
  Unit 11 ships will see only '10 × FLAG_TTL_MS = 10 minutes' and not
  the framing that justifies the 10× ratio specifically."
- **Architecture-strategist (P2-2):** "The writer-side contract Unit 11
  must honor is now five items. Atomic tmp+rename is the only invariant
  that's currently load-bearing-but-undocumented."
- **Architecture-strategist (P2-2):** "Plan §1083-1090 says the hook's
  lockstep export is `{ runHook, FLAG_TTL_MS, MAX_FLAG_BYTES,
  FLAG_NAME_RE }` — four items. It does not yet include
  `STALE_HARD_TTL_MS`."
- **Learnings (L3):** Cross-references the existing solution doc
  `docs/solutions/integration-issues/claude-code-sessionstart-hook-windows.md`
  Prevention #4 which already mandates atomic-rename for the hook side
  but not symmetrically for the writer side.

## Proposed Solutions

### Option A — Three-part doc update

1. **Source comment** at `session-start.js:23-29`: append a sentence
   like "Smaller multipliers (5×, 3×) shrink statSync cost faster but
   compress the failed-spawn debug window below the human inspection
   time. 10× chosen as the smallest multiplier that gives a useful
   debug window." (1-2 lines.)
2. **Plan update** at `docs/plans/.../plan.md:1083-1090`: add
   `STALE_HARD_TTL_MS` to the enumerated export list.
3. **Hooks README Contract invariants**: add a bullet
   `Writers (Unit 11) must place .pending-<id> via atomic write-then-
   rename so the hook's freshness gate doesn't observe a partial file.`

- **Pros:** Closes all three gaps with minimal churn.
- **Cons:** Multi-file edit; needs coordinated review.
- **Effort:** Small (~10 LOC across 3 files).
- **Risk:** None.

### Option B — Just the README writer-invariant; defer source/plan

Add only the writer-side atomic-rename invariant to the README. Leave
source and plan untouched until Unit 11 implementer finds them stale.

- **Pros:** Smallest edit.
- **Cons:** Plan rot persists; future tuner of `STALE_HARD_TTL_MS`
  still has thin rationale.
- **Effort:** Trivial.
- **Risk:** Plan stays out of sync.

### Option C — Defer until Unit 11 dispatch

Roll all three doc updates into the Unit 11 dispatch handoff. Plan
amendments are routinely deferred per project workflow.

- **Pros:** Lets Unit 11 dispatch be the single gathering point for
  the writer-side contract.
- **Cons:** Three months of stale plan / source / README before that
  dispatch lands.
- **Effort:** Zero now.
- **Risk:** Low.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- `agent-orchestrator/hooks/session-start.js:23-29` (source comment)
- `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md:1083-1115`
  (plan export-list update)
- `agent-orchestrator/hooks/README.md` Contract invariants section
  (writer atomic-rename bullet)
- No code change; doc-only.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A or B: README documents writer-side atomic write-then-rename.
- [ ] If A: source comment justifies the 10× ratio specifically.
- [ ] If A: plan §1083 enumerates all five exports.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #9 ce:review
  (architecture + pattern + learnings agents converged).

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 005 (closed): `docs/todos/005-complete-p2-unit-5-stale-flag-accumulation.md`
- Existing solution doc:
  `docs/solutions/integration-issues/claude-code-sessionstart-hook-windows.md`
  Prevention #4 (hook-side atomic-rename already documented; this
  todo extends symmetrically to the writer side).
