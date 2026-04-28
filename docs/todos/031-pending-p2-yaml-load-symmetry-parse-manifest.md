---
status: pending
priority: p2
issue_id: "031"
tags: [code-review, post-pr-9, qa-advisory, security, scripts, yaml]
dependencies: []
---

# parse-manifest.js yaml.load calls are unpinned (QA Advisory A1)

PR #9 explicitly pinned `yaml.load` to `DEFAULT_SCHEMA` in
`spawn-session.js:272` (the launcher manifest path). The schema-pin's
own comment at L268-269 claims it is "like the call in parse-manifest.js"
— but `parse-manifest.js` has two `yaml.load` calls that are NOT
explicitly pinned. The QA report's Advisory A1 surfaces this; carrying
forward as a follow-up.

## Problem Statement

Two `yaml.load` call sites in `parse-manifest.js` rely on the library
default rather than an explicit schema pin:

- `parse-manifest.js:161` — `loadManifest()` reads the user's manifest YAML
- `parse-manifest.js:722` — `runUpdate()` reads the manifest-status.yaml

`js-yaml@^4.1.0` (the pinned version) defaults to `DEFAULT_SCHEMA` for
`load()`, so behavior today is identical to the explicitly-pinned
launcher load. Two reasons to align:

1. **Defense against library downgrade.** A future `js-yaml@3.x`
   downgrade or a custom-schema injection would silently change
   behavior. Explicit pinning is what makes the launcher load future-
   proof per its own comment.
2. **Comment symmetry.** `spawn-session.js:268-269` says "like the call
   in parse-manifest.js it preserves merge keys" — strictly,
   parse-manifest.js relies on the library default rather than an
   explicit pin. A 1-character `{ schema: yaml.DEFAULT_SCHEMA }`
   addition at both sites would make the comment literally true.

## Findings

QA Row 8 advisory A1 from
`~/.claude/handoffs/newton20-agent-orchestration/20260428-053533-qa-report.md`:

> **A1.** Non-launcher `yaml.load` calls in `parse-manifest.js` are
> schema-unpinned (non-blocking). Out of PR #9's dispatched scope,
> so not a FAIL. Logging for the post-Unit-7 doc cleanup PR.

Confirmed by the security-sentinel ce:review agent on PR #9: the call
sites read paths that are operator-controlled (CLI args, derived from
manifestPath via path.resolve), so this is a defense-in-depth issue, not
a current-day vulnerability.

## Proposed Solutions

### Option A — Pin both sites to DEFAULT_SCHEMA

Mirror the launcher load:

```js
const parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
```

at both `parse-manifest.js:161` and `:722`.

- **Pros:** Symmetric with `spawn-session.js:272`. Defense-in-depth
  against library downgrade. Makes the existing comment literally true.
- **Cons:** None — identical behavior at the pinned version.
- **Effort:** Trivial (2 LOC).
- **Risk:** None.

### Option B — Drop the symmetry claim from spawn-session.js:268-269

Edit the schema-pin's comment to remove "like the call in
parse-manifest.js" and stand alone on its own merits.

- **Pros:** Smallest edit; honest about the asymmetry.
- **Cons:** Misses the defense-in-depth opportunity. Symmetric
  pinning is genuinely cheap.
- **Effort:** Trivial.
- **Risk:** None.

### Option C — Do both A and B then update the comment to reflect "now all three sites are pinned"

- **Pros:** Most thorough.
- **Cons:** Slight churn.
- **Effort:** Small.
- **Risk:** None.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected file: `agent-orchestrator/scripts/parse-manifest.js` (two
  `yaml.load` call sites)
- Optional: `agent-orchestrator/scripts/spawn-session.js:268-269`
  (comment update)
- No test changes (existing tests don't exercise exotic YAML tags).

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A or C: both `parse-manifest.js` call sites pin
  `yaml.DEFAULT_SCHEMA` explicitly.
- [ ] If B or C: spawn-session.js comment matches reality.
- [ ] Combined repo suite remains green.

## Work Log

- **2026-04-28 — todo created** — From QA Advisory A1 on PR #9.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- QA report:
  `~/.claude/handoffs/newton20-agent-orchestration/20260428-053533-qa-report.md`
  (Row 8 + Advisories section)
- Todo 004 (closed) for the launcher schema pin context:
  `docs/todos/004-complete-p3-security-hardening-launcher-and-yaml-load.md`
