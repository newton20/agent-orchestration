#!/usr/bin/env node
/**
 * parse-manifest.js — validate an agent-orchestrator manifest and emit a
 * normalized JSON representation the orchestrator process consumes.
 *
 * Also supports `--update` mode: mutates the sibling manifest-status.yaml
 * file to record runtime state (PID, status, timestamps). The manifest
 * itself is NEVER modified — the split keeps user-edit and orchestrator-
 * write paths on disjoint files.
 *
 * Exits 0 on success (valid manifest / successful update), 1 on error.
 *
 * CLI:
 *   parse-manifest.js <manifest.yaml>
 *       Validate and emit JSON on stdout.
 *
 *   parse-manifest.js <manifest.yaml> --update <phase-id> key=value [...]
 *       Set one or more fields on the phase's entry in manifest-status.yaml.
 *       Keys: status, pid, started_at, completed_at, error, retry_count.
 *       Values are stored as-is (integers auto-detected, everything else
 *       as string). manifest-status.yaml is created if missing.
 *
 *   parse-manifest.js -h | --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const KNOWN_SHELLS = ['powershell', 'cmd'];
const KNOWN_STATUS = ['pending', 'running', 'completed', 'failed', 'blocked'];
const KNOWN_UPDATE_FIELDS = [
  'status',
  'pid',
  'started_at',
  'completed_at',
  'error',
  'retry_count',
];
const KNOWN_TOP_LEVEL = new Set([
  'name',
  'workdir',
  'launcher',
  'defaults',
  'phases',
]);
const KNOWN_LAUNCHER = new Set([
  'shell',
  'binary',
  'auto_mode_flag',
  'shell_args',
  'passthrough_flags',
]);
const KNOWN_DEFAULTS = new Set([
  'model',
  'phase_timeout_minutes',
  'heartbeat_timeout_minutes',
  'permission_mode',
  'notifications',
]);
const KNOWN_PHASE = new Set([
  'id',
  'title',
  'timeout_minutes',
  'depends_on',
  'parallel_with',
  'review_loop',
  'agent',
  'agents',
  'completion_signal',
]);

// Phase ids must be safe as filesystem path segments AND YAML map keys.
// Enforced by validate() so every downstream consumer (scaffold-protocol,
// spawn-session, runUpdate, future orchestrator) gets the guarantee.
//
// ID character class. Must stay in sync with FLAG_NAME_RE in
// agent-orchestrator/hooks/session-start.js. See docs/todos/006
// for context; change both or neither.
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;
const UNSAFE_ID_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// -------------------- CLI entry --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  parse-manifest.js <manifest.yaml>',
      '      Validate and emit normalized JSON on stdout.',
      '',
      '  parse-manifest.js <manifest.yaml> --update <phase-id> key=value [...]',
      '      Update manifest-status.yaml (sibling file). Keys:',
      `      ${KNOWN_UPDATE_FIELDS.join(', ')}`,
      '',
      'Exit codes: 0 = success, 1 = validation/update error.',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  const out = { manifest: null, update: null, updates: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--update') {
      out.update = argv[++i];
      if (!out.update) fail('--update requires a phase id');
      while (i + 1 < argv.length && argv[i + 1].includes('=')) {
        const raw = argv[++i];
        const eq = raw.indexOf('=');
        const key = raw.slice(0, eq);
        const value = raw.slice(eq + 1);
        if (!KNOWN_UPDATE_FIELDS.includes(key))
          fail(
            `unknown update field "${key}" — known: ${KNOWN_UPDATE_FIELDS.join(', ')}`
          );
        out.updates[key] = coerceValue(value);
      }
      if (Object.keys(out.updates).length === 0)
        fail('--update requires at least one key=value');
    } else if (!a.startsWith('-') && out.manifest === null) {
      out.manifest = a;
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  if (!out.manifest) fail('manifest path required (see --help)');
  return out;
}

function coerceValue(raw) {
  // Integer autodetect. Everything else stays a string. Intentional.
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function fail(msg, code = 1) {
  process.stderr.write(`parse-manifest: ${msg}\n`);
  process.exit(code);
}

// -------------------- Manifest loading + validation --------------------

function loadManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs))
    return { ok: false, error: `manifest not found: ${abs}` };
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read ${abs}: ${e.message}` };
  }
  let parsed;
  try {
    // Pin schema explicitly for parity with spawn-session.js's
    // launcher-manifest load and the runUpdate() status-file load below
    // — preserves merge keys (`<<`) and timestamps; making the choice
    // explicit at every site documents intent.
    parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch (e) {
    // js-yaml errors include a .mark with line / column when available.
    const where = e.mark
      ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})`
      : '';
    return { ok: false, error: `YAML parse error${where}: ${e.reason || e.message}` };
  }
  if (parsed === null || parsed === undefined)
    return { ok: false, error: 'manifest is empty' };
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, error: 'manifest must be a YAML object at the top level' };
  return { ok: true, manifest: parsed, path: abs };
}

function validate(manifest) {
  const errors = [];
  const warnings = [];

  const push = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  // ---- top-level
  for (const k of Object.keys(manifest)) {
    if (!KNOWN_TOP_LEVEL.has(k))
      warn(k, `unknown top-level field "${k}" — ignored (forward-compat)`);
  }

  if (
    manifest.name === undefined ||
    typeof manifest.name !== 'string' ||
    manifest.name.trim() === ''
  )
    push('name', 'missing required field `name` (non-empty string)');

  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) {
    push('phases', 'must be a non-empty array');
    // Without phases, nothing else is useful to validate structurally.
    return { valid: false, errors, warnings };
  }

  // ---- workdir
  if (manifest.workdir !== undefined && typeof manifest.workdir !== 'string')
    push('workdir', 'must be a string (absolute path or path relative to the manifest)');

  // ---- launcher
  if (manifest.launcher !== undefined) {
    const L = validateLauncher(manifest.launcher);
    L.errors.forEach((e) => push(e.path, e.message));
    L.warnings.forEach((w) => warn(w.path, w.message));
  }

  // ---- defaults
  if (manifest.defaults !== undefined) {
    if (typeof manifest.defaults !== 'object' || Array.isArray(manifest.defaults))
      push('defaults', 'must be an object');
    else {
      const D = manifest.defaults;
      for (const k of Object.keys(D)) {
        if (!KNOWN_DEFAULTS.has(k))
          warn(`defaults.${k}`, `unknown defaults field "${k}"`);
      }
      if (D.phase_timeout_minutes !== undefined)
        expectPositiveInt(D.phase_timeout_minutes, 'defaults.phase_timeout_minutes', push);
      if (D.heartbeat_timeout_minutes !== undefined)
        expectPositiveInt(
          D.heartbeat_timeout_minutes,
          'defaults.heartbeat_timeout_minutes',
          push
        );
      if (D.model !== undefined && typeof D.model !== 'string')
        push('defaults.model', 'must be a string');
      if (D.permission_mode !== undefined && typeof D.permission_mode !== 'string')
        push('defaults.permission_mode', 'must be a string');
      if (D.notifications !== undefined) {
        if (typeof D.notifications !== 'object' || Array.isArray(D.notifications))
          push('defaults.notifications', 'must be an object');
        else {
          if (
            D.notifications.enabled !== undefined &&
            typeof D.notifications.enabled !== 'boolean'
          )
            push('defaults.notifications.enabled', 'must be a boolean');
          if (
            D.notifications.email !== undefined &&
            typeof D.notifications.email !== 'string'
          )
            push('defaults.notifications.email', 'must be a string');
        }
      }
    }
  }

  // ---- phases
  const seenIds = new Set();
  manifest.phases.forEach((p, i) => {
    const p_ = `phases[${i}]`;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      push(p_, 'must be an object');
      return;
    }
    for (const k of Object.keys(p)) {
      if (!KNOWN_PHASE.has(k)) warn(`${p_}.${k}`, `unknown phase field "${k}"`);
    }
    if (!p.id || typeof p.id !== 'string' || p.id.trim() === '')
      push(`${p_}.id`, 'missing required field `id` (non-empty string)');
    else if (!VALID_ID_RE.test(p.id))
      push(
        `${p_}.id`,
        `phase id "${p.id}" is not safe as a filesystem/YAML identifier — ` +
          `use [A-Za-z0-9._-]+ (no path separators, whitespace, or traversal)`
      );
    else if (UNSAFE_ID_KEYS.has(p.id))
      push(
        `${p_}.id`,
        `phase id "${p.id}" is a reserved JavaScript property name — ` +
          `avoid __proto__ / prototype / constructor`
      );
    else if (seenIds.has(p.id)) push(`${p_}.id`, `duplicate phase id "${p.id}"`);
    else seenIds.add(p.id);

    if (!p.completion_signal || typeof p.completion_signal !== 'string')
      push(`${p_}.completion_signal`, 'missing required field `completion_signal` (path string)');

    if (p.title !== undefined && typeof p.title !== 'string')
      push(`${p_}.title`, 'must be a string');

    if (p.timeout_minutes !== undefined)
      expectPositiveInt(p.timeout_minutes, `${p_}.timeout_minutes`, push);

    if (p.depends_on !== undefined) {
      if (!Array.isArray(p.depends_on))
        push(`${p_}.depends_on`, 'must be an array of phase ids');
      else
        p.depends_on.forEach((d, j) => {
          if (typeof d !== 'string')
            push(`${p_}.depends_on[${j}]`, 'must be a string (phase id)');
        });
    }
    if (p.parallel_with !== undefined) {
      if (!Array.isArray(p.parallel_with))
        push(`${p_}.parallel_with`, 'must be an array of phase ids');
      else
        p.parallel_with.forEach((d, j) => {
          if (typeof d !== 'string')
            push(`${p_}.parallel_with[${j}]`, 'must be a string (phase id)');
        });
    }

    if (p.review_loop !== undefined) {
      if (typeof p.review_loop !== 'object' || Array.isArray(p.review_loop))
        push(`${p_}.review_loop`, 'must be an object');
      else {
        if (
          p.review_loop.enabled !== undefined &&
          typeof p.review_loop.enabled !== 'boolean'
        )
          push(`${p_}.review_loop.enabled`, 'must be a boolean');
        if (p.review_loop.max_iterations !== undefined)
          expectPositiveInt(
            p.review_loop.max_iterations,
            `${p_}.review_loop.max_iterations`,
            push
          );
      }
    }

    // agent (prototype shorthand) vs agents[] (V1). Both are valid; exactly
    // one is required.
    const hasAgent = p.agent !== undefined;
    const hasAgents = p.agents !== undefined;
    if (!hasAgent && !hasAgents)
      push(`${p_}`, 'must define either `agent` (shorthand) or `agents` (list)');
    else if (hasAgent && hasAgents)
      warn(
        `${p_}`,
        'both `agent` and `agents` defined — `agents` takes precedence, `agent` ignored'
      );
    if (hasAgent) validateAgent(p.agent, `${p_}.agent`, push);
    if (hasAgents) {
      if (!Array.isArray(p.agents) || p.agents.length === 0)
        push(`${p_}.agents`, 'must be a non-empty array');
      else p.agents.forEach((a, j) => validateAgent(a, `${p_}.agents[${j}]`, push));
    }
  });

  // ---- dependency graph
  if (errors.length === 0) {
    const { cycle, order } = analyzeDeps(manifest.phases);
    if (cycle) {
      push('phases', `circular dependency: ${cycle.join(' -> ')}`);
    }
    // execution_order is computed later on the normalized phases so defaults
    // are folded. Return order here so the caller can use it.
    return { valid: errors.length === 0, errors, warnings, executionOrder: order };
  }

  return { valid: false, errors, warnings };
}

/**
 * Validate a launcher block in isolation. Shared between manifest-level
 * validation (via validate()) and callers that receive a launcher object
 * out of band (e.g. spawn-session.js builds a command from a launcher
 * and must refuse an unknown shell the same way the manifest parser does).
 *
 * Returns { errors: [{path, message}], warnings: [{path, message}] }.
 * A non-object launcher yields a single error under path 'launcher'.
 */
