---
status: pending
priority: p3
issue_id: "084"
tags: [code-review, unit-8, check-health, cli, documentation]
dependencies: []
---

# Exit code conflates "agent dead" with "agent alive"; --help easy to miss

## Problem Statement

Exit contract is "0=completed, 1=validation." An agent shelling out and reading only the exit code cannot distinguish "agent is healthy" from "agent timed out three hours ago." Deliberate design choice (the JSON carries the verdict) — and right for Unit 11 which always parses JSON. But for an operator pipeline (`if check-health …; then echo healthy`), the exit code lies.

The `--help` text at `:648-650` calls out "regardless of alive/dead verdict" so a careful reader knows, but it's easy to miss.

## Findings

1. **Single 0-exit code for both alive and dead** — only validation errors return non-zero.
2. **Documentation exists but is easy to skim past** in `printHelp`.
3. **Shell pipeline consumers** (operators, ad-hoc checks) get a misleading signal without parsing JSON.

## Proposed Solutions

### Option A — Document harder

In `--help`, add a single bold-equivalent line: `NOTE: exit code does NOT reflect alive/dead — always parse stdout JSON.`

- **Pros**: Cheapest fix; preserves Unit 11 contract.
- **Cons**: Still requires JSON parsing for shell consumers.
- **Effort**: Trivial.
- **Risk**: Low.

### Option B — Add `--strict` (or `--exit-on-status`) flag

Maps `alive=false` → exit 2, error → exit 3, leaving default behavior unchanged. One-flag promotion for shell consumers without breaking Unit 11.

- **Pros**: Real ergonomic win for shell pipelines; opt-in so no contract break.
- **Cons**: New CLI surface to maintain and test.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

_Pending triage._

## Technical Details

**Affected files:**
- `agent-orchestrator/scripts/check-health.js:684-702` (exit handling)
- `agent-orchestrator/scripts/check-health.js:638-653` (`printHelp`)

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] `--help` clearly states exit code does not reflect alive/dead status.
- [ ] If Option B is taken, `--strict` flag is documented, tested, and maps alive/error to distinct exit codes.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
