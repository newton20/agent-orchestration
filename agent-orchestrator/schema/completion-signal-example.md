---
schema_version: 1
agent: impl
phase: phase-0-scaffold
status: complete
ended_at: 2026-04-17T04:12:13Z
git_commit: a7f3c92
dispatcher_advisories: 0
---

# Phase phase-0-scaffold — impl complete

## V2 attempt-bound reports

The frontmatter at the top of this file is the V1 example. V2 workers use
the exact paths and identity supplied by their generated prompt, under
`docs\orchestration\runs\<run_id>\phases\<phase_id>\<role>\<review_iteration>\<attempt_id>\`.
The manifest's conventional completion path is not V2 authority.

Example `completion.json`:

```json
{
  "schema_version": 2,
  "run_id": "run-example",
  "phase_id": "phase-0-scaffold",
  "role": "impl",
  "review_iteration": 0,
  "attempt_id": "attempt-example",
  "kind": "completion",
  "observed_at": "2026-09-17T12:00:00Z",
  "status": "complete"
}
```

YAML frontmatter with these same fields is also accepted. Include the
narrative sections below when reporting implementation details. Every
heartbeat, checkpoint, verdict and cooperative release repeats the full
identity tuple with its own `kind` and `observed_at`. V2 heartbeats are
atomically replaced JSON objects, not an appended shared JSONL stream.
Reads are bounded to 256 KiB and reject identity mismatches.
Malformed, partially written, oversized or invalid reports put only their
attempt in `needs_operator`; they cannot authorize success or automatic
retry. Correct invalid reports at their assigned paths to reconcile again.
Filesystem I/O failures remain explicit infrastructure errors. Heartbeats
and checkpoints retain only their latest accepted provenance; they do not
consume immutable terminal completion/verdict/release history.

QA completion also needs `verdict.json`, with `kind: verdict`,
`verdict: pass|fail`, and `verification: [{ id, status, evidence }]`.
Rows `scope`, `P1`, `P2`, `P3`, `P4`, and `P6` are mandatory. A pass
requires one passing entry with evidence for each row; a role label or
an operator/approval field cannot waive required verification.
Null and non-object verification rows are invalid. A `partial` or `blocked`
QA completion without a valid fail verdict requires intervention, even
after the engine exits or the controller restarts. A valid, fully evidenced
fail verdict still enters the bounded review loop after safe release.
A `complete` QA report without required verification cannot pass.

Completion does not release a writable checkout. To release cooperatively,
write `release.json` with the same identity, `kind: release`,
`released: true`, and `no_further_writes: true`, after all mutating
descendants have stopped or relinquished writes. Perform no further
project writes without a new assignment. The terminal may remain open
for inspection. The controller otherwise retains the reservation until
engine and descendant closure is established.

## V1 example

> **This file is the canonical example of the completion signal format
> a spawned agent must write at the path specified by `phase.completion_signal`
> in the manifest. The orchestrator polls for this file every 30s–2min
> (configurable); when it appears, the phase is treated as done and the
> next phase is scheduled. The structured body is read verbatim into
> the next phase's prompt so design decisions and invariants carry
> forward. This format was promoted from "freeform handoff notes" to a
> structured schema after Unit 0 validation showed agents spontaneously
> used freeform notes as a coordination channel — see the plan's "Unit 0
> Validation Findings" section, finding #4.**

## Summary

Scaffolded the monorepo with `apps/`, `packages/`, and `tools/` top-level
directories. Added the workspace `package.json` with Turborepo, a root
`tsconfig.json` with path aliases, and a shared ESLint config in
`packages/eslint-config/`. All three directories are empty of code — they
exist so phase-1 can drop app/package/tool folders into the right place
without reshaping the tree.

## Files modified

- `package.json` — root workspace config, pins Turborepo 2.x and sets the `workspaces: ["apps/*", "packages/*"]` glob.
- `tsconfig.json` — root config with `@app/*` and `@pkg/*` path aliases.
- `turbo.json` — pipeline definitions for `build`, `lint`, `test`, `dev`.
- `packages/eslint-config/index.js` — shared ESLint base config, exported as `@repo/eslint-config`.
- `packages/eslint-config/package.json` — the package wrapper for the above.
- `.gitignore` — added `node_modules/`, `.turbo/`, `dist/`, `.env`.

## Files deliberately NOT modified

- `apps/` — empty directory; phase-1 (auth) and phase-2 (billing) each drop in their own app.
- `packages/shared/` — out of scope for phase-0. Phase-2b will create the shared billing models package here.

## Design calls the next phase should know about

- **Path alias convention:** `@app/<app-name>/*` resolves to `apps/<app-name>/src/*`. `@pkg/<pkg-name>/*` resolves to `packages/<pkg-name>/src/*`. Phase-1 and phase-2 agents should respect this; do not add alternate aliases without coordinating.
- **Turborepo pipeline:** `build` depends on `^build`, so every package must declare a `build` script in its `package.json` even if it is a stub. Phase-1 will add the app; do not forget its build script.
- **ESLint base:** `@repo/eslint-config` exports a flat-config array. Apps extend it as `{ extends: ['@repo/eslint-config'] }`. If the app needs Next.js rules specifically, add them locally — do not modify the shared base.
- **No Prettier config yet.** Deferred to a future phase to avoid conflicting with ESLint-driven formatting decisions.

## Decisions

- Picked Turborepo 2.x over Nx for the monorepo orchestration — chose Turborepo because the project already uses pnpm and Turborepo's caching ergonomics fit better than Nx's heavier graph model for a 2-app starter. Reversible if Nx-only features become load-bearing later.
- None of the deferred items above (Prettier, shared billing models package) were considered blocking for phase-0 — they are explicit phase-2/future scope.

<!--
Empty-state form for `## Decisions` and `## Blockers / open questions`:
when the section has no items, render it as a single `- none` bullet
— lowercase, no quotes, no trailing punctuation. The Blockers section
below shows that empty-state form; the Decisions section above shows
the populated form. See protocol-header.md L82-89, L100-110.
-->

## Blockers / open questions

- none

## Verification performed

- [x] `pnpm install` at the root succeeds with the generated workspace glob.
- [x] `pnpm turbo run build` runs (no-op, no packages yet) without errors.
- [x] `tsc --noEmit` accepts the root tsconfig.
- [x] `eslint --print-config packages/eslint-config/index.js` resolves without error.
- [x] All modified files staged and committed as `a7f3c92 feat(phase-0): scaffold monorepo`.
