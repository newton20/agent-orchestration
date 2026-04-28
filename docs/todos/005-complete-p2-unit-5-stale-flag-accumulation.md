---
status: complete
priority: p2
issue_id: "005"
tags: [code-review, unit-5, unit-11, hooks, performance, cleanup]
dependencies: []
---

# Unit 5 hook leaks stale `.pending-*` flags; each adds a `statSync` to every SessionStart

The ce-review performance-oracle agent flagged that TTL-expired
`.pending-*` files are filtered out of the candidate list but never
unlinked. Over time — especially in the presence of any orchestrator
(Unit 11) crash between flag-write and Claude-spawn — stale flags
accumulate in `docs/orchestration/` and silently grow the per-hook
`statSync` count on every SessionStart.

## Problem Statement

The hook's fast path is already tight: `readdirSync` + regex filter +
`isFile()` avoids `statSync` for non-`.pending-*` entries. But for
*matching* entries, the hook must `statSync` to read `mtimeMs` and
apply the 60 s TTL filter (`session-start.js:64-67`). Stale files are
then skipped via `continue` — they are preserved on disk (intentionally,
per the spec: "stale files preserved for debug").

The forever-cost is additive: every stale flag = one extra `statSync`
on every subsequent session start, forever, until someone manually
`rm`s them.

Worst case: 1000 stale flags after a year of occasional orchestrator
crashes → 1000 `statSync` calls on every session start. Still sub-
100ms on a warm local FS, but pure waste on the critical path.

## Findings

1. **Where the leak happens.** `session-start.js:65-66`:

   ```js
   if (now - st.mtimeMs > FLAG_TTL_MS) continue;  // stale — preserve on disk
   ```

   The `continue` drops the candidate without cleanup.

2. **Why the current design preserves them.** The stale-preservation
   invariant is load-bearing for two reasons:
   - **Debug.** A stale `.pending-*` file is evidence that an
     orchestrator spawn failed; keeping it lets the user inspect the
     prompt content post-hoc.
   - **Clock-skew tolerance.** The 60 s TTL is generous. A flag
     that's barely-stale when hook A runs might be "fresh again" (by
     wall-clock) when hook B runs a few ms later under clock skew.
     Preservation keeps the protocol idempotent.

3. **Why cleanup is still the right answer.** Neither debug nor
   clock-skew justifies unbounded accumulation. A flag older than
   several minutes is not coming back, and "keep the 10 most recent
   stale flags" is enough for debug. The proper fix is a secondary
   TTL — unlink flags older than, say, 10 minutes (or `10 *
   FLAG_TTL_MS`).

## Proposed Solutions

### Option A — Aggressive unlink on TTL

In the filter loop, when a flag is stale, `tryUnlink` it best-effort
(ignore ENOENT from races). Simple, O(N) cleanup amortized across hook
runs.

- **Pros:** One-line change. Bounds steady-state stat count to fresh
  flags only.
- **Cons:** Violates the "preserve for debug" invariant. A user who
  wants to see why spawn-X failed has a ~60 s window before their
  evidence is gone.
- **Effort:** Small. 2 LOC + 1 regression test.
- **Risk:** Low for the hook; medium for debuggability.

### Option B — Two-tier TTL: soft (skip) + hard (unlink)

Keep the 60 s TTL for injection eligibility; add a hard TTL (e.g. 10
minutes) after which the flag is unlinked. Files between 60 s and 10
min stay on disk for debug; files older than 10 min are GC'd.

- **Pros:** Preserves debug invariant for the important recent-past
  window. Bounds steady-state stat count to "flags created in the
  last 10 minutes."
- **Cons:** Adds a second constant. One more branch in the filter
  loop.
- **Effort:** Small. ~8 LOC + 1 regression test. Most of the
  cost is deciding the hard-TTL value — 10 min is a guess.
- **Risk:** Low.

### Option C — Move cleanup to Unit 11 (the writer)

Unit 11 knows when it's about to spawn a batch. Before writing any
new `.pending-*`, it can sweep the dir for stale flags (older than
hard-TTL) and unlink them. Unit 5 stays strictly read-only.

- **Pros:** Keeps Unit 5 minimal. Unit 11's batch-spawn window is
  the natural place for housekeeping.
- **Cons:** Unit 11 doesn't exist yet; this becomes an invariant
  future-Unit-11 must honor. If someone writes a manual flag file
  without going through Unit 11, no sweep ever happens.
- **Effort:** Small, but lands in Unit 11 not Unit 5. No hook
  change.
- **Risk:** Medium — the invariant is easy to forget.

## Recommended Action

**Option B — approved 2026-04-22 by coord.** Add a hard TTL (export
`STALE_HARD_TTL_MS = 10 * FLAG_TTL_MS` → 600_000ms / 10min). In the
filter loop, when a flag is stale:
- Age < hard-TTL → preserve on disk (current behavior — debug window).
- Age ≥ hard-TTL → `tryUnlink` best-effort (ignore ENOENT).

Preserves the debug invariant for the practically-useful recent
window (10 minutes is plenty to inspect a failed spawn), bounds
steady-state `statSync` count to flags created in the last 10
minutes, and keeps the change fully inside `session-start.js` with
no cross-module invariant for Unit 11 to remember.

Option C (Unit 11 pre-spawn sweep) was rejected because the invariant
is easy to forget AND any manual flag writer (debugging, testing)
would bypass the sweep entirely. Option A rejected because the
60-second debug window is too short to be useful.

Dispatch as part of the post-Unit-6 cleanup PR bundle with todos
001, 002, 004, 006, 007. Expected change: ~8 LOC in session-start.js
+ 1 regression test asserting the soft-vs-hard TTL boundary.

## Technical Details

- **Affected files:**
  - `agent-orchestrator/hooks/session-start.js` — the filter loop
    (A, B) or remove consideration (C)
  - `agent-orchestrator/hooks/session-start.test.js` — new test
    asserting stale-flag unlink or stable scan behavior
  - `agent-orchestrator/scripts/spawn-session.js` or a new
    `orchestrate.js` — for option C
- **Exported constants to add:** `STALE_HARD_TTL_MS` if B.
- **No database changes.**

## Acceptance Criteria

- [ ] Behavior decision captured (A / B / C) in the todo during
  triage.
- [ ] If A or B: hook has a regression test demonstrating that a
  sufficiently-old stale flag gets unlinked while a just-stale one
  is preserved.
- [ ] If B: `STALE_HARD_TTL_MS` is exported and covered by the test.
- [ ] If C: Unit 11 design spec explicitly lists the sweep as a
  pre-spawn step, and the spec cross-references this todo.
- [ ] Combined repo suite remains green (151+ tests).

## Work Log

- **2026-04-22 — todo created** — Surfaced by ce-review
  performance-oracle agent during final pre-merge review of PR #4.
  All other agents and codex gave MERGE-READY. This is the only
  convergent P2 finding not covered by a same-PR fix.

## Resources

- PR #4: https://github.com/newton20/agent-orchestration/pull/4
- Performance-oracle agent report (PR #4 pre-merge review)
- Hook contract: `agent-orchestrator/hooks/README.md`
- Similar pattern (scaffold-protocol cleanup): see
  `agent-orchestrator/scripts/scaffold-protocol.js`'s stale-file
  handling for precedent on "preserve vs unlink" decisions elsewhere
  in the plugin
