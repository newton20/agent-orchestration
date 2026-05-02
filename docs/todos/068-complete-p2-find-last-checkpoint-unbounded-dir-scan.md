---
status: complete
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

If `entries.length > MAX_ENTRIES` (e.g., 256), skip the stat
phase entirely and return `null` plus an advisory diagnostic
("phase dir overflowed — checkpoint untrustworthy"). Trying to
pick a "best" name from N>cap entries is unsafe: timestamp-prefix
naming sorts ascending so name-sort + take-first would discard
the NEWEST entries, and even mtime-sort requires the stat'ing we
were trying to bound. Past the cap the phase has clearly gone
off the rails and the recovery anchor should signal that, not
fabricate a confident-looking pick.

- **Pros:** Bounded cost in the cap-exceeded branch (zero stats).
  Safe-by-default (no incorrect "newest" claims). Defensible
  policy ("phase dir exceeded sanity threshold; signal it").
- **Cons:** Loses the checkpoint anchor entirely past the cap —
  but at >256 files in a phase dir, the anchor was already
  unreliable.
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
by `findLastCheckpoint` (default cap: 256). When
`entries.length > MAX_ENTRIES`, skip `statSync` entirely and
return `null` plus a "checkpoint untrustworthy — phase dir
overflowed" advisory rather than picking a wrong "newest" by
name-sort. Below the cap, behavior is unchanged (full mtime
scan).

Codex round 1 (this PR) flagged that the original phrasing
("sort by name, take first N") would silently discard the newest
entries when filenames are timestamp-prefixed — recommend
phase-dir-overflow as a binary "give up + signal it" instead of
"guess from a sample." This todo's Option A and Acceptance
Criteria reflect that fix.

Option B (cache + invalidate by directory mtime) adds state +
correctness risk on Windows where dir-mtime semantics vary by
filesystem. Option C (defer) leaves the per-poll cost unbounded.

Dispatch as part of the **pre-Unit-11 hardening PR bundle** along
with 067 + 069-078 + 083 + 086.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Site: lines 244-274 (`findLastCheckpoint`).
- `MAX_ENTRIES` threshold: 256 (per coord triage).
- Test file to extend: `agent-orchestrator/scripts/check-health.test.js`

## Acceptance Criteria

- [ ] When `entries.length > 256`, the function executes ZERO
      per-entry `statSync` calls (verifiable by injecting a
      counting `_statSync` and asserting `count === 0` past the
      cap). This is the safety property the cap is for; raw
      enumeration cost via `readdirSync` is still O(N) but
      bounded by NTFS MFT walk speed (~10s of ms even for
      50,000 entries on a healthy disk), and is the same I/O
      cost incurred today below the cap.
- [ ] When `entries.length > 256`, the function returns `null` for
      `lastCheckpoint` and surfaces an advisory diagnostic (log
      line or returned in result).
- [ ] Phase directories with ≤256 entries behave identically to
      current implementation (same return value, same mtime
      comparison).
- [ ] Empty directory still returns null/undefined as today.
- [ ] Implementation does NOT use name-sort + take-first as the
      cap strategy (would discard newest entries with
      timestamp-prefixed names).
- [ ] **Optional follow-up:** if profiling shows raw enumeration
      becomes the bottleneck (>100ms on observed phase dirs),
      switch to bounded enumeration via `fs.opendirSync` +
      per-entry `dir.readSync` with early exit at cap+1. Out of
      scope for this todo; capture as a new pending todo if it
      surfaces in production.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
