---
status: ready
priority: p2
issue_id: "075"
tags: [code-review, unit-8, check-health, api-versioning, agent-native]
dependencies: []
---

# check-health: JSON output has no schema_version field

`checkHealth`'s JSON output has six fields plus optional `error`,
with no version tag and no schema URI. Unit 11 (and future
operator pipelines) cannot detect a future breaking shape change.
Field renames silently produce `undefined` reads in consumers that
correlate with wrong recovery decisions.

## Problem Statement

`check-health.js:624-633` constructs the result object;
`check-health.js:701` emits it as JSON. The shape is implicit: a
consumer must know the shape by reading source.

If a field is renamed (e.g., `heartbeatAge` → `heartbeat_age_seconds`
for snake_case parity with manifest-status, which is plausible
given todo #078's drift discussion), a Unit 11 consumer pinned to
the old name silently sees `undefined`. It then decides "no
heartbeat available," skips a recovery decision, and the supervised
agent stays crashed.

The agent-native architecture principle here is well-known: every
machine-readable output that crosses a process boundary should
carry a version. The cost is ~2 lines; the benefit is bounded
forward-compat risk.

## Findings

- Result construction: `check-health.js:624-633`.
- CLI emit: `check-health.js:701` —
  `console.log(JSON.stringify(result))`.
- No schema documented in source, no schema in `--help` (see
  todo #076).
- Field renames are foreseeable (snake_case parity per the manifest
  contract).

## Proposed Solutions

### Option A — Add schema_version: 1 field (recommended)

One line in result construction:

```js
return { schema_version: 1, ...rest };
```

Document the field in `--help` and in JSDoc. Bump on any breaking
field rename or removal. Unit 11 can refuse to parse
`schema_version > N` (forward-compat refusal beats silent
mismatch).

- **Pros:** Trivial. Standard agent-native pattern. Lets
  consumers fail loudly on shape change rather than silently.
- **Cons:** One more field; bump discipline must be observed in
  future PRs.
- **Effort:** Trivial (~1 line + doc + 1 test).
- **Risk:** Low.

### Option B — Add a snapshot test that pins the field set

Catch accidental rename/removal in CI without exposing a schema
field. Cross-version interop is not addressed; only intra-repo
drift.

- **Pros:** No public-shape addition.
- **Cons:** Doesn't help cross-version interop. Doesn't help Unit
  11 (a different module) detect breaking changes if it consumes
  a different version of `check-health`.
- **Effort:** Small.
- **Risk:** Low — but doesn't solve the actual problem.

### Option C — Defer

Document that consumers should treat the JSON shape as unstable.

- **Pros:** Zero churn.
- **Cons:** Cross-module agreement on a stable shape is the whole
  point of an output contract.
- **Effort:** Zero.
- **Risk:** Medium.

## Recommended Action

**Option A + Option B — approved 2026-04-29 by coord.** Add
`schema_version: 1` as the first field of `checkHealth`'s return
value. AND add a snapshot-style test that pins the field set
(parses JSON output, asserts the keys match the documented
schema). Both together: future renames break the snapshot
loudly + consumers can detect breaking shape changes by reading
`schema_version`.

Bundle with todos 071 (`pidAliveReason`), 072 (`errorKind`), 076
(--help schema doc), and 083 (`heartbeatCorrupt`) — these all
extend the same JSON output. Land them as a coherent
`schema_version: 1` definition.

Option C (defer) ships V1 without a versioning anchor; future
breakage is silent.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Sites:
  - `:624-633` (result construction)
  - `:701` (CLI emit)
- Companion: must be advertised in `--help` (todo #076).
- Companion: bumped when `errorKind` is added (todo #072), when
  `pidAliveReason` is added (todo #071), and on any future field
  rename.

## Acceptance Criteria

- [ ] `result.schema_version` is `1` on all returns (success and
      error paths).
- [ ] `--help` mentions the field and the bump policy.
- [ ] JSDoc on the exported function documents the schema with
      field types.
- [ ] One test asserts presence and value.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
