---
status: complete
priority: p1
issue_id: "089"
tags: [unit-11, orchestrate, lockfile, concurrency, windows, post-pr-19, ce-review]
dependencies: []
---

# orchestrate: lockfile reclamation has no startedAt tiebreaker (PID recycling)

## Problem Statement

`acquireLock` at `orchestrate.js:417` writes `{pid, startedAt, hostname}` but only checks `process.kill(prev.pid, 0)` for liveness. PID recycling (post-reboot, or on long-uptime systems where the prior orchestrator's PID is now held by an unrelated process) returns either no-error (alive) or `EPERM` (process exists but ACL'd) → both treated as `alive=true` → refuses to start a legitimate new orchestrator. Operator must hand-delete the lockfile.

## Findings

1. `orchestrate.js:417-435` — liveness check is `process.kill(prev.pid, 0)` only; `prev.startedAt` is read but never compared.
2. The bug fires on PID recycling: prior orchestrator's PID = N, prior died, OS recycled PID N to an unrelated process Q. `process.kill(N, 0)` returns no-error (Q is alive) → `alive=true` → ELOCKED.
3. Real Windows surface: PID space is small (~32K typical); recycling within 30 minutes is common after orchestrator OOM/crash.

## Proposed Solutions

*Option A (recommended) — start-time tiebreaker*: when `process.kill(prev.pid, 0)` indicates the PID exists, additionally read the OS-reported start time (Windows: `Get-CimInstance Win32_Process -Filter "ProcessId=N" | select CreationDate`; POSIX: `/proc/<pid>/stat` field 22). If the start time differs from `prev.startedAt` (with reasonable epsilon — say 1 second), treat as a recycled PID and reclaim the stale lock.
- Pros: closes the recycling case definitively. Effort: medium (one PowerShell call per acquireLock when stale-suspect).
- Cons: adds another PowerShell-spawn to startup cost (~140ms once at acquireLock time, not per-tick).

*Option B — short lock-staleness TTL*: refuse the lock if `prev.startedAt` is older than a threshold (e.g., 7 days). Reclaim above the threshold regardless of liveness check.
- Pros: simple, no extra subprocess.
- Cons: arbitrary threshold; doesn't help short-lived recycling.

## Recommended Action

_Pending triage._ Coord lean: Option A.

## Technical Details

- `agent-orchestrator/scripts/orchestrate.js:417-435` — liveness check.
- `agent-orchestrator/scripts/orchestrate.js:472-476` — lockfile schema.

## Acceptance Criteria

- [ ] Test: `_killer` returns no-error AND start-time probe returns value ≠ `prev.startedAt` → reclaim path fires.
- [ ] Test: `_killer` returns no-error AND start-time matches `prev.startedAt` → ELOCKED.
- [ ] Test: `_killer` throws ESRCH → reclaim path fires (existing behavior preserved).

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `c1bd625` (re-round — P1 089/lockfile-startedAt + 2 P2s).

**Resolution:** `probeProcessStartTime` helper added (Win32 `Get-CimInstance Win32_Process` / POSIX `/proc/<pid>/stat` field 22) and integrated into `acquireLock`'s reclaim logic. When `process.kill(pid, 0)` reports the PID exists, the start-time probe runs; mismatch with `prev.startedAt` (with epsilon) treats the PID as recycled and reclaims the stale lock.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Reliability reviewer: rel-2.
