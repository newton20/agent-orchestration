---
status: pending
priority: p3
issue_id: "008"
tags: [tooling, ce-work, session-handoff, qa, upstream-investigation]
dependencies: []
---

# `/ce:work` rewrites `${CLAUDE_PLUGIN_ROOT}` to a hard-coded absolute path in dispatched scope rows

QA advisory #1 from PR #4's session-handoff assign-qa run: the
dispatcher rewrote scope row 4's `${CLAUDE_PLUGIN_ROOT}` reference to
a hard-coded absolute path, conflicting with the coord-authored
handoff's portable form. QA correctly verified against the original
assignment (not the rewritten scope) and still passed 9/9, so this
was non-blocking for PR #4. But it would false-FAIL future QA runs
that don't notice the rewrite.

## Problem Statement

Coord authored a QA handoff with scope row 4 containing a launch
command referencing `${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd` — the
portable form that matches the hooks.json contract and works on any
machine.

The QA session (spawned via `/session-handoff assign qa`, which
under the hood invokes `/ce:work` or a similar skill flow) received
the handoff, but the effective scope the QA agent ran against had
row 4 rewritten to:

```
C:/Users/dunliu/.claude/plugins/cache/.../hooks/run-hook.cmd
```

An absolute path specific to this machine and this plugin install
path. QA caught the mismatch, verified against the original scope
anyway, and included the discrepancy in advisory #1 of its report.

Whatever step is rewriting `${CLAUDE_PLUGIN_ROOT}` is:

1. Assuming the env var is only meaningful at authoring time and
   should be eagerly expanded before the QA agent runs (wrong — the
   QA agent's Claude Code session is itself the consumer of that
   env var).
2. Using whatever local PLUGIN_ROOT the coord session happened to
   have, so the substitution is non-reproducible across machines.

## Findings

- **Not in this repo's scope.** `/ce:work` is part of the
  `compound-engineering` plugin, cached under
  `~/.claude/plugins/cache/compound-engineering-plugin/...`. The
  `session-handoff` skill ships the handoff artifact verbatim;
  whatever downstream tool consumes it and schedules the QA
  dispatcher is the one rewriting.
- **Reproduction requires a second QA dispatch** with a scope row
  containing `${CLAUDE_PLUGIN_ROOT}` (or `${CLAUDE_PROJECT_DIR}`,
  or any other runtime-resolved env var reference). If rewrite
  still occurs, file upstream at the compound-engineering repo.
- **Workaround for future QA handoffs:** write the scope row with
  both forms side by side: `"Use ${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd
  (or the equivalent absolute path on your machine)"`. The prose
  form survives any overly-eager template engine.

## Proposed Solutions

### Option A — Investigate root cause in `/ce:work` skill

Read the skill definition under
`~/.claude/plugins/cache/compound-engineering-plugin/...` and find
the step that does env-var expansion on the handoff body. If
reproducible, file an upstream issue at the compound-engineering
repo.

- **Pros:** Fixes the class of bug, benefits every future QA run.
- **Cons:** Out-of-repo investigation, opaque plugin code. Could
  take a couple of hours to localize.
- **Effort:** Medium.
- **Risk:** Low (read-only investigation).

### Option B — Workaround in session-handoff skill

Update the session-handoff skill to double-encode env var references
in the coord-written portion (e.g. write `$${CLAUDE_PLUGIN_ROOT}`
which unescapes to `${CLAUDE_PLUGIN_ROOT}` after one pass of the
downstream rewriter).

- **Pros:** Defensive fix inside session-handoff, no upstream dep.
- **Cons:** Only works if we know the downstream rewriter uses
  single-pass expansion. Adds brittle coupling to a tool's internals
  we don't own.
- **Effort:** Small code change in session-handoff.
- **Risk:** High — we'd be hard-coding a workaround for undiagnosed
  behavior.

### Option C — Do nothing; rely on QA's cross-verification

Current QA workflow (compare rewritten scope vs. original handoff,
report discrepancies in advisory) is already catching the bug. If
it hasn't bitten a real PASS→FAIL false positive yet, the risk of
deferring is low.

- **Pros:** Zero churn.
- **Cons:** Next QA agent who doesn't cross-verify will false-FAIL.
  Erodes trust in the QA pipeline.
- **Effort:** Zero.
- **Risk:** Low-to-medium.

## Recommended Action

Leave blank for triage.

Preference: **Option A, but deferred**. Not a blocker for Unit 6 or
subsequent units. File for later investigation when the QA-agent
false-FAIL scenario actually bites, or during a general
compound-engineering skill audit.

## Technical Details

- **Affected files (if Option A finds a fix):** Outside this repo,
  in the compound-engineering plugin's `/ce:work` or
  `/ce:dispatch` skill definitions.
- **Affected files (if Option B):**
  `C:\Users\dunliu\projects\claude-skills\skills\session-handoff\SKILL.md`
  (assign-mode rendering logic, if such a hook exists).

## Acceptance Criteria

- [ ] Root-cause investigation status captured (completed /
  deferred / n/a).
- [ ] If a fix lands: next QA dispatch using `${CLAUDE_PLUGIN_ROOT}`
  in a scope row gets the literal var through to the QA agent.
- [ ] If deferred: session-handoff skill's assign-mode docs note
  the workaround (double-reference prose form).

## Work Log

- **2026-04-22 — todo created** — Surfaced by QA advisory #1 in the
  PR #4 session-handoff assign-qa report. Non-blocking for PR #4
  (QA cross-verified against the original scope and passed 9/9),
  but flagged for coord attention so the bug doesn't cause a
  future false-FAIL.

## Resources

- PR #4 QA report: `~/.claude/handoffs/newton20-agent-orchestration/`
  (most recent `*-qa-report.md` prior to 2026-04-22T19:23:29Z)
- `/ce:work` skill definition: under
  `~/.claude/plugins/cache/compound-engineering-plugin/...`
- `session-handoff` skill source:
  `C:\Users\dunliu\projects\claude-skills\skills\session-handoff\`
