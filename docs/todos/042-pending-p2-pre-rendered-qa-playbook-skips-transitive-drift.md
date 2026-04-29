---
status: pending
priority: p2
issue_id: "042"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, transitive-drift]
dependencies: []
---

# Pre-rendered `qaPlaybookBlock` skips transitive-drift check on `qa-playbook-prompt.md`

PR #13 ce:review's architecture-strategist flagged an asymmetry in
`generatePrompt`: when a caller pre-renders the QA playbook and
passes it via `opts.qaPlaybookBlock`, the in-generator render path
short-circuits — and the on-disk `qa-playbook-prompt.md` is never
loaded for that dispatch. That means `checkTransitiveDrift` cannot
inspect the playbook's frontmatter for that path. Codex round 6
already fixed the parallel `previousPhaseBriefing` case (signals
parsed for warnings even when the caller pre-renders the briefing
text); the symmetrical `qaPlaybookBlock` path has no such guard.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:743-752`:

```js
const needsPlaybook =
  !context.qa_playbook_block &&
  (o.role === 'qa' || (recovery && o.recoveryRole === 'qa'));
if (needsPlaybook) {
  const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE);
  const playbookOnce = renderTemplate(parseFrontmatter(playbookSrc).body, context);
  context.qa_playbook_block = renderTemplate(playbookOnce, context);
}
```

When a caller (Unit 11 has been discussed as a possible site for
playbook caching/pre-rendering) supplies `opts.qaPlaybookBlock` as a
non-empty string, `needsPlaybook` is `false` and the on-disk file is
not read. `checkTransitiveDrift(roleSrc, ...)` runs earlier in the
flow and does its own load of `qa-playbook-prompt.md`, but only to
validate the role template's frontmatter against the playbook —
it does not validate the caller-supplied bytes.

Today no caller pre-renders, so the gap is theoretical. But once
caching is added, the inlined playbook can drift from the on-disk
template without any drift-check firing.

## Findings

PR #13 ce:review architecture-strategist P2:

> "`generate-prompt.js:743-752` — when `opts.qaPlaybookBlock` is
> supplied, the in-generator render is skipped, and so is the
> on-disk read of `qa-playbook-prompt.md` for that dispatch. The
> codex round-6 fix made the briefing path resilient (parses
> signals even when the briefing is pre-rendered). The
> `qaPlaybookBlock` path is the symmetrical case and has no
> equivalent guard. If Unit 11 ever caches the playbook block,
> drift between cached bytes and on-disk template can land
> silently."

## Proposed Solutions

### Option A — Always load on-disk playbook for drift check

Move the `readTemplate(...)` call out of the `needsPlaybook` branch
and run it unconditionally for QA dispatches. Use the caller's text
for context substitution; use the on-disk frontmatter for the
lockstep/drift assertions.

- **Pros:** Closes the asymmetry. Mirrors the round-6 briefing
  fix. Drift detection works in cached and uncached paths
  identically.
- **Cons:** ~5 LOC of extra logic. Pays a ~400µs disk read on
  every QA dispatch even when the caller has already cached the
  playbook (defeating the cache's intent partially). See todo 045
  for an orthogonal hot-path fix that subsumes this cost.
- **Effort:** Small.
- **Risk:** Low — additive guard, no contract change.

### Option B — Document `qaPlaybookBlock` as JS-API debug-only

Treat `opts.qaPlaybookBlock` as not-supported-for-Unit-11 use.
The CLI's `--context` allowlist already excludes it (good). Add a
JSDoc annotation marking it as test/debug-only and not part of
the production rendering contract. Future caching work explicitly
goes through the in-generator path.

- **Pros:** No code change. Encodes the design intent.
- **Cons:** Closes off a future optimization avenue (Unit 11
  playbook cache) by doctrine. If Unit 11 design later requires
  caching, this todo reopens.
- **Effort:** Trivial (a JSDoc paragraph + a contract note).
- **Risk:** Low — documents existing behavior.

### Option C — Defer

No caller pre-renders today. Revisit when Unit 11 lands, at which
point the design constraint becomes concrete.

- **Pros:** Zero churn.
- **Cons:** Future Unit 11 author may not see the symmetry with
  the briefing fix and may add caching without the guard.
- **Effort:** Zero.
- **Risk:** Low for V1; the gap activates only with caller-side
  caching.

## Recommended Action

Pending coord triage. The asymmetry is real but the gap is
theoretical until Unit 11 introduces a caching caller. Triage
should weigh closing the symmetry now (Option A, ~5 LOC) against
deferring with a JSDoc note (Option B) or fully (Option C).

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js:743-752`.
- Symmetric reference: round-6 codex fix to the
  `previousPhaseBriefing` path (parses signals from on-disk
  `previous-phase-prompt.md` even when caller pre-renders the
  text).
- `checkTransitiveDrift` already loads
  `qa-playbook-prompt.md` for its own purposes; an Option A fix
  could plumb the bytes through to avoid double-read (overlap
  with todo 045).

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: caller-supplied `qaPlaybookBlock` no longer skips the
  on-disk read; new test asserts drift fires when a stale block
  is supplied alongside an updated on-disk playbook.
- [ ] If A: bytes from the on-disk read are reused (or shared
  with todo 045's hoist) so QA renders pay at most one playbook
  read.
- [ ] If B: JSDoc on the `qaPlaybookBlock` opt marks it
  test/debug-only and the contract note in
  `scripts/generate-prompt.js` (or `docs/`) reflects that.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P2). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- Round-6 codex fix on `previousPhaseBriefing`: the symmetrical
  pre-rendered-text guard this todo would mirror.
- Todo 045 (hot-path playbook double-read): orthogonal but
  overlaps if Option A is chosen.
