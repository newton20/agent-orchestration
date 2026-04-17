---
title: Agent Orchestration Plugin for Claude Code
date: 2026-04-15
status: brainstormed
scope: deep
---

# Agent Orchestration Plugin — Requirements

## Problem Statement

Building multi-phase projects (yoga-house, polymarket-quant, deal-seaker) with Claude Code requires manually orchestrating multiple independent sessions — generating handoff prompts, relaying artifacts between implementation and QA agents, briefing coordinator sessions, and copy-pasting instructions across windows. This manual orchestration consumes ~21% of all session interactions and is the single largest time sink in the current workflow.

## Users

- **Primary**: Solo developer running phased builds across multiple Claude Code sessions with dedicated roles (coordinator, implementation, QA, reviewer)
- **Secondary**: Any developer using Claude Code for multi-phase projects who wants separation of concerns between agent sessions

## Goals

1. **Eliminate manual copy-paste orchestration** — The user should never need to generate "copy-paste-ready prompts" or manually relay artifacts between sessions
2. **Maintain full observability** — Every spawned agent runs in a visible Claude Code window the user can inspect and steer at any time
3. **Separation of concerns** — Each session has a dedicated role, focused context, and clean boundaries — not one mega-session doing everything
4. **Survive failures gracefully** — Session crashes, machine restarts, and agent failures are recovered automatically with checkpoint-based resumption
5. **Protocol-first design** — The inter-agent communication protocol is the stable core; the orchestrator layer is swappable (Claude Code plugin today, OpenClaw/daemon tomorrow)

## Non-Goals

- Replacing the existing `/ce:plan` → `/ce:work` → `/qa` workflow (the plugin orchestrates these, not replaces them)
- Running agents in the background invisibly (user explicitly wants visible windows)
- Building a general-purpose multi-agent framework (this is purpose-built for phased development workflows)
- V1 does not need to support non-Claude-Code agent types (OpenClaw, Codex, Cowork are V2)
- V1 does not need a visual dashboard (manifest-as-dashboard is sufficient; real dashboard is V2)

## Architecture

### Two-layer design

**Layer 1: Inter-Agent Protocol (the stable core)**
- File-drop convention for signaling between agents
- Structured directory layout under `docs/orchestration/`
- Manifest YAML as the workflow definition and progress tracker
- Git commits as durable backup for all signals

**Layer 2: Orchestrator (swappable)**
- V1: Claude Code plugin with `/orchestrate` skill
- V2 bolt-on: Node.js file-watcher daemon for event-driven monitoring + notifications
- Future: OpenClaw orchestrator reading the same protocol

### Inter-Agent Protocol

#### Directory structure

```
docs/orchestration/
  manifest.yaml                    # workflow definition + live progress
  templates/
    impl-prompt.md                 # template for implementation agent prompts
    qa-prompt.md                   # template for QA agent prompts
    qa-playbook-prompt.md          # template for QA playbook generation
    coordinator-briefing.md        # template for phase completion briefings
    recovery-prompt.md             # template for crash recovery prompts
  phases/
    phase-0/
      impl-prompt.md               # generated: dispatched to impl session
      impl-heartbeat               # touched every ~2min by active agent
      qa-playbook.md               # output: QA agent's test playbook
      impl-qa-review.md            # output: impl agent's review of playbook
      qa-results.md                # output: final QA execution results
      impl-complete.md             # completion signal from impl agent
      qa-complete.md               # completion signal from QA agent
      phase-complete.md            # orchestrator writes when all agents done
    phase-1/
      ...
  logs/
    events.jsonl                   # append-only event log (spawns, signals, crashes, recoveries)
```

#### Completion signals

Every completion file follows a structured format:

```markdown
---
agent: impl
phase: phase-0
status: complete | failed | partial
timestamp: 2026-04-15T14:30:00Z
git_commit: abc1234
---

## Summary
[What was accomplished]

## Artifacts Produced
- [list of files created/modified]

## Issues / Blockers
- [any problems for downstream agents to know about]

## Recommended Next Steps
- [what should happen next]
```

#### Heartbeat

Agents touch their heartbeat file every ~2 minutes while active. The orchestrator considers a session dead if the heartbeat is >5 minutes stale AND the process PID is gone.

