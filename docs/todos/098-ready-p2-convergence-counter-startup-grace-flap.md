---
status: ready
priority: p2
issue_id: "098"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, convergence, startup-grace, tri-state]
dependencies: []
---

# orchestrate: tri-state convergence — startup_grace doesn't reset counter; flap pattern bypasses 'consecutive' semantic

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1353`, the tri-state convergence counter (per todo 071's contract: N consecutive `lookup_failed` past startup-grace = crash, where N is `DEFAULT_LOOKUP_FAILED_CONVERGE_N = 3` overridable via `--converge-n`) does not reset the counter when a poll returns `startup_grace`. A flap pattern of `lookup_failed → startup_grace → lookup_failed` reaches counter = 2 even though the failures are not actually consecutive. The 'consecutive' semantic is silently violated; recoveries can trigger one tick earlier than the configured threshold specifies. The fix is to make `startup_grace` reset the counter — NOT to change the threshold itself.

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

- [ ] **Threshold preservation:** the configured convergence threshold (`DEFAULT_LOOKUP_FAILED_CONVERGE_N = 3`, overridable via `--converge-n`) is unchanged by this fix. The fix is solely about WHEN to reset the counter, not the threshold itself. Default runs continue to require N consecutive failures (default 3); custom `--converge-n` runs continue to honor the operator-supplied value.
- [ ] Sequence `lookup_failed` → `startup_grace` → `lookup_failed`: counter ends at 1 (`startup_grace` reset it). Recovery does NOT trigger at this point — needs `convergeN` consecutive `lookup_failed` results past startup-grace.
- [ ] Sequence `lookup_failed` (×N where N = `convergeN`) consecutively past startup-grace: counter reaches N → recovery triggers per todo 071's "N consecutive `lookup_failed` past startup-grace = crash" contract.
- [ ] Sequence `lookup_failed` → `pidAlive: true` → `lookup_failed`: counter resets to 1 on the second `lookup_failed` (any non-`lookup_failed` poll resets the counter — including `pidAlive: true` AND `startup_grace`).
- [ ] Test covers the flap pattern explicitly with both default `convergeN=3` AND a custom `--converge-n=2` to verify both code paths preserve their thresholds.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
