---
status: pending
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

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1208-1218`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
