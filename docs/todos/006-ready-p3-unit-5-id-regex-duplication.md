---
status: ready
priority: p3
issue_id: "006"
tags: [code-review, unit-5, architecture, cross-module-coupling, dry]
dependencies: []
---

# ID character-class duplicated between `parse-manifest.VALID_ID_RE` and `session-start.FLAG_NAME_RE`

## Problem Statement

Two modules independently embed the same ID character class:

- `agent-orchestrator/scripts/parse-manifest.js:78` —
  `VALID_ID_RE = /^[A-Za-z0-9._-]+$/`
- `agent-orchestrator/hooks/session-start.js:24` —
  `FLAG_NAME_RE = /^\.pending-[A-Za-z0-9._-]+$/`

They must agree forever. If they diverge:

- A manifest-valid phase id (say, with `:` allowed in the manifest)
  writes a `.pending-phase:0` flag that the hook silently rejects
  → Unit 11 spawn leaks a prompt.
- A hook-valid flag name (broader class) is ingested but the
  corresponding `phases/<id>/` directory is never created by the
  scaffolder.

Neither failure is loud. Both are the kind of bug that lives at the
boundary between shipped units.

## Findings

Flagged by the architecture-strategist during ce-review of PR #4.
Convergent with the simplicity reviewer's observation that both
exports are "test-only" on the hook side — they exist precisely to
keep the two modules in lockstep.

Today the two regexes agree. No behavior change needed. But the
cross-module invariant is undocumented.

## Proposed Solutions

### Option A — Build FLAG_NAME_RE from VALID_ID_RE at hook load time

```js
const { VALID_ID_RE } = require('../scripts/parse-manifest');
const FLAG_NAME_RE = new RegExp(
  '^\\.pending-' + VALID_ID_RE.source.slice(1, -1) + '$'
);
```

- **Pros:** Single source of truth. Divergence becomes impossible.
- **Cons:** Adds a require from `hooks/` → `scripts/`, breaking the
  nice zero-dep boundary the hook currently has. Hook now depends
  on the full `parse-manifest.js` module load (js-yaml, etc.) —
  adds non-trivial cold-start cost to a critical path that fires
  on every SessionStart.
- **Effort:** Small (code), moderate (cold-start budget analysis).
- **Risk:** Medium — cold-start regression.

### Option B — Document the duplication with cross-reference comments

Add a pinned comment on both sides:

```js
// parse-manifest.js:77
// ID character class. Must stay in sync with FLAG_NAME_RE in
// agent-orchestrator/hooks/session-start.js. See docs/todos/006
// for context; change both or neither.
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;
```

- **Pros:** Zero runtime cost. Preserves the zero-dep boundary.
  Makes the invariant legible to the next person editing either
  file.
- **Cons:** Relies on the reader actually reading the comment.
  No CI enforcement.
- **Effort:** Trivial. 4 LOC across two files.
- **Risk:** Low.

### Option C — CI-enforced duplication with a consistency test

Add a shared test (probably under `scripts/` since it has the
js-yaml dep) that requires both modules and asserts their character
classes match. Runs on every push.

- **Pros:** Mechanical enforcement; no reliance on reader attention.
- **Cons:** Requires a shared test harness that can import both
  files. Hook's `package.json` is currently zero-dep.
- **Effort:** Small. ~10 LOC of test + wiring in root package.json.
- **Risk:** Low.

## Recommended Action

**Option B — approved 2026-04-22 by coord.** Add pinned cross-
reference comments on both sides naming the sister file + this todo
id. Preserves the zero-dep hook boundary (cold-start budget matters
— `session-start.js` runs on every SessionStart), preserves the
shippable test story (no new shared test harness), and makes the
invariant legible to the next editor of either file.

Option A (runtime `require`) rejected because it pulls js-yaml into
the hook's cold-start path. Option C (CI test) rejected because the
hook's `package.json` is currently zero-dep and adding a
cross-module test would require wiring. Both options' value is
"mechanical enforcement" but the invariant is unlikely to be edited
without the editor noticing the comment (the character class is
visually distinctive: `[A-Za-z0-9._-]`).

Dispatch as part of the post-Unit-6 cleanup PR bundle with todos
001, 002, 004, 005, 007. Expected change: 4 LOC across two files
plus a short "Contract invariants" bullet in
`agent-orchestrator/hooks/README.md` cross-referencing `parse-manifest.js`.

## Technical Details

- **Affected files:**
  - `agent-orchestrator/scripts/parse-manifest.js` (line 78)
  - `agent-orchestrator/hooks/session-start.js` (line 24)
  - `agent-orchestrator/hooks/README.md` (optional — add a
    "Contract invariants" cross-reference to parse-manifest)
- **No database changes.**

## Acceptance Criteria

- [ ] Triage captures the chosen option (A / B / C).
- [ ] If B: both files have comments pointing at each other AND at
  this todo.
- [ ] If C: a new test asserts the character-class equivalence.
- [ ] Combined repo suite remains green.

## Work Log

- **2026-04-22 — todo created** — Surfaced by ce-review architecture-
  strategist during final pre-merge review of PR #4.

## Resources

- PR #4: https://github.com/newton20/agent-orchestration/pull/4
- `parse-manifest.js:78` — upstream regex
- `session-start.js:24` — hook-side regex
- ce-review agents: architecture-strategist, code-simplicity-reviewer