function validateLauncher(launcher) {
  const errors = [];
  const warnings = [];
  if (
    launcher === null ||
    typeof launcher !== 'object' ||
    Array.isArray(launcher)
  ) {
    errors.push({ path: 'launcher', message: 'must be an object' });
    return { errors, warnings };
  }
  for (const k of Object.keys(launcher)) {
    if (!KNOWN_LAUNCHER.has(k))
      warnings.push({ path: `launcher.${k}`, message: `unknown launcher field "${k}"` });
  }
  if (launcher.shell !== undefined && !KNOWN_SHELLS.includes(launcher.shell))
    errors.push({
      path: 'launcher.shell',
      message: `must be one of ${KNOWN_SHELLS.join(' | ')}, got ${JSON.stringify(launcher.shell)}`,
    });
  if (launcher.binary !== undefined) {
    if (typeof launcher.binary !== 'string' || launcher.binary.trim() === '')
      errors.push({ path: 'launcher.binary', message: 'must be a non-empty string' });
  }
  if (
    launcher.auto_mode_flag !== undefined &&
    typeof launcher.auto_mode_flag !== 'string'
  )
    errors.push({
      path: 'launcher.auto_mode_flag',
      message: 'must be a string (empty string to omit)',
    });
  if (launcher.shell_args !== undefined && typeof launcher.shell_args !== 'string')
    errors.push({ path: 'launcher.shell_args', message: 'must be a string' });
  if (launcher.passthrough_flags !== undefined) {
    if (!Array.isArray(launcher.passthrough_flags))
      errors.push({
        path: 'launcher.passthrough_flags',
        message: 'must be an array of strings',
      });
    else
      launcher.passthrough_flags.forEach((v, i) => {
        if (typeof v !== 'string')
          errors.push({
            path: `launcher.passthrough_flags[${i}]`,
            message: 'must be a string',
          });
      });
  }
  return { errors, warnings };
}

