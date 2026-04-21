---
status: pending
priority: p3
issue_id: "002"
tags: [code-review, unit-4, spawn-session, simplification, cleanup]
dependencies: []
---

# Simplify spawn-session.js: drop accreted complexity from 13 codex rounds

After 13 rounds of codex review PR #3 landed with a robust but
slightly over-engineered `spawn-session.js`. The simplicity
reviewer identified ~80 lines (~15%) of reducible complexity —
largely YAGNI branches, parallel representations, and stale
codex-round comments that are archaeology rather than documentation.

## Problem Statement

Each codex round added a justified fix, but the accumulated shape
is denser than the core logic needs. Future readers (Unit 11
implementer, anyone debugging a launcher issue) will spend time on
branches that no real config exercises.

## Findings (from simplicity reviewer)

1. **`quoteBinary` `.exe ` subcommand split (L134–173).** The
   "case 5" branch handles `C:\Program Files\X\x.exe subcommand`
   — a shape with zero evidence of real use. `AGENCY_LAUNCHER`
   ships as `"agency claude"` (PATH-resolved, no path separator),
   and nothing in the plan documents the `.exe subcommand` shape.
   Drop ~14 lines; if a user ever needs it they can quote it
   themselves in the manifest.

2. **`quoteCmd` vs `quoteCmdAlways` (and PS equivalents).** The
   "Always" variants are the only callers on actual spawn paths
   (title/workdir/pluginDir). The conditional `quoteCmd` is
   called twice for simple tokens (name, model) where
   conditional-vs-always quoting produces identical output. Net
   value of keeping four quoter functions: ~2 bytes per command
   line in the rare "log readability" case. Collapse to one
   always-quote function per shell. Drops ~16 lines.

3. **Parallel `argv` + shell-string `command` rendering (L370–429).**
   Two full representations of the same command. `command` is
   documented as "never executed, only for logging/dry-run." For
   logging, a single `shellJoin(argv)` helper would produce
   equivalent output from the argv source of truth. ~20 lines of
   duplicated construction collapse to one helper.

4. **`loadLauncherFromManifest` null-vs-absent special case
   (L279–285).** The explicit throw on `launcher: null` duplicates
   what `validateLauncher`'s object-type check already rejects
   downstream. Codex round 8 added it for a pedantic "don't
   silently fall back" case, but the silent fallback the codex
   worried about was a bug in `resolveLauncher(null)` — which has
   since been fixed by the baseline-per-shell merge. The explicit
   throw is now redundant.

5. **Stale codex-round comment references.** 14 occurrences of
   `codex P1/P2 round-N` annotations throughout the file. Useful
   at review time; noise for future readers who don't care which
   round surfaced the fix, only whether the check is load-bearing.
   Replace with reason-only comments (the "why," not the "when").
   Specific lines in the simplicity review.

6. **Wide public export surface (14 symbols).** The internal
   helpers `quoteCmd`, `quoteCmdAlways`, `quotePs`, `quotePsAlways`,
   `quoteBinary`, `tokenizeShellArgs`, `buildPidLookupArgs`,
   `parsePidLookupOutput` are exported solely for unit tests.
   Move them under `module.exports.__test = {...}` or drop them
   — tests can exercise quoting through `buildSpawnCommand` inputs
   instead.

## Proposed Solutions

### Option A — Do all 6 cleanups as one simplification PR

Land after Unit 11 is underway (so we know which exports are
actually consumed). One commit per numbered cleanup; pre/post test
count should match (127 → 127, same green).

- **Pros:** Net lower maintenance burden for Unit 11 implementer.
- **Cons:** A full simplification pass this soon risks undoing a
  fix that's load-bearing in a way the simplicity review missed.
  Three codex rounds revealed subtle edge cases the original
  design missed — some of the accreted complexity is genuinely
  earning its keep.
- **Effort:** Medium. Each cleanup is small; verification is "all
  127 tests still green."
- **Risk:** Medium. We've invested heavily in the test suite; it
  should catch regressions, but "small" simplifications can
  introduce subtle bugs.

### Option B — Cherry-pick only the obvious wins (#1 + #5)

Drop the `.exe ` heuristic (clear YAGNI, no real trigger) and
clean up the stale codex comments (pure documentation, zero risk
to behavior). Leave #2, #3, #4, #6 for Unit 11.

- **Pros:** Low-risk, immediate readability win.
- **Cons:** Leaves the bigger structural simplifications on the
  table.
- **Effort:** Small.
- **Risk:** Very low.

### Option C — Do nothing; let the code stabilize

The code works. 127 tests green. Codex + QA approved. Some of the
apparent complexity may turn out to be needed once Unit 11 hits
real launchers. Revisit after Unit 11 if anything still looks
gratuitous.

- **Pros:** No churn, no risk.
- **Cons:** Future readers pay the complexity cost forever.
- **Effort:** Zero.
- **Risk:** Zero now; deferred.

## Recommended Action

_(to be filled during triage)_

Preference: **Option B** — land the two lowest-risk wins, defer
the rest until Unit 11 exercises the real launcher surface.

## Technical Details

- Affected file: `agent-orchestrator/scripts/spawn-session.js`
- Specific line ranges per finding in the simplicity review
  output (see Resources).
- Tests: `agent-orchestrator/scripts/spawn-session.test.js` — 127
  tests must remain green. If dropping exports (finding #6), tests
  need migration to use the `__test` namespace or to exercise via
  the public API.

## Acceptance Criteria

**If taking Option B:**
- [ ] `quoteBinary` collapses to the single path-sep + whitespace
  rule; `.exe ` matching and subcommand split removed.
- [ ] All `codex P1/P2 round-N` annotations replaced with
  reason-only comments OR removed where the comment was only
  scaffolding.
- [ ] 127 tests still green.
- [ ] No changes to public export surface or `buildSpawnCommand`
  return shape.

**If taking Option A:** above, plus:
- [ ] `quoteCmd`/`quotePs` conditional variants removed; single
  always-quote function per shell.
- [ ] `command` shell-string is derived from `argv` via a
  `shellJoin` helper; no duplicated construction.
- [ ] `loadLauncherFromManifest` returns `parsed.launcher` (or
  undefined) without the null special case; `validateLauncher`
  handles errors.
- [ ] Public exports trimmed to `spawnSession`, `getSessionPid`,
  `buildSpawnCommand`, `resolveLauncher`,
  `loadLauncherFromManifest`, `DEFAULT_LAUNCHER`,
  `AGENCY_LAUNCHER`. Test-only helpers under `__test`.
- [ ] Test file migrated; 127 tests green.

## Work Log

_(empty)_

## Resources

- Triggering PR: https://github.com/newton20/agent-orchestration/pull/3
- Simplicity review output: captured in `/ce:review` session
  output, 2026-04-20.
- Related compound doc:
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
