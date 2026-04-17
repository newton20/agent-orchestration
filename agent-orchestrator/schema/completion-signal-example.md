---
schema_version: 1
agent: impl
phase: phase-0-scaffold
status: complete
timestamp: 2026-04-17T04:12:13Z
git_commit: a7f3c92
---

# Phase phase-0-scaffold — impl complete

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

## Blockers / open questions

- None.

## Verification performed

- [x] `pnpm install` at the root succeeds with the generated workspace glob.
- [x] `pnpm turbo run build` runs (no-op, no packages yet) without errors.
- [x] `tsc --noEmit` accepts the root tsconfig.
- [x] `eslint --print-config packages/eslint-config/index.js` resolves without error.
- [x] All modified files staged and committed as `a7f3c92 feat(phase-0): scaffold monorepo`.
