---
status: pending
priority: p3
issue_id: "052"
tags: [code-review, post-pr-13, ce-review, scripts, security, defense-in-depth]
dependencies: []
---

# `VALID_ID_RE` permits `.`, `..`, `...` — defense-in-depth tighten

PR #13 ce:review's security-sentinel flagged that
`VALID_ID_RE = /^[A-Za-z0-9._-]+$/` accepts dot-only strings. Today
this is harmless because Unit 7 never uses phaseId as a path
segment (the write target is `${phaseDir}/${role}-prompt.md` with
operator-controlled phaseDir + role enum). But the regex is the
shared canonical ID class for both phaseId and pending-flag names,
and a future caller using IDs as path segments would inherit a
traversal vector.

## Problem Statement

`agent-orchestrator/scripts/parse-manifest.js:82`:

```js
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;
```

Per the comment at lines 79-81, this regex must stay in sync with
`FLAG_NAME_RE` in
`agent-orchestrator/hooks/session-start.js`, which is
`^\.pending-` prepended to the same character class (lockstep test
at `agent-orchestrator/scripts/parse-manifest.test.js:644-650`).

`generate-prompt.js:704` validates `phaseId` against `VALID_ID_RE`:

```js
if (typeof o.phaseId !== 'string' || !VALID_ID_RE.test(o.phaseId)) {
  throw new Error(...);
}
```

But `VALID_ID_RE` accepts `.`, `..`, `...` (any all-dots string of
length ≥ 1) because the character class includes `.` and the
quantifier is `+`. Today `phaseId` is rendered as text into the
prompt body (via `{{phase_id}}` interpolation) but is NOT
constructed into a write path — the write target is
`path.join(phaseDir, ...)` where `phaseDir` is operator-controlled
and resolved early. So the all-dots input is harmless in Unit 7.

A future caller — Unit 11's dispatcher, or any hook policy that
uses `phaseId` as a path segment (`path.join(phasesRoot, phaseId)`
or similar) — would immediately have `..` traversal. Because
`VALID_ID_RE` is the canonical "this is a safe identifier"
predicate, that future caller would be entitled to assume safety
and skip an extra check.

## Findings

PR #13 ce:review security-sentinel P3:

> "`parse-manifest.js:82` consumed in `generate-prompt.js:704` —
> VALID_ID_RE permits `..`, `.`, `...` as phase IDs. Today
> harmless in Unit 7 (phaseId is rendered text only, never a
> path component — write target uses operator-controlled
> phaseDir + role enum). But the regex is shared with
> FLAG_NAME_RE per parse-manifest.js:79-80; if a future caller
> (Unit 11 dispatcher) ever uses phaseId as a path segment, `..`
> traversal becomes immediate."

## Proposed Solutions

### Option A — Tighten `VALID_ID_RE` to forbid all-dots strings

Rewrite the regex so the first character must be alphanumeric or
underscore, and the whole string cannot be all dots:

```js
const VALID_ID_RE = /^(?!\.+$)[A-Za-z0-9_][A-Za-z0-9._-]*$/;
```

Equivalently, two-step:

```js
const VALID_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// (First-char anchor implicitly forbids `.`, `..`, `...`.)
```

The simpler form (require first character ∈ `[A-Za-z0-9_]`) also
forbids `-foo` (which a few CLIs misparse as a flag) without the
negative-lookahead.

`FLAG_NAME_RE` in `session-start.js` is
`^\.pending-` + the same class. Since `FLAG_NAME_RE` already has
the `^\.pending-` prefix anchoring the start, the body part can
adopt the same first-char restriction by deriving from a shared
character class (todo 006-style) or by manually mirroring the
edit.

The lockstep regex assertion at
`parse-manifest.test.js:644-650` (which is
`FLAG_NAME_RE.source === '^\\.pending-' + VALID_ID_RE.source.slice(1)`)
needs to be updated so the two regexes still match.

- **Pros:** Eliminates a defense-in-depth gap at the canonical ID
  predicate. Future callers using `phaseId` as a path segment get
  the safety automatically.
- **Cons:** Touches the lockstep regex assertion (todo 027/041)
  and `FLAG_NAME_RE`. Existing manifests using IDs that begin
  with `.`, `-`, or are all dots would suddenly fail validation
  — but no such IDs are in the repo (verifiable via grep).
- **Effort:** Small (regex change in 2 files + lockstep test
  update).
- **Risk:** Low. Lockstep test catches drift; existing tests for
  bad IDs may need expansion.

### Option B — Document the gap in `parse-manifest.js`

Leave the regex as-is. Add a JSDoc paragraph above
`VALID_ID_RE`:

```js
// IMPORTANT: VALID_ID_RE matches `.`, `..`, `...` (all-dots
// strings). Callers using IDs as path segments MUST additionally
// reject `^\.+$` to prevent traversal — Unit 7 is safe because
// it never uses phaseId as a path component. Unit 11 dispatchers,
// hook policies, and future consumers must add their own check.
```

- **Pros:** Zero regex change; preserves existing manifest
  validation surface.
- **Cons:** Defense-in-depth gap remains. Future caller has to
  read the comment.
- **Effort:** Trivial.
- **Risk:** Low today, persists as a latent trap.

### Option C — Defer (no exploit path today)

Unit 7's write target structure makes the gap unreachable. Wait
until Unit 11 surfaces a real path-segment use of `phaseId`.

- **Pros:** Zero churn.
- **Cons:** Defers the fix into Unit 11 implementation pressure,
  where the temptation is to add a local guard rather than fix
  the canonical predicate.
- **Effort:** Zero.
- **Risk:** Low today.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — defense-in-depth at the canonical
predicate is the right place, and the lockstep test update is
mechanical. The simpler `[A-Za-z0-9_][...]*` form is slightly
preferred over the negative-lookahead form for readability.

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/parse-manifest.js:82` —
    `VALID_ID_RE`.
  - `agent-orchestrator/hooks/session-start.js` — `FLAG_NAME_RE`
    (must stay in lockstep).
  - `agent-orchestrator/scripts/parse-manifest.test.js:644-650`
    — lockstep regex assertion.
- Manifest scan: confirm no existing `phaseId` in the repo's
  test fixtures or example manifests starts with `.` or `-`.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `VALID_ID_RE.test('.')`, `VALID_ID_RE.test('..')`,
  `VALID_ID_RE.test('...')` all return false.
- [ ] If A: existing valid phaseIds in test fixtures still pass.
- [ ] If A: lockstep regex assertion still holds (or is updated
  to match the new derivation).
- [ ] If A: `FLAG_NAME_RE` updated symmetrically; flag-file
  parsing tests still pass.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (security-sentinel P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/parse-manifest.js:82` —
  `VALID_ID_RE`.
- `agent-orchestrator/scripts/generate-prompt.js:704` — phaseId
  validation use site.
- `agent-orchestrator/scripts/parse-manifest.test.js:644-650` —
  lockstep regex assertion.
- Todos 006/027/041 — prior decisions on the
  `VALID_ID_RE`/`FLAG_NAME_RE` lockstep enforcement.
