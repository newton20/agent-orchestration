---
status: ready
priority: p3
issue_id: "004"
tags: [code-review, security, unit-4, spawn-session, launcher, yaml]
dependencies: []
---

# spawn-session: security hardening for launcher trust boundary + yaml.load

The security review of PR #3 found no P1 injection vectors — the
`execFileSync` + argv design correctly neutralizes the primary
attack surfaces. Three low-severity hardening opportunities remain
for defense-in-depth.

## Problem Statement

1. **Launcher fields are unsanitized pass-through.** `binary`,
   `auto_mode_flag`, `shell_args`, and `passthrough_flags` reach
   the inner shell verbatim. A manifest with
   `auto_mode_flag: "--flag & calc.exe"` would execute `calc.exe`.
   This is BY DESIGN per the threat model (launcher = trusted
   config surface), but:
   - `validateLauncher` currently checks only types, not content.
   - An accidentally misquoted manifest (much more likely than a
     deliberately malicious one) can silently produce broken-or-
     worse commands.
   - The module's doc header does not explicitly state "launcher
     values are trusted and flow through to the shell verbatim."

2. **`yaml.load()` uses the default schema.** `loadLauncherFromManifest`
   (`spawn-session.js:271`) calls `yaml.load(raw)` without a
   schema. js-yaml v4+'s default is `CORE_SCHEMA` (safe — no
   `!!js/function` or similar), but this is version-dependent. If
   `js-yaml` is ever downgraded / replaced, the permissive
   `DEFAULT_SAFE_SCHEMA` could reintroduce custom-tag execution.

3. **`windowTarget` is concatenated without validation.** Defaults
   to `'0'`, but any caller-supplied string is passed as the
   argument to `wt -w`. The argv-form design means `wt.exe` would
   reject an injection attempt, but defense-in-depth would add a
   `/^[0-9]+$|^new$|^last$/` guard.

## Findings (from security-sentinel)

- **F1 [Medium, design decision].** Launcher fields unsanitized.
- **F2 [Low].** `windowTarget` needs a format guard.
- **F3 [Low].** `yaml.load` should use explicit `CORE_SCHEMA` or
  `FAILSAFE_SCHEMA`.
- **F4 [Informational].** Regex-based boundary check is correct.
  `escapeRegex` properly neutralizes user-controlled name content.
- **F5 [Low].** `quoteBinary` regex split is greedy — could mis-
  split pathological binary strings. Not an injection; produces
  broken commands.
- **F6 [Informational].** No length limits on interpolated values.
  `CreateProcess` caps at 32767 chars; pathological manifests
  could hit that.

## Proposed Solutions

### Option A — Address F1, F2, F3 with small fixes

1. `validateLauncher`: add shell-metacharacter rejection for
   `auto_mode_flag` and `shell_args`. Reject `&`, `|`, `;`, `\n`,
   `\r`, backtick, `$(`.
2. `buildSpawnCommand`: add `windowTarget` format guard; throw if
   not `/^[0-9]+$|^new$|^last$/`.
3. `loadLauncherFromManifest`: pass
   `yaml.load(raw, { schema: yaml.CORE_SCHEMA })` explicitly.

Also update module header comment to document: "Launcher values
(`binary`, `shell_args`, `auto_mode_flag`, `passthrough_flags`)
reach the shell verbatim. Treat the launcher block as a trusted
config surface."

- **Pros:** Cheap defense-in-depth; matches the security
  reviewer's prioritized recommendations.
- **Cons:** F1's metacharacter rejection might break an obscure
  legitimate config (e.g. `passthrough_flags: ["--flag=a&b"]`).
  Needs a quick compatibility test.
- **Effort:** Small. Each fix is 3-5 lines + tests.
- **Risk:** Low for F2/F3. F1 needs a policy call on
  over-rejection vs security.

### Option B — Document trust boundary only

Add the module-header comment from Option A, but skip the validator
and guard changes. Keep `yaml.load(raw)` as-is.

- **Pros:** Zero code churn. Accurate documentation for the
  current design.
- **Cons:** Defense-in-depth not improved. The accidentally-
  misquoted-manifest case stays a foot-gun.
- **Effort:** Trivial.
- **Risk:** Low.

### Option C — Do nothing

The security review found no P1/critical issues. The design's
primary defenses (argv-form spawn, phase-id validation upstream)
are sound.

- **Pros:** Zero churn.
- **Cons:** Leaves the documented foot-guns in place.
- **Effort:** Zero.
- **Risk:** Low. None of the issues are exploitable; worst case
  is accidental breakage from a misquoted manifest.

## Recommended Action

**Option B + pull forward F3 — approved 2026-04-20.** Ship in the
cleanup PR bundle with todos #001 and #002. Three changes:

1. **Module-header doc in `spawn-session.js`.** Explicitly name the
   launcher fields (`binary`, `shell_args`, `auto_mode_flag`,
   `passthrough_flags`) as trusted pass-through. No validator change.
2. **F3 yaml schema pin.** Change `loadLauncherFromManifest`'s
   `yaml.load(raw)` to `yaml.load(raw, { schema: yaml.CORE_SCHEMA })`.
   One line, zero compatibility risk at our pinned js-yaml version,
   prevents a future downgrade from silently reintroducing
   `!!js/function` execution.
3. **No other changes.** F1 (shell-metacharacter rejection) and F2
   (`windowTarget` format guard) are deferred to Unit 11 where the
   real launcher-handling policy is finalized.

Dispatch as part of the "cleanup PR" handoff after Unit 5 merges.

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/spawn-session.js` (module header,
    `buildSpawnCommand` for F2, `loadLauncherFromManifest` for F3)
  - `agent-orchestrator/scripts/parse-manifest.js` (`validateLauncher`
    for F1)
- Tests: `agent-orchestrator/scripts/spawn-session.test.js`,
  `agent-orchestrator/scripts/parse-manifest.test.js`

## Acceptance Criteria

**Option B (doc only):**
- [ ] Module header in `spawn-session.js` explicitly documents
  launcher trust boundary.

**Option A (doc + fixes):** above, plus:
- [ ] `validateLauncher` rejects `auto_mode_flag` / `shell_args` /
  `passthrough_flags` containing shell metacharacters (`&`, `|`,
  `;`, `\n`, `\r`, `` ` ``, `$(`).
- [ ] `buildSpawnCommand` throws for `windowTarget` not matching
  `/^[0-9]+$|^new$|^last$/`.
- [ ] `loadLauncherFromManifest` uses `yaml.CORE_SCHEMA`
  explicitly.
- [ ] Tests for each rejection; compatibility tests confirming no
  pre-existing legitimate configs break.
- [ ] 127 tests + new tests pass.

## Work Log

_(empty)_

## Resources

- Triggering PR: https://github.com/newton20/agent-orchestration/pull/3
- Security review output: `/ce:review` session on 2026-04-20.
- Related compound doc:
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
