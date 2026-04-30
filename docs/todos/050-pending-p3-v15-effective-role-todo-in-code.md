---
status: pending
priority: p3
issue_id: "050"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, v1.5-prep]
dependencies: []
---

# Add a grep-able V1.5 TODO at the `effectiveRole` site

PR #13 ce:review's architecture-strategist noted that the V1
recovery-prompt path collision risk is documented in
`templates/README.md` and todo 010, but is not flagged in the
generate-prompt.js source where the path is composed. When V1.5's
recovery-analyst introduces `recovery` as a distinct role value,
the migration warning needs to be grep-able from the code site
that breaks first.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:701-703`:

```js
const effectiveRole = recovery ? o.recoveryRole : o.role;
```

Today `effectiveRole` is one of `impl | qa | coord` (because
`recoveryRole` is one of those three when `role === 'recovery'`).
The live prompt path is composed at line 781:

```js
const promptPath = path.join(outputDir, `${effectiveRole}-prompt.md`);
```

Per `agent-orchestrator/templates/README.md` §138 (recovery
template authoring) and `docs/todos/010` (V1.5 recovery-analyst
introduction), V1.5 will introduce `recovery` as a distinct role
value — the recovery-analyst dispatch will set
`effectiveRole === 'recovery'`. At that point
`${effectiveRole}-prompt.md` evaluates to `recovery-prompt.md`,
which is also the name of the recovery template file the renderer
reads via `ROLE_TEMPLATES.recovery`. The output path will then
collide with the template name on disk for any future code path
that reads templates from the same directory it writes to (or any
operator who places templates and outputs side-by-side).

The migration warning lives in `templates/README.md` only. A
future maintainer touching `generate-prompt.js` will not see it.

## Findings

PR #13 ce:review architecture-strategist P3:

> "`generate-prompt.js:701-703` — V1 renders recovery dispatches
> with the original role (impl/qa/coord). V1.5's recovery-analyst
> will introduce `recovery` as a distinct role value
> (templates/README.md §138, todo 010). When V1.5 lands,
> `${effectiveRole}-prompt.md` will collide with the recovery
> template name itself. The migration warning lives only in
> templates/README.md — should also be a grep-able TODO in
> generate-prompt.js."

## Proposed Solutions

### Option A — Add a `// TODO(V1.5)` comment at line 703

Insert at line 703:

```js
const effectiveRole = recovery ? o.recoveryRole : o.role;
// TODO(V1.5): when recoveryRole === 'recovery' is supported, the
// file path `${effectiveRole}-prompt.md` will collide with the
// recovery template (recovery-prompt.md). Introduce a separate
// output path (e.g. recovery-analyst-prompt.md) before adding
// 'recovery' to VALID_RECOVERY_ROLES. See templates/README.md §138
// and docs/todos/010.
```

- **Pros:** Grep-able from the code site that breaks first. Future
  maintainer adding `'recovery'` to `VALID_RECOVERY_ROLES` will
  see the warning before the collision lands.
- **Cons:** Code comments accrete. If V1.5 is significantly
  reshaped, the comment goes stale.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Defer

V1.5 is far away; templates/README.md and todo 010 already capture
the constraint.

- **Pros:** Zero churn.
- **Cons:** A maintainer adding `'recovery'` to
  `VALID_RECOVERY_ROLES` (currently `['impl', 'qa', 'coord']` per
  the validation at line 697) without first reading templates/README.md
  introduces the collision silently — the path is composed but
  the role-template file at `templatesDir/recovery-prompt.md`
  also exists, and the write-target collision is unrecoverable
  on case-insensitive filesystems.
- **Effort:** Zero.
- **Risk:** Low until V1.5 lands; medium at that moment.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — single comment at the most-likely
maintenance site, zero behavioral change, makes the V1.5 trap
visible to grep.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Line: 703 (after `const effectiveRole = ...`).
- No behavioral change.
- Optional supplementary anchor: a similar comment near
  `VALID_RECOVERY_ROLES` declaration so the trap is also visible
  from the validation site.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: comment at line 703 mentions both
  `templates/README.md` §138 and `docs/todos/010`.
- [ ] If A: comment is grep-able via `TODO(V1.5)` substring.
- [ ] No behavioral change to V1 dispatches.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:701-703` —
  `effectiveRole` composition.
- `agent-orchestrator/scripts/generate-prompt.js:781` — live
  prompt path composition.
- `agent-orchestrator/templates/README.md` §138 — recovery
  template authoring + V1.5 migration note.
- `docs/todos/010` — V1.5 recovery-analyst introduction (open).