function validateAgent(a, p_, push) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) {
    push(p_, 'must be an object');
    return;
  }
  if (a.role === undefined || typeof a.role !== 'string' || a.role.trim() === '')
    push(`${p_}.role`, 'missing required field `role` (non-empty string)');
  if (a.model !== undefined && typeof a.model !== 'string')
    push(`${p_}.model`, 'must be a string');
  if (a.prompt_file !== undefined && typeof a.prompt_file !== 'string')
    push(`${p_}.prompt_file`, 'must be a string (path)');
  if (a.plugin_dir !== undefined && typeof a.plugin_dir !== 'string')
    push(`${p_}.plugin_dir`, 'must be a string (path)');
}

function expectPositiveInt(v, p_, push) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0)
    push(p_, `must be a positive integer, got ${JSON.stringify(v)}`);
}

// -------------------- Dependency graph --------------------

/**
 * Topological sort via Kahn's algorithm. When a cycle exists, falls back
 * to a DFS that returns the actual cycle path (not just the unsorted
 * residue — residue includes downstream nodes reachable from the cycle,
 * which is misleading in the error message).
 *
 * Returns { order: string[] | null, cycle: string[] | null }. On cycle,
 * `cycle` is a ring of node ids that proves the circularity — e.g.
 * ['a', 'b', 'c', 'a'] for a -> b -> c -> a.
 */
