# agent-orchestrator

A Claude Code plugin (in active development) for multi-phase, multi-session
builds. You write a YAML manifest describing phases and agent roles, and
the V1 orchestrator spawns visible Claude Code sessions in Windows Terminal
tabs, polls a file-drop protocol for completion signals, and advances
phases. V1 includes review loops, crash recovery, and prompt injection;
email notifications remain deferred.

**Current shipped scope:** V1 feature-complete (Units 0-8 + Unit 11). The
`/orchestrate` skill validates a manifest, scaffolds the protocol, and
starts the Node.js orchestrator process — which spawns sessions,
injects prompts via the SessionStart hook, runs review loops, and
recovers from crashes. The orchestrator runs zero Claude context. See
the status table below for unit-by-unit detail.

## V2 offline delivery

V2 has durable state/ownership, fixture-backed attempt lifecycles, event
projection, and read-only progress snapshots. Offline helpers prepare
attempt-bound engine candidates and a relocatable plugin package.
**Production V2 dispatch remains disabled.** Packaging, capability probes,
and hook receipts do not establish live engine support.

The candidate adapters distinguish direct Claude, Agency/Claude, and
Agency/Copilot. They require native Windows `.exe` installations on PATH,
Node.js >=20, and explicit supported engine/model/permission mappings.
An earlier shell shim on PATH is rejected rather than silently skipped.
Read-only enforcement and descendant tracking are not proven by these
offline adapters. Native process/session correlation, immutable per-run
executable/preflight binding, runtime integration, and separately authorized
live acceptance remain required before U3 is complete.

### Build the offline package

Run from `agent-orchestrator\scripts`, using a new absolute output directory
outside the checkout whose parent already exists:

```powershell
npm run package:plugin -- --output C:\artifacts\agent-orchestrator
```

The command builds a directory containing the plugin components, the three
dashboard assets, and locked runtime dependencies, then writes
`package-inventory.json` with sorted SHA-256 file hashes. It runs
`npm ci --omit=dev --ignore-scripts --no-audit
--no-fund` inside the staging directory and refuses to replace an existing
output. Node itself is not bundled. The packager excludes test/fixture
paths, hidden entries, and named secret/credential paths; never place
secrets inside runtime source files.

Agency loading does not run this build or install npm dependencies on the
package's behalf. A successful build establishes filesystem/runtime
packaging only, not installed-engine plugin discovery.
The source-checkout test entrypoints include offline adapter/channel/package
and Copilot-hook tests. The scripts suite also runs the dashboard frontend
tests; frontend test files are excluded from the package.
The twelve live-acceptance cases remain explicit
skips with unimplemented procedures; removing a skip cannot turn them into
a passing acceptance result.

See `docs\manifest-reference.md` for V1/V2 configuration boundaries and
`docs\runtime-state-reference.md` for canonical state and observation
contracts. A live run requires a dedicated disposable checkout and separate
authorization; do not enable production through the fixture adapter.

### Read-only dashboard

The loopback companion exposes authenticated snapshots, events, and bounded
artifact reads independently of the controller. It never schedules workers,
projects the outbox, or changes canonical state. Open its reported URL for
the bundled progress dashboard. Missing assets return `503 UI_UNAVAILABLE`;
rebuild an incomplete package rather than substituting a placeholder.

From `agent-orchestrator\scripts`, replace the example manifest path with
the run you want to inspect:

```powershell
node .\dashboard-server.js start C:\projects\example\manifest.yaml
node .\dashboard-server.js status C:\projects\example\manifest.yaml
node .\dashboard-server.js access C:\projects\example\manifest.yaml
node .\dashboard-server.js stop C:\projects\example\manifest.yaml
```

`start` detaches the companion and waits for readiness. `serve` runs it in
the foreground. Repeated starts discover the same service for that manifest;
another manifest in the same workspace is a conflict. The package's
`dashboard-server` bin points to the same entrypoint.

Only run `access` in your own interactive terminal. It displays a one-use
code valid for 60 seconds; machine output provides instructions, not a code.
Browser sessions last 15 minutes and expire on service restart. Codes and
cookies belong in neither URLs nor logs. Enter the code in the local page's
access form.

The page shows intervention and freshness first, then phases, selected-attempt
evidence, and a bounded timeline. Follow the current run or pin a historical
run for inspection. Worker reports and QA evidence remain distinct from
independent verification. Artifact text is untrusted, even when its hash
matches accepted evidence. The page has no workflow mutation controls.

For recovery when the manifest or status is unavailable, `status`, `stop`,
and `access` accept `--workspace` with the original Git workspace directory.
`stop` may also take an exact service ID after the manifest path. It stops
only that companion, not the controller or its workers. Status comes from
live service identity rather than trusting a stored port or PID.

The snapshot/SSE/auth/error contract and sanitized examples are in
`scripts\test-support\dashboard-contract.json` in the source checkout.
Keep snapshot progress authoritative, use delivered event IDs for reconnect,
and display projection/history gaps. One-second companion observation is
not evidence that a controller or worker is alive.

This service is for a trusted local operator, not isolation from hostile
same-user processes. Loopback cookies are host-scoped rather than
port-isolated. Rejected aliased static roots, transient concurrent
stop/discovery failures, real-socket backpressure/stop flush behavior, and
near-limit polling cost remain documented platform acceptance concerns.
Never resolve a diagnostic by deleting scheduler ownership records.

