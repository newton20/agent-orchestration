---
status: ready
priority: p3
issue_id: "108"
tags: [unit-11, orchestrate, post-pr-19, ce-review, p3-cleanup-bundle, tracking]
dependencies: []
---

# orchestrate: P3 cleanup-wave tracking (bundle)

## Problem Statement

Seventeen P3 mechanical cleanups surfaced in /ce:review of PR #19.
Bundled into one tracking todo per coord dispatch — this entire
bundle ships in **PR #21 cleanup wave**. Mostly `safe_auto`-grade
maintainability / api-contract / cli-readiness / performance / reliability
nits with high reviewer confidence (per the source doc's `Conf` column).

## Findings

Sub-items per /ce:review report (lines 340-362), with reviewer + confidence preserved:

- [ ] **108.a** — `agent-orchestrator/scripts/orchestrate.js:2046` — No-op ternary `effectiveRoleForSignal = isRecovery ? role : role` — maintainability — Conf 100.
- [ ] **108.b** — `agent-orchestrator/scripts/orchestrate.js:1840` — Dead action type `mark_phase_running` — handled, never emitted — maintainability — Conf 100.
- [ ] **108.c** — `agent-orchestrator/scripts/orchestrate.js:942` — Write-only `phaseAdvanced` (9 assignments, 0 reads, suppressed via `void`) — maintainability — Conf 100.
- [ ] **108.d** — `agent-orchestrator/scripts/orchestrate.js:1967` — `isRecovery` / `isInitial` stale-unlink branches are character-identical — maintainability — Conf 100.
- [ ] **108.e** — `agent-orchestrator/scripts/orchestrate.js:3108` — Parsed CLI flag `out.once` set, never consumed — maintainability — Conf 100.
- [ ] **108.f** — `agent-orchestrator/scripts/orchestrate.js:1686` — Lazy per-tick Set init duplicated despite explicit reset in `runOneTick` — maintainability — Conf 100.
- [ ] **108.g** — `agent-orchestrator/scripts/orchestrate.js:305` — Raw-phase lookup pattern duplicated 3× — extract `findRawPhase()` — maintainability — Conf 75.
- [ ] **108.h** — `agent-orchestrator/scripts/orchestrate.js:840` — JSDoc lists action mode `'initial' | 'recovery'`, omits `'review_retry'` — api-contract — Conf 100.
- [ ] **108.i** — `agent-orchestrator/scripts/orchestrate.js:2266` — Stale-flag sweep silently skips on EACCES — re-introduces codex-round-20 bug if cross-user perms appear — reliability — Conf 75.
- [ ] **108.j** — `agent-orchestrator/scripts/orchestrate.js:1358` — Convergence counter: unknown / null `pidAliveReason` path is untested — testing — Conf 75 (advisory).
- [ ] **108.k** — `agent-orchestrator/scripts/orchestrate.js:2486` — Stale-signal mtime cleanup: `statSync`-throws branch is untested — testing — Conf 75.
- [ ] **108.l** — `agent-orchestrator/scripts/orchestrate.js:3107-3113` — `--once` and `--max-ticks` are order-dependent with no warning — cli-readiness — Conf 100.
- [ ] **108.m** — `agent-orchestrator/scripts/orchestrate.js:3132-3134` — `--plugin-dir` does no path-existence check at the CLI boundary — cli-readiness — Conf 75.
- [ ] **108.n** — `agent-orchestrator/scripts/orchestrate.js:3039-3040` — `--help` text for `--once` does not disclose equivalence to `--max-ticks 1` — cli-readiness — Conf 100.
- [ ] **108.o** — `agent-orchestrator/scripts/orchestrate.js:1161-1170, 978` — Multi-role completion aggregation re-parses sibling role signals N² times per tick — performance — Conf 75.
- [ ] **108.p** — `agent-orchestrator/scripts/orchestrate.js:584-591` — `buildPidSnapshot` re-parses same PowerShell JSON once per session name — performance — Conf 100.
- [ ] **108.q** — `agent-orchestrator/scripts/orchestrate.js:3241-3246` — `main()` error path skips `removeListener` for SIGINT/SIGTERM (cosmetic — process is exiting) — reliability — Conf 100.

## Proposed Solutions

### Option A — Implement all 17 sub-items in PR #23 cleanup wave (recommended)
- Each sub-item is a documented `safe_auto`-grade fix. Implementer applies per-item per the description.
- Pros: closes the entire P3 backlog in one wave. Effort: small (most are 1-3 LOC).

### Option B — Defer low-conf items (Conf 75) to V1.5
- Cherry-pick only Conf-100 items.
- Cons: bookkeeping for 8 deferred items; perpetual P3 queue.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** All 17 sub-items in PR #23 cleanup wave. Implementer follows each sub-item's reviewer + confidence guidance verbatim from the body checklist. Note: the body's reference to "PR #21" is a stale label from the source /ce:review doc; the cleanup wave is now PR #23 (PR #20-22 numbering shifted; see post-PR-19 triage history).

## Technical Details

- Primary file: `agent-orchestrator/scripts/orchestrate.js` (line refs preserved per sub-item).
- Test surface: `agent-orchestrator/scripts/orchestrate.test.js` (for 108.j / 108.k coverage gaps).

## Acceptance Criteria

- [ ] All 17 sub-items in the body checklist closed (boxes checked with cite-of-fix-commit each).
- [ ] No regression in existing tests after each sub-item lands.
- [ ] Tests added for 108.j (convergence counter unknown reason) and 108.k (stale-signal statSync-throws branch) per sub-item descriptions.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (lines 340-362, P3 cleanup table)
