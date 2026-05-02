---
status: pending
priority: p2
issue_id: "087"
tags: [unit-11-design, spawn-session, check-health, manifest-status, writer-reader-asymmetry, post-pr-17]
dependencies: []
---

# Writer-side `started_at` rename in spawn-session output / manifest-status persist path

## Problem Statement

PR #17 closed todo 078 by making `check-health.js` read `started_at`
(snake_case) from manifest-status.yaml as the canonical timestamp,
dropping the `?? spawned_at` fallback. The reader side is now
single-canonical-name.

The writer side is incomplete:

- `spawn-session.js` returns / logs `spawnedAt` (camelCase) in its
  output shape.
- `parse-manifest.js`'s `runUpdate` is the canonical writer for
  `manifest-status.yaml` and would store whatever key the caller
  passes.

Today this is **decoupled** at runtime: `spawn-session.js` does NOT
directly persist to `manifest-status.yaml` — it just spawns the wt
tab and returns metadata. The reader/writer asymmetry is benign as
long as no orchestrator wires spawn-session output into a
manifest-status write.

**Unit 11 will wire this.** Per the plan, Unit 11's polling loop
calls `spawnSession` to launch a phase, then writes the spawn
result (PID, started timestamp, etc.) into `manifest-status.yaml`
via `runUpdate`. At THAT moment, the camelCase `spawnedAt` from
`spawn-session.js`'s return value would land in the YAML under
the wrong key — and `check-health.js` (post-PR-17) would not find
it, surfacing as `pidAlive: null + pidAliveReason: 'lookup_failed'`
forever.

## Findings

QA report on PR #17 (2026-05-01) flagged this carry-forward note:

> "spawnedAt (camelCase) in spawn-session.js vs started_at
> (snake_case) read in check-health.js — documented + tested,
> but writer-side rename needed wherever spawn-session output
> gets serialized into manifest-status. Not blocking."

The "not blocking" judgment is correct for PR #17 itself. The
write path is Unit 11's design responsibility.

## Proposed Solutions

### Option A — Unit 11 owns the rename as part of its dispatch (recommended)

Unit 11's design phase explicitly handles the spawn-session →
manifest-status persist path. When wiring it, normalize to
`started_at` snake_case at the boundary:

```js
const spawnResult = spawnSession({...});
runUpdate(manifestPath, phaseId, {
  // snake_case at the YAML boundary; camelCase stays internal to spawn-session
  pid: spawnResult.pid,
  started_at: spawnResult.spawnedAt,
  ...
});
```

The internal camelCase in spawn-session stays (Node convention);
the snake_case at the YAML boundary matches the parse-manifest +
check-health convention.

- **Pros:** No change to spawn-session.js or its tests. Unit 11
  owns the boundary translation, which is its natural
  responsibility (it's the integration layer).
- **Cons:** None — Unit 11's design has to handle this boundary
  anyway.
- **Effort:** Small (one boundary translation in Unit 11 code).
- **Risk:** Low.

### Option B — Rename spawn-session's return shape now

Change `spawn-session.js` to return `started_at` (snake_case)
instead of `spawnedAt` (camelCase). All callers (today: just the
internal post-spawn lookup at L690 area) updated.

- **Pros:** Single canonical name across modules, no boundary
  translation needed.
- **Cons:** Breaks the camelCase JS convention for in-memory
  return values. Touches spawn-session + tests for a benefit
  that's purely about wire-format symmetry.
- **Effort:** Small.
- **Risk:** Low for spawn-session itself; medium if any external
  consumer (none today) reads `spawnedAt`.

### Option C — Defer indefinitely

No action; Unit 11's first integration test will catch the
mismatch.

- **Pros:** Zero effort.
- **Cons:** Surfaces as a runtime bug rather than a design
  decision. Wastes Unit 11 impl time.
- **Effort:** Zero.
- **Risk:** Medium — Unit 11 implementer hits this in test.

## Recommended Action

_(filled when Unit 11 dispatches.)_

**Coord lean: Option A.** Unit 11 is the integration layer that
naturally owns boundary translations between modules. The
spawn-session internal return shape stays JS-conventional
(camelCase); the YAML wire format stays snake_case (matches
parse-manifest + check-health). Unit 11 translates at the seam.
This todo's Recommended Action will be filled in the post-Unit-11
triage PR by either marking it complete (Unit 11 shipped the
translation) or pivoting to Option B if Unit 11's design surfaces
a reason.

## Technical Details

- Reader (snake_case): `agent-orchestrator/scripts/check-health.js`
  — reads `status.started_at` from manifest-status.yaml.
- Writer (today): `agent-orchestrator/scripts/parse-manifest.js`'s
  `runUpdate` — writes whatever caller passes.
- Source of camelCase: `agent-orchestrator/scripts/spawn-session.js`
  — returns `spawnedAt` in spawn metadata.
- **No current bug:** spawn-session's output is not persisted to
  manifest-status.yaml today.
- **Future bug:** Unit 11's spawn → status-write wire would
  surface the asymmetry.

## Acceptance Criteria

- [ ] Unit 11's design or impl phase explicitly handles the
      camelCase ↔ snake_case boundary (Option A) OR migrates
      spawn-session to snake_case (Option B).
- [ ] After Unit 11 ships: `check-health.js` reading the timestamp
      from a Unit-11-spawned phase's manifest-status.yaml
      returns a sensible value (not null / not undefined).
- [ ] Integration test (in Unit 11's test surface) covers the
      end-to-end spawn → write → poll → read flow.

## Work Log

- **2026-05-01 — todo created.** Carry-forward from PR #17 QA
  report. Disposition deferred to Unit 11 dispatch.

## Resources

- PR #17 QA report:
  `~/.claude/handoffs/newton20-agent-orchestration/20260501-170409-qa-report.md`
- PR #17 merge commit: `734c5c5`
- Todo 078 (closed): the reader-side migration (started_at
  canonical).
- Affected files (read side):
  `agent-orchestrator/scripts/check-health.js`
- Affected files (writer side, deferred to Unit 11):
  `agent-orchestrator/scripts/spawn-session.js` AND/OR Unit 11's
  new orchestrator script.
