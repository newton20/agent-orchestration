---
status: pending
priority: p2
issue_id: "106"
tags: [unit-11, orchestrate, post-pr-19, ce-review, cli-readiness, flag-parsing]
dependencies: []
---

# orchestrate: --plugin-dir / --project-name silently consume next -prefixed flag as their value

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:3092-3098, 3132-3137`, the CLI flag parser for `--plugin-dir` and `--project-name` greedily consumes the next argv token as the flag value with no sanity check. Invocations like `--plugin-dir --resume foo.yaml` parse `pluginDir = '--resume'` and silently drop `--resume` (which the operator clearly intended as a separate flag). The user has no signal that a flag was lost.

## Findings

- `--plugin-dir` / `--project-name` silently consume next `-`-prefixed flag as their value; e.g., `--plugin-dir --resume foo.yaml` parses `pluginDir = '--resume'` and silently drops `--resume`.
- /ce:review reviewer attribution: cli-readiness.

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:3092-3098, 3132-3137`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
