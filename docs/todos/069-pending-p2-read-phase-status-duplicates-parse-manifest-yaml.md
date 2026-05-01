---
status: pending
priority: p2
issue_id: "069"
tags: [code-review, unit-8, check-health, parse-manifest, reuse, single-source-of-truth]
dependencies: []
---

# check-health: readPhaseStatus duplicates manifest-status YAML parsing instead of routing through parse-manifest

`readPhaseStatus` calls `yaml.load` directly and re-implements
structural guards (object shape, phases-map shape, entry shape)
for the SAME status file shape that `parse-manifest`'s `runUpdate`
already parses. Reuse-discipline gap: when `parse-manifest` adds
normalization (e.g., the `__proto__` filter at parse-manifest.js:747
that `readPhaseStatus` does NOT have), the two paths drift.

## Problem Statement

`check-health.js:286-312` opens `manifest-status.yaml`, runs
`yaml.load`, and validates structure inline. Meanwhile,
`parse-manifest.js:720-752` (`runUpdate`) ALREADY parses the same
file, with the same shape, and with additional safety:

- `UNSAFE_ID_KEYS` filter (`__proto__`, `constructor`, etc.).
- Merge-key handling.
- Entry shape normalization.

The two readers disagree TODAY. A status file with a
`__proto__: { …malicious }` key is filtered by `runUpdate` and
ingested as-is by `readPhaseStatus`. The dispatch coord-acked
`parse-manifest` as the canonical reader for manifest-shape data,
but Unit 8 grew its own.

Multi-source-of-truth risk for the manifest-status contract.

## Findings

- `check-health.js:286-312`: `readPhaseStatus` calls `yaml.load`
  directly, hand-validates `result.phases[phaseId]`.
- `parse-manifest.js:720-752`: `runUpdate` reads the same file,
  applies `UNSAFE_ID_KEYS` filter at line 747.
- No exported `loadStatus` API in `parse-manifest`, so reuse
  requires a small refactor.
- Drift surface area: any future normalization added to one path
  silently disagrees with the other.

## Proposed Solutions

### Option A — Add loadStatus to parse-manifest, reuse from check-health (recommended)

Export `loadStatus(manifestDir) → { ok, status, error }` from
`parse-manifest.js`. Refactor `runUpdate` to call it internally
(no behavior change). Reduce `check-health.js`'s `readPhaseStatus`
to a thin wrapper that calls `loadStatus` and indexes into
`status.phases[phaseId]`.

- **Pros:** Single source of truth. Future normalization added in
  one place flows to both consumers automatically. The
  `UNSAFE_ID_KEYS` filter applies in both paths.
- **Cons:** Touches both files. Adds a new exported API surface.
- **Effort:** Small-Medium (~30-50 lines net + tests on both
  sides).
- **Risk:** Low — `runUpdate` keeps its current behavior.

### Option B — Apply UNSAFE_ID_KEYS filter inline in readPhaseStatus

Smaller blast radius: copy the filter logic (or import the keyset
constant if exported) and apply it in `readPhaseStatus` before
returning. Closes the `__proto__` gap without an API change.

- **Pros:** Minimal diff. No new export.
- **Cons:** Doesn't solve the underlying drift problem; future
  normalization in one place still won't reach the other.
- **Effort:** Small (~5 lines + 1 test).
- **Risk:** Low.

### Option C — Defer

Document the discrepancy and revisit if/when a real bug surfaces.

- **Pros:** Zero churn.
- **Cons:** Real `__proto__` gap exists today. Drift compounds.
- **Effort:** Zero.
- **Risk:** Medium.

## Recommended Action

_Pending triage._

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/check-health.js` (lines 286-312)
  - `agent-orchestrator/scripts/parse-manifest.js`
    (lines 720-752, plus new export)
- Test files:
  - `agent-orchestrator/scripts/check-health.test.js`
  - `agent-orchestrator/scripts/parse-manifest.test.js`

## Acceptance Criteria

- [ ] A manifest-status file containing a `__proto__` key under
      `phases` does NOT pollute the prototype when read via
      `check-health`.
- [ ] If Option A taken: `parse-manifest` exports `loadStatus`,
      `runUpdate` is refactored to call it, and
      `readPhaseStatus` is a thin wrapper.
- [ ] If Option B taken: `readPhaseStatus` filters
      `UNSAFE_ID_KEYS` before returning the entry.
- [ ] Existing manifest-status tests in both files pass without
      modification.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/parse-manifest.js`
  - `agent-orchestrator/scripts/check-health.test.js`
  - `agent-orchestrator/scripts/parse-manifest.test.js`
