# Manifest Reference

The manifest is a YAML file that describes a multi-phase build. It is the
single source of truth the orchestrator reads on every tick. The user owns
the structural fields (phases, agents, dependencies, launcher). The
orchestrator owns runtime state (PIDs, timestamps, completion flags), which
it writes to a separate `manifest-status.yaml` to avoid concurrent-edit
conflicts.

This reference documents every field. Each is tagged with the unit that
makes it active:

- **prototype** — honored by `prototype/orchestrate-prototype.js` today.
- **V1** — honored by the full orchestrator (Units 1–8, 11) once shipped.
- **V1.5** — deferred (Units 9, 10, 12).

## Top-level schema

```yaml
name: my-feature                # Optional. Cosmetic label.
launcher: { ... }               # Optional. How Claude is spawned.
defaults: { ... }               # Optional. Per-run fallbacks.
phases:                         # Required. Ordered list of phases.
  - id: phase-0
    ...
```

### `name`

- **Type:** string
- **Required:** no
- **Default:** `(unnamed)`
- **Since:** prototype
- **Description:** Shown in the orchestrator's startup header. No runtime
  effect.

### `workdir`

- **Type:** string (absolute path or path relative to the manifest file)
- **Required:** no
- **Default:** the manifest file's directory
- **Since:** prototype
- **Description:** Where spawned tabs start (`wt --startingDirectory`). Use
  this when the manifest lives alongside orchestration artifacts but
  agents should work from a different directory (typically the project
  root). `prompt_file` and `completion_signal` paths always resolve
  against the manifest's directory, regardless of `workdir`.

### `launcher`

How the orchestrator spawns each Claude session. Ships with defaults matching
Microsoft's `agency` wrapper, since that's the primary user's environment.

```yaml
launcher:
  shell: powershell
  binary: agency claude
  auto_mode_flag: --enable-auto-mode
  shell_args: -NoExit -Command    # V1
  passthrough_flags: []           # V1
```

| Field | Type | Default | Since | Notes |
|---|---|---|---|---|
| `shell` | string (`powershell` \| `cmd`) | `powershell` | prototype | Which host shell wraps the binary in the new `wt` tab. The prototype validates this literally — any other value errors. |
| `binary` | string | `agency claude` | prototype | The Claude CLI invocation. Works well for space-separated subcommands like `agency claude` or a single binary like `claude`. **Caveat:** the prototype concatenates `binary + auto_mode_flag` into a shell string; embedded quotes, paths with spaces, or shell metacharacters may break. Unit 4's `spawn-session.js` will replace this with proper argv construction. |
| `auto_mode_flag` | string | `--enable-auto-mode` | prototype | Passed immediately after `binary`. Set to empty string to omit. Same quoting caveat as `binary`. |
| `shell_args` | string | `-NoExit -Command` (ps) / `/k` (cmd) | V1 | Arguments injected between the shell binary and the Claude invocation. |
| `passthrough_flags` | list of strings | `[]` | V1 | Extra flags appended to every Claude spawn (e.g. `--model`, `--plugin-dir`). |

**Prototype behavior:** The prototype wraps `binary + auto_mode_flag` in
either `powershell -NoExit -Command "..."` or `cmd /k ...` and always adds
`--suppressApplicationTitle` to the `wt` command to stop tab titles from
reverting.

### `defaults`

Per-run fallbacks used when a phase omits the field. Honored by V1's
orchestrator; the prototype ignores this block.

```yaml
defaults:
  model: sonnet                         # V1
  heartbeat_timeout_minutes: 5          # V1
  phase_timeout_minutes: 120            # V1
  permission_mode: auto                 # V1
  notifications:                        # V1.5
    enabled: false
    email: liudun88@gmail.com
```

| Field | Type | Default | Since | Notes |
|---|---|---|---|---|
| `model` | string | `sonnet` | V1 | Claude model used unless a phase overrides. |
| `heartbeat_timeout_minutes` | integer | `5` | V1 | Seconds of heartbeat staleness before secondary-signal warning. Does not itself kill the agent — PID + `phase_timeout_minutes` do. |
| `phase_timeout_minutes` | integer | `120` | V1 | Wall-clock cap on a single phase. Exceeding it marks the phase failed. |
| `permission_mode` | string (`auto` \| `default`) | `auto` | V1 | Maps to Claude's `--permission-mode`. |
| `notifications.enabled` | boolean | `false` | V1.5 | Email notifications for phase_complete, agent_failed, decision_needed, all_done. |
| `notifications.email` | string | — | V1.5 | Recipient address. |

### `phases[]`

Ordered list. Each entry defines a unit of work and the agent(s) that do it.
The prototype runs them strictly sequentially; V1 honors `depends_on` and
`parallel_with` for DAG execution.

```yaml
phases:
  - id: phase-0
    title: Scaffold initial files
    timeout_minutes: 120
    depends_on: []                 # V1
    parallel_with: []              # V1
    review_loop:                   # V1
      enabled: true
      max_iterations: 3
    agent:                         # prototype: single agent
      role: impl
      prompt_file: prompts/phase-0-impl.md
    agents:                        # V1: multiple agents (impl + QA)
      - role: impl
        model: sonnet
        prompt_file: prompts/phase-0-impl.md
      - role: qa
        model: sonnet
        prompt_file: prompts/phase-0-qa.md
    completion_signal: signals/phase-0-impl-complete.md
```

