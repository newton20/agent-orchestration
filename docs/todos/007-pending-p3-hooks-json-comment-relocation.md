---
status: pending
priority: p3
issue_id: "007"
tags: [code-review, unit-5, hooks, docs, cleanup]
dependencies: []
---

# `hooks.json` `_comment` field is ~500 chars; relocate to a supported docs surface

## Problem Statement

`agent-orchestrator/hooks/hooks.json:2` carries a ~500-character
`_comment` field explaining why the escaped double-quotes around
`${CLAUDE_PLUGIN_ROOT}` are load-bearing under Git Bash. The
content is correct and valuable; the placement is questionable.

Concerns raised by the code-simplicity-reviewer:

1. `_comment` is a JSON convention, not part of Claude Code's
   hooks schema. Claude Code silently ignores unknown fields today;
   a future stricter validator could reject it.
2. The same explanation already lives in
   `agent-orchestrator/hooks/README.md` (the "Plugin activation
   caveat" section) and in
   `agent-orchestrator/spikes/launcher-compat-findings.md` (the
   side-finding). Three copies, one source of truth.
3. The 500-char blob makes the 5-line functional payload of
   hooks.json hard to skim.

Not a defect in any functional sense — the file parses cleanly
and Claude Code is happy with it. Entirely a maintainability /
convention-alignment concern.

## Findings

Flagged by the code-simplicity-reviewer during ce-review of PR #4.

## Proposed Solutions

### Option A — Shrink the `_comment` to a pointer

Replace the 500-char comment with a one-liner pointing at the
authoritative docs:

```json
"_comment": "Quoted \"${CLAUDE_PLUGIN_ROOT}\" is load-bearing under Git Bash — see hooks/README.md and spikes/launcher-compat-findings.md"
```

- **Pros:** Keeps a breadcrumb for future editors. Reduces noise.
  Survives future stricter schema validation (still unknown-field,
  but much smaller blast radius).
- **Cons:** Relies on the reader following the pointer. Still
  uses an unsupported JSON convention.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Move the full comment into `run-hook.cmd`

`run-hook.cmd` is the physically-nearest file to the quoting
decision and already has a comment block. Move the 500 chars there,
drop `_comment` from hooks.json entirely.

- **Pros:** Zero-convention overhead (cmd comments are legit).
  Closest to the sharp edge.
- **Cons:** `.cmd` files are rarely the first place a maintainer
  looks. README.md remains the canonical documentation anchor.
- **Effort:** Small. 2 file edits.
- **Risk:** None.

### Option C — Drop `_comment` entirely

The rationale already exists in README.md and the spike doc. A
future editor who breaks the quoting and sees "weird escapes" in
hooks.json will grep, find README, and learn.

- **Pros:** Maximally clean hooks.json.
- **Cons:** No local breadcrumb at the edit site. Future-you may
  remove the escapes before reading docs.
- **Effort:** Trivial.
- **Risk:** Low — but the "delete the escapes during a cleanup
  pass" scenario is exactly what this comment was written to
  prevent, and pure removal is the *opposite* of that intent.

## Recommended Action

Leave blank for triage. **Leaning Option A** — preserves the anti-
regression breadcrumb with minimal noise.

## Technical Details

- **Affected files:**
  - `agent-orchestrator/hooks/hooks.json` (line 2)
  - Optionally `agent-orchestrator/hooks/run-hook.cmd` for option B
- **No test changes needed** — the comment is not executable.

## Acceptance Criteria

- [ ] Triage captures the chosen option (A / B / C).
- [ ] If A or B: hooks.json `_comment` is either a short pointer or
  absent.
- [ ] Hook still fires correctly in a manual smoke test (command
  shape unchanged).

## Work Log

- **2026-04-22 — todo created** — Surfaced by ce-review
  code-simplicity-reviewer during final pre-merge review of PR #4.

## Resources

- PR #4: https://github.com/newton20/agent-orchestration/pull/4
- `agent-orchestrator/hooks/hooks.json`
- `agent-orchestrator/hooks/README.md` — the current authoritative
  docs for the quoting contract
- `agent-orchestrator/spikes/launcher-compat-findings.md` — the
  empirical origin of the constraint
