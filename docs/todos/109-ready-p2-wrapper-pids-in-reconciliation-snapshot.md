---
status: ready
priority: p2
issue_id: "109"
tags: [unit-11, orchestrate, post-pr-19, re-codex-round-2, reconciliation, wrapper-pid]
dependencies: []
---

# orchestrate: wrapper PIDs in reconciliation snapshot — same root as todo 073's excludeWrappers flip but at a different call site

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

**Option A — approved 2026-05-04 by coord.** Use the existing primitive (`getSessionPid` or `buildPidSnapshot`) with `excludeWrappers: true`. Verify the call site receives the post-todo-073 default; if it's calling a different primitive, route through one that respects the default. Bundle in PR #23 cleanup wave. Implementer should locate the precise line in commit `c1bd625` and update the source file's TBD reference.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (reconciliation snapshot call site added in commit `c1bd625`; precise line TBD — see PR #19 re-codex Round 2 emergent findings).
- Cross-reference: todo 073 (closed) — `get-session-pid` `excludeWrappers` default flip.
- Cross-reference: PR #19 fix commit `c1bd625` — re-round close of P2 cluster including 097.

## Acceptance Criteria

- [ ] Reconciliation snapshot excludes wrapper PIDs (cmd.exe, powershell.exe, agency wrapper).
- [ ] Test: phase with live cmd.exe wrapper + dead inner Claude → reconciliation correctly classifies as crashed (not alive).
- [ ] Cross-reference cite to todo 073 (closed) preserved in code comment.
- [ ] Precise line number filled in this todo's Technical Details (was TBD).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 073 (P2 — `get-session-pid` default flags wrong).
