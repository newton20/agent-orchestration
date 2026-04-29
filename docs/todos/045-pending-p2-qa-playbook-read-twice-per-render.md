---
status: pending
priority: p2
issue_id: "045"
tags: [code-review, post-pr-13, ce-review, scripts, performance, hot-path]
dependencies: []
---

# `qa-playbook-prompt.md` is read twice per QA render

PR #13 ce:review's performance-oracle traced the read paths in
`generatePrompt` and found that QA dispatches (and recovery+qa)
load `qa-playbook-prompt.md` from disk **twice per render**: once
via `readTemplate` for the two-pass render (line 750), and once
inside `checkTransitiveDrift` (line 307/318) which loads the
playbook to validate the role template's frontmatter against it.
At ~394µs per read on Windows, this adds ~400µs to every QA
render.

The full read scope (codex round 3 caught the original triage
understating it):
- **`role: 'qa'`** — both reads fire (full ~790µs redundancy).
- **`role: 'recovery'` with `recoveryRole: 'qa'`** — same: both
  reads fire.
- **`role: 'recovery'` with `recoveryRole: 'impl'` or `'coord'`**
  — `recovery-prompt.md` itself contains `{{qa_playbook_block}}`
  (declared optional in its frontmatter so empty values render as
  the empty string). `checkTransitiveDrift(roleSrc=recovery-prompt.md, ...)`
  therefore does NOT short-circuit and still reads the playbook
  once (~394µs). The two-pass render is skipped (no need to
  inline a playbook the recovery prose handles as empty), so this
  path is single-read, not double-read.
- **Pure `role: 'impl'` / `role: 'coord'`** — neither
  template body contains `{{qa_playbook_block}}`, so
  `checkTransitiveDrift` short-circuits via
  `body.includes('{{qa_playbook_block}}')` and zero playbook
  reads happen.

