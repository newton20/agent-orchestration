---
status: ready
priority: p2
issue_id: "001"
tags: [code-review, unit-4, spawn-session, windows, cmd, wmi]
dependencies: []
---

# spawn-session: escape `%` under cmd + allow quoted `--name` in PID regex

Two edge-case correctness gaps raised by codex review round 14 of
PR #3 that were NOT fixed before merge because they are triple-
conditional on surfaces the orchestrator's normal path cannot
produce. Both are real for CLI callers or for future launcher shapes.

## Problem Statement

**Gap 1 — `%VAR%` expansion under cmd launcher.** `cmd.exe` eagerly
expands `%VAR%`-shaped tokens at parse time, EVEN INSIDE double
quotes. Our `quoteCmd()` / `quoteCmdAlways()` double-quote values
but do not escape `%`. If a caller (or a future manifest field)
supplies a value containing `%EXISTING_VAR%`, cmd substitutes the
env var's value before the inner program sees it. Example:

```
spawn-session.js --name "orch-%USERNAME%" --workdir ...
```

Under the default (cmd) launcher, the spawned claude process sees
`--name orch-dunliu` (or whichever username). PID lookup then
fails (the orchestrator thinks the session name is
`orch-%USERNAME%`; WMI sees `orch-dunliu`) and any prompt-routing
keyed on name goes to the wrong session.

Realistic trigger surfaces:
- Phase-ids are validated by `parse-manifest.js`'s `VALID_ID_RE`
  (`/^[A-Za-z0-9._-]+$/`) → session names CANNOT contain `%`. Safe.
- `model`, `pluginDir`, `title`, `workdir` are NOT validated against
  `%`. A manifest with `pluginDir:
  C:\Users\%USERNAME%\.claude-plugins` would hit this.
- Custom `launcher.binary`, `launcher.auto_mode_flag`,
  `launcher.passthrough_flags` are pass-through — unprotected.

Not a threat-model concern (launcher is trusted config), but a
silent-wrong-behavior concern for manifests that reference Windows
env-var paths.

**Gap 2 — `parsePidLookupOutput` regex rejects quoted `--name`
values.** Our boundary regex:

```
(?:^|\s)--name\s+${escapeRegex(name)}(?=\s|$|['"])
```

correctly matches trailing quote (`codex P2 round 12` fix). But the
LEADING context is `(?:^|\s)` — whitespace or start-of-line.
If the CommandLine contains `--name "orch-some name"` (space in
name, quoted), the regex looks for `--name orch-some` unquoted and
misses the row entirely. Triggering CLI scenario:

```
spawn-session.js --name "orch phase 0" ...
```

The spawn works (Node argv-escapes correctly), but
`getSessionPid("orch phase 0")` always returns null because WMI
reports `--name "orch phase 0"` and the regex only matches bare
`--name orch`.

Realistic trigger surfaces:
- Phase-ids validated (no spaces allowed) → orchestrator-spawned
  sessions never have spaced names. Safe in normal flow.
- Direct CLI invocation with `--name "<value with spaces>"` → bug
  manifests.

