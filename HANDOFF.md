# Agent Orchestration Plugin — Session Handoff

**Handoff date:** 2026-04-16
**Previous session:** Brainstorm + Plan + /autoplan review (~home~ directory)
**This session:** V1 implementation (this directory)
**Status:** Plan reviewed and approved. Ready for `/ce:work` starting with Unit 0.

---

## What This Project Is

A Claude Code plugin (`agent-orchestrator`) that automates multi-session phased development workflows. The user currently spends ~21% of Claude Code interactions manually orchestrating multiple sessions — generating handoff prompts, relaying artifacts between implementation and QA agents, briefing coordinator sessions, and copy-pasting instructions across windows. This plugin eliminates that manual work.

The user is building this because they've felt the pain firsthand across yoga-house (8 phases), polymarket-quant (multi-phase trading system), deal-seaker, and content-pipeline projects.

**Inspiration:** Elvis Sun's OpenClaw Agent Swarm article (see `docs/brainstorms/inspiration-openclaw-elvis-sun.txt`). But instead of fire-and-forget background agents, the user wants **visible, steerable Claude Code session windows** with a formal review loop where QA and implementation agents iterate on each other's output.

---

## What's Already Been Done

1. **Brainstorming** — Full requirements doc with problem frame, goals, non-goals, architecture, manifest format, failure recovery model, and phased delivery. See `docs/brainstorms/2026-04-15-agent-orchestration-plugin-requirements.md`.

2. **Planning** — Full implementation plan with 10 units across 6 phases. See `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`.

3. **/autoplan Review** — CEO + Eng + DX reviews (Claude subagents, Codex unavailable). 19 findings, all resolved. Plan fundamentally revised based on review feedback. See "GSTACK REVIEW REPORT" section at bottom of the plan file.

---

## Key Architecture Decisions (Important — Read Before Starting)

These were validated through brainstorm, planning, and three review passes. Do NOT second-guess these without strong evidence:

### 1. Orchestrator is a stateless Node.js process, NOT a Claude Code session

The orchestrator (`scripts/orchestrate.js`) runs as a standalone Node.js process that polls the file protocol every 2 minutes. It re-reads ALL state from disk each tick. It has zero accumulated context window. Only calls `claude -p` for rare operations needing LLM reasoning (V1: never in the main loop).

**Why:** A long-running `/loop` inside a Claude Code session would exhaust the context window after ~90 ticks (3 hours). This was flagged as CRITICAL by both CEO and Eng review.

### 2. Template interpolation for V1, NOT LLM-generated prompts

`scripts/generate-prompt.js` reads template files + plan excerpts + completion signals and does deterministic `{{variable}}` string replacement. LLM prompt generation is deferred to V1.5.

**Why:** LLM-generated prompts introduce compounding variance (orchestrator LLM generates prompt → impl agent LLM interprets it → errors compound). Template interpolation is deterministic and debuggable.

### 3. File-drop protocol with structured completion signals

Every agent signals completion by writing a structured markdown file with YAML frontmatter (agent, phase, status, timestamp, git_commit) + sections (Summary, Artifacts Produced, Issues/Blockers, Recommended Next Steps). The Node.js orchestrator assembles context for next agent by reading these files.

**Why:** The fresh Claude session spawned for each phase has NO conversation history. It gets full context because everything is in the file protocol — plan excerpt, previous phase briefings, and a protocol header telling it where to write outputs.

### 4. Split manifest: `manifest.yaml` (user) + `manifest-status.yaml` (orchestrator)

User edits manifest.yaml for structure (phases, agents, dependencies, launcher config). Orchestrator writes manifest-status.yaml for runtime state (PIDs, timestamps, completion status). No locking needed.

**Why:** Eliminates concurrent-write conflicts when user edits while orchestrator runs.

### 5. PID + timeout primary crash detection, heartbeat secondary

PID monitoring via `tasklist /FI "PID eq X"` is deterministic. Timeout is configurable. Heartbeat (agent-side file touching) is a bonus signal for early hung-agent detection but not required.

**Why:** Agent compliance with heartbeat instructions under heavy workload is unvalidated. PID+timeout works without agent cooperation.

### 6. Configurable launcher for wrapper CLIs (critical for this user's setup)

**THE USER RUNS CLAUDE CODE VIA MICROSOFT'S AGENCY WRAPPER:**
```powershell
agency claude --enable-auto-mode [other args]
```

NOT direct `claude`. This affects the spawn command. The plugin supports a configurable `launcher` block:

