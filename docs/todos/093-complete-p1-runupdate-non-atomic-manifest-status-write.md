---
status: complete
priority: p1
issue_id: "093"
tags: [parse-manifest, atomicity, manifest-status, pre-existing, ce-review-pr-19]
dependencies: []
---

# parse-manifest: runUpdate writes manifest-status non-atomically

## Problem Statement

`parse-manifest.js:838` writes manifest-status.yaml via bare `fs.writeFileSync(statusPath, header + yaml.dump(status))`. Mid-write crash leaves a truncated YAML file; the next tick's `loadStatus` returns `errorKind=config` and halts every subsequent run until the operator hand-fixes the file. Tmp+rename closes it (same-FS rename is atomic on POSIX/NTFS).

## Findings

1. Pre-existing in `parse-manifest.js`. Not introduced by PR #19.
2. PR #19's heavy use of `runUpdate` (multiple times per tick: persist on spawn, persist on completion, persist on convergence-recovery, persist on review-iteration) increases the exposure surface.
3. Closes findings #1 + #8 from the /ce:review report at the root if landed alongside Todo 088.

## Proposed Solutions

*Option A (recommended) — atomic tmp+rename + try-wrap*: write to `<statusPath>.tmp-<pid>-<rand>`, then `fs.renameSync(tmp, statusPath)`. Wrap the whole sequence in try/catch returning `{ok:false, error}`. Document that the writer is now atomic and exception-safe.
- Pros: closes Todo 088 cluster's root. Effort: small. Risk: low (rename is atomic on same FS).

*Option B — defer to PR #21 cleanup wave*: pre-existing, not introduced here.
- Pros: zero scope-creep into PR #19. Cons: the cluster (088) has to address it indirectly via wrap-at-call-site.

## Recommended Action

_Pending triage._ Coord lean: Option A, bundled with Todo 088.

## Technical Details

- `agent-orchestrator/scripts/parse-manifest.js:838` — bare writeFileSync.

## Acceptance Criteria

- [ ] Test: kill orchestrator mid-write (simulated by injecting a throw between rename and write) → manifest-status.yaml left intact (the tmp file is orphaned, not the canonical).
- [ ] Test: existing parse-manifest.test.js passes unchanged.

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `09dd710` (initial /ce:review round 1 — P1s 088-092 closed) and `c1bd625` (re-round — P1 089/lockfile-startedAt + 2 P2s).

**Resolution:** Bundled with todo 088 per coord dispatch. `parse-manifest.runUpdate` rewritten to write to `<statusPath>.tmp-<pid>-<rand>` then `fs.renameSync(tmp, statusPath)` (atomic on same-FS POSIX/NTFS). Whole sequence wrapped in try/catch returning `{ok:false, error}`. Mid-write crashes leave the canonical file untouched; tmp files orphan rather than corrupting state.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Adversarial reviewer: adv-2 (pre-existing).
