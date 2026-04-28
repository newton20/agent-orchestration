#!/usr/bin/env node
/**
 * Unit 5 — SessionStart hook for prompt injection (flag-file fallback).
 *
 * Reads the oldest-fresh `.pending-<id>` file under
 * `$CLAUDE_PROJECT_DIR/docs/orchestration/`, atomically consumes it via
 * rename, and emits its contents as `additionalContext` on stdout. Any
 * failure path collapses to `{}` — a misbehaving hook must not block
 * session start.
 *
 * Mechanism picked by Unit 4.5 spike (launcher-compat-findings.md):
 * `--name` is never exposed to SessionStart hooks under any tested
 * launcher, so name-based detection is dead. Unit 11 (orchestrator)
 * writes the flag files before `wt new-tab`; this hook is a strict
 * no-op until it does.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FLAG_TTL_MS = 60_000;           // 60 seconds — plan default
// Two-tier TTL: soft TTL (FLAG_TTL_MS) skips the candidate but preserves
// the file for debug. After STALE_HARD_TTL_MS the file is unlinked best-
// effort to bound steady-state statSync cost on every SessionStart.
// 10 × FLAG_TTL_MS ⇒ 600_000 ms / 10 minutes. The 10× multiplier (vs 5×
// or 30×) is chosen so the GC window is long enough to inspect a failed
// spawn (typical post-incident investigation arrives within minutes) and
// short enough to keep the per-tick `statSync` count bounded by realistic
// crash recency. See docs/todos/005:108-125 for the soft-vs-hard-TTL
// framing.
const STALE_HARD_TTL_MS = 10 * FLAG_TTL_MS;
const MAX_FLAG_BYTES = 256 * 1024;    // 256 KB prompt cap
// .pending-* flag-file name shape. The ID character class must stay
// in sync with VALID_ID_RE in agent-orchestrator/scripts/parse-manifest.js.
// See docs/todos/006 for context; change both or neither.
const FLAG_NAME_RE = /^\.pending-[A-Za-z0-9._-]+$/;

function logErr(msg) {
  try { process.stderr.write(`[unit-5-hook] ${msg}\n`); } catch (_) { /* never throw */ }
}

function tryUnlink(fsLib, p) {
  try { fsLib.unlinkSync(p); }
  catch (err) { if (err && err.code !== 'ENOENT') logErr(`unlink ${p}: ${err.message}`); }
}

function runHook(opts) {
  const o = opts || {};
  const projectDir = o.projectDir;
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const fsLib = o.fsLib || fs;
  const pid = typeof o.pid === 'number' ? o.pid : process.pid;

  if (!projectDir || typeof projectDir !== 'string') return '{}';
  if (!path.isAbsolute(projectDir)) {
    logErr(`CLAUDE_PROJECT_DIR is not absolute: ${projectDir}`);
    return '{}';
  }

  const orchDir = path.join(projectDir, 'docs', 'orchestration');

  let entries;
  try {
    entries = fsLib.readdirSync(orchDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code !== 'ENOENT') logErr(`readdir ${orchDir}: ${err.message}`);
    return '{}';
  }

  const candidates = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!FLAG_NAME_RE.test(ent.name)) continue;
    const full = path.join(orchDir, ent.name);
    let st;
    try { st = fsLib.statSync(full); }
    catch (err) { logErr(`stat ${full}: ${err.message}`); continue; }
    const age = now - st.mtimeMs;
    if (age > FLAG_TTL_MS) {
      // Stale: skip either way. Beyond the hard TTL, GC the file so the
      // per-tick statSync count stays bounded by recent activity rather
      // than every flag ever written. Files in [soft, hard) stay on disk
      // as the debug window for a failed spawn.
      if (age >= STALE_HARD_TTL_MS) tryUnlink(fsLib, full);
      continue;
    }
    candidates.push({ path: full, mtimeMs: st.mtimeMs, name: ent.name });
  }

  if (candidates.length === 0) return '{}';
  // Oldest fresh wins — deterministic, matches "first hook to delete wins".
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Iterate every candidate; no arbitrary cap. The list is bounded by
  // readdirSync so there is no unbounded-loop risk, and capping would
  // drop a valid prompt when N concurrent hooks each race past the cap
  // (N orchestrator-spawned sessions start roughly simultaneously).
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    // Consume by renaming to a sibling whose name does NOT start with
    // `.pending-`, so a leftover file (e.g. a crashed hook) can never
    // be re-matched by FLAG_NAME_RE on a later run.
    const id = cand.name.slice('.pending-'.length);
    const consumingPath = path.join(
      orchDir,
      `.consuming-${id}-${pid}-${Date.now()}-${i}`
    );

    try {
      fsLib.renameSync(cand.path, consumingPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;  // race: another hook consumed it
      logErr(`rename ${cand.path}: ${err.message}`);
      continue;
    }

    // Re-stat via the consuming path for the size guard. Avoids TOCTOU on
    // the original flag name (rename is atomic, so the inode is ours now).
    let sizeBytes;
    try { sizeBytes = fsLib.statSync(consumingPath).size; }
    catch (err) {
      logErr(`stat ${consumingPath}: ${err.message}`);
      tryUnlink(fsLib, consumingPath);
      continue;
    }
    if (sizeBytes > MAX_FLAG_BYTES) {
      logErr(`flag ${cand.name} exceeds ${MAX_FLAG_BYTES} bytes (got ${sizeBytes})`);
      tryUnlink(fsLib, consumingPath);
      return '{}';
    }

    let content;
    try { content = fsLib.readFileSync(consumingPath, 'utf8'); }
    catch (err) {
      logErr(`read ${consumingPath}: ${err.message}`);
      tryUnlink(fsLib, consumingPath);
      continue;
    }

    tryUnlink(fsLib, consumingPath);  // best-effort; warn-only on failure

    return JSON.stringify({ additionalContext: content });
  }

  return '{}';
}

if (require.main === module) {
  try {
    process.stdout.write(runHook({ projectDir: process.env.CLAUDE_PROJECT_DIR }));
  } catch (err) {
    // Defense in depth — runHook itself already swallows errors.
    logErr(`unexpected: ${err && err.message}`);
    process.stdout.write('{}');
  }
  process.exit(0);
}

module.exports = {
  runHook,
  FLAG_TTL_MS,
  STALE_HARD_TTL_MS,
  MAX_FLAG_BYTES,
  FLAG_NAME_RE,
};
