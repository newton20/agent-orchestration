---
status: complete
priority: p2
issue_id: "109"
tags: [unit-11, orchestrate, post-pr-19, re-codex-round-2, reconciliation, wrapper-pid, already-in-main]
dependencies: []
---

# orchestrate: wrapper PIDs in reconciliation snapshot — already excluded via buildPidSnapshot

## Problem Statement

The reconciliation snapshot pass added in PR #19 fix commit `c1bd625`
(closing the P2 cluster around todo 097) builds its live-PID set from
a raw PID list which can include **wrapper PIDs** — `cmd.exe`,
`powershell.exe`, the agency wrapper — rather than the **inner Claude
PID** that the rest of the manifest-status pipeline tracks. When
reconciliation compares the snapshot against `prev.pid` from
manifest-status, the comparison can match against a wrapper PID and
mis-classify a stranded session as alive (or vice versa).

Same root cause as todo 073's `excludeWrappers` flip in
`get-session-pid` (closed in PR #15) — but at a *different* call site
that didn't pick up the flip. The fix is symmetric: the reconciliation
snapshot must use `excludeWrappers: true` (or its equivalent
filter step) so only inner Claude PIDs land in the snapshot.

## Findings

- Reconciliation snapshot (added in PR #19 commit `c1bd625`) uses raw PID list including wrapper PIDs.
- Inner Claude PID is what reconciliation should compare against (matches manifest-status `pid` field semantics).
- Surfaced by re-codex Round 2 of PR #19 — held off the P1 gate as P2 because it is a soft mis-classification (not a data-loss class), but worth closing in the cleanup wave.

## Proposed Solutions

### Option A — Pass excludeWrappers: true at the snapshot call site (recommended)
- The reconciliation snapshot's PID-lookup call site missed the new default from todo 073's flip. Either it explicitly passes `false` (override) or it's calling a different primitive that didn't pick up the default. Pass `true` explicitly.
- Pros: minimal change; uses existing primitive; consistent with the rest of the codebase. Effort: trivial. Risk: low.

### Option B — Filter wrapper PIDs at the comparison layer
- Build the snapshot raw, then filter wrapper PIDs in the comparison loop.
- Cons: duplicates wrapper-detection logic that already lives in spawn-session.

## Recommended Action

**Closed as already-in-main — verified 2026-05-04 post-codex round 1 of PR #22.** The reconciliation pass at `orchestrate.js:1062-1106` reads its `pidSnapshot` from the result of `buildPidSnapshot` (`orchestrate.js:704`), which calls `parsePidLookupOutput(stdout, name, { excludeWrappers: true })` at `orchestrate.js:723`. So wrapper PIDs (cmd.exe / powershell.exe / agency wrapper) are already filtered out before reconciliation compares against `prev.pid`. The original re-codex Round 2 finding either misidentified the call site or the fix landed inside PR #19 itself before re-codex completed.

No new work needed in PR #23. If a future call site introduces a raw PID lookup that bypasses `buildPidSnapshot`, re-open this todo with the new site cited.

## Technical Details

- Verified call site: `agent-orchestrator/scripts/orchestrate.js:723` inside `buildPidSnapshot` (`orchestrate.js:704`). Reconciliation at `orchestrate.js:1062-1106` consumes the resulting `pidSnapshot` via `pollAllPhases`'s return shape (`orchestrate.js:1039`).
- Cross-reference: todo 073 (closed) — `get-session-pid` `excludeWrappers` default flip; the post-073 default is what `buildPidSnapshot` passes through.
- Cross-reference: PR #19 fix commit `c1bd625` — re-round close of P2 cluster including 097 (the reconciliation pass introduction).

## Acceptance Criteria

- [x] Reconciliation snapshot excludes wrapper PIDs (cmd.exe, powershell.exe, agency wrapper) — verified via `orchestrate.js:723` `excludeWrappers: true`.
- [x] Test coverage for "live wrapper + dead inner Claude → classified as crashed" — exists at the `parsePidLookupOutput` unit level (`spawn-session.test.js:491,506,517` confirm `excludeWrappers: true` returns null when only the wrapper survives). The reconciliation pass consumes this filtered snapshot, so the wrapper-only case cannot reach the comparison loop.
- [x] Cross-reference cite to todo 073 — implicit via `buildPidSnapshot` calling the post-todo-073 primitive.
- [x] Precise line number filled — `orchestrate.js:723` (was TBD).

## Follow-ups (not blocking closure)

- An explicit reconciliation-path **integration** test (covering the full `pollAllPhases → reconciliation → adopt/abandon` flow with a wrapper-only PID snapshot) is a separate, narrower coverage gap. If wanted, capture as a sub-item under todo 107 (testing-coverage bundle) rather than re-opening this todo. The existing unit-level coverage already prevents the wrapper-only case from reaching reconciliation.

## Work Log

### 2026-05-04 — Closed as already-in-main; codex round 1 of PR #22

**By:** Codex review of PR #22; verified by review-impl agent.

**Actions:**
- Codex round 1 flagged: "Don't queue an already-applied wrapper-PID fix" — the current `buildPidSnapshot` implementation already calls `parsePidLookupOutput(stdout, name, { excludeWrappers: true })`.
- Verified via `grep -n "excludeWrappers" agent-orchestrator/scripts/orchestrate.js` → hit at `orchestrate.js:723` inside `buildPidSnapshot`. The reconciliation pass at `orchestrate.js:1062-1106` consumes this snapshot via `pollAllPhases`'s return shape.

**Resolution:** Marked complete; no work needed in PR #23. The PR #19 re-codex Round 2 emergent finding either misidentified the call site or the fix landed mid-cycle before re-codex completed. Future raw-lookup sites that bypass `buildPidSnapshot` would need a fresh todo.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 073 (P2 — `get-session-pid` default flags wrong).
