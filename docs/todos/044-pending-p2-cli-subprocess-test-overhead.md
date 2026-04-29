---
status: pending
priority: p2
issue_id: "044"
tags: [code-review, post-pr-13, ce-review, scripts, performance, test-coverage]
dependencies: []
---

# CLI subprocess tests dominate test runtime (~41% of 2.08s)

PR #13 ce:review's performance-oracle measured the
`generate-prompt.test.js` suite: 6 of its tests use `spawnSync` to
exercise the CLI surface end-to-end. Total subprocess overhead is
~848ms, ~41% of the 2.08s suite runtime. Each subprocess pays
Node startup + module load + js-yaml cold-load (~120ms on Windows).
The tests are valuable (they exercise actual `argv`, stderr, exit
codes), but as the suite grows they'll continue to dominate.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.test.js` lines 1194,
1259, 1335, 1388, 1436, 1469: each is a `spawnSync(process.execPath,
[GENERATE_PROMPT_SCRIPT, ...])` call. Tests cover:

- Missing required args → exit 1, stderr contains usage.
- Bad `--role` → exit 1, stderr names the bad role.
- `--context k=v` allowlist enforcement → exit 1 on unknown key.
- `--context` value parses as JSON when shape suggests JSON.
- `--out` flag writes to disk and prints "wrote ..." to stdout.
- Default behavior (no `--out`) prints rendered prompt to stdout.

Performance-oracle measured each subprocess at ~140ms on Windows
(Node startup ~60ms + module load ~50ms + js-yaml cold-load ~30ms +
work). 6 × 140ms ≈ 848ms of pure overhead before any test logic.

## Findings

PR #13 ce:review performance-oracle P2:

> "`generate-prompt.test.js` lines 1194/1259/1335/1388/1436/1469
> use `spawnSync(process.execPath, [generate-prompt.js, ...])` to
> exercise CLI surface. Total subprocess overhead ~848ms = 41%
> of the 2.08s test runtime. Each pays Node startup + module
> load + js-yaml cold-load (~120ms on Windows). As the suite
> grows these tests will continue to dominate. Recommended fix:
> refactor `main()` and `parseCliArgs()` to take an explicit
> `argv`/`stdout`/`stderr` and an injectable `exit` (or have
> them throw a tagged `CliError` and let a thin wrapper translate
> to `process.exit`). 4 of the 6 CLI tests can call
> `main(['node','generate-prompt.js',...])` in-process. Estimated
> savings ~600ms (~28% test speedup). Keep 1-2 subprocess tests
> as smoke checks."

## Proposed Solutions

### Option A — Refactor `main()` for in-process invocation

Change `main()` and `parseCliArgs()` signatures to accept
`{ argv, stdout, stderr, exit }` (or throw `CliError` and wrap).
4 of the 6 subprocess tests refactor to in-process calls. Keep
1-2 (e.g. the actual binary smoke test, the `--out` disk-write
test) as subprocess tests.

- **Pros:** ~600ms test speedup (~28% of total). Better isolation
  for stderr/exit assertions (can inspect a buffer instead of
  shelling out). Sets a precedent for CLI-shaped tests in
  sibling scripts. Aligns with the "thin shim around a pure
  function" pattern Unit 5 already uses for `parseManifest`.
- **Cons:** Touches the production `main()` shape. Need to be
  careful about `process.exit` semantics in tests (use throw
  or an injected `exit` rather than calling `process.exit`
  directly during tests). Subprocess tests still needed for
  actual-shell-invocation smoke (1-2 retained).
- **Effort:** Medium — refactor + 4 test rewrites.
- **Risk:** Medium — changing `main()`'s contract is a small
  but real surface change; need to confirm no caller depends
  on it (only `bin/generate-prompt` and tests today).

### Option B — Replace some subprocess tests with JS API calls

The `--context k=v` allowlist tests are about input shape
validation. The same shape can be probed via the JS API (call
`generatePrompt({ context: { unknownKey: 'x' } })` and assert it
throws). Keep subprocess tests only where the CLI parsing
itself is what's under test (argv → opts).

- **Pros:** Smaller refactor than Option A. No `main()`
  signature change. Just relocate tests.
- **Cons:** Some assertions (e.g. stderr message format, exit
  code 1 vs 0) genuinely require a subprocess to verify. Won't
  remove all 6 — likely 2-3.
- **Effort:** Small-medium.
- **Risk:** Low — pure test refactor.

### Option C — Defer

~2s test runtime is fine for V1. Revisit if/when the suite
grows large enough to slow CI noticeably (e.g. when sibling
modules add their own subprocess tests).

- **Pros:** Zero churn.
- **Cons:** Tests will continue to dominate as the suite grows.
  Each new CLI surface (Unit 8/9/10) likely adds its own
  subprocess tests, multiplying the overhead.
- **Effort:** Zero.
- **Risk:** Low for V1; the cost compounds as suite grows.

## Recommended Action

Pending coord triage. Option A is the most impactful (~28%
speedup) but also the most invasive. Option B is a pure test
refactor that captures part of the win. Option C defers entirely.
Triage should weigh whether the V1-freeze applies to test-only
infrastructure changes; the production `main()` signature change
is the load-bearing question.

## Technical Details

- Measurements: 6 subprocess tests × ~140ms ≈ 848ms / 2.08s suite.
- Affected files (Option A):
  - `agent-orchestrator/scripts/generate-prompt.js` —
    refactor `main()` / `parseCliArgs()`.
  - `agent-orchestrator/bin/generate-prompt` (or equivalent
    binary entry) — call the new `main()` with
    `process.argv`/`process.stdout`/`process.stderr`/`process.exit`.
  - `agent-orchestrator/scripts/generate-prompt.test.js` —
    rewrite 4 of 6 subprocess tests as in-process calls.
- Sibling pattern: `parseManifest` is already pure-function; CLI
  shim is thin. Apply the same shape to `generatePrompt`.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `main()` accepts injectable `argv`/`stdout`/
  `stderr`/`exit` (or throws `CliError`). 4 of the 6 subprocess
  tests now call `main()` in-process.
- [ ] If A: at least 1 subprocess test retained as a smoke
  check that the binary actually invokes.
- [ ] If A: total suite runtime drops by ≥ 400ms (target ~600ms).
- [ ] If B: 2-3 subprocess tests replaced with direct JS API
  calls; remaining subprocess tests cover CLI-specific behavior
  (argv parsing, stderr format, exit codes).
- [ ] All 158+ tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (performance-oracle P2). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.test.js` lines
  1194/1259/1335/1388/1436/1469 — the 6 subprocess sites.
- Sibling pattern: `agent-orchestrator/scripts/parse-manifest.js`
  pure-function shape with a thin CLI shim.
