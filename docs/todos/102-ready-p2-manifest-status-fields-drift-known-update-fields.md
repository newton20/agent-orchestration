---
status: ready
priority: p2
issue_id: "102"
tags: [unit-11, orchestrate, post-pr-19, ce-review, api-contract, manifest-status, schema-drift]
dependencies: []
---

# orchestrate: manifest-status field schema unversioned + drifts from parse-manifest.KNOWN_UPDATE_FIELDS (review_iteration, review_stage)

## Problem Statement

The manifest-status YAML field schema is unversioned at `agent-orchestrator/scripts/orchestrate.js:1054-1056, 1128-1133, 2502-2510` and has already drifted from `parse-manifest.KNOWN_UPDATE_FIELDS`. Specifically, `review_iteration` and `review_stage` are written by orchestrate.js but absent from parse-manifest's allow-list — meaning runUpdate either silently strips them (data loss) or accepts them (allow-list is a lie). The two modules have effectively forked their notion of the manifest-status contract.

## Findings

- manifest-status field schema unversioned + drifts from `parse-manifest.KNOWN_UPDATE_FIELDS` (`review_iteration`, `review_stage`).
- /ce:review reviewer attribution: api-contract.

## Proposed Solutions

### Option A — Add review_iteration + review_stage to KNOWN_UPDATE_FIELDS (recommended)
- Hoist the missing fields to `parse-manifest.KNOWN_UPDATE_FIELDS`. orchestrate.js writes against the canonical authority.
- Pros: closes the drift; maintains parse-manifest as single source of truth. Effort: trivial. Risk: low.

### Option B — runUpdate accepts-but-warns on unknown fields
- Allow orchestrate.js to write any field; runUpdate warns on unknown.
- Cons: KNOWN_UPDATE_FIELDS becomes documentation rather than enforcement.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Add `review_iteration` and `review_stage` to `KNOWN_UPDATE_FIELDS`. Defense-in-depth: have runUpdate also warn on truly-unknown fields (Option B's good idea preserved as defensive logging, not as the primary contract). Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1054-1056, 1128-1133, 2502-2510`
- Cross-module reference: `agent-orchestrator/scripts/parse-manifest.js` `KNOWN_UPDATE_FIELDS` allow-list.

## Acceptance Criteria

- [ ] `KNOWN_UPDATE_FIELDS` includes `review_iteration` and `review_stage`.
- [ ] Test: runUpdate with these fields persists them to manifest-status.
- [ ] Test: runUpdate with truly unknown field logs warning (defense in depth).
- [ ] orchestrate.js write sites verified consistent with the expanded allow-list.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