### Manifest Format

```yaml
name: polymarket-quant-phase-0
plan: docs/plans/2026-04-13-001-feat-auto-agentic-polymarket-trading-system-plan.md
created: 2026-04-15T10:00:00Z
status: running  # pending | running | paused | completed | failed

phases:
  - id: phase-0
    name: "Infrastructure & Smoke Test"
    status: pending  # pending | running | completed | failed | skipped
    depends_on: []
    started_at: null
    completed_at: null
    agents:
      - role: impl
        skill: /ce:work
        prompt_template: templates/impl-prompt.md
        completion_signal: phases/phase-0/impl-complete.md
        status: pending
        pid: null
        session_title: "Phase 0 — Impl"
        timeout: 60min
        max_retries: 3
        retry_count: 0
      - role: qa
        skill: /qa
        prompt_template: templates/qa-prompt.md
        depends_on: [impl]
        completion_signal: phases/phase-0/qa-complete.md
        status: pending
        timeout: 30min
        max_retries: 3

    review_loop:
      enabled: true
      steps:
        - qa: creates playbook (design only, no execution)
        - impl: reviews playbook, provides feedback
        - qa: incorporates feedback, executes tests
    
    verification:
      - command: "npm run build"
      - command: "npm test"

    on_complete:
      - notify
      - generate_next_phase_briefing

  - id: phase-1
    name: "Market Intelligence Engine"
    status: pending
    depends_on: [phase-0]
    parallel_with: [phase-2]
    agents:
      - role: impl
        skill: /ce:work
      - role: qa
        skill: /qa

notifications:
  channel: email
  address: liudun88@gmail.com
  events: [phase_complete, decision_needed, agent_failed, agent_recovered, all_done]
  # V2: add desktop toast, telegram

session:
  type: visible
  model: opus[1m]
  mode: auto

# Updated by orchestrator during execution
events:
  - timestamp: 2026-04-15T10:05:00Z
    type: phase_started
    phase: phase-0
  - timestamp: 2026-04-15T10:05:02Z
    type: agent_spawned
    phase: phase-0
    role: impl
    pid: 12345
```

### Manifest Lifecycle

- **Created by**: User (manually) or `/manifest-gen` skill (from a `/ce:plan` output)
- **Status updates**: Orchestrator writes silently (phase started/completed, agent spawned/done, timing)
- **Structural changes**: Orchestrator writes + notifies user with rationale. Auto-applies after 5 minutes unless user vetoes. Examples: changing phase dependencies, splitting a phase, switching parallel to sequential.
- **User edits**: User can edit the manifest at any time (pause a phase, skip an agent, adjust timeouts). Orchestrator detects changes on next poll and adapts.

### Failure Recovery

#### Detection (three layers)

| Layer | Mechanism | Detects |
|---|---|---|
| Process monitor | Track PIDs of spawned `claude` processes | Hard crashes, killed processes, restarts |
| Heartbeat | Agent touches heartbeat file every ~2min. Stale >5min + PID gone = dead | Hangs, infinite loops, silent failures |
| Timeout | Configurable per-role in manifest | Everything above misses |

#### Recovery flow

1. Crash detected → read file protocol to determine last checkpoint
2. Read git log for last committed state
3. Diff completed vs. remaining work
4. Choose recovery strategy:
   - **>80% done** (completion signal missing): Respawn with focused "finish + signal" prompt
   - **Mid-task** (some artifacts exist): Respawn with recovery prompt listing completed + remaining work
   - **Barely started** (heartbeat only): Clean retry with original prompt
5. Notify user: "Phase 0 impl agent crashed. Auto-respawning (attempt 2/3)"
6. Log crash event + recovery action to manifest and events.jsonl
7. After 3 failed attempts: stop + escalate to user with full context

#### Machine-level recovery

On machine restart, `/orchestrate manifest.yaml --resume` scans the file protocol, detects interrupted state, and picks up where things left off.

### Session Spawning (Windows)

```powershell
# Open a new Windows Terminal tab with a titled Claude Code session
wt -w 0 new-tab --title "Phase 0 — Impl" cmd /c claude --model opus[1m] -p (Get-Content phases/phase-0/impl-prompt.md -Raw)
```

