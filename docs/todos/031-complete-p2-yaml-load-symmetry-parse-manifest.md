---
status: complete
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
launcher load. Reasons to align:

1. **Comment symmetry / honesty.** `spawn-session.js:268-269` says
   "like the call in parse-manifest.js it preserves merge keys" —
   strictly, parse-manifest.js relies on the library default rather
   than an explicit pin. A 1-line `{ schema: yaml.DEFAULT_SCHEMA }`
   addition at both sites would make the comment literally true.
2. **Document intent.** Explicit pin tells the next reader "we chose
   the default deliberately" rather than "we never thought about
   schema choice."

**Caveat — the pin is NOT a downgrade defense.** A previous draft of
this todo claimed pinning to `DEFAULT_SCHEMA` defends against a
hypothetical `js-yaml@3.x` downgrade. That claim is wrong: in v3,
`DEFAULT_SCHEMA` is the FULL/unsafe schema (including `!!js/function`);
the safe v3 alias was `DEFAULT_SAFE_SCHEMA`. v4 dropped `!!js/function`
entirely so v4's `DEFAULT_SCHEMA` is safe by construction. The actual
downgrade defense is the `^4.1.0` pin in `package.json` — code-level
schema names alone do not survive a downgrade. Anyone implementing
this todo should NOT add downgrade-defense language to the source
comments; the pin's value is symmetry + intent, not safety.

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

- **Pros:** Symmetric with `spawn-session.js:272`. Makes the existing
  comment literally true. Documents intent at the call site.
- **Cons:** None — identical behavior at the pinned version. (Not a
  downgrade defense; see Caveat above.)
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

**Option C — approved 2026-04-28 by coord.** Pin both
`parse-manifest.js` `yaml.load` sites to `DEFAULT_SCHEMA` AND update
the symmetry comment in `spawn-session.js`:

1. **`parse-manifest.js:161` (`loadManifest`)** — change
   `yaml.load(raw)` to
   `yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA })`.
2. **`parse-manifest.js:722` (`runUpdate`)** — same.
3. **`spawn-session.js:268-269` symmetry comment** — update to
   reflect the now-true claim that all three sites are explicitly
   pinned. Use parity / intent / merge-keys framing only — do NOT
   add downgrade-defense language to the comment (see the Caveat in
   the Problem Statement; `DEFAULT_SCHEMA` is not a downgrade defense
   and the source comment must not claim it is). Something like:
   "Pinned to DEFAULT_SCHEMA for parity with the calls in
   parse-manifest.js — preserves merge keys (`<<`) and timestamps;
   making the choice explicit at every site documents intent."

Closes QA Advisory A1 from PR #9 by making all three call sites
match. The pin's value is symmetry + intent, not downgrade defense
(library-version pinning in `package.json` is what defends against a
v3 downgrade, not the schema name).

Option A alone (pin without comment update) leaves the symmetry
comment in spawn-session.js still claiming a parallel that doesn't
exist on the other side. Option B alone (drop the symmetry claim)
walks back the explicit-pin breadcrumb at the launcher site for no
gain. Option C closes both sides.

Dispatch as part of the pre-Unit-7 round 3 PR bundle along with
todos 027, 028, 029, 030. ~3-4 LOC across 2 files.

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
- **2026-04-28 — merged via PR #11** (`feat(templates): pre-Unit-7
  fixes round 3`). Option C implemented: pinned both
  `parse-manifest.js` `yaml.load` sites (`loadManifest:165`,
  `runUpdate:730`) to `{ schema: yaml.DEFAULT_SCHEMA }`; rewrote
  `spawn-session.js:284-287` symmetry comment to parity / intent /
  merge-keys framing only. **Caveat compliance verified:** the
  source comment does NOT contain downgrade-defense language —
  PR #11's pattern + simplicity reviewers explicitly checked, and
  the prior "future js-yaml downgrade can't silently reintroduce
  custom-tag execution via a permissive default" framing has been
  fully removed. PR #11 ce:review surfaced one P3 follow-up
  (`docs/todos/036` — minor "Pin"/"Pinned" voice mismatch + the
  three near-duplicate comments are acceptable for context-locality
  but cosmetic-only; deferred per V1-freeze).

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- QA report:
  `~/.claude/handoffs/newton20-agent-orchestration/20260428-053533-qa-report.md`
  (Row 8 + Advisories section)
- Todo 004 (closed) for the launcher schema pin context:
  `docs/todos/004-complete-p3-security-hardening-launcher-and-yaml-load.md`
