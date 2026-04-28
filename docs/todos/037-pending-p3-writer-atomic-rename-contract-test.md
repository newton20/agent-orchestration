---
status: pending
priority: p3
issue_id: "037"
tags: [code-review, post-pr-11, ce-review, hooks, unit-11, test-coverage]
dependencies: []
---

# Writer atomic-rename invariant is prose-only — close the loop with a contract test (Unit 11 follow-up)

PR #11 closed todo 029 by adding a writer-side atomic write-then-rename
invariant to `hooks/README.md`'s "Contract invariants" section. PR #11
ce:review's architecture-strategist noted that this invariant is now
prose-only — the *symmetric* version of the regex-pair lockstep before
todo 027 added its node:test assertion.

## Problem Statement

The relevant invariant from `agent-orchestrator/hooks/README.md:64-72`:

> Writers (Unit 11 orchestrator, manual debugging tools) MUST place
> `.pending-<id>` files via atomic write-then-rename
> (`writeFileSync(tmpPath, content); renameSync(tmpPath, flagPath)`),
> never via direct `writeFileSync(flagPath, content)`. Without atomic
> write, the hook's `statSync` could see a 0-byte mid-write file with
> `mtime=now`, pass the freshness gate, and then fail the size guard
> or read mid-stream.

This is currently a prose contract. The architecture review on PR #11
made the parallel:

> "The atomic-rename invariant ... is prose-only. Unit 11 will
> implement the writer; a contract test that simulates a 0-byte
> mid-write file and verifies the hook handles it gracefully would
> close the loop the way the lockstep test closes the regex one. The
> plan's existing 'explicit regression test' pattern (§1078-1079) is
> the model. Filing as a Unit 11 follow-up todo would be appropriate;
> not this PR's job."

Concretely: a future Unit 11 writer agent that forgets the tmp+rename
pattern and uses `writeFileSync(flagPath, content)` directly will
**not** trip a CI failure today. The hook's behavior on partial writes
is documented but not test-pinned. PR #9's two-tier-TTL added a
regression test (§1078-1079) for the soft/hard TTL boundaries; the
analogous test for atomic-rename does not yet exist.

## Findings

PR #11 ce:review architecture-strategist:

> "P3-C — The atomic-rename invariant ('writeFileSync(tmpPath,
> content); renameSync(tmpPath, flagPath)') at `hooks/README.md:67`
> is prose-only. Unit 11 will implement the writer; a contract test
> that simulates a 0-byte mid-write file and verifies the hook
> handles it gracefully would close the loop the way the lockstep
> test closes the regex one. Filing as a Unit 11 follow-up todo
> would be appropriate; not this PR's job."

Existing precedent the test should mirror: `hooks/session-start.test.js`
already exercises the readdir/stat path against synthetic
`.pending-<id>` fixtures. The new test would extend that pattern with
a mock `fsLib` that returns `mtimeMs=now` + `size=0` on `statSync` and
fails the subsequent `readFileSync` (or returns truncated bytes) — and
assert the hook returns `{}` cleanly with a `[unit-5-hook]` log
message.

## Caveat — what the test must verify

**A hook-side synthetic-partial-file test does NOT, by itself,
enforce the writer-side contract.** The invariant in
`hooks/README.md:64-72` is that *writers* MUST use atomic
write-then-rename. A hook test that simulates a 0-byte mid-write
file only validates the hook's defensive behavior — the test would
still pass if a Unit 11 writer used `writeFileSync(flagPath, content)`
directly. The actual contract violation slips through because the
hook's catch-all error swallowing converts most partial-file failures
to a clean `{}` return.

Worse: if `readFileSync` succeeds on truncated-but-nonzero bytes
(crash mid-write after first write of partial content), the hook
will inject the truncated content as `additionalContext` and mark
the file consumed via atomic rename — a silent partial-prompt
injection. The hook's error-swallowing path is NOT a substitute
for writer-side atomic-rename.

So the follow-up's acceptance criteria must bind to the
**writer-side** behavior, not the hook-side robustness. Two
viable test shapes:

1. **Writer unit test** — when Unit 11's writer module ships, a
   unit test asserts the writer calls `writeFileSync(tmpPath, ...)`
   followed by `renameSync(tmpPath, flagPath)` (via a mock `fsLib`
   that records the call sequence and fails the test if any
   `writeFileSync` call lands directly on the *final* flag path).