For interactive (steerable) sessions, spawn without `-p`:
```powershell
wt -w 0 new-tab --title "Phase 0 — Impl" cmd /c claude --model opus[1m]
# Then send the prompt via the file protocol — agent reads its prompt file on startup
```

### Prompt Generation

The orchestrator generates prompts by interpolating templates with:
- Plan excerpt (relevant implementation units for this phase)
- Previous phase outputs (completion briefings, QA results)
- Manifest context (what role this agent plays, what it should produce)
- Recovery context (if respawning after crash)
- File protocol instructions (where to write outputs, how to signal completion)

Each generated prompt includes a **protocol header**:
```markdown
## Orchestration Protocol
You are the **implementation agent** for Phase 0 of polymarket-quant.
- Write your QA playbook to: docs/orchestration/phases/phase-0/qa-playbook.md
- Signal completion by writing: docs/orchestration/phases/phase-0/impl-complete.md
- Touch your heartbeat file every ~2 minutes: docs/orchestration/phases/phase-0/impl-heartbeat
- Your plan context is at: docs/plans/2026-04-13-...-plan.md (units 1-3)
```

## Plugin Structure

```
plugin: agent-orchestrator/
  skills/
    orchestrate/SKILL.md       # main skill: /orchestrate manifest.yaml [--resume]
    manifest-gen/SKILL.md      # generates manifest from /ce:plan output
  templates/
    impl-prompt.md
    qa-prompt.md
    qa-playbook-prompt.md
    coordinator-briefing.md
    recovery-prompt.md
  scripts/
    spawn-session.ps1          # spawns visible Claude Code windows
    watch-signals.js           # V2: file watcher daemon (Approach C bolt-on)
    notify.ps1                 # sends email/desktop notifications
  schema/
    manifest.schema.json       # JSON schema for manifest validation
    completion-signal.schema.json
```

## Phased Delivery

### V1: Core Orchestration (MVP)
- `/orchestrate manifest.yaml` — reads manifest, generates prompts, spawns visible Claude Code sessions
- `/manifest-gen plan.md` — generates manifest scaffold from existing plan
- File-drop protocol with structured completion signals
- Heartbeat-based health monitoring
- Checkpoint-based crash recovery with auto-respawn (3 attempts)
- Email notifications for phase completion and failures
- Manifest as live progress tracker
- QA ↔ impl review loop support

### V2: Daemon + Dashboard + Multi-Agent
- Node.js file-watcher daemon for event-driven monitoring (replaces polling)
- Desktop toast notifications (BurntToast on Windows)
- Progress dashboard (web UI reading manifest + events.jsonl)
- OpenClaw agent type adapter
- Codex agent type adapter
- Browser-based ChatGPT adapter (via agent-browser) for GPT 5.4-pro extended reasoning — supports 30+ minute response times, used for adversarial design review on high-stakes tasks
- Manifest structural change proposals with auto-apply + veto window
- Smart timeout calibration based on historical phase durations

### V3: Proactive Orchestration
- Orchestrator proactively finds work (scan git issues, Sentry errors, meeting notes — like Elvis's Zoe)
- Cross-project orchestration (manage yoga-house + polymarket-quant simultaneously)
- Learning loop: log what prompts/configurations led to successful phases, improve prompt generation over time

## Success Criteria

1. A phased build (like polymarket-quant phase 0-2) can be kicked off with a single `/orchestrate` command and run to completion with zero manual copy-paste between sessions
2. Every spawned session is visible and steerable — user can type into any window at any time
3. A session crash during phase execution is automatically detected and recovered within 5 minutes
4. The manifest accurately reflects current progress at all times
5. The file protocol works identically regardless of which orchestrator drives it (Claude Code plugin, daemon, or future OpenClaw)

## Open Questions (deferred to planning)

- Exact template interpolation syntax (Handlebars, simple `{{var}}`, or LLM-generated?)
- Whether `claude -p` supports Windows Terminal tab titles natively or needs a wrapper
- How to handle the interactive vs. headless session tradeoff for steerability
- Whether heartbeat should be agent-side (agent writes it) or orchestrator-side (orchestrator pings agent)
- Email sending mechanism (SMTP, SendGrid, or OS-level `Send-MailMessage`)