function analyzeDeps(phases) {
  const ids = phases.map((p) => p.id);
  const idSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const edges = new Map(ids.map((id) => [id, []]));
  const deps = new Map(ids.map((id) => [id, []]));

  for (const p of phases) {
    const ds = Array.isArray(p.depends_on) ? p.depends_on : [];
    for (const d of ds) {
      if (!idSet.has(d)) continue; // dangling — surfaced separately
      edges.get(d).push(p.id);
      deps.get(p.id).push(d);
      indeg.set(p.id, indeg.get(p.id) + 1);
    }
  }

  const queue = ids.filter((id) => indeg.get(id) === 0);
  const indegWork = new Map(indeg);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of edges.get(id)) {
      indegWork.set(next, indegWork.get(next) - 1);
      if (indegWork.get(next) === 0) queue.push(next);
    }
  }
  if (order.length === ids.length) return { order, cycle: null };

  // Cycle exists. Find the shortest actual cycle via DFS from each
  // still-in-degree node, walking depends_on edges (reverse of execution).
  const residue = new Set(ids.filter((id) => indegWork.get(id) > 0));
  const cycle = findCycle(ids, deps, residue);
  return { order: null, cycle };
}

function findCycle(ids, deps, residue) {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const stack = [];
  const seen = new Set();

  const starts = residue.size > 0 ? [...residue] : ids;
  for (const start of starts) {
    if (color.get(start) !== WHITE) continue;
    const path = dfsFindCycle(start, deps, color);
    if (path) return path;
  }
  return null;

  function dfsFindCycle(node, deps, color) {
    if (seen.has(node)) return null;
    color.set(node, GRAY);
    stack.push(node);
    for (const d of deps.get(node) || []) {
      if (color.get(d) === GRAY) {
        // Found a back-edge: cycle is stack from `d` to end + back to `d`.
        const idx = stack.indexOf(d);
        return [...stack.slice(idx), d];
      }
      if (color.get(d) === WHITE) {
        const found = dfsFindCycle(d, deps, color);
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    seen.add(node);
    return null;
  }
}

// -------------------- Dangling dep check (runs before graph) --------------------

function findDanglingDeps(phases) {
  const ids = new Set(phases.map((p) => p.id).filter(Boolean));
  const dangling = [];
  phases.forEach((p, i) => {
    if (Array.isArray(p.depends_on)) {
      p.depends_on.forEach((d, j) => {
        if (typeof d === 'string' && !ids.has(d))
          dangling.push({
            path: `phases[${i}].depends_on[${j}]`,
            message: `references unknown phase "${d}"`,
          });
      });
    }
    if (Array.isArray(p.parallel_with)) {
      p.parallel_with.forEach((d, j) => {
        if (typeof d === 'string' && !ids.has(d))
          dangling.push({
            path: `phases[${i}].parallel_with[${j}]`,
            message: `references unknown phase "${d}"`,
          });
      });
    }
  });
  return dangling;
}

// -------------------- Normalize: fold defaults into phases --------------------

function normalizePhases(manifest) {
  const D = manifest.defaults || {};
  return manifest.phases.map((p) => {
    const timeoutMin =
      p.timeout_minutes !== undefined
        ? p.timeout_minutes
        : D.phase_timeout_minutes !== undefined
          ? D.phase_timeout_minutes
          : null;
    const agents = p.agents
      ? p.agents.map((a) => normalizeAgent(a, D))
      : p.agent
        ? [normalizeAgent(p.agent, D)]
        : [];
    return {
      id: p.id,
      title: p.title || null,
      timeout_minutes: timeoutMin,
      depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
      parallel_with: Array.isArray(p.parallel_with) ? p.parallel_with : [],
      review_loop: p.review_loop
        ? {
            enabled: p.review_loop.enabled === true,
            max_iterations: p.review_loop.max_iterations || 3,
          }
        : { enabled: false, max_iterations: 3 },
      agents,
      completion_signal: p.completion_signal,
    };
  });
}

function normalizeAgent(a, defaults) {
  return {
    role: a.role || 'impl',
    model: a.model || defaults.model || null,
    prompt_file: a.prompt_file || null,
    plugin_dir: a.plugin_dir || null,
  };
}

// -------------------- Validate mode --------------------

function runValidate(manifestPath) {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) {
    emit({ valid: false, errors: [{ path: '', message: loaded.error }], warnings: [] });
    process.exit(1);
  }

  const { manifest } = loaded;

  // Dangling deps are checked before graph analysis so the caller gets a
  // specific error instead of a generic "cycle" message for a missing node.
  const dangling = findDanglingDeps(manifest.phases || []);
  const result = validate(manifest);
  result.errors = [...dangling, ...result.errors];
  result.valid = result.errors.length === 0;

  if (!result.valid) {
    emit({ valid: false, errors: result.errors, warnings: result.warnings });
    process.exit(1);
  }

  const phasesResolved = normalizePhases(manifest);
  emit({
    valid: true,
    manifest,
    phases_resolved: phasesResolved,
    execution_order: result.executionOrder,
    warnings: result.warnings,
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// -------------------- Update mode --------------------

function statusPathFor(manifestPath) {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath, path.extname(manifestPath));
  return path.join(dir, `${base}-status.yaml`);
}

// Phase-id validation (VALID_ID_RE / UNSAFE_ID_KEYS) is declared near
// the top of this file and enforced by validate(). runUpdate still checks
// the provided phaseId independently because the caller passes it on the
// command line, bypassing the manifest validator.

/**
 * Testable update entry point. Returns { ok: true, status_file, phase,
 * updates } on success, { ok: false, error } on any validation failure.
 * Never calls process.exit — callers (CLI main) do that.
 */
function runUpdate(manifestPath, phaseId, updates) {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const dangling = findDanglingDeps(
    Array.isArray(loaded.manifest.phases) ? loaded.manifest.phases : []
  );
  const vresult = validate(loaded.manifest);
  if (dangling.length > 0 || !vresult.valid) {
    const errs = [...dangling, ...vresult.errors]
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    return {
      ok: false,
      error: `manifest is invalid — cannot update status: ${errs}`,
    };
  }

  if (
    typeof phaseId !== 'string' ||
    UNSAFE_ID_KEYS.has(phaseId) ||
    !VALID_ID_RE.test(phaseId)
  )
    return {
      ok: false,
      error:
        `phase id "${phaseId}" is not safe as a YAML map key — ` +
        `use [A-Za-z0-9._-]+ and avoid __proto__/prototype/constructor`,
    };

  const ids = new Set(loaded.manifest.phases.map((p) => p.id));
  if (!ids.has(phaseId))
    return {
      ok: false,
      error: `phase "${phaseId}" not found in ${manifestPath}`,
    };

  if (
    updates.status !== undefined &&
    !KNOWN_STATUS.includes(String(updates.status))
  )
    return {
      ok: false,
      error:
        `status must be one of ${KNOWN_STATUS.join(' | ')}, got ${JSON.stringify(updates.status)}`,
    };
  if (updates.pid !== undefined && !Number.isInteger(updates.pid))
    return {
      ok: false,
      error: `pid must be an integer, got ${JSON.stringify(updates.pid)}`,
    };
  if (
    updates.retry_count !== undefined &&
    !Number.isInteger(updates.retry_count)
  )
    return {
      ok: false,
      error: `retry_count must be an integer, got ${JSON.stringify(updates.retry_count)}`,
    };

  const statusPath = statusPathFor(path.resolve(manifestPath));
  let status = { phases: Object.create(null) };
  if (fs.existsSync(statusPath)) {
    const raw = fs.readFileSync(statusPath, 'utf8');
    let parsed;
    try {
      // Pin schema explicitly for parity with the loadManifest() call
      // above and spawn-session.js's launcher load — preserves merge
      // keys (`<<`) and timestamps; making the choice explicit at every
      // site documents intent.
      parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
    } catch (e) {
      return {
        ok: false,
        error: `corrupt status file at ${statusPath}: ${e.message}`,
      };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      status = parsed;
      if (
        !status.phases ||
        typeof status.phases !== 'object' ||
        Array.isArray(status.phases)
      )
        status.phases = Object.create(null);
      else {
        const safe = Object.create(null);
        for (const k of Object.keys(status.phases))
          if (!UNSAFE_ID_KEYS.has(k)) safe[k] = status.phases[k];
        status.phases = safe;
      }
    }
  }

  const existing = status.phases[phaseId] || {};
  status.phases[phaseId] = { ...existing, ...updates };
  status.updated_at = new Date().toISOString();

  const header =
    '# auto-generated by parse-manifest.js --update; do not hand-edit\n' +
    '# runtime state for the orchestrator; the user-owned manifest is the sibling file\n';
  fs.writeFileSync(statusPath, header + yaml.dump(status));
  return { ok: true, status_file: statusPath, phase: phaseId, updates };
}

// -------------------- Entry --------------------

function main() {
  const args = parseCliArgs(process.argv);
  if (args.update) {
    const result = runUpdate(args.manifest, args.update, args.updates);
    if (!result.ok) fail(result.error);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          status_file: result.status_file,
          phase: result.phase,
          updates: result.updates,
        },
        null,
        2
      ) + '\n'
    );
  } else runValidate(args.manifest);
}

// Run only when invoked as a script. Under `node --test` or `require`d,
// the functions stay testable.
if (require.main === module) main();

module.exports = {
  loadManifest,
  validate,
  validateLauncher,
  findDanglingDeps,
  analyzeDeps,
  normalizePhases,
  statusPathFor,
  runUpdate,
  KNOWN_SHELLS,
  VALID_ID_RE,
};