2. **End-to-end test** — Unit 11's writer + the existing hook are
   exercised against a real tmp directory; the test introduces a
   crash window between the writer's `writeFileSync` and `rename`
   (e.g. via a `fsLib` that records the call sequence and aborts
   after `writeFileSync(tmpPath, ...)` but before `rename`); a
   subsequent hook tick must see no consumable `.pending-<id>`
   file. Exact contract: a writer crash mid-write must NOT yield
   a consumable flag file.

The hook-side synthetic-partial-file test from the original
proposal is still useful as a regression guard against future
hook refactors that might make `readFileSync` failure fatal —
but it's a **separate** concern and must not be conflated with
the writer-side contract test.

### Test-design pitfalls a future implementer must avoid

Codex review on the triage PR surfaced two false-negative gaps
the test design must defend against:

**Pitfall 1 — temp basename can still match `FLAG_NAME_RE`.**
A natural writer-side temp pattern like `.pending-${id}.tmp`
*satisfies* `FLAG_NAME_RE` (`^\.pending-[A-Za-z0-9._-]+$`)
because the ID character class includes `.`. So if Unit 11's
writer crashes between `writeFileSync('.pending-foo.tmp', ...)`
and `renameSync('.pending-foo.tmp', '.pending-foo')`, the
on-disk `.pending-foo.tmp` file matches `FLAG_NAME_RE` and the
hook will consume it.

**Constraint:** Unit 11's writer MUST use a tmp basename that
does NOT match `FLAG_NAME_RE`, and the tmp file MUST live in the
same filesystem as `docs/orchestration/` (else
`renameSync(tmpPath, flagPath)` is not atomic and may fail with
`EXDEV` — the very invariant this contract protects). The
recommended shape: place the tmp file *inside* the orch dir with
a basename that does not match `FLAG_NAME_RE` — e.g. prefix with
`.writing-` rather than `.pending-`
(`.writing-${id}-${pid}-${ms}`). The leading `.` keeps it hidden
in `dir` listings; the `.writing-` prefix is structurally outside
the hook's match set. Avoid placing tmp files in OS-tempdir or
any path on a different volume — even though that side-steps
Pitfall 1 by definition, it loses rename atomicity entirely.

The test must assert the in-orch-dir non-matching-basename
constraint explicitly — e.g. `for every recorded writeFileSync
call into the orch dir, assert
!FLAG_NAME_RE.test(path.basename(callPath))`.

**Pitfall 2 — `FLAG_NAME_RE` is anchored, so it matches only
basenames, not full paths.** A naive test that records
full-path `writeFileSync` calls (e.g.
`<orchDir>/.pending-foo`) and runs `FLAG_NAME_RE.test(callPath)`
will always return `false` because the regex is anchored
(`^\.pending-...$`). A direct-`writeFileSync(flagPath, ...)`
violation would silently pass.

**Constraint:** when matching recorded calls against the flag
contract, match `path.basename(callPath)` — OR compare
`callPath` directly to the final flag path resolved by the
writer. Both forms are correct; raw `FLAG_NAME_RE.test(fullPath)`
is broken.

## Proposed Solutions

### Option A — Writer-side contract test in Unit 11's PR (preferred)

When Unit 11 lands, its test suite includes a unit test that
asserts the writer module never calls `fs.writeFileSync` with the
final flag path. Implementation: mock the writer's injected
`fsLib`; record every `writeFileSync` call; fail the test if any
recorded call has `callPath === flagPath` (final-path equality
check) **or** `path.basename(callPath)` matches `FLAG_NAME_RE`
when the call lands inside the orch dir. Pair with two positive
tests: (a) the writer DOES call `writeFileSync(tmpPath, ...)`
followed by `renameSync(tmpPath, flagPath)`, and (b)
`!FLAG_NAME_RE.test(path.basename(tmpPath))` — the tmp basename
itself must not be hook-consumable.

**Pitfall 1 + 2 mitigation embedded.** This shape closes both
codex-flagged gaps: the final-path equality check catches direct
`writeFileSync(flagPath, ...)` (raw-regex-on-fullpath would have
missed it because `FLAG_NAME_RE` is anchored to basenames), and
the tmp-basename assertion catches the
`.pending-${id}.tmp`-style violation that would leave a
consumable partial file behind on a mid-write crash.

- **Pros:** Tests the *writer's* contract compliance, not the
  hook's error-swallowing. Fails loudly the moment a Unit 11
  writer regresses to direct writeFileSync. Codex's correction
  on this todo's original framing is satisfied.
- **Cons:** Requires the writer module to accept an injected
  `fsLib`, like the hook does — a small but non-trivial design
  constraint on Unit 11.
