---
status: ready
priority: p2
issue_id: "107"
tags: [unit-11, orchestrate, post-pr-19, ce-review, testing, coverage-gaps, bundle]
dependencies: []
---

# orchestrate: P2 testing / coverage gaps (bundle)

## Problem Statement

Five testing / coverage gaps surfaced in /ce:review of PR #19. Bundled
into one tracking todo per coord dispatch (the /ce:review doc lines
328-336 specify this single-bundle approach for P2 testing gaps). Each
sub-item is independently addressable but they share a single class:
the test-suite asserts shapes / signals weakly enough that real bugs
could survive.

## Findings

Sub-items per /ce:review report:

- [ ] **107.a** — `agent-orchestrator/scripts/orchestrate.test.js:3512` — Test X3 is vacuous (`assert.ok(true)` with no functional check). Test count 179 over-states real coverage by 1.
- [ ] **107.b** — `agent-orchestrator/scripts/orchestrate.test.js:4836` — Test AL1 hardcodes `FLAG_NAME_RE` instead of importing from `../hooks/session-start`. The cross-module poison-pill invariant becomes a copy-paste; if the source-of-truth regex changes, the test silently drifts.
- [ ] **107.c** — `agent-orchestrator/scripts/orchestrate.js:457` — Stale-lock reclaim `ENOENT` branch (rename-loser path) is untested.
- [ ] **107.d** — `agent-orchestrator/scripts/orchestrate.test.js:749` — Recovery max-3 inner boundary not asserted (no test for `retry_count=2 → spawn iteration=3`); off-by-one `>=`→`>` swap would still pass H1/H2/H4.
- [ ] **107.e** — `agent-orchestrator/scripts/orchestrate.test.js:4966` — AM1 secondary lock test is incomplete: never asserts `r1` actually acquired the workdir lockfile, never asserts cleanup, no samePath / Windows-case-insensitive branch.

## Proposed Solutions

### Option A — Address all 5 sub-items in cleanup wave (recommended)
- All 5 are small (1-test each); no reason to split.
- Pros: closes the bundle in one pass. Effort: small.

### Option B — Cherry-pick highest-value 2-3
- Pick 107.b (FLAG_NAME_RE import — cross-module invariant) + 107.d (recovery max-3 boundary — convergence guarantee).
- Cons: leaves easy wins on the table.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** All 5 sub-items in PR #23 cleanup wave. Each is a focused test addition or fix; no design judgment needed beyond what's already documented in the sub-item descriptions.

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/orchestrate.test.js` (lines 749, 3512, 4836, 4966)
  - `agent-orchestrator/scripts/orchestrate.js:457` (impl path needing coverage)

## Acceptance Criteria

- [ ] 107.a — Test X3 has functional check beyond `assert.ok(true)`; reported test count reflects real coverage.
- [ ] 107.b — AL1 imports `FLAG_NAME_RE` from `../hooks/session-start` (no copy-paste).
- [ ] 107.c — Stale-lock reclaim ENOENT branch covered by a test (rename-loser path).
- [ ] 107.d — Recovery max-3 inner boundary asserted: `retry_count=2 → spawn iteration=3` test exists; `>=` vs `>` swap fails the test.
- [ ] 107.e — AM1 secondary-lock test asserts r1 acquired the workdir lockfile + cleanup happens + samePath / case-insensitive Windows branch covered.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (lines 328-336, P2 testing/coverage gaps table)
