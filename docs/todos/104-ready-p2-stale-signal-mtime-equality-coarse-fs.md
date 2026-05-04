---
status: ready
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

### Option A — mtime snapshot at spawn time (recommended)
- Capture spawn timestamp in manifest-status `started_at` (already there per todo 078). Compare current signal `mtime` against `started_at` directly. A signal with `mtime >= started_at` is fresh; older is stale.
- Pros: FS-resolution-independent; ties freshness to a known orchestrator-controlled timestamp. Effort: small. Risk: low.

### Option B — `>=` instead of `>`
- Accept equal mtime as fresh.
- Cons: still couples freshness to tick-start instead of spawn-time; doesn't fully close coarse-FS edge cases.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Use `started_at` from manifest-status as the freshness anchor. Eliminates the strict-`>` vs `>=` debate by anchoring against a different (and correct) reference point. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`

## Acceptance Criteria

- [ ] Stale-signal cleanup compares signal mtime against `started_at` (not tick-start mtime).
- [ ] Test: signal written at same mtime-second as `started_at` → recognized as fresh, not stale.
- [ ] FAT-2s coarse-FS edge case covered.
- [ ] NFS subsecond-less edge case covered.
- [ ] Test: signal predating `started_at` correctly classified as stale.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