## V1 status

| Unit | What | Status |
|---|---|---|
| 0 | Shell-script prototype (spawn + poll + advance) | **Done** — see [`prototype/`](./prototype/) |
| 0.5 | README + manifest reference | **Done** — you're reading it |
| 1 | Plugin scaffold (`.claude-plugin/`, stub skills, templates, schema) | **Done (pending plugin-load smoke test)** |
| 2 | Manifest parser + validator (`scripts/parse-manifest.js` + tests) | **Done** |
| 3 | File-protocol scaffolding (`scripts/scaffold-protocol.js` + tests) | **Done** |
| 4 | Session spawner (Node.js) | **Done** — see [`scripts/spawn-session.js`](./scripts/spawn-session.js) |
| 4.5 | SessionStart hook + agency launcher spike | **Done (findings landed)** — see [`spikes/launcher-compat-findings.md`](./spikes/launcher-compat-findings.md) |
| 5 | SessionStart hook for prompt injection | **Done (pending Unit 11 integration)** — see [`hooks/`](./hooks/) |
| 6 | Protocol header + prompt templates | **Done (pending Unit 7 integration)** — see [`templates/`](./templates/) |
| 7 | Template-based prompt generator | **Done** — see [`scripts/generate-prompt.js`](./scripts/generate-prompt.js) |
| 8 | Health checker (PID + timeout + heartbeat) | **Done** — see [`scripts/check-health.js`](./scripts/check-health.js) |
| 11 | Main orchestrator (Node.js process, `/orchestrate` skill) | **Done** — see [`scripts/orchestrate.js`](./scripts/orchestrate.js) and [`skills/orchestrate/SKILL.md`](./skills/orchestrate/SKILL.md) |
| 9, 10, 12 | Recovery analyst, email, `--init` | V1.5 (deferred) |

Full plan: [`../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`](../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md).

## Try it now (prototype)

The prototype proves the core loop works. It has real functionality — it
spawns Claude sessions, polls for completion signals, and advances phases
sequentially. It's intentionally dumb about prompt injection, recovery, and
review loops; those arrive with later units.

```powershell
cd C:\path\to\agent-orchestration\agent-orchestrator\prototype
npm install
node orchestrate-prototype.js manifest-example.yaml
```

Details, CLI flags, and a no-Claude smoke test: [`prototype/README.md`](./prototype/README.md).

## V1 architecture

```
User ── /orchestrate ──► Claude Code session (thin skill entry point)
                         │
                         └─► spawns ──► orchestrate.js (stateless Node process)
                                        │
                                        ├─► reads manifest.yaml + manifest-status.yaml every 2m
                                        ├─► generates prompts via generate-prompt.js (templates)
                                        ├─► spawns Claude sessions via wt + SessionStart hook
                                        ├─► polls docs/orchestration/ for completion signals
                                        ├─► tracks PIDs + timeouts for crash detection
                                        └─► writes runtime state to manifest-status.yaml
```

The orchestrator runs as an **external Node.js process**, not inside a
Claude session. This keeps the context window clean — the orchestrator
re-reads all state from disk each tick, accumulating nothing. It only calls
`claude -p` for operations that genuinely need LLM reasoning (V1 uses no
LLM in the main loop).

## Prerequisites

- Windows 11 with Windows Terminal on `PATH` (`where.exe wt`)
- Node.js >=20; Windows PowerShell and Git on PATH for workspace ownership
- For V1, Claude Code CLI invoked directly or through its configured wrapper
- For offline V2 candidates, native `claude.exe` or `agency.exe` on PATH;
  installed versions, capabilities, and actual live behavior still require
  the separate acceptance gate

## Docs

- [`prototype/README.md`](./prototype/README.md) — prototype quick-start and CLI flags
- [`docs/manifest-reference.md`](./docs/manifest-reference.md) — every manifest field, type, default, and meaning
- [`../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`](../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md) — implementation plan, review findings, decisions

## Friction log from Unit 0

Notes captured while running the prototype against the first smoke test.
These inform Units 1–11 as they land.

- `npm install` must run from `agent-orchestrator\prototype\`, not repo
  root. Missing cwd surfaced as `ENOENT: package.json`. Documented in the
  prototype README.
- Windows Terminal clobbers `--title` because PowerShell and Claude emit
  OSC title escapes. Fixed by adding `--suppressApplicationTitle` to the
  `wt` command. Unit 4 should carry this forward.
- Spawned tabs stay open across phase advances by design (so you can
  inspect prior agents). This means a long run leaves N tabs around. Unit
  11 should consider optional auto-close after phase success, or at least
  a "close all completed" helper.
- The 30-second poll interval feels fine for smoke testing. Revisit if
  real phases produce signal files quickly — worst case, missing the
  signal by <30s adds negligible latency to a multi-hour build.
- The no-Claude smoke path (`New-Item -ItemType File -Path ... -Force`)
  proved very useful for iterating on the orchestrator without burning
  tokens. Keeping that affordance in Unit 11's real orchestrator is worth
  the effort.

## License

Internal project. Not yet published.
