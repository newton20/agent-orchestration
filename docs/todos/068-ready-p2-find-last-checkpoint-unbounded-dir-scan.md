---
status: ready
priority: p2
issue_id: "068"
tags: [code-review, unit-8, check-health, performance, dos]
dependencies: []
---

# check-health: findLastCheckpoint unbounded directory scan

`findLastCheckpoint` reads every entry in the phase directory and
runs `statSync` on each one to compute mtime. With a runaway loop,
log dump, or compile-output explosion in the phase directory, this
becomes a multi-second hot-path cost on every poll tick.

## Problem Statement

`check-health.js:244-274` calls
`readdirSync(phaseDir, { withFileTypes: true })` and then iterates,
running `statSync` per entry to find the most recent file by
mtime. There is no entry cap, no skip-by-name, no caching.

Verified locally: 50,000 small files in the phase dir → 2 s
wallclock per `checkHealth` call, with `statSync` dominating the
profile.

Real-world trigger surfaces:

- An impl agent in a tight loop that writes per-iteration files.
- A QA agent dumping per-test artifacts.
- A coord agent committing compile output / build artifacts to
  the phase scaffold.

At Unit 11's polling cadence (30 s) × N phases × M roles, this
lands directly in the orchestrator's hot path. A single phase with
a misbehaving role can pin a CPU core indefinitely.

## Findings

- Site: `check-health.js:244-274` (`findLastCheckpoint`).
- `readdirSync` returns full entry list. No `entries.slice(0, N)`.
- `statSync` per entry. No cache. No reuse across calls.
- The function only needs the most recent file BY MTIME.
  `readdirSync` returns entries by directory order (not mtime), so
  a scan IS required — but a hard cap is still safe because
  beyond a threshold, "newest by mtime" is meaningless for crash
  recovery (the phase has clearly gone off the rails).

## Proposed Solutions

### Option A — Cap entries (recommended)

If `entries.length > MAX_ENTRIES` (e.g., 5000), log a warning and
return the most recent N entries by NAME (skip stat). Names that
sort by name often correlate with timestamp prefixes; even when
they don't, returning *some* recent file beats hanging the
orchestrator. Optionally fall back to "no checkpoint found" with
a diagnostic.

- **Pros:** Bounded cost. Simple. No state. Defensible policy
  ("phase dir exceeded sanity threshold").
- **Cons:** May return a non-newest checkpoint when name order
  doesn't match mtime order — but the alternative is hanging.
- **Effort:** Small (~10 lines + 2 tests).
- **Risk:** Low.

### Option B — Cache + invalidate by directory mtime

Stat the directory itself; if `dir.mtimeMs` hasn't advanced past
the last cached value, return the cached basename. Most ticks then
do exactly 2 `statSync` calls (dir + previously-known newest).

- **Pros:** Optimal steady-state cost.
- **Cons:** Adds state to a stateless function. Requires cache
  scoping (per-phase). Cache invalidation is now load-bearing for
  correctness. Doesn't solve the cold-cache or first-poll case.
- **Effort:** Medium.
- **Risk:** Medium — stateful caching in what was a pure helper.

### Option C — Defer to operator

Document that phase scaffolds must not contain >N files. No code
change.

- **Pros:** Zero churn.
- **Cons:** Relies on agent discipline for orchestrator stability.
- **Effort:** Zero.
- **Risk:** Medium.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Cap entries scanned
by `findLastCheckpoint` (default cap: 256). Sort `readdirSync`
output by string-name (cheap, deterministic), take the first N
entries, run `statSync` on those only. A phase directory with
runaway log dumps (>256 files) gets a "checkpoint maybe stale —
phase dir overflowed" advisory rather than blocking the polling
hot path.

Option B (cache + invalidate by directory mtime) adds state +
correctness risk on Windows where dir-mtime semantics vary by
filesystem. Option C (defer) leaves the per-poll cost unbounded.

Dispatch as part of the **pre-Unit-11 hardening PR bundle** along
with 067 + 069-078 + 083 + 086.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Site: lines 244-274 (`findLastCheckpoint`).
- Suggested `MAX_ENTRIES` threshold: 5000.
- Test file to extend: `agent-orchestrator/scripts/check-health.test.js`

## Acceptance Criteria

- [ ] `findLastCheckpoint` on a phase directory with 50,000 files
      completes in <100 ms.
- [ ] When entry count exceeds the cap, a warning diagnostic is
      surfaced (log line or returned in result).
- [ ] Phase directories with <5000 entries behave identically to
      current implementation (same return value, same mtime
      comparison).
- [ ] Empty directory still returns null/undefined as today.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
