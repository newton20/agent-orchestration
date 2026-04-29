---
status: pending
priority: p2
issue_id: "043"
tags: [code-review, post-pr-13, ce-review, scripts, agent-native, windows-paths]
dependencies: []
---

# Mixed path separators in rendered protocol prompts on Windows

PR #13 ce:review's agent-native-reviewer noted that templates write
literal forward-slash separators (e.g.
`` `{{phase_dir}}/{{role}}-prompt.md` ``) while the JS generator
derives paths via `path.join`, which returns OS-native separators —
backslashes on Windows. The result is a rendered prompt that mixes
both within adjacent bullets pointing at the same parent directory.
Filesystem operations work (Windows accepts both); but agents that
do string-equality comparisons against `process.argv` or
`fs.realpathSync` outputs see two different strings for the same dir.

## Problem Statement

`agent-orchestrator/templates/protocol-header.md:32` uses a literal
forward slash:

```
`{{phase_dir}}/{{role}}-prompt.md`
```

`agent-orchestrator/scripts/generate-prompt.js:729-730` builds the
completion-signal path with `path.join`:

```js
const completionSignalPath = path.join(o.phaseDir, `${o.role}-complete.md`);
```

`path.join` on Windows returns `\\`-separated paths. The rendered
prompt therefore contains:

```
- Read prompt: C:\Users\…\rev-XYZ/qa-prompt.md
- Write completion: C:\Users\…\rev-XYZ\qa-complete.md
- Heartbeat: C:\Users\…\rev-XYZ\qa-heartbeat.md
```

The first line uses `/` (template literal); the second/third use
`\\` (path.join). An agent that snapshots `argv[2]` (its own prompt
path) and string-compares against the rendered "Read prompt" line
will mismatch even though both point at the same file.

## Findings

PR #13 ce:review agent-native-reviewer P2:

> "`templates/protocol-header.md:32` writes
> `` `{{phase_dir}}/{{role}}-prompt.md` `` with a literal
> forward slash, but `generate-prompt.js:729-730` derives
> `completionSignalPath` via `path.join(o.phaseDir, ...)` which
> returns native separators (backslash on Windows). On Windows
> the rendered prompt mixes `/` and `\` within adjacent bullets
> pointing at the same dir. Filesystem ops accept both — but
> agents doing string-equality comparisons against `process.argv`
> or `realpathSync` outputs see two strings for the same dir.
> Recommend normalizing all rendered protocol paths to forward
> slashes (cross-platform stable, matches the Unix-bias of the
> templates)."

## Proposed Solutions

### Option A — Normalize to forward slashes in `buildContext`

In the context-construction step, replace `\\` with `/` for every
rendered path before substitution: `phaseDir`, `workdir`,
`completionSignalPath`, `heartbeatPath`, each entry in
`prior_phase_dirs`. Templates continue to use `/` literals; agents
see `/`-only paths regardless of OS.

- **Pros:** Single chokepoint. Cross-platform stable. Matches the
  template-author bias (already writing `/`). Rendered prompts
  diff cleanly between Linux CI and Windows dev.
- **Cons:** ~5 LOC of `replace(/\\/g, '/')` calls. Need a small
  helper (`toForwardSlashes`) to centralize. Tests need a
  Windows-conditional case (or a pure-string test that passes a
  pre-baked Windows-style path through `buildContext` and
  asserts forward-slash output).
- **Effort:** Small.
- **Risk:** Low — purely cosmetic on the agent's view; fs ops
  continue to work because Windows accepts both.

### Option B — Use `path.posix.join` for derivation

Switch `path.join` to `path.posix.join` for
`completionSignalPath` and `heartbeatPath` derivation. Forces
forward-slash output regardless of OS for those specific paths.
`o.phaseDir` itself still arrives via the caller and may already
contain backslashes — so Option B alone may not fully fix the mix.

- **Pros:** Localized change at the derivation site. Explicit
  signal that "these strings are agent-facing path strings, not
  fs-input."
- **Cons:** Doesn't normalize `phaseDir` itself if the caller
  passed it with backslashes. Need to combine with a normalize
  on `o.phaseDir`. Two-step.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Accept mixed separators for V1

Windows fs accepts both. No agent in the V1 surface does string-
equality comparisons of paths today (the agent reads its prompt
via `argv[2]` and writes by `path.join`-ing, both of which work
fine).

- **Pros:** Zero churn.
- **Cons:** Future agent code (or human reviewer) doing a string
  compare will hit a confusing mismatch. Rendered-prompt diffs
  between Linux CI and Windows dev show OS noise instead of
  content. Visual inconsistency in agent-facing output.
- **Effort:** Zero.
- **Risk:** Low for V1; latent for V2.

## Recommended Action

Pending coord triage. Option A is the most direct cross-platform
fix and centralizes the concern in `buildContext`; Option B is
narrower but may not cover `phaseDir` itself; Option C defers.
Triage should weigh whether agent-facing path strings are part of
the contract (Option A) or implementation detail (Option C).

## Technical Details

- Affected files (Option A):
  - `agent-orchestrator/scripts/generate-prompt.js` —
    `buildContext` (or the call site that assembles the path
    fields). Add a `toForwardSlashes(p)` helper.
  - `agent-orchestrator/scripts/generate-prompt.test.js` —
    new test feeding a Windows-style `phaseDir` and asserting
    the rendered output uses `/`.
- Templates already use `/` literals (no template change needed
  for Option A).
- Other call sites that read these paths (heartbeat watcher,
  completion-signal poller) operate on the original `o.phaseDir`,
  not the rendered string — unaffected.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: a unit test with a synthetic Windows-style
  `phaseDir` (e.g. `C:\\foo\\bar`) renders a prompt whose path
  bullets all use `/` separators.
- [ ] If A: `prior_phase_dirs` entries also normalized.
- [ ] If A: snapshot of a rendered prompt on Windows matches
  the snapshot on Linux for path strings.
- [ ] If B: `completionSignalPath` and `heartbeatPath` use
  `path.posix.join`; combine with a `phaseDir` normalize.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (agent-native-reviewer P2). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/templates/protocol-header.md:32` — the
  literal-`/` site.
- `agent-orchestrator/scripts/generate-prompt.js:729-730` —
  the `path.join` derivation site.