So the affected paths are: QA + qa-recovery (double-read) AND
impl-recovery + coord-recovery (single-read). Non-recovery non-QA
dispatches are unaffected. The optimization in Option A should
account for all three QA-touching paths, not "QA only."

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js`:

- Line 307/318: `checkTransitiveDrift(roleSrc, ...)` — when the
  role template body includes `{{qa_playbook_block}}`, the helper
  loads `qa-playbook-prompt.md` to validate frontmatter lockstep.
- Line 750: inside the `needsPlaybook` branch in `generatePrompt`,
  `const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE)`
  loads the same file again for the two-pass render.

For QA dispatches (and recovery dispatches with `recoveryRole=qa`),
both paths fire: ~394µs × 2 ≈ ~790µs of redundant disk reads per
render. Multiplied by a typical run with 25 QA dispatches, ~10ms
of overhead — small in absolute terms but a clear pattern of
"reading the same file twice in the same call stack."

## Findings

PR #13 ce:review performance-oracle P2:

> "`generate-prompt.js:307,318,750` — for QA dispatches (or
> recovery+qa), `qa-playbook-prompt.md` is read from disk twice
> per render: once via `readTemplate` for the two-pass render,
> and once inside `checkTransitiveDrift(roleSrc, ...)` (which
> loads the playbook to check the role template's frontmatter
> against it). At ~394µs per read on Windows, this adds ~400µs
> per QA render. For non-QA renders, `checkTransitiveDrift`
> short-circuits via `body.includes('{{qa_playbook_block}}')`
> so only QA renders are affected. Cheapest fix: hoist
> `playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE)`
> to a single call when `needsPlaybook` is true, and pass it
> into `checkTransitiveDrift` via opts so the helper can skip
> its own read when bytes are provided."

## Proposed Solutions

### Option A — Hoist read; pass bytes to `checkTransitiveDrift`

Restructure `generatePrompt` to read `qa-playbook-prompt.md` once
near the top (when QA is involved). Pass the resulting string into
both `checkTransitiveDrift` (via a new `playbookSrc` opt that
lets it skip its own read when provided) and the two-pass render
block.

- **Pros:** Saves ~400µs per QA render (~10ms over a 25-dispatch
  run). Single source of truth for "this dispatch's playbook
  bytes." Localized refactor — no module-scoped state. Sets up
  Option A of todo 042 cleanly (the bytes are already in scope
  for the drift assertion against a caller-supplied block).
- **Cons:** ~10 LOC of plumbing. `checkTransitiveDrift`'s
  signature grows by one optional opt. Need to verify the read
  happens before `checkTransitiveDrift` is called.
- **Effort:** Small.
- **Risk:** Low — purely an optimization with no behavior
  change; covered by existing tests.

### Option B — Module-scoped template cache

Add a `Map<absolutePath, string>` keyed by full template path,
populated on first read. Templates don't change during a process
lifetime (CLI invocations are one-shot; long-lived JS API callers
in tests use fresh `templatesDir` per fixture). Covers all
template reads, not just the playbook.

- **Pros:** Generalizes — any future "read same template twice"
  pattern is covered for free. Simpler call sites (no plumbing
  through opts).
- **Cons:** Module-scoped mutable state. Test isolation needs
  thinking-through (need a `clearTemplateCache()` for the test
  setup or per-test `templatesDir` paths). More invasive than
  Option A. Overkill if the playbook double-read is the only
  hot site.
- **Effort:** Medium.
- **Risk:** Medium — module-scoped state is a category of bug
  source the codebase has avoided so far.

### Option C — Defer

~10ms over a 25-QA-render run is negligible. Revisit if
profiling shows playbook reads in a hot loop (e.g. a test that
renders 1000+ QA prompts).

- **Pros:** Zero churn.
- **Cons:** The double-read is a clear pattern smell. A future
  reader sees two reads of the same file and assumes one is
  out of date or has a reason — wasted cognitive load.
- **Effort:** Zero.
- **Risk:** Low for V1.

## Recommended Action

Pending coord triage. Option A is the cheapest fix and aligns
naturally with todo 042's Option A (which also wants the
playbook bytes available outside the `needsPlaybook` branch).
Option B is a more general cache but introduces module-scoped
state. Option C defers. Triage should consider whether to bundle
this with todo 042 (both center on playbook-load plumbing).

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`.
  - `checkTransitiveDrift` signature gains an optional
    `{ playbookSrc }` opt (Option A).
  - `generatePrompt` reads the playbook once, passes bytes
    into both call sites.
- `readTemplate` per-call cost on Windows: ~394µs measured.
- Non-QA renders unchanged (the existing
  `body.includes('{{qa_playbook_block}}')` short-circuit
  preserves zero-cost for non-QA paths).

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: QA renders read `qa-playbook-prompt.md` exactly
  once (verified via a test that wraps `fs.readFileSync` and
  counts calls, or via a debug counter).
- [ ] If A: `checkTransitiveDrift` accepts pre-loaded bytes
  via opts; existing tests still pass without modification
  (the new opt is optional with the original load as fallback).
- [ ] If B: cache populated on first read; `clearTemplateCache()`
  exposed for test reset; all 158+ tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (performance-oracle P2). Coord triage pending.
- **2026-04-29 — corrected via codex round 3 on triage PR** —
  original Problem Statement claimed non-QA renders were
  unaffected by the redundant playbook read. Codex correctly
  noted that `recovery-prompt.md` contains `{{qa_playbook_block}}`
  for ALL recoveryRoles (declared optional so empty renders as
  empty), so impl-recovery and coord-recovery still trigger one
  playbook read in `checkTransitiveDrift`. Rewrote the affected
  paragraph to enumerate all four dispatch combinations (QA
  double-read; qa-recovery double-read; impl/coord-recovery
  single-read; pure impl/coord zero-read) so Option A's
  optimization scope captures the full surface.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:307,318,750` —
  the three read sites.
- Todo 042 (pre-rendered qaPlaybookBlock skips drift check):
  overlapping concern — both center on playbook-load plumbing.
