---
status: complete
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

**Option A — approved 2026-04-28 by coord.** Three-part doc update,
all small, all load-bearing for Unit 11:

1. **Source-comment expansion at `session-start.js:23-29`.** Add the
   10× ratio rationale inline so future tuners see it without
   trail-following: e.g. "10 × FLAG_TTL_MS ⇒ 600_000 ms / 10 minutes.
   The 10× multiplier (vs 5× or 30×) is chosen so the GC window is
   long enough to inspect a failed spawn (typical post-incident
   investigation arrives within minutes) and short enough to keep the
   per-tick `statSync` count bounded by realistic crash recency. See
   docs/todos/005:108-125 for the soft-vs-hard-TTL framing."

2. **Plan §1083-1090 update.** Edit
   `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
   to update the hook's lockstep export surface from
   `{ runHook, FLAG_TTL_MS, MAX_FLAG_BYTES, FLAG_NAME_RE }` (4
   elements) to
   `{ runHook, FLAG_TTL_MS, STALE_HARD_TTL_MS, MAX_FLAG_BYTES, FLAG_NAME_RE }`
   (5 elements). Critical for Unit 11 readability since Unit 11
   reads the plan first and must require the correct exports.

3. **Writer atomic-rename invariant in `hooks/README.md`.** Add a
   bullet to the "Contract invariants" section: "Writers (Unit 11
   orchestrator, manual debugging tools) MUST place
   `.pending-<id>` files via atomic write-then-rename
   (`writeFileSync(tmpPath, content); renameSync(tmpPath, flagPath)`),
   never via direct `writeFileSync(flagPath, content)`. Without
   atomic write, the hook's `statSync` could see a 0-byte mid-write
   file with mtime=now and pass the freshness gate only to fail
   size-guard or read mid-stream. The hook deletes via atomic rename
   on consume; writers must be symmetric on creation."

Option B (just the README writer-invariant; defer source/plan)
leaves Unit 11's plan-reading on a stale 4-export claim — that's a
Unit 11 readability bug, not a deferral candidate. Option C (defer
all until Unit 11 dispatch) misses the chance to fix three small
gaps now in a single bundle.

Dispatch as part of the pre-Unit-7 round 3 PR bundle along with
todos 027, 028, 030, 031. ~10-15 LOC across 3 files.

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
- **2026-04-28 — merged via PR #11** (`feat(templates): pre-Unit-7
  fixes round 3`). Option A (three-part doc update) implemented:
  (1) `STALE_HARD_TTL_MS` rationale comment expanded at
  `session-start.js:23-32` with the 10× vs 5×/30× framing;
  (2) plan `§1083` updated 4 → 5 elements
  (`{ runHook, FLAG_TTL_MS, STALE_HARD_TTL_MS, MAX_FLAG_BYTES, FLAG_NAME_RE }`)
  + a paragraph explaining why Unit 11 writers must understand
  `STALE_HARD_TTL_MS`'s GC effect; (3) writer atomic-rename invariant
  added to `hooks/README.md` "Contract invariants". PR #11
  ce:review's architecture-strategist surfaced one P3 follow-up
  (`docs/todos/037` — atomic-rename invariant is prose-only; a
  contract test belongs in Unit 11's PR alongside the writer
  itself).

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 005 (closed): `docs/todos/005-complete-p2-unit-5-stale-flag-accumulation.md`
- Existing solution doc:
  `docs/solutions/integration-issues/claude-code-sessionstart-hook-windows.md`
  Prevention #4 (hook-side atomic-rename already documented; this
  todo extends symmetrically to the writer side).
