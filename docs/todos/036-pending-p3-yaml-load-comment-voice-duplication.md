---
status: pending
priority: p3
issue_id: "036"
tags: [code-review, post-pr-11, ce-review, simplicity, pattern, scripts, yaml]
dependencies: []
---

# yaml.load DEFAULT_SCHEMA pin comments — voice mismatch + near-duplicate prose across 3 sites

PR #11 closed todo 031 by pinning all three `yaml.load` sites to
`DEFAULT_SCHEMA` and rewriting the comment at each site to use parity /
intent / merge-keys framing only (per the todo 031 Caveat). Pattern +
simplicity reviewers on PR #11 ce:review both flagged minor cosmetic
inconsistencies in the result.

## Problem Statement

The three explicit-pin sites are:

- `agent-orchestrator/scripts/parse-manifest.js:161-164` — `loadManifest()`
- `agent-orchestrator/scripts/parse-manifest.js:726-729` — `runUpdate()`
- `agent-orchestrator/scripts/spawn-session.js:284-287` — `loadLauncherFromManifest()`

Two cosmetic findings:

1. **Voice mismatch.** The two parse-manifest sites use imperative
   "**Pin** schema explicitly..." while spawn-session uses past
   participle "**Pinned** to DEFAULT_SCHEMA...". Both are grammatical
   and semantically identical, but the repo's other imperative
   comment leads (e.g. `parse-manifest.js:79` "ID character class.
   Must stay in sync...") suggest "Pin" is the house default.
2. **Near-duplicate prose with per-site cross-references.** All three
   blocks close on the verbatim clause "preserves merge keys (`<<`)
   and timestamps; making the choice explicit at every site documents
   intent." The cross-references at each site point to the *other
   two* by name ("for parity with spawn-session.js's launcher-manifest
   load and the runUpdate() status-file load below" / etc.).

The pattern reviewer on PR #11 explicitly judged the duplication
**acceptable** (each comment serves its local context; centralizing
into a constant would lose the per-site cross-reference). The
simplicity reviewer reached the same verdict ("acceptable DRY
violation for context-locality"). So this is **prose polish**, not
a structural defect.

## Findings

PR #11 ce:review session:

- **Pattern-recognition (P3):** "minor 'Pin'/'Pinned' voice mismatch
  across the three yaml.load sites... if a future round wanted to
  pick one shape, 'Pin schema explicitly' matches the repo's other
  imperative comment leads."
- **Code-simplicity (P3):** "Total potential LOC reduction: ~5 LOC
  if the two P3 nits were addressed (out of +87 LOC). Not worth the
  churn."
- **Architecture (P3):** "Three identical 'parity for parity's sake'
  comments could collapse to a one-liner + cross-reference. Either
  is fine; collapsing is a future-cleanup refinement, not a defect."

## Proposed Solutions

### Option A — Tighten voice only (parse-manifest stays imperative; rewrite spawn-session to match)

Change `spawn-session.js:284` from "Pinned to DEFAULT_SCHEMA..." to
"Pin schema explicitly..." and re-flow the surrounding clause to
match the parse-manifest sites. Keep all three blocks as separate
comments.

- **Pros:** Smallest edit. Restores voice consistency.
- **Cons:** Doesn't address duplication. Pure cosmetic.
- **Effort:** Trivial (1-2 LOC).
- **Risk:** None.

### Option B — Collapse to a one-liner at each site + a single shared explainer above one of them

Pick one site (probably the launcher load in spawn-session.js since
todo 004's history makes it the canonical "schema choice was
deliberate" anchor). Keep its 4-line explainer. The other two sites
become 1-line comments: `// Pin schema explicitly — see spawn-session.js:284 for rationale.`

- **Pros:** Saves ~6 LOC. Single source of truth for the rationale.
- **Cons:** Cross-file pointer for a one-line schema arg adds
  reader-friction; pattern reviewer specifically flagged this as
  inferior to the current local-context comments.
- **Effort:** Small.
- **Risk:** Mild — the rationale is now anchored to a specific file
  position; renaming functions or moving sites could orphan the
  pointer.

### Option C — Defer entirely (V1-freeze posture)

Leave all three comments as-is. Address only if a future PR is
already touching one of these sites for unrelated reasons.

- **Pros:** Zero churn during the V1 freeze. Both reviewers
  explicitly judged this acceptable.
- **Cons:** Voice mismatch persists.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

**Triage: leave for post-Unit-7 doc cleanup PR.** PR #11's ce:review
reviewers all classified this as P3 prose-polish that V1-freeze
explicitly defers. If a future PR touches `parse-manifest.js` or
`spawn-session.js` for unrelated work, fold Option A in opportunistically
(1-2 LOC, no risk). Option B is overengineering for cosmetic-only
gain. Don't dispatch a dedicated PR for this alone.

## Technical Details

- Affected files (Option A or B):
  - `agent-orchestrator/scripts/parse-manifest.js:161-164`
  - `agent-orchestrator/scripts/parse-manifest.js:726-729`
  - `agent-orchestrator/scripts/spawn-session.js:284-287`
- No test changes (purely comment rewording).
- No production behavior change.

## Acceptance Criteria

- [ ] Triage captures chosen Option (A / B / C).
- [ ] If A: voice across all three sites is consistent ("Pin..." or
  "Pinned..." — pick one).
- [ ] If B: one anchor site has the full rationale, two pointer
  sites have one-line cross-references.
- [ ] No production behavior change; tests still 158 green.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (pattern + simplicity + architecture agents converged on this as
  P3 cosmetic; coord deferred per V1-freeze).

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 031 (closed by PR #11): the source comment contract that this
  todo refines.
- PR #9 simplicity reviewer's V1-freeze recommendation (PR #7
  carry-forward).