Not blocking anything downstream (PID lookup is best-effort and
Unit 11 hasn't landed), but worth fixing for CLI correctness.

## Findings

- **Gap 1 codex quote (round 14):** "In `cmd.exe`, `%...%` expands
  even inside double quotes, so inputs like `--name
  "orch-%USERNAME%"` or a plugin directory under a path containing
  `%` are rewritten before Claude starts…"
- **Gap 2 codex quote (round 14):** "`parsePidLookupOutput()` only
  matches the unquoted form `--name <value>`… WMI reports `--name
  "orch phase 0"` / `--name 'orch phase 0'` and the current regex
  does not allow the opening quote."
- **Why deferred:** PR #3 already landed after 13 codex rounds + QA
  PASS on all 4 scenarios. The normal orchestrator-spawned path
  cannot produce either trigger. Both are CLI-power-user /
  unusual-manifest edge cases with small blast radius.

## Proposed Solutions

### Option A — Fix both inline in `spawn-session.js`

Gap 1: Modify `quoteCmd()` / `quoteCmdAlways()` to escape `%` as
`%%` (for batch-file contexts) or reject values containing `%`
under cmd launcher with a clear error. Preferred: reject with
error because `%%` only works inside batch files, not on the cmd
command line — the clean CLI alternative is `^%`, but `^%` inside
double quotes is NOT an escape either. There is no reliable cmd
command-line escape for `%`; the only fix is to avoid `%` under
cmd or to route through PowerShell.

Gap 2: Extend the regex prefix-boundary:

```js
const re = new RegExp(
  `(?:^|\\s)--name\\s+(?:['"])?${escapeRegex(name)}(?=\\s|$|['"])`
);
```

Add an optional opening quote before the name. Combined with the
existing trailing-quote boundary, this covers bare, single-quoted,
and double-quoted forms.

- **Pros:** Closes both gaps cleanly.
- **Cons:** Gap 1 fix is effectively "reject or route through PS,"
  which may break manifests that currently "work" by accident.
- **Effort:** Small (4-6 lines + tests).
- **Risk:** Low for Gap 2. Medium for Gap 1 — the reject/route
  policy needs to be decided.

### Option B — Document-only

Add to `spawn-session.js` docstring: "Under the cmd launcher,
values containing `%NAME%`-shaped tokens will be expanded by cmd
as env var lookups. Use the PowerShell launcher or avoid `%` in
values. Session names constructed from validated phase-ids do not
exhibit this."

- **Pros:** Zero code churn. Accurate for the orchestrator path.
- **Cons:** Foot-gun for direct CLI users. Gap 2 (quoted-name PID
  lookup) remains broken.
- **Effort:** Trivial.
- **Risk:** Low.

### Option C — Fix only Gap 2; document Gap 1

Gap 2 is a clean regex extension with no policy question. Gap 1
requires deciding "reject vs route" — defer that to when a real
manifest hits it.

- **Pros:** Ships the quick win immediately.
- **Cons:** Partial fix.
- **Effort:** Small.
- **Risk:** Low.

## Recommended Action

**Option C — approved 2026-04-20.** Ship Gap 2 (regex extension
allowing optional opening quote before the name) as part of the
post-Unit-5 follow-up PR bundle. Add 2-3 tests covering bare,
double-quoted, and single-quoted forms. Gap 1 is deferred to Unit 11
so the reject-vs-route-vs-escape policy can be decided against a real
manifest surface.

Dispatch as part of the "cleanup PR" handoff after Unit 5 merges. Do
not dispatch solo — bundle with todos #002 and #004 to reduce PR
overhead.

## Technical Details

- Affected file: `agent-orchestrator/scripts/spawn-session.js`
- Gap 2 lines: 534-536 (regex construction in
  `parsePidLookupOutput`)
- Gap 1 lines: 89-132 (all cmd-side quoters)
- Test file to extend: `agent-orchestrator/scripts/spawn-session.test.js`

## Acceptance Criteria

**Gap 2 (if taking Option A or C):**
- [ ] `parsePidLookupOutput` matches rows where the CommandLine
  contains `--name "orch phase 0"` (double-quoted) and returns the
  correct PID.
- [ ] Same for single-quoted form `--name 'orch phase 0'`.
- [ ] Bare-name matching (current behavior) unchanged.
- [ ] Suffix-collision rejection (`orch-phase-1-impl` vs
  `orch-phase-1-impl-review`) still holds for quoted names.
- [ ] Test count grows by 2-3; no pre-existing tests regress.

**Gap 1 (if taking Option A only):**
- [ ] Decide reject-vs-route-vs-escape policy.
- [ ] Manifest with `pluginDir: C:\Users\%USERNAME%\...` under cmd
  launcher either errors cleanly or is routed through PowerShell
  transparently.
- [ ] Document the decision in `docs/manifest-reference.md`.

## Work Log

_(empty)_

## Resources

- Triggering PR: https://github.com/newton20/agent-orchestration/pull/3
- Codex round 14 review comment (post-merge): captured in
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
  under "Findings" if needed.
- Related compound doc:
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
  finding #A (cmd.exe argv interpretation).
