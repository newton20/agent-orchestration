---
status: complete
priority: p2
issue_id: "073"
tags: [code-review, unit-8, spawn-session, api-defaults, footgun]
dependencies: []
---

# spawn-session: excludeWrappers + throwOnError on getSessionPid have the wrong defaults

The new `excludeWrappers` and `throwOnError` options on
`getSessionPid` exist solely to serve `checkHealth`. Their defaults
are `false` to preserve back-compat for ONE internal caller in
`spawn-session` itself. Every external caller (check-health, future
Unit 11, future recovery agent) must remember to flip both. The
defaults invert the safe option for everyone except the one site
that doesn't need them.

## Problem Statement

`spawn-session.js:617-640` defines the option defaults. The
post-spawn lookup at `spawn-session.js:690` is the ONLY in-tree
caller relying on the current defaults. All other production users
pass `{ excludeWrappers: true, throwOnError: true }`:

- `check-health.js:514-518` (the new caller in this PR).
- Future Unit 11 polling loop.
- Future recovery agent.

This is the textbook "sticky-bit boolean" anti-pattern: the right
value is "true except for one internal site." A future caller who
forgets reintroduces exactly the wrapper-mask bug that codex
caught in round 3 of PR #15 — silently masking the launcher
wrapper PID instead of the actual claude PID.

`throwOnError: false` likewise hides runner failures from
production callers; only the post-spawn one-shot can defensibly
ignore them (the spawn just succeeded, so the runner failing on
WMI is a soft "we'll find out later").

## Findings

- Option definition: `spawn-session.js:617-640`.
- Internal caller depending on defaults:
  `spawn-session.js:690`.
- External caller passing both true:
  `check-health.js:514-518`.
- Codex round 3 (PR #15) caught the wrapper-mask bug; the fix was
  the `excludeWrappers` option. Defaulting it to `false` keeps the
  bug latent for the next caller.

## Proposed Solutions

### Option A — Flip defaults (recommended)

Make `excludeWrappers: true` and `throwOnError: true` the defaults.
Update `spawn-session`'s own internal call at line 690 to pass
`{ excludeWrappers: false, throwOnError: false }` explicitly. The
explicit form documents WHY that one site differs.

- **Pros:** Safe-by-default for every external caller. The
  explicit-opt-out at the one internal site is self-documenting.
  Eliminates the latent footgun for future Unit 11 / recovery
  callers.
- **Cons:** One-line behavior change at the internal site (which
  is actually a no-op because the runner does include wrappers
  anyway in that path).
- **Effort:** Small (default flip + one explicit override + 2
  tests pinning the new defaults).
- **Risk:** Low — only one in-tree caller relies on the old
  defaults, and that caller is updated.

### Option B — Move wrapper detection into checkHealth

Have `getSessionPid` return all matching rows. `checkHealth`
filters wrappers. Removes the policy from `spawn-session`
entirely.

- **Pros:** Cleanest separation of concerns.
- **Cons:** Refactor of the WMI parsing return shape. Every
  caller now does its own wrapper logic — the EXACT problem the
  current API was trying to centralize.
- **Effort:** Medium.
- **Risk:** Medium.

### Option C — Document as a footgun and require explicit opts

Add a JSDoc warning that callers MUST pass both `true` and add a
runtime warning when neither is set. Keep the defaults.

- **Pros:** No behavior change.
- **Cons:** Doesn't actually prevent the footgun; just rebrands it.
- **Effort:** Trivial.
- **Risk:** Medium.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Flip BOTH defaults
on `getSessionPid`:
- `excludeWrappers: true` (was `false`) — every external caller
  wants the inner Claude process, not the cmd.exe / powershell.exe
  / agency wrapper.
- `throwOnError: true` (was `false`) — every external caller wants
  runner failures to propagate so they can distinguish "lookup
  errored, can't tell" from "no matching process, definitely
  missing" (codex round 5 of PR #15 caught the conflation when
  this defaulted false). Loop-survival concerns are addressed by
  callers wrapping the call in try/catch and converting the throw
  into a tri-state null at their layer (check-health does this
  today at L520-535).

Update the one internal caller in `spawn-session` that depended
on the old defaults to pass `{ excludeWrappers: false,
throwOnError: false }` explicitly. That site loses
default-friendliness in exchange for every external caller
(check-health, future Unit 11, future recovery agent) getting
the safe default.

Option B (move wrapper detection into checkHealth) duplicates
logic that's correctly placed in spawn-session. Option C (footgun
+ explicit opts) preserves the current foot-gun.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/spawn-session.js`
- Option defaults: lines 617-640.
- Internal caller to update if Option A: line 690.
- Test file: `agent-orchestrator/scripts/spawn-session.test.js`
- Codex round 3 wrapper-mask bug: see PR #15 review history.

## Acceptance Criteria

- [ ] If Option A: calling `getSessionPid(name)` with no options
      returns the non-wrapper PID and throws on runner errors.
- [ ] Internal `spawn-session` post-spawn call retains current
      behavior via explicit overrides.
- [ ] Tests pin the new defaults.
- [ ] No regression in PR #15's wrapper-mask test cases.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/spawn-session.js`
  - `agent-orchestrator/scripts/spawn-session.test.js`
  - `agent-orchestrator/scripts/check-health.js`
- Related: codex round 3 wrapper-mask finding in PR #15 review
  history.
