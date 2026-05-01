---
status: pending
priority: p3
issue_id: "085"
tags: [code-review, unit-8, check-health, documentation, v1.5-prep]
dependencies: []
---

# Recovery role timing implicit; session-name format may not survive V1.5

## Problem Statement

Session name is `orch-<phaseId>-<role>`. When recovery lands in V1.5, the session for "recovery on phase-3 because impl crashed" is presumably `orch-phase-3-recovery`. But what if recovery itself crashes and re-spawns? `orch-phase-3-recovery` collides with the prior recovery's WMI entry until the dead PowerShell wrapper is killed. The current 1-tuple (phase, role) naming has no generation/iteration counter.

Latent — only matters in V1.5. Flagging now so the V1.5 unit author is forewarned.

## Findings

1. **defaultSessionName** uses a 1-tuple naming scheme: `orch-<phase>-<role>`.
2. **No iteration discriminator** — re-spawned roles cannot be distinguished from prior generations until WMI is cleaned up.
3. **Test at `:1619`** rejects `'recovery'` as V1.5 territory, confirming the unit author already knows recovery isn't yet in scope.
4. **V1.5 risk concrete** — recovery-of-recovery is the realistic collision path.

## Proposed Solutions

### Option A — Document the constraint

Add a note to README §"Health checker" or `docs/manifest-reference.md`: "Session names are role-scoped per phase. Recovery (V1.5) will need an iteration counter to disambiguate re-spawns; current format is `orch-<phase>-<role>` and a future `orch-<phase>-<role>-attempt-<n>` will be considered."

- **Pros**: Forewarns V1.5 author; zero implementation risk.
- **Cons**: Doesn't fix the latent issue.
- **Effort**: Trivial.
- **Risk**: Low.

### Option B — Pre-emptively reserve the format

Add an opt-in `attempt` arg to `defaultSessionName` that's currently always `0` / hidden.

- **Pros**: V1.5 inherits a ready seam.
- **Cons**: Premature abstraction; risks shipping unused surface.
- **Effort**: Small.
- **Risk**: Medium — premature abstraction.

## Recommended Action

_Pending triage._

## Technical Details

**Affected files:**
- `agent-orchestrator/scripts/check-health.js:365-367` (`defaultSessionName`)
- `agent-orchestrator/scripts/check-health.test.js:1619` (V1.5 rejection)

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] V1.5 recovery designers see a clear note about session-name uniqueness constraints.
- [ ] If Option B is chosen, `defaultSessionName` accepts an `attempt` arg with a stable backwards-compatible default.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/check-health.test.js`
