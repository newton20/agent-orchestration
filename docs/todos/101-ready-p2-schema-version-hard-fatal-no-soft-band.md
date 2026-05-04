---
status: ready
priority: p2
issue_id: "101"
tags: [unit-11, orchestrate, post-pr-19, ce-review, api-contract, schema-version, v15-compat]
dependencies: []
---

# orchestrate: schema_version mismatch is a hard fatal — no soft compat band blocks any V1.5 minor bump

## Problem Statement

> **Scope correction (post-codex round 9):** the original /ce:review brief cited `orchestrate.js:1208-1218` and described this as a manifest `schema_version` issue. Codex round 9 verified that the cited line is actually a guard on the `checkHealth` JSON output schema (todo 075's `schema_version: 1` field added in PR #17 hardening), NOT a top-level manifest field. Current manifests do NOT define a top-level `schema_version` field. So the original concern doesn't map cleanly to current state.

The actionable intent — preserve forward-compat for minor schema bumps when V1.5 introduces them — still matters, but applies to whichever schema gets versioned next. Two cases that the implementer should triage during PR #23:

1. **`checkHealth` JSON output `schema_version`** (today's hard-fatal guard): if/when V1.5 bumps its result schema, the consumer-side guard should soft-compat on minor mismatch. Today the guard reads `schema_version: 1`; a V1.5 bump to `1.1` should warn-not-fail downstream consumers.
2. **Manifest schema_version (does not exist today):** if/when V1.5 introduces a top-level `schema_version` to manifest.yaml, the parse-manifest validator should adopt the same MAJOR / MAJOR.MINOR semver-ish parse + soft-compat semantics from the start. (Otherwise the V1 → V1.5 manifest migration is a hard wall.)

## Findings

- Original /ce:review brief targeted manifest `schema_version` at `orchestrate.js:1208-1218`, but that cite is the `checkHealth` JSON-output schema guard (todo 075). Manifests do not have a `schema_version` field today.
- Actionable concern remains: any future V1.5 schema bump (output OR manifest) should land with soft-compat semantics from the start.
- /ce:review reviewer attribution: api-contract.

## Proposed Solutions

### Option A — Apply MAJOR / MAJOR.MINOR soft-band semantics to existing checkHealth output guard, defer manifest concern to V1.5 (recommended)
- For the existing `checkHealth` JSON output `schema_version` guard at `orchestrate.js:1208-1218`: parse as semver-ish (`MAJOR` or `MAJOR.MINOR`). Major-mismatch hard fails. Minor mismatch (newer than consumer's known) warns + proceeds. Document the soft-band in `--help` and in a code comment at the guard site.
- For manifest `schema_version`: this field does not exist today. Capture as a V1.5 design note rather than a code change in PR #23 — when V1.5 introduces the field, it should ship with the same soft-band semantics from the start.
- Pros: closes the actionable gap on the existing guard; defers the manifest concern to where it actually arises (V1.5 design). Effort: small for the checkHealth guard. Risk: low.

### Option B — Strict version match (current behavior)
- Document as deliberate. Cons: every future minor bump breaks all consumers/manifests. Defers the inevitable.

### Option C — Pre-emptively add manifest schema_version with soft-band semantics
- Introduce the field in V1, default to `schema_version: 1`. Manifest validator parses it, soft-band on minor mismatch.
- Pros: V1.5 manifest migration is seamless. Cons: adds a field that has no use in V1; operator confusion ("why do I need to add this?"). Effort: medium.

## Recommended Action

**Option A — approved 2026-05-04 by coord; revised post-codex round 9 to correct the scope.** The original /ce:review brief mis-targeted manifest schema_version; the actual cite at `orchestrate.js:1208-1218` is the checkHealth JSON-output schema guard. Apply MAJOR / MAJOR.MINOR soft-band semantics to that guard. The manifest schema_version concern (B from coord's first pass) is a V1.5 design note, not a V1 code change — capture it in a separate V1.5-track todo if not already covered. Bundle the checkHealth-guard fix in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1208-1218`

## Acceptance Criteria

- [ ] **Scope: the checkHealth JSON-output `schema_version` guard at `orchestrate.js:1208-1218`** (NOT a manifest field, which does not exist today).
- [ ] `schema_version: 1` accepted (V1 baseline) — backward-compatible behavior preserved.
- [ ] `schema_version: 1.1` accepted with warning ("checkHealth output declares schema 1.1; consumer targets 1 — proceeding under soft-compat band").
- [ ] `schema_version: 2` rejected as hard major mismatch with structured error.
- [ ] Malformed values (`"1.0.x"`, `"abc"`, `null`, missing field) rejected as structured config errors per the `MAJOR | MAJOR.MINOR` format. (No lenient parse.)
- [ ] Soft-band documented in `--help` text and in a code comment at the guard site.
- [ ] Manifest `schema_version` field is OUT OF SCOPE for this todo — captured as a V1.5 design note (separate todo if needed).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
