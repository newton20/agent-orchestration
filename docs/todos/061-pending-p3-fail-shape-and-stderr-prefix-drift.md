---
status: pending
priority: p3
issue_id: "061"
tags: [code-review, post-pr-13, ce-review, scripts, pattern, error-shape]
dependencies: []
---

# `generate-prompt.js`'s `fail()` drifts from sibling-module shape

PR #13 ce:review pattern-recognition-specialist flagged that
`generate-prompt.js` defines a `fail()` helper that diverges from
the established sibling-module pattern in two ways: it drops the
`code` parameter and includes the `.js` suffix in the stderr
prefix.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:932-935`:

```js
function fail(msg) {
  process.stderr.write(`generate-prompt.js: ${msg}\n`);
  process.exit(1);
}
```

Sibling modules use a consistent shape:

- `agent-orchestrator/scripts/parse-manifest.js:142-145`:
  ```js
  function fail(msg, code = 1) {
    process.stderr.write(`parse-manifest: ${msg}\n`);
    process.exit(code);
  }
  ```
- `agent-orchestrator/scripts/scaffold-protocol.js:80-83` — same
  shape, prefix `scaffold-protocol:`.
- `agent-orchestrator/scripts/spawn-session.js:730-733` — same
  shape, prefix `spawn-session:`.

Two drifts:

1. **Missing `code` param:** generate-prompt.js cannot exit with a
   non-1 code without inlining `process.exit`.
2. **`.js` suffix in prefix:** stderr reads `generate-prompt.js:`
   while siblings emit bare module names (`parse-manifest:`).

## Findings

PR #13 ce:review pattern-recognition-specialist P3:

> "`generate-prompt.js:932-935` defines `fail(msg)` that diverges
> from the sibling pattern at `parse-manifest.js:142-145`,
> `scaffold-protocol.js:80-83`, and `spawn-session.js:730-733`.
> The siblings accept `code = 1` and prefix with bare module
> name. generate-prompt drops the param and uses the `.js`
> suffix. Align to the sibling shape — error messages should
> read consistently across the script suite."

## Proposed Solutions

### Option A — Align `generate-prompt.js` to the sibling shape

Edit `agent-orchestrator/scripts/generate-prompt.js:932-935`:

```js
function fail(msg, code = 1) {
  process.stderr.write(`generate-prompt: ${msg}\n`);
  process.exit(code);
}
```

Update existing tests that assert against the `generate-prompt.js:`
prefix to expect `generate-prompt:`.

- **Pros:** Sibling-module consistency. Future readers find one
  shape across the suite. Optional non-1 exit codes available
  without further drift.
- **Cons:** Touches existing test fixtures that match the current
  prefix. Lockstep edit.
- **Effort:** Small (helper edit + test fixture sweep).
- **Risk:** Low — tests catch any missed prefix.

### Option B — Update sibling modules to the new shape

Reverse direction: keep generate-prompt's shape, conform siblings.
Rejected on V1-freeze posture (siblings are already shipped and
their callers depend on the bare-name prefix).

- **Pros:** Zero edits to generate-prompt.
- **Cons:** Touches three additional files post-V1. Inverts the
  drift direction (siblings are the established norm).
- **Effort:** Medium.
- **Risk:** Medium.

### Option C — Defer

V1-freeze posture: leave the drift; it doesn't cause functional
breakage.

- **Pros:** Zero churn.
- **Cons:** stderr inconsistency persists across the suite.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected files (Option A):
  - `agent-orchestrator/scripts/generate-prompt.js:932-935`
  - `agent-orchestrator/scripts/generate-prompt.test.js` —
    sweep for `generate-prompt.js:` prefix matches.
- Sibling references for the canonical shape:
  - `agent-orchestrator/scripts/parse-manifest.js:142-145`
  - `agent-orchestrator/scripts/scaffold-protocol.js:80-83`
  - `agent-orchestrator/scripts/spawn-session.js:730-733`

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `fail()` accepts `code = 1`; prefix is bare module
  name.
- [ ] If A: tests updated for the new prefix; full suite green.
- [ ] If A: at least one test exercises a non-default exit code
  through the helper (or fixture sweep documented).

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (pattern-recognition-specialist P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- Sibling pattern locus:
  `agent-orchestrator/scripts/parse-manifest.js:142-145`
- `agent-orchestrator/scripts/generate-prompt.js:932-935`
