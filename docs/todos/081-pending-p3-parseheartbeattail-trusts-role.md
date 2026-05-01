---
status: pending
priority: p3
issue_id: "081"
tags: [code-review, unit-8, check-health, security, defense-in-depth]
dependencies: []
---

# parseHeartbeatTail trusts caller-supplied role (defense-in-depth)

## Problem Statement

When `role` is set to a string equal to whatever role a malicious heartbeat puts in its own `role` field, `parseHeartbeatTail` returns that record's `tsMs`/`pid`. Verified: `role: '__proto__'` and a heartbeat line `{"ts":"2099-01-01T00:00:00Z","role":"__proto__","pid":42}` produces `{ tsMs: 4070908800000, pid: 42 }`.

Inside `checkHealth` this is gated by `VALID_ROLES`, so it's not exploitable through the public API today. Concern: `parseHeartbeatTail` is in `module.exports` (line 709) — a future caller that doesn't pre-validate `role` would inherit the exposure.

## Findings

1. **No role-shape check inside parseHeartbeatTail** — caller-supplied `role` is compared to record fields verbatim.
2. **Public export** — `parseHeartbeatTail` is reachable outside `checkHealth`.
3. **Spoofed timestamps allow far-future or past values** through to result.

## Proposed Solutions

### Option A — Validate role at the parseHeartbeatTail boundary

Inside `parseHeartbeatTail`, when `role` is supplied, verify `VALID_ROLES.includes(role)` and return `null` otherwise. Match `checkHealth`'s contract one layer down.

- **Pros**: Defense-in-depth at the export boundary; same shape as existing checkHealth guard.
- **Cons**: Tests that previously passed unusual roles need updating.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

_Pending triage._

## Technical Details

**Affected file:** `agent-orchestrator/scripts/check-health.js:178-209` (definition); export at `:709`.

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] `parseHeartbeatTail` returns `null` for any `role` not in `VALID_ROLES`.
- [ ] Tests cover invalid roles (`__proto__`, empty string, unknown role) and confirm `null`.
- [ ] No behavior change visible through `checkHealth`'s public API.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/check-health.test.js`
