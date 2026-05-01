---
status: ready
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

Export `loadStatus(manifestPath) → { ok, status, error }` from
`parse-manifest.js`. The argument is `manifestPath` (NOT a status
path or directory) for symmetry with `runUpdate(manifestPath, …)`
and `loadManifest(manifestPath)` — `loadStatus` derives the
sibling status path internally via `statusPathFor(manifestPath)`,
so callers pass the same primary key the writer side already
takes. Refactor `runUpdate` to call `loadStatus` internally
(no behavior change). Reduce `check-health.js`'s `readPhaseStatus`
to a thin wrapper that calls `loadStatus(manifestPath)` and
indexes into `status.phases[phaseId]`.

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

**Option A — approved 2026-04-29 by coord.** Add `loadStatus`
(or equivalent) to `parse-manifest.js`'s exports — the canonical
manifest-status YAML loader with the same `__proto__` filter,
shape validation, and YAML schema pin (DEFAULT_SCHEMA per todo
031) that `runUpdate` uses on the writer side. The exported
signature is `loadStatus(manifestPath) → { ok, status, error }`
(NOT `loadStatus(statusPath)`) for symmetry with
`runUpdate(manifestPath, …)` and `loadManifest(manifestPath)` —
callers pass the manifest path; `loadStatus` derives the
sibling status path internally. Replace `check-health.js`'s
inline parse + structural guards with
`require('./parse-manifest').loadStatus(manifestPath)`.

Closes the reuse-discipline gap and ensures readers + writers
share normalization. Future hardenings (e.g., schema version
bump) propagate to all consumers via one source of truth.

Option B (apply UNSAFE_ID_KEYS inline in readPhaseStatus) preserves
the duplication; Option C (defer) ships the same drift to Unit 11.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

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
