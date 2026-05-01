---
status: ready
priority: p2
issue_id: "077"
tags: [code-review, unit-8, parse-manifest, single-source-of-truth, v1.5-prep]
dependencies: []
---

# check-health: VALID_ROLES cross-module truth duplicated in source

`VALID_ROLES = ['impl', 'qa', 'coord']` lives at
`check-health.js:100`. The same role list is encoded implicitly in
`defaultSessionName` (lines 365-367) and in `spawn-session`'s
session-name convention. When V1.5 adds a recovery role (the test
at `check-health.test.js:1619` explicitly rejects it as "V1.5
territory"), three independent sites need editing. Drift is
inevitable on the V1.5 PR.

## Problem Statement

Today the role enum is duplicated:

- `check-health.js:100`: explicit array
  `VALID_ROLES = ['impl', 'qa', 'coord']`.
- `check-health.js:365-367`: `defaultSessionName` encodes the same
  role set in its template.
- `spawn-session`: session-name format docs and validation
  implicitly encode the role set.
- `parse-manifest`: validates roles in agents arrays — the
  CANONICAL site for "what is a valid role" by manifest contract.

When V1.5 introduces a recovery role (per the dispatch and the
explicit-rejection test at `check-health.test.js:1619`), the V1.5
unit author must:

1. Find the literal `['impl', 'qa', 'coord']` in `check-health`.
2. Update `defaultSessionName`'s template.
3. Update `spawn-session`'s docs / validation.
4. Update `parse-manifest`'s validator.

Step ordering matters; missing any one site silently breaks a
downstream consumer. This is the canonical "single source of truth"
violation that's bitten the manifest contract before.

## Findings

- `check-health.js:100`: `VALID_ROLES` literal.
- `check-health.js:365-367`: `defaultSessionName` reuses the role
  set without referencing `VALID_ROLES`.
- `parse-manifest.js`: validates roles per manifest schema —
  candidate canonical site.
- `spawn-session.js`: session-name format implicitly tied.
- `check-health.test.js:1619`: explicit "V1.5 territory" rejection
  test marks the V1.5 expansion point.

## Proposed Solutions

### Option A — Hoist VALID_ROLES to parse-manifest, re-export (recommended)

Add `VALID_ROLES` (or `ROLES`) as an exported constant in
`parse-manifest.js`. Have `check-health` import it. Have
`spawn-session` import it for its session-name format / validation.
Refactor `defaultSessionName` to compose the format from the
imported constant.

- **Pros:** One source of truth. V1.5 author updates one constant
  and every consumer follows. Aligns with `parse-manifest` as the
  canonical owner of manifest-shape vocabulary.
- **Cons:** Touches three files. Requires `parse-manifest` to
  expose a small new symbol — but it already validates roles
  internally, so the refactor is mostly "extract constant."
- **Effort:** Small (extract + 3 imports + 2 tests pinning the
  re-export).
- **Risk:** Low.

### Option B — Defer to V1.5 unit author

Document in a comment near `VALID_ROLES` that V1.5 will add
"recovery" and the author must update three sites.

- **Pros:** Zero churn now.
- **Cons:** The V1.5 author has to find all three sites; comment
  may be missed; drift on the V1.5 PR.
- **Effort:** Trivial.
- **Risk:** Low — but defers a clean fix that the V1.5 PR will
  benefit from.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Hoist `VALID_ROLES`
to `parse-manifest.js`'s `module.exports` (analogous to how
`VALID_ID_RE` was hoisted in PR #11). Update `check-health.js`
and `spawn-session.js` to `require` it from parse-manifest rather
than each maintaining their own copy. Document in the
parse-manifest export comment: "Authoritative role enum;
mutating this requires updating every consumer + the V1.5
recovery role addition path (see todo 085)."

Closes the future-V1.5-drift hazard captured in the codex
review. The recovery role addition becomes a one-file edit in
parse-manifest plus targeted updates per consumer that
specifically exclude/include `recovery`.

Option B (defer to V1.5 unit author) ships the duplication
permanently into V1.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/check-health.js` (lines 100,
    365-367)
  - `agent-orchestrator/scripts/parse-manifest.js` (add export)
  - `agent-orchestrator/scripts/spawn-session.js` (consume export
    where session-name format is encoded)
- Test files:
  - `agent-orchestrator/scripts/check-health.test.js`
  - `agent-orchestrator/scripts/parse-manifest.test.js`
- V1.5 expansion-point marker: `check-health.test.js:1619`.

## Acceptance Criteria

- [ ] `parse-manifest` exports a single `VALID_ROLES` (or `ROLES`)
      constant.
- [ ] `check-health` imports and uses it; the literal at line 100
      is removed.
- [ ] `defaultSessionName` composes its template from the imported
      constant.
- [ ] `spawn-session` consumes it (or, at minimum, has a comment
      pointing to the canonical export).
- [ ] Existing tests pass without modification.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/parse-manifest.js`
  - `agent-orchestrator/scripts/spawn-session.js`
  - `agent-orchestrator/scripts/check-health.test.js`
- V1.5 marker: `check-health.test.js:1619`.
