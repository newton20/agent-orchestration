---
status: ready
priority: p2
issue_id: "101"
tags: [unit-11, orchestrate, post-pr-19, ce-review, api-contract, schema-version, v15-compat]
dependencies: []
---

# orchestrate: schema_version mismatch is a hard fatal — no soft compat band blocks any V1.5 minor bump

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1208-1218`, manifest `schema_version` mismatch is a hard fatal: any version that doesn't match the orchestrator's expected value halts the run with no soft-compatibility band. Once V1.5 ships even a minor schema bump (e.g., adding a new optional field), every existing V1 manifest stops working — even though the bump is forward-compatible by design. The contract has no minor/patch tolerance.

## Findings

- `schema_version` mismatch is a hard fatal — no soft compat band blocks any V1.5 minor bump.
- /ce:review reviewer attribution: api-contract.

## Proposed Solutions

### Option A — Major-version match; minor warns (recommended)
- Parse `schema_version` as semver-ish (`MAJOR` or `MAJOR.MINOR`). Major-mismatch hard fails. Minor mismatch (newer than orchestrator's known) warns + proceeds.
- Pros: forward-compat by design; V1.5 minor bumps don't break V1 manifests. Effort: small. Risk: low.

### Option B — Strict version match
- Current behavior; document as deliberate.
- Cons: every minor bump breaks every existing manifest.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Parse as semver; major-only strict; minor warn-not-fail. Document the soft-band in `--help` and in the schema_version comment. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1208-1218`

## Acceptance Criteria

- [ ] `schema_version: 1` accepted (V1 baseline).
- [ ] `schema_version: 1.1` accepted with warning.
- [ ] `schema_version: 2` rejected as hard major mismatch with structured error.
- [ ] `schema_version: "1.0.x"` parsed as major=1; accepted.
- [ ] Soft-band documented in `--help` text.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