- **Effort:** Small (1-2 tests, ~15-20 LOC) once Unit 11 ships.
- **Risk:** Low.

### Option B — End-to-end writer+hook test in Unit 11's PR

A test that wires up the real writer + hook against a real tmp
directory and verifies that a writer crash *during* the write
(simulated via `fsLib` that throws on the second call before
`rename`) leaves no consumable `.pending-<id>` file behind.

- **Pros:** Highest fidelity — exercises the actual atomic-rename
  invariant end-to-end.
- **Cons:** More complex test scaffolding; needs a deterministic
  way to inject the crash. Brittle to filesystem timing on
  Windows.
- **Effort:** Medium (~30-50 LOC).
- **Risk:** Medium (test brittleness on Windows fs).

### Option C — Hook-side synthetic-partial-file test ONLY (defective; do NOT close on this alone)

The original framing of this todo. As codex's correction made
explicit, this test by itself does NOT enforce the writer-side
contract — it only validates the hook's error-swallowing
behavior. **Listed here for completeness and explicitly rejected
as the only follow-up.** A hook synthetic-partial-file test is
fine as a *companion* regression guard, but it must NOT be the
sole acceptance criterion for closing this todo.

- **Pros:** Easy to write today.
- **Cons:** Doesn't actually enforce the contract. False sense of
  coverage.
- **Effort:** Trivial.
- **Risk:** **High** — closing this todo with only this test
  would leave the writer-side invariant prose-only despite
  appearing to be test-enforced.

### Option D — Defer indefinitely (V1-freeze posture)

Skip the test entirely. The prose contract in
`hooks/README.md` stays the only enforcement. Unit 11's writer
implementer is expected to read it.

- **Pros:** Zero churn.
- **Cons:** A Unit 11 writer agent that misses the prose
  contract has no CI guardrail.
- **Effort:** Zero.
- **Risk:** Low if Unit 11 implementer reads carefully; medium
  otherwise.

## Recommended Action