```yaml
# launcher.yaml or in manifest
launcher:
  shell: powershell
  binary: "agency claude"
  auto_mode_flag: "--enable-auto-mode"
  shell_args: "-NoExit -Command"
```

**Unit 4.5 (SPIKE) must verify agency compatibility before Unit 5 (hook) is built.** The spike tests whether `--name`, `--plugin-dir`, and SessionStart hooks survive the agency wrapper. Decision matrix is in the plan under Unit 4.5.

### 7. Scope cut: V1 is Units 0, 0.5, 1-8, 11. V1.5 is Units 9, 10, 12.

Deferred to V1.5 (not blocking V1 ship):
- Unit 9: Recovery analyst agent (LLM-powered crash analysis)
- Unit 10: Email notifications
- Unit 12: `/orchestrate --init` manifest generator

---

## Start Here: Unit 0 — Shell-Script Prototype

The plan explicitly starts with a **prototype unit** before building the full plugin. This is critical — the user validates the core assumptions on a real project before investing in the full architecture.

**Unit 0 goal:** A single Node.js script (~200 lines) at `prototype/orchestrate-prototype.js` that:
- Reads a simple manifest YAML
- Spawns `wt` tabs with `claude` (or `agency claude` per user's setup)
- Polls for completion signal files in a loop
- Advances to next phase when signals arrive

No templates, no hook, no recovery, no email — just spawn + poll + advance.

**Then:** Use it on one real 2-phase project to collect real-world friction data. If the prototype reveals the design is wrong, revise the plan BEFORE building Units 1-11.

After Unit 0 works end-to-end, proceed to Unit 0.5 (README), then Units 1-8, 11 in dependency order.

---

## User Context (Read First)

- **Platform:** Windows 11, PowerShell
- **Runtime:** Microsoft `agency` CLI wrapper, not direct claude. Command: `agency claude --enable-auto-mode`
- **Shell:** Git Bash for scripting (Unix-style paths work)
- **Node.js:** v22.22.2, npm v10.9.7
- **Windows Terminal:** Available at `C:\Users\dunliu\AppData\Local\Microsoft\WindowsApps\wt.exe`
- **Stack preference:** Node.js + markdown only. PowerShell eliminated from the stack (Eng review).
- **API keys:** Stored at `C:\Users\dunliu\OneDrive - Microsoft\Documents\devbox_shared\api.txt`. Never commit secrets.
- **Email for notifications:** liudun88@gmail.com (V1.5 feature, not V1)
- **GitHub:** newton20 account for personal projects
- **Workflow:** User follows strict /ce:brainstorm → /ce:plan → /autoplan → /ce:work → /qa → /codex → /ship cycle

---

## Critical Reference Files in This Project

- `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md` — **The plan. Source of truth for implementation.**
- `docs/brainstorms/2026-04-15-agent-orchestration-plugin-requirements.md` — Original requirements
- `docs/brainstorms/inspiration-openclaw-elvis-sun.txt` — Architectural inspiration (tmux → Windows Terminal adaptation)

---

## Reference Patterns to Study (from other plugins)

- **Plugin structure:** `~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/2.66.1/` — look at `.claude-plugin/plugin.json`, `skills/*/SKILL.md` format, `agents/*/*.md` format
- **SessionStart hook pattern:** `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/hooks/` — look at `hooks.json`, `session-start` script, `run-hook.cmd`

Windows paths:
- `C:\Users\dunliu\.claude\plugins\cache\compound-engineering-plugin\compound-engineering\2.66.1\`
- `C:\Users\dunliu\.claude\plugins\cache\claude-plugins-official\superpowers\5.0.7\`

---

## Copy-Paste-Ready Kickoff Prompt

Paste this into the fresh Claude Code session:

```
I'm implementing an agent-orchestration Claude Code plugin. Please read HANDOFF.md in the current directory for full context — it has the architecture decisions, user setup, and reference patterns you need.

Then read the plan at docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md.

The plan has been through /autoplan review and is approved. Start with Unit 0 (shell-script prototype) — build the minimal ~200-line Node.js script that spawns Claude Code sessions via `wt` tabs and polls for completion signal files. Do NOT start with Unit 1 or later units — Unit 0 validates core assumptions before we invest in the full plugin architecture.

Important context on my runtime setup:
- I run Claude Code via Microsoft's agency wrapper: `agency claude --enable-auto-mode` (not direct claude)
- PowerShell, not cmd
- Windows 11

Use /ce:work to drive the implementation. Follow the plan unit-by-unit. After Unit 0 is working end-to-end (spawns 2 sequential sessions, detects completion files, advances phases), check with me before moving to Unit 0.5 and beyond.
```
