---
status: complete
priority: p2
issue_id: "071"
tags: [code-review, unit-8, check-health, api-contract, unit-11-prep]
dependencies: []
---

# check-health: tri-state pidAlive: null lacks a "why" channel

`pidAlive: null` collapses three causally distinct states. Unit 11's
documented "two consecutive nulls past startup grace = treat as
crash" heuristic only works if the consumer can distinguish them,
because each state's convergence behavior differs. Without
disambiguation, Unit 11 ends up recomputing startup-grace from
`started_at` itself, duplicating logic that already lives in
`checkHealth`.

## Problem Statement

Three causally distinct sources of `pidAlive: null` exist today:

1. **Lookup runner threw** — `check-health.js:530-532`. Transient,
   genuinely "I don't know." Two consecutive == possible crash.
2. **Lookup returned null AND within startup grace** —
   `check-health.js:553-557`. Deterministic; resolves within the
   grace window without any agent action. Should NOT count toward
   "consecutive nulls."
3. **Kill returned an unknown errno** — `check-health.js:143-145`
   inside `isPidAlive`. Informational; the pid exists but kernel
   semantics are unclear.

All three flow into the same `pidAlive: null` field at
`check-health.js:419-426` (baseResult). Unit 11's heuristic is
only well-defined if it can tell #2 ("not a real null, ignore")
apart from #1 ("transient null, count it") apart from #3
("unusual null, log it").

Today Unit 11 will need to recompute startup-grace from
`started_at` to filter case #2. That logic already lives here. The
duplication is exactly the kind of cross-module drift that bit
the heartbeat-by-role contract in PR #15 itself.

## Findings

- `check-health.js:530-532`: lookup-runner-threw branch — sets
  pidAlive=null.
- `check-health.js:553-557`: startup-grace branch — sets
  pidAlive=null AND inStartupGrace=true.
- `check-health.js:143-145`: kill-unknown-errno inside `isPidAlive`
  — returns null up the stack.
- `check-health.js:419-426`: baseResult shape; all nulls collapse.
- Unit 11 spec (per dispatch): documented "two consecutive nulls
  past startup grace" heuristic — assumes disambiguation.

## Proposed Solutions

### Option A — Add pidAliveReason field (recommended)

Populate only when `pidAlive === null`. Values (snake_case wire
form for JSON-output stability):

- `'startup_grace'` — within startup grace window; PID lookup not
  yet meaningful (deterministic resolve as agent registers in WMI).
- `'lookup_failed'` — runner threw OR `kill(pid, 0)` returned an
  unrecognized errno. Both are "couldn't determine"; folded into
  one wire value because Unit 11 treats them identically (re-poll).
- `'session_not_found'` — WMI lookup returned no match past startup
  grace. **Behavior change vs PR #15:** today this surfaces as
  `pidAlive: false`; with this todo applied, it surfaces as
  `pidAlive: null` + `pidAliveReason: 'session_not_found'` so Unit
  11's tri-state convergence applies. Past startup grace, Unit 11
  treats this as a confirmed crash signal.

Note: `kill(pid, 0)` returning ESRCH (definitively no such process)
remains `pidAlive: false` — we had a PID and the kernel said it's
gone; that's the strongest possible "dead" signal.

Document as nullable so simple Unit 11 consumers can ignore it for
the basic two-null heuristic; advanced consumers can read it.

- **Pros:** Cheap. Extensible. Eliminates Unit 11's duplicated
  startup-grace recompute. Future reasons can be added without
  breaking shape (it's nullable).
- **Cons:** One more field on a small public shape — but that's
  the cost of doing the work.
- **Effort:** Small (set the field at 3 sites + add to baseResult
  + tests).
- **Risk:** Low.

### Option B — Defer to Unit 11

Let Unit 11 recompute startup-grace itself from `started_at` and
the configured `startupGraceMs`.

- **Pros:** Zero churn in this PR.
- **Cons:** Duplicates startup-grace logic across two modules.
  When `startupGraceMs` semantics change (add manifest fallback,
  change default, add per-role override), Unit 11 silently drifts.
  Cannot distinguish lookup-error from kill-unknown-errno at all.
- **Effort:** Zero in this PR; Medium-Large in Unit 11.
- **Risk:** Medium — drift exposure across the boundary.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Add a `pidAliveReason`
field to `checkHealth`'s return value. When `pidAlive: null`,
`pidAliveReason` is one of:
- `'startup_grace'` — within startup grace window; PID lookup not
  yet meaningful
- `'lookup_failed'` — runner error or transient WMI/process.kill
  failure; Unit 11 should re-poll
- `'session_not_found'` — WMI lookup returned no match; spawned
  process never started or already exited cleanly

Document the convergence behavior expected for each in the JSON
schema doc (see todo 075 + 076 — bundle): `startup_grace` →
re-poll; `lookup_failed` → re-poll up to N times; `session_not_found`
+ post-grace → treat as crash.

Closes the "Unit 11 re-derives startup-grace from started_at"
duplication noted by codex.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Sites:
  - `:530-532` (lookup-error branch)
  - `:553-557` (startup-grace branch)
  - `:143-145` (`isPidAlive` kill-unknown-errno)
  - `:419-426` (baseResult shape)
- Test file: `agent-orchestrator/scripts/check-health.test.js`
- Companion: this field should be advertised in `--help` (see
  todo #076 — JSON output schema documentation).

## Acceptance Criteria

- [ ] `result.pidAliveReason` is `'startup_grace'`,
      `'lookup_failed'`, or `'session_not_found'` whenever
      `pidAlive === null`.
- [ ] When `pidAlive` is true or false, `pidAliveReason` is null
      or omitted.
- [ ] One test per reason value (3 tests).
- [ ] **Behavior change test:** WMI lookup returning null PAST
      startup grace produces `pidAlive: null` +
      `pidAliveReason: 'session_not_found'` (was `pidAlive: false`
      pre-this-todo).
- [ ] `kill(pid, 0)` returning ESRCH still produces `pidAlive: false`
      (we had a PID and the kernel said it's gone; strongest dead
      signal).
- [ ] Existing tests for `pidAlive: true` (kill OK / EPERM)
      unchanged.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
