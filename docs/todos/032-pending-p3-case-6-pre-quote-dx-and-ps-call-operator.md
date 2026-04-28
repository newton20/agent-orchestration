---
status: pending
priority: p3
issue_id: "032"
tags: [code-review, post-pr-9, qa-advisory, codex, spawn-session, docs]
dependencies: []
---

# quoteBinary case 6 raw error DX + PowerShell `&` call-operator subtlety (QA A2 + codex round 4)

PR #9's todo 002 dropped quoteBinary's `.exe`-subcommand split branch.
The boundary-guard regex preserves case 5 (`C:\tools\x.exe sub` —
no spaces) and the pre-quoted form. Case 6 (path-with-spaces +
subcommand) requires manifest authors to pre-quote the exe portion.
Two post-PR follow-ups bundled here:

## Problem Statement

**A2 (from QA report) — case-6 raw produces OS-level ENOENT, not a
pre-emptive validation error.** A manifest author who writes
`binary: C:\Program Files\X\x.exe sub` (without pre-quote) will see
the spawn fail with the OS's `ENOENT C:\Program` because the shell
tokenized at the first whitespace. The dispatch's PASS criterion
("clear error OR fails the spawn cleanly") is satisfied — but the
manifest author has to map `ENOENT C:\Program` → `I need to pre-
quote my binary value`, which is a non-obvious leap.

**Codex round 4 nuance — even the pre-quoted workaround has a
PowerShell subtlety.** A manifest author dutifully pre-quoting as
`'"C:\Program Files\X\x.exe" sub'` will get the literal string
through quoteBinary verbatim (the boundary regex matches `.exe" `).
Under cmd that's tokenized fine. Under PowerShell, however, a quoted
path needs the `&` call operator (`& 'path' arg`) for actual
execution — without it, the quoted path is treated as a string
literal, not a command. So the documented escape hatch does NOT
work transparently for PowerShell users; they need
`'& "C:\Program Files\X\x.exe" sub'` or similar.

## Findings

- **QA Advisory A2:** "A follow-up could add a pre-emptive guard in
  `validateLauncher` (or a one-line check in `quoteBinary` itself)
  that detects raw path-with-spaces + subcommand and throws with a
  message like `binary contains a path with spaces followed by
  additional tokens — pre-quote the executable path: '\"C:\\Program
  Files\\X\\x.exe\" sub'`. Trade-off: validation surface area grows,
  and the dispatch explicitly invited 'trust verification by the
  impl' rather than mandating pre-emptive guards."
- **Codex round 4:** "The documented pre-quoted workaround also still
  won't execute under PowerShell without the `&` call operator."
- **Simplicity reviewer take:** "Adding a pre-emptive validator grows
  surface area; the dispatch invited the trust verification, not a
  guard. Update the manifest authoring docs instead, if anywhere."

## Proposed Solutions

### Option A — Doc-only

Document the pre-quote requirement and the PowerShell `&` nuance in
the manifest reference (when it exists) and/or in the spawn-session.js
quoteBinary header comment. No code change.

- **Pros:** Honors the dispatch's "trust verification" intent.
  Smallest change.
- **Cons:** Manifest authors only learn the requirement after hitting
  the OS-level error.
- **Effort:** Small (doc-only).
- **Risk:** None.

### Option B — Pre-emptive guard in validateLauncher

When `binary` contains a path separator + whitespace + an executable
extension boundary, throw with a clear message naming both the cmd
and PowerShell pre-quote forms.

- **Pros:** Immediate, actionable error at config-load time.
- **Cons:** Validator surface area grows; must understand exec
  context (cmd vs PowerShell call-operator).
- **Effort:** Small-medium (10-15 LOC + tests).
- **Risk:** Low. Could over-reject valid edge cases.

### Option C — Auto-add `&` for PowerShell pre-quoted shape

quoteBinary detects `.exe" ` boundary AND PowerShell shell, then
prepends `&` if absent. cmd path unchanged.

- **Pros:** PowerShell pre-quote shape "just works" without manual
  `&` prefix.
- **Cons:** Re-introduces the kind of clever-detection complexity
  todo 002 just deleted. Brittle to additional shapes.
- **Effort:** Small.
- **Risk:** Medium — moves toward case-6-by-stealth.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected files (Option B):
  - `agent-orchestrator/scripts/parse-manifest.js` (validateLauncher)
  - `agent-orchestrator/scripts/parse-manifest.test.js` + tests
- Option A only touches docs:
  - `agent-orchestrator/scripts/spawn-session.js` quoteBinary header
  - Future `docs/manifest-reference.md`

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If B: validateLauncher rejects path-with-spaces + subcommand
  raw form with a message naming both cmd and PowerShell pre-quote
  shapes.
- [ ] If A or C: docs explain the PowerShell `&` requirement.

## Work Log

- **2026-04-28 — todo created** — From QA Advisory A2 + codex round 4
  nuance on PR #9.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- QA report:
  `~/.claude/handoffs/newton20-agent-orchestration/20260428-053533-qa-report.md`
  (Row 9 + Advisory A2)
- Codex round 4 transcript captured during PR #9 ce:review session
  2026-04-28.
- Todo 002 (closed):
  `docs/todos/002-complete-p3-simplify-spawn-session-post-codex.md`
