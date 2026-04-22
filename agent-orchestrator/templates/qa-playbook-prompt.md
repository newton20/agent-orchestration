---
required: []
optional: [test_commands_block]
---

# QA playbook (reusable)

> This playbook is inlined into `qa-prompt.md` via the
> `qa_playbook_block` variable at interpolation time — it is not a
> standalone prompt. Rows here are static: they run the same way for
> every PR. The per-PR scope rows live in `qa-prompt.md` under **Scope
> rows**. Keep this file free of project-specific paths or commit SHAs.

## Ground rules

- You are the QA agent. You test, you report. You do not modify
  application code, push commits, touch the plan, or fix bugs you find.
- Every row below is either **PASS** with evidence or **FAIL** with
  evidence. "Skip" is never acceptable silently — if a row is
  infeasible (e.g., a test command requires credentials you do not
  have), record it explicitly as **SKIP (reason)** under Evidence. A
  silent skip destroys trust in the pass signal.
- Advisories (non-blocking concerns you noticed while running the
  playbook) are recorded in a separate **Advisories** section at the
  end of your report. Advisories do not gate merge.
- If a scope row in `qa-prompt.md` disagrees with the original handoff
  or the plan, verify against the original source and flag the
  discrepancy as an advisory. Do not silently follow the rewritten row
  and do not silently follow the original — report both and let the
  coordinator triage.

## Playbook rows

### P1 — Test suite, every workspace

For each directory under the repo root containing a `package.json`:

1. Run `npm test` (or the project's declared test command — check the
   `scripts.test` field).
2. Capture the total pass/fail/skip counts from the runner's final
   summary line.
3. Capture the exit code.

**PASS** if every workspace exits 0 with every test green.
**FAIL** if any workspace has a failing test, a test-runner crash, or a
non-zero exit code.

Record the per-workspace pass counts and the sum in your report. The
sum is the single number the coordinator cares about — it should match
the expected count the handoff specified.

### P2 — Working tree is clean after tests

After running the full test suite, run `git status --porcelain`. The
output must be empty.

**PASS** if empty.
**FAIL** if anything is listed (tests that wrote output files, lint
autofixes triggered by running tests, temp files left behind).

A dirty working tree after tests means the tests have side effects —
that is a real finding, not a setup error. Report it and do not clean
up; the coordinator needs to see what was written.

### P3 — Sample one non-trivial scope row end-to-end

Pick the scope row from `qa-prompt.md` that best represents the
phase's core value (usually the "happy path" row for the main feature
the phase shipped). Run it not just as a unit test but as a black-box
end-to-end exercise:

- Invoke the shipped entrypoint the way a user would.
- Observe the externally-visible behavior (stdout, a file written, a
  process exit code, a log entry).
- Compare against the expected behavior in the plan or handoff.

**PASS** if externally-visible behavior matches expectation.
**FAIL** if behavior differs or the entrypoint cannot be invoked as
described.

This row catches the "tests green but feature broken" class of regression
that unit-test-only coverage misses.

### P4 — Git log shape

Run `git log --oneline origin/main..HEAD` (or the equivalent base branch).
Verify every commit on the branch:

- Uses the project's conventional-commit style (`feat(scope): …`,
  `fix(scope): …`, `docs: …`, `chore(scope): …`).
- Ends with an attribution trailer (`Co-Authored-By: Claude
  <noreply@anthropic.com>`).
- Has no merge commits from the base branch mixed in (rebase, not
  merge, is the project convention).

**PASS** if every commit matches.
**FAIL** if any commit violates the shape.

### P5 — Diff file list cross-check (advisory-only)

Run `git diff --stat origin/main..HEAD` and compare the listed files
against the handoff's declared file list. Every file touched by the
branch should appear in the handoff; every file in the handoff should
appear in the diff.

**Verdict:** always **PASS** — this row exists to surface mismatches as
advisories, not to gate the merge. A genuinely broken branch (e.g., an
empty diff when impl was supposed to ship) shows up under P1 (test
suite) or P3 (happy-path end-to-end), which do gate merge.

For each file in the diff that is NOT in the handoff, append an
advisory:

- **[advisory]** scope-creep candidate: `<path>` appears in the diff
  but not in the handoff's file list — check whether the extra touch
  looks intentional or accidental in Evidence.

For each file in the handoff that is NOT in the diff, append an
advisory:

- **[advisory]** missing output: `<path>` declared in the handoff but
  not present in the diff — impl may have skipped or re-scoped it.

### P6 — Test command discoverability

A new contributor must be able to discover and run the tests by
following the README alone. Verify:

- The README describes the test command (`npm test`, etc.).
- Running the documented command from a fresh clone reproduces the
  test counts from P1.

**PASS** if both hold.
**FAIL** if the README is silent or the command does not work from
root.

## Advisories

Any non-blocking concerns you noticed while running the playbook land
here, each with a short severity tag:

- **[advisory]** <one-line concern> — <evidence or file:line reference>
- **[nit]** <stylistic observation> — <evidence>

Advisories do not gate merge but the coordinator may convert them into
follow-up todos under `docs/todos/`.

## Test commands (project-specific)

If the coordinator supplied project-specific test commands, they appear
here:

{{test_commands_block}}

If this section is empty, fall back to `npm test` per-workspace as
described in P1.