**Triage: defer to Unit 11 dispatch (Option A preferred, Option
B acceptable).** When Unit 11 ships, the writer module must
accept an injected `fsLib` (matching the hook's existing pattern)
specifically so this contract test is writeable. The Unit 11
dispatch handoff should explicitly call out the testability
constraint.

**Do NOT close on Option C alone** (codex's correction). A
hook-side synthetic-partial-file test only validates hook
robustness, not writer compliance. Such a test is fine as a
*companion* regression guard alongside Option A or B but cannot
substitute for it.

If Unit 11 ships without this test, the todo stays open and gets
folded into the next post-Unit-11 cleanup batch — not silently
closed.

## Technical Details

- Affected files (Option A): Unit 11's writer module + its test
  file (path TBD when Unit 11 dispatches).
- Affected files (Option B): Unit 11's writer module + its test
  file + possibly `hooks/session-start.test.js` for the
  end-to-end half.
- Test count delta: +1 to +2 depending on Option.
- Constraint on Unit 11 design: writer module must accept
  injected `fsLib` (mirrors hook pattern).

## Acceptance Criteria

- [ ] Triage captures chosen Option (A / B / C-as-companion-only / D).
- [ ] If A: a Unit 11 writer-module test asserts (i) no recorded
  `writeFileSync` call equals the final flag path, (ii) the
  writer's path is `writeFileSync(tmpPath) +
  renameSync(tmpPath, flagPath)`, (iii)
  `!FLAG_NAME_RE.test(path.basename(tmpPath))` — the tmp basename
  must not itself match the hook's flag-name regex, and (iv)
  `path.dirname(tmpPath) === path.dirname(flagPath)` — the tmp
  file and the final flag file are siblings inside
  `docs/orchestration/`, guaranteeing same-filesystem rename.
  An equivalent same-filesystem proof (e.g. comparing
  `fs.statSync(...).dev`) is acceptable but the sibling-dir
  check is the simplest sufficient form.
- [ ] If B: a writer+hook end-to-end test asserts that a writer
  crash *between* `writeFileSync(tmpPath, ...)` and
  `renameSync(...)` leaves no consumable flag file — i.e. either
  no file exists in the orch dir, or any leftover file's basename
  fails `FLAG_NAME_RE`. The end-to-end test must use a tmp path
  inside `docs/orchestration/` (or otherwise proven
  same-filesystem) so that the `renameSync` it covers is the
  real atomic-rename path, not a cross-device fallback.
- [ ] **NOT acceptable as sole enforcement:** (1) a hook test that
  exercises a synthetic 0-byte file (validates hook robustness,
  not writer compliance); (2) any test that uses
  `FLAG_NAME_RE.test(fullPath)` against recorded
  `writeFileSync` call paths (the regex is anchored to
  basenames, so it always returns false for full paths and the
  test would silently miss direct-`writeFileSync(flagPath, ...)`
  violations); (3) any test that does not assert tmpPath
  same-filesystem with flagPath (else a writer using
  `os.tmpdir()` or another volume could pass the test while
  `renameSync` later fails with `EXDEV` or loses atomicity).
- [ ] Hook + scripts suites both green at the new counts.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (architecture-strategist P3-C). Coord deferred to Unit 11 dispatch
  per V1-freeze + reviewer's explicit "not this PR's job" framing.
- **2026-04-28 — corrected via codex on triage PR (round 1)** —
  original framing proposed a hook-side synthetic-partial-file
  test as the enforcement mechanism. Codex flagged that a
  hook-side test validates only the hook's error-swallowing path,
  NOT the writer's atomic-rename contract — a writer using
  `writeFileSync(flagPath, ...)` directly would still let the
  hook test pass while the contract is silently violated, and a
  truncated-but-nonzero mid-write read could even inject partial
  prompt content as `additionalContext`. Rewrote the Caveat,
  Proposed Solutions, Recommended Action, and Acceptance Criteria
  to require a writer-side test (Option A or B). Hook-side
  synthetic-partial-file test is now Option C — explicitly
  rejected as sole enforcement, acceptable only as a companion
  regression guard.
- **2026-04-28 — corrected via codex on triage PR (round 2)** —
  the rewrite introduced two false-negative test-design gaps,
  both flagged by codex:
  (1) A natural writer tmp pattern like `.pending-${id}.tmp`
  *satisfies* `FLAG_NAME_RE` because the ID character class
  includes `.`, so a mid-write crash on that pattern would still
  yield a hook-consumable file — the test must explicitly require
  the tmp basename to fail `FLAG_NAME_RE`.
  (2) `FLAG_NAME_RE` is anchored (`^\.pending-...$`) and matches
  basenames only; a test that runs `FLAG_NAME_RE.test(fullPath)`
  against recorded `writeFileSync` calls (e.g.
  `<orchDir>/.pending-id`) always returns `false`, so a writer
  using direct `writeFileSync(flagPath, ...)` would *pass* the
  proposed test. The test must compare against
  `path.basename(callPath)`, or do a final-path equality check.
  Added a "Test-design pitfalls" section, restructured Option A's
  test shape to embed both mitigations (final-path equality +
  basename regex check + tmp basename non-match), and rewrote the
  Acceptance Criteria to enumerate the disallowed test forms.
- **2026-04-28 — corrected via codex on triage PR (round 3)** —
  the round-2 fix suggested "place the tmp file outside
  `docs/orchestration/` and rename across directories" as one
  way to avoid Pitfall 1. Codex flagged this as introducing a
  worse violation: cross-filesystem `renameSync` is not atomic
  (POSIX `rename(2)` returns `EXDEV` across mount points), so
  the same-volume constraint is load-bearing for the very
  invariant this todo is meant to enforce. Restricted the
  Pitfall 1 mitigation to in-orch-dir non-matching basenames
  (`.writing-${id}-${pid}-${ms}` or similar); explicitly called
  out that OS-tempdir / different-volume tmp paths are
  unacceptable.
- **2026-04-28 — corrected via codex on triage PR (round 4)** —
  the round-3 fix added the same-filesystem narrative
  constraint but did NOT bind it into the Acceptance Criteria.
  Codex flagged that a future Unit 11 writer using `os.tmpdir()`
  for `tmpPath` could still pass criterion (iii) (tmp basename
  doesn't match `FLAG_NAME_RE`) while the `renameSync` later
  fails with `EXDEV`. Added criterion (iv):
  `path.dirname(tmpPath) === path.dirname(flagPath)`
  (tmp file and final flag file are siblings inside
  `docs/orchestration/`, the simplest sufficient
  same-filesystem proof). Also extended the disallowed-test
  list with the missing-same-filesystem-assertion form.

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 029 (closed by PR #11): the prose contract this todo would
  test-enforce.
- PR #9 (`feat/templates-pre-unit-7-round-2`): two-tier TTL
  regression test pattern at plan §1078-1079.
- `docs/solutions/integration-issues/claude-code-sessionstart-hook-windows.md`
  Prevention §4 — the hook-side atomic-rename precedent that the
  writer-side mirrors.
