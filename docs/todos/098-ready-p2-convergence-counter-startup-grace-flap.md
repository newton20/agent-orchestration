---
status: ready
priority: p2
issue_id: "098"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, convergence, startup-grace, tri-state]
dependencies: []
---

# orchestrate: tri-state convergence — startup_grace doesn't reset counter; flap pattern bypasses 'consecutive' semantic

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1353`, the tri-state convergence counter (per todo 071's contract: two consecutive `lookup_failed` past startup-grace = crash) does not reset the counter when a poll returns `startup_grace`. A flap pattern of `lookup_failed → startup_grace → lookup_failed` reaches counter = 2 even though the failures are not actually consecutive. The 'consecutive' semantic is silently violated; recoveries trigger one tick earlier than the contract specifies.

## Findings

- Tri-state convergence: `startup_grace` doesn't reset counter; flap pattern bypasses 'consecutive' semantic.
- /ce:review reviewer attribution: reliability.

## Proposed Solutions

### Option A — startup_grace resets the counter (recommended)
- Only `lookup_failed` and `session_not_found` increment the consecutive-null counter; any non-null pidAlive value (true/false) AND `startup_grace` reset to 0.
- Pros: matches the documented "consecutive" semantic; flap pattern correctly counts 1 (not 2).
- Effort: small (one reset call in the convergence path). Risk: low.

### Option B — Document the flap as expected behavior
- Update todo 071's contract doc to say "consecutive includes startup_grace as a continuation".
- Cons: weakens the convergence guarantee; loosens the contract Unit 11 was designed against.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** The "consecutive" word in the contract is load-bearing; flap patterns must NOT bypass the convergence threshold. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1353`

## Acceptance Criteria

- [ ] Sequence `lookup_failed` → `startup_grace` → `lookup_failed`: counter ends at 1 (NOT 2).
- [ ] Sequence `lookup_failed` → `lookup_failed` → `lookup_failed`: counter reaches 3 → recovery triggers.
- [ ] Sequence `lookup_failed` → `pidAlive: true` → `lookup_failed`: counter resets to 1 on the second `lookup_failed`.
- [ ] Test covers the flap pattern explicitly.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
