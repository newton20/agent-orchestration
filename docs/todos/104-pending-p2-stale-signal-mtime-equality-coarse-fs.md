---
status: pending
priority: p2
issue_id: "104"
tags: [unit-11, orchestrate, post-pr-19, ce-review, adversarial, mtime, stale-signal, coarse-fs, testing-gap]
dependencies: []
---

# orchestrate: stale-signal cleanup uses strict > mtime comparison — coarse-FS equality boundary deletes live verdict

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`, the stale-signal cleanup uses a strict `>` mtime comparison to decide whether a sibling signal predates the current tick. On coarse-resolution filesystems (FAT 2-second, NFS subsecond-less), two writes within the same resolution tick produce equal mtimes; the strict-`>` test then classifies a *live* verdict as stale and deletes it. Cross-reviewer corroboration (adversarial + testing) promoted this finding — adv flagged the equality-boundary attack, testing flagged the missing coverage.

## Findings

- Stale-signal cleanup uses strict `>` mtime comparison; coarse-FS equality boundary deletes live verdict (FAT 2s, NFS subsecond-less).
- /ce:review reviewer attribution: adversarial + testing (cross-promoted, anchor 75→100).

## Proposed Solutions

_(To be drafted during coord triage round; the /ce:review doc's brief format does not include solution options for these.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
