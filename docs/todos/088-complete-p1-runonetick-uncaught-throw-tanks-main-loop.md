---
status: complete
priority: p1
issue_id: "088"
tags: [unit-11, orchestrate, reliability, polling-loop, post-pr-19, ce-review]
dependencies: ["091"]
---

# orchestrate: runOneTick uncaught throw tanks main loop on FS write failure

## Problem Statement

`runOrchestrator`'s main `for(;;)` loop calls `runOneTick(runState, opts)` at `orchestrate.js:2855` with no try/catch around the tick body. `executeActions` cases that touch `runUpdateFn` (`mark_phase_completed`/`failed`/`blocked`/`running` and post-spawn persist) call `runUpdate` bare; `parse-manifest.js:838`'s `runUpdate` wraps `fs.writeFileSync` with NO try block. EBUSY / EPERM / ENOSPC / Windows-AV-handle-held / ENOSPC-on-tmp-files throws bubble through and kill the polling loop. Contradicts the unit's stated invariant: *"failure of one tick must not tank the loop."*

## Findings

1. `orchestrate.js:2855` — `runOneTick(runState, opts)` is invoked inside `for(;;)` with only `finally` (lock release), no `catch`.
2. `parse-manifest.js:838` — `fs.writeFileSync(statusPath, header + yaml.dump(status));` is bare. Any FS error throws.
3. `orchestrate.js:2511` — post-spawn `runUpdateFn(manifestPath, phase.id, updates);` is bare.
4. `orchestrate.js:1762, 1810, ...` — every `mark_phase_*` action invocation of `runUpdateFn` is bare.

## Proposed Solutions

*Option A (recommended) — fix the root in parse-manifest + add defense-in-depth in orchestrate*: make `runUpdate` write atomically (tmp + rename) AND wrap the write in try/catch returning `{ok:false, error}`. Wrap `runOneTick` call site in `orchestrate.js` in a try/catch that logs and continues to the next tick when an unexpected throw escapes. Closes Todo 091 (pre-existing) at the same time.
- Pros: closes the entire cluster (this todo + 091 + 094 below); minimal code touches in orchestrate.js (just the loop body wrap). Effort: small.
- Cons: changes parse-manifest's runUpdate return contract for callers. Risk: medium (touches a shared module).

*Option B — wrap call sites only*: leave parse-manifest alone; wrap every `runUpdateFn(...)` call in `orchestrate.js` and the main loop's `runOneTick` call in try/catch.
- Pros: parse-manifest untouched. Effort: small. Risk: low.
- Cons: doesn't close 091 (atomic-write); duplicates error-handling at every call site.

## Recommended Action

_Pending triage._ Coord lean: Option A for permanent fix; if Unit 11 ships first as Option B and 091 lands as a follow-up, that's also acceptable.

## Technical Details

- `agent-orchestrator/scripts/orchestrate.js:2855` — main loop call.
- `agent-orchestrator/scripts/orchestrate.js:1762, 1810, 2511` — bare runUpdateFn call sites.
- `agent-orchestrator/scripts/parse-manifest.js:838` — bare writeFileSync.

## Acceptance Criteria

- [ ] A test where `_runUpdate` throws (simulating EBUSY) — orchestrator logs + continues to the next tick.
- [ ] A test where parse-manifest's actual `runUpdate` is called against a path whose directory is read-only — returns `{ok:false}` instead of throwing.

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `09dd710` (initial /ce:review round 1 — P1s 088-092 closed) and `c1bd625` (re-round — P1 089/lockfile-startedAt + 2 P2s).

**Resolution:** Bundled with todo 093 (atomic write) per coord dispatch. `parse-manifest.runUpdate` rewritten to use atomic tmp+rename and wrapped in try/catch returning `{ok:false, error}`; `runOneTick` call site in `orchestrate.js` wrapped in try/catch that logs and continues to the next tick. Note: the `dependencies: ["091"]` field is stale from the source /ce:review doc (numbering shifted during authoring — 093 is the actual atomic-write counterpart). Preserved verbatim for audit trail.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Reliability reviewer: rel-1.
