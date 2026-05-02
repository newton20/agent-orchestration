---
status: complete
priority: p2
issue_id: "078"
tags: [code-review, unit-8, check-health, spawn-session, naming-convention, drift]
dependencies: []
---

# check-health: started_at vs spawned_at fallback codifies known drift

`statusEntry.started_at ?? statusEntry.spawned_at` is defensive
against "a future writer mirrors `spawn-session`'s camelCase." That
future writer is Unit 11 itself. The fallback codifies the
ambiguity rather than resolving it, leaving the next reviewer free
to pick whichever name they like — and only the OTHER consumer
breaks.

## Problem Statement

`check-health.js:573-580` reads
`statusEntry.started_at ?? statusEntry.spawned_at`. The fallback
exists because `spawn-session.spawnSession` returns
`{ pid, command, argv, sessionName, title, spawnedAt }` (camelCase).

Unit 11 will be the writer of `manifest-status`. It has two
plausible choices:

1. **snake_case `started_at`** — matches `parse-manifest`'s
   `KNOWN_UPDATE_FIELDS` and the rest of the manifest contract.
2. **camelCase `spawnedAt`** — matches `spawn-session`'s return
   shape, no rename in the writer.

The fallback in `check-health` accepts either. The dispatch
already coord-acked snake_case as canonical for status fields, so
the answer is `started_at` — but the fallback hides the rule
instead of enforcing it. A future Unit 11 author reads
`check-health` and sees "either field works." They pick `spawnedAt`
because it requires no rename. Then a different consumer
(future-future, or a recovery agent) reads `started_at` and breaks.

The fallback is not defense in depth; it's a postponed argument.

## Findings

- Site: `check-health.js:573-580`
  (`statusEntry.started_at ?? statusEntry.spawned_at`).
- `spawn-session.spawnSession` return shape: `spawnedAt`
  (camelCase).
- `parse-manifest.KNOWN_UPDATE_FIELDS`: snake_case for status
  fields (canonical per dispatch).
- Unit 11 has not yet landed; today's `manifest-status` writers
  use `started_at`.
- The fallback masks the canonical-name choice from Unit 11's
  reviewer.

## Proposed Solutions

### Option A — Pick started_at as canonical, drop fallback (recommended)

Read only `statusEntry.started_at`. Add a one-line clarifying note
in `spawn-session.spawnSession`'s docstring: "callers persisting
`spawnedAt` to `manifest-status` MUST rename to `started_at` —
manifest-status is snake_case by contract." Optionally add a
`spawn-session` README/JSDoc block linking to
`parse-manifest.KNOWN_UPDATE_FIELDS`.

- **Pros:** Forces Unit 11's hand toward the canonical name.
  Eliminates the silent "either works" trap. Snake_case parity
  with the rest of the manifest contract is preserved.
- **Cons:** If a writer mistakenly persists `spawnedAt`, the
  health check ignores `started_at`-absent rows. But that's the
  POINT — fail loudly so the writer is corrected.
- **Effort:** Small (drop fallback + 1 line of docstring + 1
  test).
- **Risk:** Low.

### Option B — Pick spawnedAt as canonical, migrate parse-manifest

Reverse the choice: standardize on camelCase for status fields,
update `parse-manifest.KNOWN_UPDATE_FIELDS`, update existing
manifest-status writers.

- **Pros:** No rename burden on `spawn-session` consumers.
- **Cons:** Touches multiple files. Reverses the dispatch's
  snake_case-canonical decision. Breaks any existing
  manifest-status fixtures.
- **Effort:** Medium.
- **Risk:** Medium — deeper migration.

### Option C — Defer; keep fallback

Keep `started_at ?? spawned_at` as is and let Unit 11's reviewer
decide.

- **Pros:** Zero churn.
- **Cons:** The fallback's purpose was always "make it easier for
  a future writer to be wrong." That hasn't changed.
- **Effort:** Zero.
- **Risk:** Medium — Unit 11 picks `spawnedAt`, recovery agent
  expects `started_at`, drift compounds.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Pick `started_at`
as the canonical name (already used by check-health's primary
read path). Drop the `spawned_at` fallback. Update any other
consumer that writes/reads the field to use `started_at` only.

Specifically: review `runUpdate` in parse-manifest and any
spawn-session writes to manifest-status.yaml. If they write
`spawnedAt` (camelCase) or `spawned_at`, migrate to
`started_at`. One canonical name; one write path; no fallback to
hide future drift.

Coordinates with todo 069 (loadStatus in parse-manifest) — both
land in the parse-manifest reuse work, plus check-health's
fallback removal.

Option B (pick spawnedAt + migrate parse-manifest) is a larger
edit with no semantic gain. Option C (keep fallback) ships the
ambiguity into Unit 11's writer surface.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/check-health.js` (lines 573-580)
  - `agent-orchestrator/scripts/spawn-session.js` (docstring on
    `spawnSession` return shape)
- Test file:
  - `agent-orchestrator/scripts/check-health.test.js` (a test
    asserting `spawned_at`-only rows are NOT picked up if Option A
    chosen)
- Canonical reference: `parse-manifest.KNOWN_UPDATE_FIELDS`.

## Acceptance Criteria

- [ ] One canonical name is chosen and documented.
- [ ] If Option A: fallback removed; `spawn-session.spawnSession`
      docstring states the rename rule; a test pins
      `spawned_at`-only rows to NOT resolve.
- [ ] If Option B: `parse-manifest.KNOWN_UPDATE_FIELDS` updated;
      existing fixtures migrated; manifest-reference doc updated.
- [ ] Unit 11 spec updated to reference the canonical name.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/spawn-session.js`
  - `agent-orchestrator/scripts/check-health.test.js`
- Canonical reference: `agent-orchestrator/scripts/parse-manifest.js`
  (`KNOWN_UPDATE_FIELDS`).
