---
status: pending
priority: p3
issue_id: "056"
tags: [code-review, post-pr-13, ce-review, scripts, performance, caller-discipline, unit-11-prep]
dependencies: []
---

# Pre-render `planUnits` once per phase (caller-discipline note for Unit 11)

PR #13 ce:review's performance-oracle flagged that `extractPlanUnit`
reads the full plan file (~150KB in the current repo) on every
call. The extracted unit text is identical for impl/qa/coord
within one phase; if Unit 11 hands each role-render a `planPath`
instead of pre-rendered `planUnits`, the same plan file is
re-read and re-extracted three times per phase.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:356-390`:

```js
function extractPlanUnit(planPath, unitMarker) {
  if (typeof unitMarker !== 'string' || unitMarker.length === 0) {
    throw new Error('extractPlanUnit: unitMarker must be a non-empty string');
  }
  const text = fs.readFileSync(planPath, 'utf8');
  const escaped = escapeRegExp(unitMarker);
  const headingRe = new RegExp(
    `^- \\[[ x]\\] \\*\\*Unit ${escaped}:`,
    'm',
  );
  // ...regex match + slice
  return text.slice(startIdx, endIdx).trimEnd();
}
```

Every call:
1. `fs.readFileSync` of the entire plan file (~150KB at present).
2. RegExp build + match.
3. Sibling-heading match + slice.

For a single phase, the caller dispatches three role renders
(impl, qa, coord). If Unit 11 calls `generatePrompt` with the
same `planPath` and `planUnitMarker` three times in a row, the
plan file is read three times, the same regex runs three times,
the same slice happens three times. The output of all three calls
is byte-identical.

For an orchestration of ~15 phases × 3 roles = 45 renders, that's
45 plan reads where 15 would suffice. Total wasted ~30 disk
reads + regex passes per orchestration. At ~150KB and ~2ms each,
that's roughly 60ms of avoidable I/O per full orchestration —
small in absolute terms but a clean caller-discipline win for
Unit 11.

The `planUnits` value, once extracted, is just a string. It's
already substitutable as a content-block: a Unit 11 caller can
extract once and pass `planUnits` directly via opts, bypassing
`extractPlanUnit` entirely.

## Findings

PR #13 ce:review performance-oracle P3:

> "`generate-prompt.js:356-390` — extractPlanUnit reads the full
> plan file (~150KB) on every call. For 50 renders in an
> orchestration this is up to ~100ms total. The planUnits value
> is identical for impl/qa/coord within one phase; if Unit 11
> hands each role-render a planPath rather than a pre-rendered
> planUnits, it re-extracts 3x per phase."

## Proposed Solutions

### Option A — Document caller discipline in templates/README.md

Add a subsection to `agent-orchestrator/templates/README.md` (e.g.
"Caller discipline" or "Performance notes for Unit 11"):

> **Pre-render `planUnits` once per phase.** `extractPlanUnit`
> reads the plan file on every invocation. The extracted unit
> text is identical across the impl/qa/coord renders for a
> single phase. Unit 11 should call `extractPlanUnit(planPath,
> unitMarker)` once per phase and pass the result as
> `planUnits` to all three role dispatches via the
> `generatePrompt` opts. This avoids 2× redundant disk reads
> per phase (~150KB each).

No Unit 7 code change. Unit 11 implementer follows the
discipline.

- **Pros:** Zero code change. Documents the discipline at the
  point Unit 11 implementers will look. Unit 7 stays simple.
- **Cons:** Discipline-by-documentation; Unit 11 implementer
  could ignore the note and pay the overhead.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Add an LRU cache inside `extractPlanUnit`

Cache by `(planPath, unitMarker)` keys with a small LRU
(e.g. 8 entries):

```js
const _planUnitCache = new Map();
function extractPlanUnit(planPath, unitMarker) {
  const key = planPath + '\0' + unitMarker;
  if (_planUnitCache.has(key)) {
    const v = _planUnitCache.get(key);
    _planUnitCache.delete(key);
    _planUnitCache.set(key, v); // refresh recency
    return v;
  }
  // ... existing logic
  _planUnitCache.set(key, result);
  while (_planUnitCache.size > 8) _planUnitCache.delete(_planUnitCache.keys().next().value);
  return result;
}
```

- **Pros:** Caller doesn't need to know about it. Works for any
  call pattern.
- **Cons:** Adds module-scoped mutable state. Stale-cache risk if
  the plan file is hot-edited between renders (rare but
  possible in dev). Cache eviction is an implementation choice
  callers may need to know about.
- **Effort:** Small.
- **Risk:** Low to medium. The stale-cache risk is non-trivial
  in dev workflows where a developer hand-edits the plan file
  mid-orchestration.

### Option C — Defer

Render-loop performance is not a V1 concern. Unit 11 may pre-render
naturally as part of its phase-orchestration loop without explicit
guidance.

- **Pros:** Zero churn.
- **Cons:** Unit 11 implementer pays the I/O without realizing
  it's avoidable.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — caller-discipline note in
templates/README.md is the right level. Option B's stale-cache
risk in dev workflows isn't worth the small wins.

## Technical Details

- Affected file (Option A): `agent-orchestrator/templates/README.md`.
- Affected file (Option B): `agent-orchestrator/scripts/generate-prompt.js`
  lines 356-390.
- No production behavior change for Option A; new code path for
  Option B.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `templates/README.md` documents the pre-render
  discipline + the I/O reasoning + the recommended Unit 11
  invocation pattern.
- [ ] If B: `extractPlanUnit` caches by `(planPath, unitMarker)`;
  test that two calls with identical args do exactly one
  `readFileSync`.
- [ ] If B: cache eviction is bounded.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (performance-oracle P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:356-390` —
  `extractPlanUnit`.
- Companion todo 057 — same caller-discipline pattern for
  `buildPreviousPhaseBriefing`.
