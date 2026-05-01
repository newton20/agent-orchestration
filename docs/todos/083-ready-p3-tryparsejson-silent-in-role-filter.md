---
status: ready
priority: p3
issue_id: "083"
tags: [code-review, unit-8, check-health, observability, diagnostics]
dependencies: []
---

# tryParseJson swallows non-JSON tail silently in role-filter mode

## Problem Statement

In role-filter mode, malformed lines are skipped silently with no diagnostic. Compared to strict-tail mode (line 192) which deliberately returns `null` on a malformed last line so the supervisor sees something is wrong, role-filter mode walks past corruption unconditionally. An agent can't tell the difference between "no recent qa heartbeat" and "qa heartbeat lines exist but are all corrupted."

Trade-off the dispatch acknowledges (role-filter needed for multi-role), but worth surfacing as a diagnostic.

## Findings

1. **Asymmetric error handling** — strict-tail surfaces malformed last line; role-filter does not.
2. **Operator-debugging signal lost** — corruption is invisible from the verdict.
3. **Behavior is intentional** for multi-role correctness, but no advisory channel exists.

## Proposed Solutions

### Option A — Bubble a `heartbeatCorrupt` diagnostic field

Set `heartbeatCorrupt: true` in the result when role-filter encountered any malformed lines while walking. Unit 11 can render it as an advisory.

- **Pros**: Preserves operator-debugging signal; non-breaking; small surface.
- **Cons**: Adds a field to the result schema (Unit 11 contract update).
- **Effort**: Small.
- **Risk**: Low.

### Option B — Accept silently; document the trade-off in checkHealth's JSDoc

- **Pros**: Zero code change.
- **Cons**: Loses an operator-debugging signal.
- **Effort**: Trivial.
- **Risk**: Low.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Add a
`heartbeatCorrupt` boolean diagnostic to `checkHealth`'s return
value. Set true when role-filter mode encountered any
non-parseable lines AND found no valid record matching the role.
Distinguishes "no recent qa heartbeat" (no qa lines at all)
from "qa heartbeat exists but is corrupted."

The diagnostic is informational, not policy-driving. Unit 11
treats `heartbeatCorrupt: true` as a "possibly hung agent
producing garbage" advisory, separate from the existing alive /
heartbeatStale signals.

Bundle with todos 071 (pidAliveReason), 072 (errorKind), 075
(schema_version), 076 (--help) as a coherent V1 schema_version: 1
definition for `checkHealth`'s output.

Option B (document trade-off only) leaves the silent-skip in
place; future debugging requires adding telemetry.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

**Affected file:** `agent-orchestrator/scripts/check-health.js:196-208`

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] Either `heartbeatCorrupt` is exposed in role-filter mode results, or JSDoc documents the silent-skip behavior explicitly.
- [ ] Tests cover the chosen behavior (corruption in role-filter walk).

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/check-health.test.js`
