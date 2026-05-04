---
status: pending
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

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/orchestrate.test.js` (lines 749, 3512, 4836, 4966)
  - `agent-orchestrator/scripts/orchestrate.js:457` (impl path needing coverage)

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (lines 328-336, P2 testing/coverage gaps table)