| Field | Type | Default | Since | Notes |
|---|---|---|---|---|
| `id` | string | — | prototype | **Required.** Used in the session name (`orch-<id>-<role>`). The prototype checks presence only; V1's `parse-manifest.js` will also enforce uniqueness. |
| `title` | string | — | prototype | Cosmetic suffix appended to the tab title. When present, the tab title becomes `orch-<id>-<role> — <title>`; otherwise it is `orch-<id>-<role>`. |
| `timeout_minutes` | integer | 60 (prototype) / `defaults.phase_timeout_minutes` (V1) | prototype | Wall-clock cap for this phase. On timeout, the prototype exits fatally; V1 marks the phase failed and continues the DAG. |
| `depends_on` | list of phase `id`s | `[]` | V1 | DAG edge. Phase cannot start until every listed phase completes. |
| `parallel_with` | list of phase `id`s | `[]` | V1 | Hint for the scheduler that these phases can run simultaneously. |
| `review_loop.enabled` | boolean | `false` | V1 | Turns on the impl↔QA review cycle for this phase. |
| `review_loop.max_iterations` | integer | `3` | V1 | Hard cap on review cycles before escalating to the user. |
| `agent` | object | — | prototype | Single-agent shorthand. The prototype only reads this. |
| `agents` | list of objects | — | V1 | V1 form — lets a phase have impl + QA + coordinator agents. |
| `completion_signal` | string (path) | — | prototype | **Required.** Path (relative to the manifest) that an agent must create to signal done. Parent directories are auto-created. |

### `agent` / `agents[]`

Either one `agent` object (prototype) or a list under `agents` (V1).

```yaml
agent:
  role: impl
  model: sonnet                    # V1 (falls back to defaults.model)
  prompt_file: prompts/phase-0-impl.md
  plugin_dir: ../another-plugin    # V1
```

| Field | Type | Default | Since | Notes |
|---|---|---|---|---|
| `role` | string | `impl` | prototype | Freeform label. Conventional values: `impl`, `qa`, `coordinator`. Appears in the session name. |
| `model` | string | `defaults.model` | V1 | Overrides the default model for this agent only. |
| `prompt_file` | string (path) | — | prototype | Path (relative to manifest) to a markdown prompt. The prototype prints this path for you to paste by hand. Unit 5's SessionStart hook will inject it automatically. |
| `plugin_dir` | string (path) | — | V1 | Extra plugin directory passed as `--plugin-dir`. |

## Path resolution

All relative paths (`prompt_file`, `completion_signal`, etc.) resolve
against the manifest file's directory — not the orchestrator's cwd. This
keeps manifests portable across checkouts.

## Validation rules

V1's `parse-manifest.js` will enforce these. The prototype enforces only
the required fields.

- `phases[]` must be non-empty.
- Every `phase.id` must be unique.
- Every `phase.completion_signal` must be non-empty.
- Every `depends_on` reference must resolve to an existing `phase.id`.
- No circular dependencies in the `depends_on` graph.
- `launcher.shell` must be one of the known values (`powershell`, `cmd`).
- Unknown top-level fields produce a warning, not an error, so future V1+
  fields don't break older manifests.

## Minimal example (prototype today)

```yaml
name: my-feature
phases:
  - id: phase-0
    completion_signal: signals/phase-0-done.md
    agent:
      role: impl
      prompt_file: prompts/phase-0-impl.md
  - id: phase-1
    completion_signal: signals/phase-1-done.md
    agent:
      role: impl
      prompt_file: prompts/phase-1-impl.md
```

## Full example (V1 target)

```yaml
name: yoga-house-rebuild
launcher:
  shell: powershell
  binary: agency claude
  auto_mode_flag: --enable-auto-mode
defaults:
  model: sonnet
  phase_timeout_minutes: 120
  permission_mode: auto
  notifications:
    enabled: true
    email: liudun88@gmail.com

phases:
  - id: phase-0
    title: Scaffold monorepo
    review_loop:
      enabled: true
      max_iterations: 3
    agents:
      - role: impl
        prompt_file: prompts/phase-0-impl.md
      - role: qa
        prompt_file: prompts/phase-0-qa.md
    completion_signal: signals/phase-0-impl-complete.md

  - id: phase-1a
    title: Auth module
    depends_on: [phase-0]
    parallel_with: [phase-1b]
    agents:
      - role: impl
        prompt_file: prompts/phase-1a-impl.md
      - role: qa
        prompt_file: prompts/phase-1a-qa.md
    completion_signal: signals/phase-1a-impl-complete.md

  - id: phase-1b
    title: Billing module
    depends_on: [phase-0]
    parallel_with: [phase-1a]
    agents:
      - role: impl
        prompt_file: prompts/phase-1b-impl.md
      - role: qa
        prompt_file: prompts/phase-1b-qa.md
    completion_signal: signals/phase-1b-impl-complete.md

  - id: phase-2
    title: Integration + final QA
    depends_on: [phase-1a, phase-1b]
    agents:
      - role: impl
        prompt_file: prompts/phase-2-impl.md
      - role: qa
        prompt_file: prompts/phase-2-qa.md
    completion_signal: signals/phase-2-impl-complete.md
```

## See also

- [`../prototype/manifest-example.yaml`](../prototype/manifest-example.yaml) — a runnable two-phase example.
- [`../prototype/README.md`](../prototype/README.md) — how the prototype consumes the manifest.
- [`../../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`](../../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md) — source of truth for what V1 implements.
