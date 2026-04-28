---
status: pending
priority: p2
issue_id: "027"
tags: [code-review, post-pr-9, ce-review, hooks, scripts, cross-module-coupling, test-coverage]
dependencies: []
---

# CI consistency test for VALID_ID_RE ↔ FLAG_NAME_RE character-class lockstep

PR #9's todo 006 chose Option B (mutually-pointing prose comments) over
Option A (runtime require) and Option C (CI test). PR #9 ce:review flagged
that the prose-only enforcement is the only cross-module coupling docs
in the repo without a corresponding test, and that adding a 2-line node:test
assertion at the test layer captures the durability benefit of Option C
without paying the cold-start cost of Option A.

## Problem Statement

After PR #9 the lockstep contract is documented in three places:

- `agent-orchestrator/scripts/parse-manifest.js:79-81` (above `VALID_ID_RE`)
- `agent-orchestrator/hooks/session-start.js:31-33` (above `FLAG_NAME_RE`)
- `agent-orchestrator/hooks/README.md` "Contract invariants" section

But the invariant ("ID character class must stay in sync; change both or
neither — see docs/todos/006") is enforced only by the editor reading the
comment. Three independent ce:review agents (architecture, pattern, agent-
native) converged on the same recommendation: add a build-time invariant
test that imports both regexes and asserts character-class equivalence.

This converts a prose-comment contract into a CI tripwire. Neither the
hook's zero-dep cold-start budget nor the no-shared-test-harness story is
violated — the test imports `parse-manifest.js` at *test load* time, not
at hook runtime. (The cross-module require Option A explicitly rejected
by todo 006 was a *runtime* require from the hook itself.)

## Findings

Convergent across three ce:review agents on PR #9:

1. **Architecture-strategist (P2-1):** "Recommend adopting an explicit
   convention going forward: whenever you add cross-module pinning
   comments, the README's 'Contract invariants' section gets a parallel
   bullet enumerating ALL sites encoding the same value."
2. **Pattern-recognition (P2-1):** "A 2-line consistency test would
   convert the breadcrumb from prose-with-good-intentions into a hard
   tripwire. This is the canonical way this repo would solve a lockstep
   invariant."
3. **Agent-native (warning AN-2):** "ID-class drift is comment-enforced,
   not test-enforced. Recommendation: add a node:test assertion in
   `session-start.test.js` that imports `VALID_ID_RE` from
   `parse-manifest.js` and asserts the character classes are identical."

The invariant for the test:

```js
const { VALID_ID_RE } = require('../scripts/parse-manifest');
assert.strictEqual(
  FLAG_NAME_RE.source,
  '^\\.pending-' + VALID_ID_RE.source.slice(1)
);
```

## Proposed Solutions

### Option A — Test in `hooks/session-start.test.js`

Add the assertion in the existing hooks test suite. Pulls `parse-manifest`
into the hook test's runtime, but only at test time — production hook
load is unaffected.

- **Pros:** Single test file. Co-located with the hook side of the lockstep.
- **Cons:** Cross-package import in hooks tests; minor.
- **Effort:** Small (3-5 LOC + import).
- **Risk:** Low.

### Option B — Test in `scripts/parse-manifest.test.js`

Mirror the import direction; have parse-manifest's tests import the hook
constants and assert the same identity.

- **Pros:** No cross-package import in hooks tests.
- **Cons:** Asymmetric — the lockstep is bidirectional.
- **Effort:** Same as A.
- **Risk:** Low.

### Option C — New `tests/lockstep-invariants.test.js` at repo root

Dedicated test file outside both packages. Reads both files via
require/relative path; explicit "this is a cross-module invariant test."

- **Pros:** Most architecturally honest.
- **Cons:** New test directory; needs wiring into a npm test script.
- **Effort:** Medium (new dir + wiring).
- **Risk:** Low.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected files: `agent-orchestrator/hooks/session-start.test.js` (or
  `parse-manifest.test.js`) for the test; potentially
  `agent-orchestrator/hooks/package.json` if a new script is added.
- No production behavior change.
- Net test count: +1.

## Acceptance Criteria

- [ ] Triage captures chosen Option (A / B / C).
- [ ] A failing test exists that catches divergence between
  `VALID_ID_RE.source` and `FLAG_NAME_RE.source`.
- [ ] Test passes today (regexes match).
- [ ] Combined repo suite remains green.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #9 ce:review (architecture
  + pattern + agent-native agents converged).

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 006 (closed): `docs/todos/006-complete-p3-unit-5-id-regex-duplication.md`
- Architecture-strategist + pattern-recognition + agent-native review
  outputs from PR #9 ce:review session 2026-04-28.
