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

// Todo 099: out-of-band spawn-token binding for cross-tick poison-pill.
// The orchestrator generates a per-spawn UUID, embeds it as the FIRST
// LINE of the .pending-<name> flag content (`# spawn_token: <uuid>`),
// and propagates the same token to the spawned tab via the
// AGENT_FLAG_TOKEN environment variable.
//
// When the hook fires, it peek-reads each candidate's first line and
// compares the extracted token against AGENT_FLAG_TOKEN. Mismatch ⇒
// the candidate was written for a DIFFERENT spawn (most commonly: the
// fresh next-tick flag, written after the current tab's spawn timed
// out and was treated as failed). The hook skips that candidate
// WITHOUT the destructive `.consuming-*` rename — leaving the fresh
// flag intact for the intended new tab to consume.
//
// This closes the cross-tick wrong-prompt-to-wrong-agent class:
// pre-fix, an orphan tab whose hook fired AFTER its spawn timed out
// would consume the next-tick fresh flag (oldest-flag-wins, no name
// filter) and deliver an unrelated prompt. Post-fix, the orphan's
// AGENT_FLAG_TOKEN was bound to the OLD spawn's UUID at tab-launch
// time; the new flag carries a NEW UUID; mismatch → skip → safe.
//
// Compat: when AGENT_FLAG_TOKEN is unset (legacy spawn paths, or
// spawn-session env propagation not yet wired), the hook falls back
// to the pre-fix oldest-flag-wins behavior. This is INTENTIONAL —
// hook tests run without AGENT_FLAG_TOKEN, and the orchestrator's
// env-propagation path through spawn-session.js is wired separately
// (out-of-scope for the hook itself).
const SPAWN_TOKEN_HEADER_RE = /^[ \t]*#[ \t]*spawn_token[ \t]*:[ \t]*([A-Za-z0-9._-]+)[ \t]*$/;
const SPAWN_TOKEN_PEEK_BYTES = 256;

function extractSpawnToken(content) {
  if (typeof content !== 'string' || content === '') return null;
  // The token MUST be on the first line. Reading further would let an
  // adversarial agent's mid-prompt 'spawn_token: ...' string spoof
  // the header. The orchestrator writes the token as line 1.
  const newlineIdx = content.indexOf('\n');
  const firstLine = newlineIdx === -1 ? content : content.slice(0, newlineIdx);
  const m = SPAWN_TOKEN_HEADER_RE.exec(firstLine);
  return m ? m[1] : null;
}

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
  // Todo 099: tab-bound token from out-of-band channel. Production
  // path reads from process.env. Tests pass `tabToken` directly to
  // exercise the matching/skipping logic without env-var setup.
  const tabToken =
    typeof o.tabToken === 'string'
      ? o.tabToken
      : typeof process.env.AGENT_FLAG_TOKEN === 'string' && process.env.AGENT_FLAG_TOKEN !== ''
        ? process.env.AGENT_FLAG_TOKEN
        : null;

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

    // Todo 099: pre-rename token filter. When AGENT_FLAG_TOKEN is
    // bound, peek at the candidate's first line (no rename) and
    // skip any candidate whose embedded token does not match. This
    // MUST happen BEFORE the destructive `.consuming-*` rename —
    // otherwise the orphan tab would remove the fresh flag and
    // then refuse to deliver it, leaving the intended new tab
    // with no prompt to consume (codex round 7 of PR #22).
    if (tabToken) {
      let peekContent;
      try {
        const fd = fsLib.openSync(cand.path, 'r');
        try {
          const buf = Buffer.alloc(SPAWN_TOKEN_PEEK_BYTES);
          const bytesRead = fsLib.readSync(fd, buf, 0, SPAWN_TOKEN_PEEK_BYTES, 0);
          peekContent = buf.toString('utf8', 0, bytesRead);
        } finally {
          fsLib.closeSync(fd);
        }
      } catch (err) {
        if (err && err.code === 'ENOENT') continue; // race: vanished
        logErr(`peek ${cand.path}: ${err.message}`);
        continue;
      }
      const fileToken = extractSpawnToken(peekContent);
      // Mismatch behavior: skip without rename. A null fileToken
      // (header missing — legacy flag) is also a mismatch when the
      // tab itself was launched with a token; better to fail closed
      // than to consume an unauthenticated prompt.
      if (fileToken !== tabToken) {
        continue;
      }
    }

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
    //
    // Codex round 2 P2: stat MUST happen BEFORE the post-rename
    // revalidation read. Pre-fix the revalidation called readFileSync
    // unconditionally — a swapped-content attack could replace the
    // tiny token-prefixed flag with a multi-MB blob between peek and
    // rename, and the revalidation would OOM-read it before the
    // size check ran. Stat first; reject oversize; only then
    // proceed to revalidation reads.
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

    // Todo 099: post-rename revalidation. A race between peek and
    // rename could swap the file content (extremely unlikely, but
    // the existing protocol assumes atomic-rename guarantees only
    // on the rename itself). Re-read post-rename and bail if the
    // token no longer matches the tab-bound token. Now bounded by
    // the size guard above.
    if (tabToken) {
      let postContent;
      try {
        postContent = fsLib.readFileSync(consumingPath, 'utf8');
      } catch (err) {
        logErr(`revalidate ${consumingPath}: ${err.message}`);
        tryUnlink(fsLib, consumingPath);
        continue;
      }
      const postToken = extractSpawnToken(postContent);
      if (postToken !== tabToken) {
        // Renaming back is unnecessary — the file is now `.consuming-*`
        // and orphan to whichever tab thought it was renaming for
        // itself. Best-effort cleanup; the intended-tab's flag is
        // unaffected because this rename happened on a DIFFERENT
        // candidate (the one whose post-rename content didn't match).
        tryUnlink(fsLib, consumingPath);
        continue;
      }
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
  extractSpawnToken,
  SPAWN_TOKEN_HEADER_RE,
};
