---
status: complete
priority: p3
issue_id: "086"
tags: [code-review, unit-8, check-health, performance, unit-11-prep, batching]
dependencies: []
---

# Polling-loop ergonomics missing from public contract (batching seam)

## Problem Statement

Unit 11's likely needs are memoization, backoff, concurrency control. None are addressed in `checkHealth`'s public surface. Specifically:

- (a) no way to share manifest-load cache across calls — every poll re-loads `manifest.yaml` + `manifest-status.yaml` from disk;
- (b) no way to share WMI snapshot — each role-scoped lookup spawns a separate PowerShell child;
- (c) no batch surface — Unit 11 maps over phases × roles serially.

Result: Unit 11 likely builds a `pollAllPhases({manifest, snapshot})` wrapper around `checkHealth` that bypasses its loaders, leaving them vestigial in production (alive only for CLI and tests). Performance audit P1 cross-references.

## Findings

1. **checkHealth re-reads manifest files per call** — disk-bound work duplicated across a polling loop.
2. **PID lookup spawns PowerShell per call** — WMI snapshot is not shareable.
3. **Existing test injection (`_pidLookup`)** is the same pattern that batching seams would extend.
4. **Risk of dead-loaders-in-prod** if Unit 11 wraps and bypasses without the seams.

## Proposed Solutions

### Option A — Add batching seams: `_loadedManifest`, `_loadedStatus`, `_pidSnapshot` injection

Existing tests already inject `_pidLookup`; this is the same pattern at one level higher. Document as "Unit 11 batching seam."

- **Pros**: Lets Unit 11 share state across polls; keeps internal loaders alive (still used for CLI/tests).
- **Cons**: Expands internal-but-exported surface; needs JSDoc framing.
- **Effort**: Small–Medium.
- **Risk**: Low.

### Option B — Defer to Unit 11

Let Unit 11 wrap and bypass `checkHealth`'s internal loaders.

- **Pros**: Zero work in this PR.
- **Cons**: `checkHealth`'s loaders become dead in prod; future drift risk.
- **Effort**: Zero.
- **Risk**: Medium — internal-vs-prod divergence.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Add three injection
seams to `checkHealth`'s opts:
- `_loadedManifest` — already-loaded manifest object; if set,
  skip `loadManifest(manifestPath)`
- `_loadedStatus` — already-loaded manifest-status (per todo 069's
  `loadStatus`); if set, skip the read
- `_pidSnapshot` — already-fetched WMI/process-table snapshot
  (Map<sessionName, {pid, parentPid, ...}>); if set, skip
  `getSessionPid` invocation

The underscore prefix signals "advanced caller (Unit 11) opt-in;
not part of the everyday API." Default behavior unchanged for the
CLI + simple programmatic callers.

Unit 11 builds `pollAllPhases({manifest, status, snapshot})` once
per tick; each per-phase `checkHealth` call passes the
pre-loaded artifacts. Per-poll cost drops from O(N × disk +
WMI per phase) to O(disk + WMI once + N × in-memory checks).

Option B (defer) leaves Unit 11 to either (a) re-load every poll
or (b) bypass the public surface entirely. Both are bad
outcomes.

Dispatch as part of the **pre-Unit-11 hardening PR bundle** —
the underscore-prefix convention should land with the other
pre-Unit-11 contracts so Unit 11's design has a complete
batching API surface to consume.

## Technical Details

**Affected file:** `agent-orchestrator/scripts/check-health.js:371-634` (full `checkHealth`)

Existing seam pattern: `_pidLookup` injection in tests. New seams (`_loadedManifest`, `_loadedStatus`, `_pidSnapshot`) would follow the same shape.

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] If Option A: `checkHealth` accepts `_loadedManifest`, `_loadedStatus`, `_pidSnapshot` and bypasses internal loaders when provided. JSDoc labels them "Unit 11 batching seam."
- [ ] Existing tests still pass; new tests cover injected-state paths.
- [ ] If Option B: a docs note records the deferred decision and the prod-only loader concern.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/check-health.test.js`
- `agent-orchestrator/scripts/spawn-session.js`
