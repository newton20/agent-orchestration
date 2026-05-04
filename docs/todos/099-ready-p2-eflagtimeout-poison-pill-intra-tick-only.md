---
status: ready
priority: p2
issue_id: "099"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, security, eflagtimeout, flag-consume, cross-tick]
dependencies: []
---

# orchestrate: EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent)

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2456`, the EFLAGTIMEOUT handling treats the poison-pill semantic as intra-tick only. If a slow tab is orphaned (the orchestrator gives up waiting on flag-consume within a tick), the tab is still alive and can consume the *next* tick's flag for an unrelated phase/role, delivering the wrong prompt to the wrong agent across tick boundaries. Both reliability and security reviewers flagged this from independent angles.

## Findings

- EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent).
- /ce:review reviewer attribution: reliability + security.

## Proposed Solutions

### Option A — Delete the .pending-* flag on EFLAGTIMEOUT (recommended)
- On EFLAGTIMEOUT, immediately unlink the `.pending-<name>` flag. Slow tab consuming an empty/missing file gets nothing; orchestrator's next tick re-issues a fresh flag if the spawn is still warranted.
- Pros: fits the file-protocol model (delete = orphan); no sidecar metadata. Effort: small.
- Cons: if the slow tab eventually does start and consumes a *next-tick* flag for the SAME (phase, role), it gets the right prompt — but it's a different invocation. Acceptable: the flag content for a re-issue is correct for the new spawn.

### Option B — Sidecar consumption metadata
- Persist consumption attempt in `.pending-<name>.consuming-<pid>-<ts>` so cross-tick continuation can detect the orphan and abort.
- Pros: more defensive. Cons: more file-protocol surface; more failure modes.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Delete the flag on EFLAGTIMEOUT; orchestrator's existing flag-write path on next tick handles re-issue. Bundle with 111 (shared spawning-marker rollback).

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2456`

## Acceptance Criteria

- [ ] Test: EFLAGTIMEOUT → `.pending-<name>` flag is deleted.
- [ ] Test: orphan slow tab consumed previous tick's now-deleted flag → no prompt delivered (file missing); session terminates.
- [ ] Test: next tick after EFLAGTIMEOUT re-issues a fresh flag if spawn still warranted.
- [ ] Cross-tick wrong-prompt-to-wrong-agent eliminated.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
