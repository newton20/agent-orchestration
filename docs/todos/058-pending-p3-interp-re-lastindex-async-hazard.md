---
status: pending
priority: p3
issue_id: "058"
tags: [code-review, post-pr-13, ce-review, scripts, performance, defensive-design]
dependencies: []
---

# Module-scoped `INTERP_RE` carries `lastIndex` state — async/re-entrant hazard

PR #13 ce:review's performance-oracle flagged that `INTERP_RE` is a
module-scoped global regex (`/g` flag). In current Node sync code
this is fine, but a future async/await refactor or generator-based
re-entrant call could race the per-regex `lastIndex` state and
silently corrupt output.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:138`:

```js
const INTERP_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
```

Used at:
- Line 191: `body.replace(INTERP_RE, (match, name) => { ... })` —
  `interpolate()`.
- Line 235: `body.replace(INTERP_RE, (_m, name) => { ... })` —
  `renderTemplate()` body-var discovery.

`String.prototype.replace` with a `/g` regex resets `lastIndex` to
0 internally, so today this is safe under fully-synchronous
execution. Two facts about JavaScript regex semantics make this
fragile under future refactors:

1. A `/g` regex carries a `lastIndex` property between calls when
   used with `RegExp.prototype.exec` / `RegExp.prototype.test` (not
   with `String.prototype.replace`, but those methods are easily
   reachable).
2. If two callers share the same regex object and one is
   suspended (async/await across a `for` loop calling `.exec()`
   in stages, or a generator yielding mid-scan), the other can
   advance `lastIndex` and corrupt the suspended caller's
   subsequent matches.

Today `interpolate()` and the body-var-discovery `replace` in
`renderTemplate()` are both fully synchronous calls to
`String.prototype.replace`, which internally manages
`lastIndex` and resets it. The hazard is purely speculative
under V1.

A future refactor that:
- Awaits inside a `for-of` over `INTERP_RE.exec(body)`, OR
- Uses `INTERP_RE` as an iterator via `[Symbol.iterator]` /
  generator wrapping, OR
- Shares `INTERP_RE` across worker_threads (unlikely but
  possible)

would expose silent output corruption.

## Findings

PR #13 ce:review performance-oracle P3:

> "`generate-prompt.js:138` — INTERP_RE is module-scoped with the
> `g` flag. Global regexes carry per-regex lastIndex state. In
> current Node single-threaded sync code this is fine. If a
> future refactor introduces async/await between regex uses (or
> shares the regex across re-entrant calls via a generator),
> lastIndex would race and silently corrupt output."

## Proposed Solutions

### Option A — Add a defensive comment at the declaration

Insert at line 138:

```js
// INTERP_RE is module-scoped with /g. Safe today because every
// usage is via String.prototype.replace which resets lastIndex.
// If you ever switch to RegExp.prototype.exec or share this
// regex across async boundaries / generators / workers, switch
// to a per-call local regex literal or a fresh RegExp constructor
// in each function — module-scoped /g state is not re-entrant.
const INTERP_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
```

- **Pros:** Documents the constraint at the point of declaration.
  Future refactor reads the warning before introducing the
  hazard.
- **Cons:** Comment-only; relies on future maintainer to read.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Use a fresh local regex inside each function

Replace the module-scoped constant with per-call literals:

```js
function interpolate(body, context) {
  const re = /\{\{([A-Za-z0-9_]+)\}\}/g;
  return body.replace(re, (match, name) => { /* ... */ });
}

function renderTemplate(template, context, opts) {
  // ...
  const refRe = /\{\{([A-Za-z0-9_]+)\}\}/g;
  body.replace(refRe, (_m, name) => { /* ... */ });
  // ...
}
```

A fresh regex per call is immune to lastIndex sharing. JavaScript
engines compile literal regexes once per source location anyway,
so the perf delta is effectively zero.

- **Pros:** Eliminates the hazard structurally. No comment
  required.
- **Cons:** Two duplicate regex literals (one in each function).
  If the regex shape changes, two sites must be edited.
- **Effort:** Small.
- **Risk:** Low (the duplication can drift).

### Option C — Use `String.prototype.matchAll` style with a fresh regex

Same as Option B but explicit about creating a new regex per
match operation:

```js
function* iterInterpRefs(body) {
  const re = /\{\{([A-Za-z0-9_]+)\}\}/g;
  for (const m of body.matchAll(re)) yield m;
}
```

- **Pros:** Idiomatic ES2020 / ES2021. Explicit fresh regex.
- **Cons:** Requires refactoring `replace`-based call sites to
  the iterator pattern. More LOC.
- **Effort:** Medium.
- **Risk:** Low.

### Option D — Defer

Node sync code is safe today. No async refactor is on the V1
roadmap.

- **Pros:** Zero churn.
- **Cons:** Latent until someone introduces an async path.
- **Effort:** Zero.
- **Risk:** Low.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — defensive comment is the right
weight for a speculative hazard. Option B's duplication is mildly
worse than the comment-only approach for the same defensive
benefit. Option C is more invasive than the hazard warrants.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 138 (declaration), 191 (`interpolate` use site), 235
  (body-var-discovery use site).
- All current uses go through `String.prototype.replace`, which
  resets `lastIndex`. No behavior change required for Option A.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: comment at line 138 names the hazard explicitly and
  identifies which usage patterns trigger it
  (`exec`/iterator/async/worker).
- [ ] If B: each function uses a local regex literal; module-scoped
  `INTERP_RE` removed (or kept as a documented constant, e.g.
  `INTERP_RE_SOURCE = '\\{\\{([A-Za-z0-9_]+)\\}\\}'`, with
  callers building fresh regex from it).
- [ ] If B: tests still green; both interpolate and renderTemplate
  body-discovery behavior unchanged.
- [ ] If C: matchAll-based iterator pattern; tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (performance-oracle P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:138` —
  `INTERP_RE` declaration.
- `agent-orchestrator/scripts/generate-prompt.js:191` —
  `interpolate` use site.
- `agent-orchestrator/scripts/generate-prompt.js:235` —
  `renderTemplate` body-var discovery.
- MDN: `RegExp.lastIndex` semantics under `/g` flag.
