---
status: pending
priority: p2
issue_id: "046"
tags: [code-review, post-pr-13, ce-review, scripts, pattern, test-style]
dependencies: []
---

# `generate-prompt.test.js` uses double-rule banners — sibling tests use single-rule

PR #13 ce:review's pattern-recognition-specialist flagged a
test-file-only style drift: the new `generate-prompt.test.js`
introduces full-width double-rule banners for section headers,
while every sibling test file in the project uses single-line
banners. The source file `generate-prompt.js` itself uses the
canonical short-banner shape — so the drift is contained to the
test file. Future test-file authors will face a 50/50 choice
between styles.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.test.js` lines 88, 90,
118, 120, 162, 164, etc. (24 banner pairs) use:

```js
// =========================================================================
// A — parseFrontmatter
// =========================================================================
```

Sibling test files (`parse-manifest.test.js`,
`spawn-session.test.js`, `scaffold-protocol.test.js`) all use:

```js
// -------------------- Title --------------------
```

The production source `generate-prompt.js` itself uses the
short-banner shape — confirming the canonical style. The drift is
test-file-only. The new file does add a useful element: the
section-letter prefix (`A — parseFrontmatter`, `B — ...`) which
gives reviewers a stable handle into the file. Worth preserving.

## Findings

PR #13 ce:review pattern-recognition-specialist P2:

> "`generate-prompt.test.js` lines 88/90/118/120/162/164 etc.
> (24 banner pairs) use full-width `==========` double-rule
> banners. Every sibling test file (`parse-manifest.test.js`,
> `spawn-session.test.js`, `scaffold-protocol.test.js`) uses
> single-line `// -------------------- Title --------------------`
> banners. The production `generate-prompt.js` itself uses the
> short-banner shape, so the drift is test-file-only. The
> section-letter prefix the new file adds (`A — parseFrontmatter`)
> is useful and worth preserving. Recommend converting to
> `// -------------------- A — parseFrontmatter --------------------`
> to match siblings while keeping the section letters."

## Proposed Solutions

### Option A — Convert to short-banner shape; keep section letters

Edit all 24 banner pairs in `generate-prompt.test.js` to the
sibling style:

```js
// -------------------- A — parseFrontmatter --------------------
```

Keeps the (useful) section-letter prefix that the new file
introduces. Aligns with all three sibling test files.

- **Pros:** Single canonical style across all test files.
  Future test-file authors copy one shape. Section-letter
  innovation preserved (and likely propagates back to siblings
  organically).
- **Cons:** 24 mechanical edits — purely cosmetic. Adds churn
  to the file's git blame.
- **Effort:** Trivial — find/replace.
- **Risk:** None — comments only.

### Option B — Update sibling test files to the new `===` shape

Convert `parse-manifest.test.js`, `spawn-session.test.js`,
`scaffold-protocol.test.js` to use the double-rule banners.
Reverses the style decision implicit in PR #7's V1-freeze.

- **Pros:** The new style is arguably more visually distinct
  in long files.
- **Cons:** Reverses the V1-freeze posture explicitly set by
  PR #7. More churn (3 files instead of 1). Doesn't match the
  production source's short-banner shape — which is the
  author-of-record canonical style.
- **Effort:** Small (3 files × ~10-20 banners each).
- **Risk:** Low mechanically; medium politically (re-litigates
  a closed style decision).

### Option C — Defer

Both styles are valid. Future readers will copy one or the
other; the drift will resolve over time naturally.

- **Pros:** Zero churn.
- **Cons:** Future test files have a 50/50 toss-up. Pattern
  reviewer will flag it again.
- **Effort:** Zero.
- **Risk:** Low for V1.

## Recommended Action

Pending coord triage. Option A is the trivial conversion that
aligns with the canonical style (matches the production source
and all three sibling test files). Option B reverses the
V1-freeze. Option C defers. Triage should weigh whether
test-file style drift counts as in-scope for the V1-freeze
posture or as cosmetic-only.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.test.js`.
  - 24 banner pairs (counted by pattern-recognition-specialist).
  - Lines 88, 90, 118, 120, 162, 164, etc. (full list in the
    review notes).
- Sibling reference files (canonical short-banner style):
  - `agent-orchestrator/scripts/parse-manifest.test.js`
  - `agent-orchestrator/scripts/spawn-session.test.js`
  - `agent-orchestrator/scripts/scaffold-protocol.test.js`
- Production source (canonical short-banner style):
  `agent-orchestrator/scripts/generate-prompt.js`.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: all 24 banner pairs in
  `generate-prompt.test.js` converted to
  `// -------------------- A — Title --------------------`
  shape; section-letter prefix preserved.
- [ ] If A: a quick grep confirms no `// =====` banners remain
  in the test file.
- [ ] If A: tests still 158+ green (purely cosmetic change).
- [ ] If B: all sibling test files converted to the new shape;
  V1-freeze decision documented as overridden in the PR.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (pattern-recognition-specialist P2). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- Sibling reference files for the canonical short-banner shape:
  `agent-orchestrator/scripts/parse-manifest.test.js`,
  `spawn-session.test.js`, `scaffold-protocol.test.js`.
- Production source canonical style:
  `agent-orchestrator/scripts/generate-prompt.js`.
