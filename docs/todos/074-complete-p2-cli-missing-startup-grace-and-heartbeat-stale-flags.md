---
status: complete
priority: p2
issue_id: "074"
tags: [code-review, unit-8, check-health, cli, operator-dx]
dependencies: []
---

# check-health: CLI missing --startup-grace-ms and --heartbeat-stale-ms

The library API accepts `heartbeatStaleMs` and `startupGraceMs`
overrides. The CLI ignores them and always uses defaults.
Operators dogfooding the CLI to debug a slow-starting session on a
cold or auth-blocked Claude binary cannot extend the windows
without editing source. `startupGraceMs` has no manifest fallback,
so there is no other tunable.

## Problem Statement

`check-health.js:638-682` (`parseCliArgs`) and `:689-700` (`main`)
do not accept `--startup-grace-ms` or `--heartbeat-stale-ms`. The
underlying library function does:

- `heartbeatStaleMs`: has a manifest-level fallback via
  `defaults.heartbeat_timeout_minutes`. Omitting the CLI flag is
  defensible because operators have *some* knob.
- `startupGraceMs`: has NO manifest fallback. The hard-coded
  default (per the library) is the only knob. To extend the
  startup grace for a slow Claude binary (cold start on a fresh
  machine, blocked auth, slow disk), the operator must edit source
  and reinstall the package.

Operator DX gap. The CLI is part of the agent-native surface for
Unit 11 and recovery flows; an undebuggable startup grace is a real
field issue.

## Findings

- CLI parser: `check-health.js:638-682`. Currently accepts
  `--manifest`, `--phase`, `--role`, `--json`. No timing flags.
- Main: `check-health.js:689-700`. Calls library with whatever
  parser produced.
- Library API: accepts `{ heartbeatStaleMs, startupGraceMs, … }`.
- `startupGraceMs` has no manifest fallback; the hard-coded
  default is the only knob.
- `heartbeatStaleMs` falls back to
  `manifest.defaults.heartbeat_timeout_minutes`.

## Proposed Solutions

### Option A — Add both flags (recommended)

Add `--startup-grace-ms <n>` and `--heartbeat-stale-ms <n>` to
`parseCliArgs`. Validate each as a non-negative integer. Pass
through to the library call in `main`. Document both in `--help`
including the manifest-fallback semantics for `heartbeat-stale-ms`.

- **Pros:** Closes the operator-DX gap completely. Tiny diff. No
  semantic change to the library.
- **Cons:** Two more flags to keep documented and tested.
- **Effort:** Small (~12-15 lines + 4 tests covering parse,
  validation, pass-through, help-text).
- **Risk:** Low.

### Option B — Add only --startup-grace-ms

`heartbeatStaleMs` has a manifest fallback so its CLI absence is
less urgent. Add only `--startup-grace-ms`.

- **Pros:** Minimal addition; addresses the worst gap.
- **Cons:** Inconsistent — operators expect the CLI to mirror the
  library API. They will find out only when they need
  `--heartbeat-stale-ms` and discover it doesn't exist.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Defer

Document that operators must use the library directly via Node
script if they need to override these.

- **Pros:** Zero churn.
- **Cons:** Operator DX miss. Unit 11 recovery debugging is harder.
- **Effort:** Zero.
- **Risk:** Low.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Add both
`--startup-grace-ms` and `--heartbeat-stale-ms` to the CLI flag
parser, threading values through to the library API's existing
`startupGraceMs` / `heartbeatStaleMs` opts. Defaults match library
defaults. Update `--help` (todo 076 will subsume this) to
document the flags.

Operators dogfooding cold-Claude or auth-blocked starts need both
overrides without source edits. Symmetric with library API.

Option B (only --startup-grace-ms) leaves heartbeat-stale tuning
to recompile/edit. Option C (defer) leaves operators stuck.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Sites:
  - `:638-682` (`parseCliArgs`)
  - `:689-700` (`main`)
  - Help text printer (`printHelp`).
- Test file: `agent-orchestrator/scripts/check-health.test.js`
- Companion: see todo #076 (--help schema documentation).

## Acceptance Criteria

- [ ] `--startup-grace-ms <n>` accepted; non-negative integer
      validated; passed through to library call.
- [ ] If Option A: `--heartbeat-stale-ms <n>` likewise; help-text
      documents both, plus the manifest fallback for
      `heartbeat-stale-ms`.
- [ ] Invalid values produce a clear error and non-zero exit.
- [ ] Tests cover parse, validation, pass-through, and help-text
      mention.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
