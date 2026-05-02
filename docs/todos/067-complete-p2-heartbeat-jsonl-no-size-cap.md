---
status: complete
priority: p2
issue_id: "067"
tags: [code-review, unit-8, check-health, performance, security, dos]
dependencies: []
---

# check-health: heartbeat JSONL has no size cap; full-file read into memory

`checkHealth` reads `heartbeat.jsonl` with `readFileSync` and splits
the entire buffer on `/\r?\n/`. The heartbeat file is appended by
the supervised agent on every tick and never truncated by the
orchestrator, so its size is bounded only by agent discipline (or
prompt-injection budget). At polling cadence of 30s-2min (per
Unit 11), an agent that fails to truncate or is induced to write
huge entries can stall the orchestrator and cause GC pressure.

## Problem Statement

`check-health.js:587-596` opens the file and `:178-209` parses it.
Both paths are full-file. Verified locally:

- 200 MB heartbeat → `checkHealth` wallclock ~540 ms, RSS over
  250 MB.
- 25 MB heartbeat → ~60 ms.
- 1 MB heartbeat → low single-digit ms.

The orchestrator runs `checkHealth` per role per phase per poll
tick. With Unit 11's planned cadence (30s-2min), N phases, and M
roles, a single bloated heartbeat file becomes a multiplicative
hot-path cost. A misbehaving or compromised agent that keeps
appending without truncating turns into a denial-of-service vector
on the orchestrator process itself.

The relevant API surface only needs the LATEST role-matching
record. There is no semantic reason to read the entire file.

## Findings

- Read site: `agent-orchestrator/scripts/check-health.js:587-596`
  (`fs.readFileSync(heartbeatPath, 'utf8')`).
- Parse site: `check-health.js:178-209` (`parseHeartbeatTail`,
  reverse iteration looking for the latest entry whose role
  matches).
- No truncation/rotation policy is enforced by the orchestrator;
  no size guard before reading.
- Heartbeat freshness is the load-bearing signal for "agent alive"
  decisions in Unit 11; degrading it silently is dangerous.
- Threat surface: prompt-injection of the supervised agent into
  emitting MB-scale JSONL records, OR an honest bug in agent code
  that loops on heartbeat emission.

## Proposed Solutions

### Option A — Tail-read fixed window (recommended)

Open the file, `statSync` for size, read the last 64 KB into a
buffer (`fs.openSync` + `fs.readSync` from `size - 64KB`). Drop
the leading partial line (everything up to and including the
first newline). Pass the resulting tail to `parseHeartbeatTail`
unchanged. If no role-match found in 64 KB, re-expand to 256 KB,
then 1 MB, then give up and return `heartbeatAge: null` with a
diagnostic.

- **Pros:** Bounds the cost at ~1 ms regardless of file size.
  Semantics preserved (still finds the latest matching record in
  the tail). No agent-side change required. No state added.
- **Cons:** Pathological case where the latest role-match is
  >1 MB behind the tail (e.g., one role hasn't emitted in
  1 M lines) returns null — but that case is itself a heartbeat
  staleness signal, so degrading-to-null is correct policy.
- **Effort:** Small (~30-40 lines + 3-4 tests covering small
  file, tail-only file, partial-line drop, and re-expand path).
- **Risk:** Low.

### Option B — Stat-and-skip ceiling

If `statSync(heartbeatPath).size > 5 * 1024 * 1024`, log a warning
and return `heartbeatAge: null`.

- **Pros:** Trivial implementation.
- **Cons:** Silently masks heartbeat freshness as soon as the log
  gets large. The orchestrator loses its primary liveness signal
  exactly when it most needs it. Operator must know to truncate.
- **Effort:** Small.
- **Risk:** Medium — masking a load-bearing signal.

### Option C — Defer to operator

Document that supervised agents must truncate `heartbeat.jsonl`
periodically. No code change in `check-health.js`.

- **Pros:** Zero code churn.
- **Cons:** Relies on agent discipline for orchestrator stability.
  An agent bug or hostile prompt becomes an orchestrator outage.
- **Effort:** Zero (doc only).
- **Risk:** High.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Replace the
`readFileSync` of the entire file with a tail-read fixed-window
read (e.g., open `r` mode, `fstatSync` → seek to `size - WINDOW`,
read backward until enough lines for the role-filter, parse only
that window). Window default: 64 KiB (sufficient for ~500 typical
heartbeat lines at ~120 bytes each). Bounded memory regardless of
file size; the supervisor can DoS-tolerate a runaway heartbeat
writer.

Option B (stat-and-skip ceiling) doesn't bound the parsed buffer
once the ceiling is hit; if the ceiling is generous, the failure
mode is "we parse less of the file" silently. Option C (defer to
operator) leaves Unit 11's polling loop exposed.

Dispatch as part of the **pre-Unit-11 hardening PR bundle** along
with todos 068-078 + 083 + 086.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Read site: lines 587-596
- Parse site: lines 178-209 (`parseHeartbeatTail`)
- Test file to extend: `agent-orchestrator/scripts/check-health.test.js`
- Recommended tail window: 64 KB initial, exponential re-expand
  to 256 KB then 1 MB before giving up.

## Acceptance Criteria

- [ ] `checkHealth` on a 200 MB heartbeat file completes in
      <50 ms wallclock and <50 MB RSS delta.
- [ ] Tail read still returns the latest role-matching record
      when it falls within the tail window.
- [ ] Re-expand path covered by test (latest record at 100 KB
      offset, initial 64 KB window misses it, 256 KB hits it).
- [ ] Files smaller than the initial window read correctly (no
      partial-line drop applied).
- [ ] Returns `heartbeatAge: null` with a diagnostic when the
      latest role-matching record is beyond the maximum tail.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
