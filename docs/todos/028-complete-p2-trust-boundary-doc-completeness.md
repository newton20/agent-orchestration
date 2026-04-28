---
status: complete
priority: p2
issue_id: "028"
tags: [code-review, post-pr-9, ce-review, security, spawn-session, docs]
dependencies: []
---

# Trust-boundary doc in spawn-session.js header is incomplete

PR #9 added a trust-boundary paragraph at `spawn-session.js:42-45` naming
`binary`, `shell_args`, `auto_mode_flag`, `passthrough_flags` as trusted
verbatim pass-through. Two ce:review agents flagged that the doc is
incomplete in ways that could mislead future readers.

## Problem Statement

After reading the trust-boundary paragraph, a future security reviewer
or Unit 11 implementer would reasonably conclude: "These four launcher
fields are trusted; everything else is validated." That conclusion is
incorrect in two specific ways:

1. **`windowTarget`** (spawn-session.js parameter, default `'0'`) is
   passed verbatim to `wt -w <windowTarget>` at L399 and into the
   command-string render at L424. It is NOT a launcher field, but
   it's in the same trusted-pass-through bucket — and it has no
   format guard (F2 from todo 004 was deferred to Unit 11).
2. **Per-call args** (`name`, `model`, `pluginDir`, `title`, `workdir`)
   are quoted by `q()` / `qPath()` at L347-348 but the doc doesn't say
   so. A reader could conclude they're unprotected like the trusted
   four — they're actually defended at the *quoting* layer, not the
   validation layer.
3. **Manifest path passed to `--launcher`** is itself trusted: the
   operator picks the YAML path; spawn-session does no traversal
   validation. When Unit 11 ships and a higher-layer caller (web UI,
   API) might pass a launcher path from less-trusted input, the
   manifest-path-is-trusted invariant must be explicit.

The doc should not pretend `windowTarget` is validated when it's not, and
should not leave per-call-arg readers wondering whether `model` is
trusted. The current state is "almost honest"; minor tightening makes it
fully so.

## Findings

Convergent across two ce:review agents on PR #9:

- **Architecture-strategist (P2-3):** "The trust-boundary doc is silent
  on `windowTarget`. A reader of the header doc today would conclude:
  'These four fields are trusted; everything else is validated.' That's
  not quite right — `windowTarget` is in the same trusted-pass-through
  bucket as the four named fields, but slips through the doc."
- **Security-sentinel (P2 follow-up):** "Recommend a one-sentence
  addition in a follow-up: 'Per-call args (name, model, pluginDir,
  title, workdir, windowTarget) are quoted by quoter functions; the
  manifest path passed to `--launcher` is itself trusted (operator-
  controlled).'"

## Proposed Solutions

### Option A — One-paragraph addition naming the three gaps

Append to the trust-boundary paragraph at L42-45:

```
* Per-call args (name, model, pluginDir, title, workdir) are defended
* at the quoting layer (quoteCmd/quotePs and their always-variants),
* not at validation. windowTarget is trusted-pass-through (format
* guard deferred to Unit 11; F2 in docs/todos/004). The manifest path
* passed via --launcher is itself trusted — the operator selects it.
```

- **Pros:** Honest about the actual defense layers; closes the doc
  gap without ballooning the header.
- **Cons:** Doc grows by ~5 lines.
- **Effort:** Small (doc-only).
- **Risk:** None.

### Option B — Move the trust contract into a dedicated section in scripts/README.md

Pull the contract out of the spawn-session header and into a doc that
can grow without paying the source-file noise tax. Header keeps a
one-line pointer.

- **Pros:** Header stays terse; contract has room.
- **Cons:** Adds a doc surface that a future editor of the header may
  not check.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Defer to Unit 11

Leave the doc as-is until Unit 11 lands and the orchestrator-side
contract is fully understood. Re-do the trust-boundary doc as part of
the Unit 11 dispatch.

- **Pros:** Avoids churn now.
- **Cons:** The doc will mislead readers in the interim.
- **Effort:** Zero.
- **Risk:** Low (the gaps are doc-completeness, not exploitable).

## Recommended Action

**Option A — approved 2026-04-28 by coord.** Extend the existing
trust-boundary paragraph at `spawn-session.js:42-45` (or wherever the
current header doc lives) to name all three gaps:

1. **windowTarget** is trusted pass-through (no format guard in V1;
   F2 from todo 004 deferred to Unit 11).
2. **Per-call args** (`name`, `model`, `pluginDir`, `title`,
   `workdir`) are *quoted-not-validated* — defended at the quoting
   layer by `q()` / `qPath()`, NOT by upstream validation. Phase IDs
   used as session names are independently validated by
   `parse-manifest.js`'s `VALID_ID_RE`; other per-call args trust the
   caller to pass sane values.
3. **Manifest path passed via `--launcher`** is itself trusted: the
   operator picks the YAML path; spawn-session does no traversal
   validation. When higher-layer callers (web UI, API) pass launcher
   paths from less-trusted input, the higher layer must validate the
   path before calling spawn-session.

Option B (move to scripts/README.md dedicated section) splits doc
location for a 5-line addition; readers who already trust the inline
header would still see only the original paragraph. Option C (defer
to Unit 11) leaves the foot-gun in place; the gaps surface during
security review, not Unit 11 design.

Dispatch as part of the pre-Unit-7 round 3 PR bundle along with
todos 027, 029, 030, 031. Pure documentation (~5-8 LOC).

## Technical Details

- Affected file: `agent-orchestrator/scripts/spawn-session.js` (lines 42-45)
- Optional: `agent-orchestrator/scripts/README.md` (Option B)
- No test changes.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] Reading the header alone, a reviewer can identify which fields
  are trusted-verbatim vs quoted vs validated.
- [ ] `windowTarget` and the manifest-path-is-trusted invariant are
  explicitly documented somewhere reachable from the header.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #9 ce:review
  (architecture + security agents converged).
- **2026-04-28 — merged via PR #11** (`feat(templates): pre-Unit-7
  fixes round 3`). Option A implemented: extended the trust-boundary
  paragraph at `spawn-session.js:42-65` to name all three gaps —
  `windowTarget` (trusted pass-through, F2 deferred to Unit 11),
  per-call args (`name`, `model`, `pluginDir`, `title`, `workdir`)
  defended at quoting layer not validation, manifest path passed via
  `--launcher` operator-trusted. PR #11 ce:review's agent-native
  reviewer confirmed the expansion gives Unit 11 reviewers the trust
  contract they need; no follow-up.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 004 (closed): `docs/todos/004-complete-p3-security-hardening-launcher-and-yaml-load.md`
- F1/F2 from todo 004 are still deferred to Unit 11; this todo only
  documents the deferred state, doesn't ship the guards.
