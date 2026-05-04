---
status: pending
priority: p2
issue_id: "105"
tags: [unit-11, orchestrate, post-pr-19, ce-review, adversarial, resume, stale-flags, pending-flags]
dependencies: []
---

# orchestrate: --resume does not sweep stale .pending-* flags at startup — stale flag delivered to unrelated newly-spawned sessions

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`, the `--resume` startup path does not sweep stale `.pending-*` flags from the protocol directory. If a prior orchestrator died after writing a `.pending-orch-<phase>-<role>` flag but before the target session consumed it, that flag persists. On `--resume`, when a new session for the same `(phase, role)` spawns, it consumes the stale flag — delivering an outdated prompt to a freshly-spawned agent, with the same wrong-prompt-to-wrong-agent semantics as todo 099 but at startup boundary.

## Findings

- `--resume` does not sweep stale `.pending-*` flags at startup → stale flag delivered to unrelated newly-spawned sessions.
- /ce:review reviewer attribution: adversarial.

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
