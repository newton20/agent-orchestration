#!/usr/bin/env node
/**
 * generate-prompt.js — render an orchestration prompt from a role
 * template + the universal protocol header, into a phase directory the
 * spawned Claude session will read on SessionStart.
 *
 * The contract is documented in agent-orchestrator/templates/README.md
 * (the authoritative variable catalog and interpolation contract).
 * Where the plan and the README diverge, the README wins — it absorbed
 * three rounds of pre-Unit-7 hardening (PRs #5/#6/#7/#9/#11) the plan
 * was written before.
 *
 * Public API:
 *
 *   generatePrompt({
 *     role,                 // 'impl' | 'qa' | 'coord' | 'recovery'
 *     recoveryRole,         // when role === 'recovery': underlying role
 *     phaseId,              // matches VALID_ID_RE
 *     templatesDir,         // absolute path to templates/ dir
 *     projectName, workdir, phaseDir,
 *     completionSignalPath, // optional override; default derived
 *     priorPhaseSignals,    // array of completion-signal paths
 *     heartbeatPath,
 *     suggestedCommitMessage,
 *     // role / recovery content blocks (per templates/README.md catalog):
 *     planUnits,            // pre-rendered plan excerpt; or set planPath + planUnitMarker
 *     planPath, planUnitMarker,
 *     outputPaths,
 *     previousPhaseBriefing,// pre-rendered; or auto-derived from priorPhaseSignals
 *     prOrBranchUnderTest,
 *     qaScopeRows,
 *     testCommandsBlock,
 *     statusSummaryBlock, decisionsBlock, openQuestionsBlock,
 *     planReferenceBlock, projectContextBlock, gitDetailsBlock,
 *     warningsBlock, artifactPointer, coordNextActions,
 *     recoveryCheckpointPath, crashTimestamp, lastHeartbeatTimestamp,
 *     priorSessionPid, completedCheckpointsBlock, remainingWorkBlock,
 *   }) -> { promptPath, charCount, varsUsed, warnings }
 *
 * Design decisions for the seven Open Questions raised in
 * templates/README.md and the Unit 7 dispatch handoff are recorded in
 * the same README's "Unit 7 design decisions" section. The short list:
 *   1. Plan-excerpt literals — interpolation is one-pass; nested
 *      `{{...}}` inside fenced code blocks survives as text.
 *   2. Newline normalization — output is LF on every platform.
 *   3. Catalog sync — README-only. No JSON mirror until a 2nd consumer.
 *   4. Empty-state placeholder owner — generatePrompt injects
 *      `(no decisions captured)`, `(no open questions)`, and
 *      `(no warnings)` when the caller passes empty / null / undefined
 *      for `decisions_block`, `open_questions_block`, or
 *      `warnings_block`. Callers can pass `""` indifferently.
 *   5. `dispatcher_advisories` parser accepts the integer V1 form;
 *      non-zero counts on upstream signals surface in the returned
 *      `warnings` array so the orchestrator can route investigation.
 *   6. Re-declaration transitive drift — `qa_playbook_block` is the
 *      only nested template today; checkTransitiveDrift hardcodes the
 *      special case and emits a warning (not an error) when a
 *      template inlines `{{qa_playbook_block}}` without re-declaring
 *      every var that `qa-playbook-prompt.md` declares.
 *   7. Render-size methodology — `charCount` measures the
 *      post-frontmatter, post-substitution, pre-write text the file
 *      will contain (after LF normalization).
 *
 * Three load-bearing invariants downstream readers must preserve:
 *
 *   A. Function-form replace. Every `{{var}}` substitution uses
 *      `String.prototype.replace(regex, () => value)`, NOT
 *      `replace(regex, value)`. The 2nd-arg form interprets `$&`,
 *      `$$`, `$'`, `` $` ``, `$<name>` as backreferences and silently
 *      corrupts shell snippets, regex examples, and jq filters in
 *      `plan_units`. PR #6 fix 9a1f927 caught this; the discipline is
 *      load-bearing.
 *   B. One-pass interpolation. The body-scan replace uses a single
 *      regex `/\{\{([A-Za-z0-9_]+)\}\}/g` with one match per spot.
 *      Substituted content is not re-scanned, so a `{{plan_units}}`
 *      value containing the literal `{{role}}` (e.g. inside a code
 *      fence demonstrating template syntax) survives as text.
 *   C. Original-prompt preservation is idempotent. On a recovery
 *      dispatch, the live `${role}-prompt.md` is copied to
 *      `${role}-prompt.original.md` ONLY when that target does not
 *      already exist. Re-recovery dispatches see the slot is taken
 *      and skip the copy, so the slot continues to hold the FIRST
 *      non-recovery prompt across the entire crash chain — see
 *      templates/README.md §5 and docs/todos/017.
 *
 * CLI:
 *   generate-prompt.js --role <role> --phase <id> --output <dir>
 *                      [--templates <dir>] [--workdir <dir>]
 *                      [--project <name>] [--plan <path>]
 *                      [--unit-marker <marker>] [--context <json-path>]
 *                      [--dry-run]
 *
 * Exits 0 on success, 1 on validation / IO error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { VALID_ID_RE } = require('./parse-manifest');

// -------------------- Constants --------------------

const VALID_ROLES = ['impl', 'qa', 'coord', 'recovery'];
const VALID_RECOVERY_ROLES = ['impl', 'qa', 'coord'];

// Map dispatch role → role-template filename. The protocol header is
// prepended regardless. `coord` uses `coordinator-briefing.md` (the
// template name diverges from the role name; the output path always
// uses the role-name form `${effectiveRole}-prompt.md`).
const ROLE_TEMPLATES = Object.freeze({
  impl: 'impl-prompt.md',
  qa: 'qa-prompt.md',
  coord: 'coordinator-briefing.md',
  recovery: 'recovery-prompt.md',
});

const PROTOCOL_HEADER_FILE = 'protocol-header.md';
const QA_PLAYBOOK_FILE = 'qa-playbook-prompt.md';

// Three coord-specific blocks always render an explicit literal
// placeholder rather than empty prose. The reader must distinguish
// "we looked and found nothing" from "we forgot to look." Per
// templates/README.md "Empty-state rendering". Owner: Unit 7 — the
// caller can pass "" / null / undefined indifferently.
const EMPTY_STATE_PLACEHOLDERS = Object.freeze({
  decisions_block: '(no decisions captured)',
  open_questions_block: '(no open questions)',
  warnings_block: '(no warnings)',
});

// Single regex used for body-scan interpolation. One pass over the
// template; substituted content is NOT re-scanned (Open Question #1
// resolution). The character class matches the template authoring
// convention (lowercase + underscores + digits).
const INTERP_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

// -------------------- Frontmatter parse --------------------

/**
 * Split a template into { frontmatter, body }. Frontmatter is the
 * leading YAML block delimited by `---` lines. Body is everything
 * after the closing `---` (with one leading newline stripped).
 *
 * Returns { frontmatter: object | null, body: string }. A null
 * frontmatter means the template did not begin with `---` — every
 * orchestration template must declare frontmatter, so callers should
 * treat null as a render error.
 */
function parseFrontmatter(text) {
  // Normalize line endings up-front so the rest of the function only
  // reasons about LF. Templates check into the repo with LF, but a
  // hand-edit on Windows or a misconfigured git autocrlf could land
  // CRLF — the parser must tolerate either without surprising the
  // template author with "missing frontmatter" errors.
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!norm.startsWith('---\n')) return { frontmatter: null, body: norm };
  // Use start-position 3 (not 4) so a fully-empty frontmatter
  // (`---\n---\nbody`) parses correctly — the closing `\n---\n`
  // begins at the newline immediately after the opening fence.
  const closeIdx = norm.indexOf('\n---\n', 3);
  if (closeIdx < 0) return { frontmatter: null, body: norm };
  const fmText = norm.slice(4, closeIdx);
  const body = norm.slice(closeIdx + 5);
  let frontmatter;
  try {
    frontmatter = yaml.load(fmText, { schema: yaml.DEFAULT_SCHEMA });
  } catch (err) {
    throw new Error(`frontmatter YAML parse error: ${err.message}`);
  }
  return { frontmatter: frontmatter || {}, body };
}

// -------------------- Body interpolation --------------------

/**
 * Do a single-pass replace of `{{var}}` patterns in `body` using the
 * `context` map. Function-form replacement: backreferences in the
 * value (`$&`, `$$`, `$'`, `` $` ``, `$<name>`, `$1`) are NEVER
 * interpreted — they pass through verbatim. This is load-bearing for
 * `plan_units`, regex examples, jq filters, and shell snippets.
 *
 * Throws if a body var is referenced but not present as an own
 * property of `context`. Validation must run before interpolate to
 * surface useful template-author errors; this throw is a defense in
 * depth.
 */
function interpolate(body, context) {
  return body.replace(INTERP_RE, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(context, name)) {
      const v = context[name];
      return v == null ? '' : String(v);
    }
    throw new Error(`interpolation: unknown variable {{${name}}} in body`);
  });
}

// -------------------- Template render + validation --------------------

/**
 * Render a template against a context. Performs three checks:
 *
 *   (i)  Every body `{{var}}` must appear in the frontmatter's
 *        `required ∪ optional` set. Otherwise the template author
 *        forgot to declare the variable; Unit 7 throws so the lint
 *        error surfaces at render time rather than silently shipping
 *        an unsubstituted `{{var}}` into the agent's prompt.
 *   (ii) Every `required` variable must be present and non-empty in
 *        `context`. Empty-string values for required variables are
 *        rejected — except the three coord-specific blocks listed in
 *        EMPTY_STATE_PLACEHOLDERS, which are auto-filled with
 *        placeholders before validation runs (see callers).
 *   (iii) `optional` variables that are absent default to empty
 *         strings; the surrounding template prose handles the empty
 *         case.
 *
 * Returns { text, varsUsed, warnings }.
 */
function renderTemplate(template, context, opts) {
  const tn = (opts && opts.templateName) || '<template>';
  const { frontmatter, body } = parseFrontmatter(template);
  if (!frontmatter) {
    throw new Error(`template ${tn}: missing YAML frontmatter (must begin with --- delimiter)`);
  }
  const required = Array.isArray(frontmatter.required) ? frontmatter.required : [];
  const optional = Array.isArray(frontmatter.optional) ? frontmatter.optional : [];
  const declared = new Set([...required, ...optional]);

  // Discover all body-referenced variables and validate each is
  // declared. Iterate via String.replace + an accumulator rather than
  // matchAll() so the body is scanned exactly once.
  const referenced = new Set();
  body.replace(INTERP_RE, (_m, name) => {
    referenced.add(name);
    return '';
  });
  const undeclared = [...referenced].filter((v) => !declared.has(v));
  if (undeclared.length > 0) {
    throw new Error(
      `template ${tn}: body references {{${undeclared.join('}}, {{')}}} ` +
        `but frontmatter does not declare them — every body variable must ` +
        `appear in required or optional`,
    );
  }

  // Validate required vars are present and produce non-empty
  // substituted text. Coerce to string FIRST and then check for
  // emptiness — a bare `''` check passes `[]` (codex round 11)
  // because an empty array is neither undefined/null nor a string,
  // yet interpolate() renders it as `String([])` = `''`, leaving a
  // load-bearing required block empty in the prompt. Catching
  // post-coercion emptiness covers `[]`, `''`, `null`, `undefined`,
  // and any future malformed shape that string-coerces to empty.
  // Empty-state placeholder injection has already run at the call
  // site for the three coord blocks (decisions / open_questions /
  // warnings), so a coerce-empty value here is genuinely a caller
  // bug rather than the legit empty-state form.
  for (const name of required) {
    const v = context[name];
    if (v === undefined || v === null) {
      throw new Error(`template ${tn}: required variable "${name}" is missing in context`);
    }
    if (String(v) === '') {
      throw new Error(
        `template ${tn}: required variable "${name}" coerces to the empty string ` +
          `(got ${JSON.stringify(v)}) — would leave the substitution position empty in the rendered prompt`,
      );
    }
  }

  // Build the per-render context: declared vars only, falling back
  // to empty strings for optional vars the caller did not supply.
  // Limiting the context to declared vars hardens against accidental
  // body-substitution of internal helpers.
  const renderCtx = Object.create(null);
  for (const name of declared) {
    if (Object.prototype.hasOwnProperty.call(context, name)) {
      renderCtx[name] = context[name];
    } else {
      renderCtx[name] = '';
    }
  }

  const text = interpolate(body, renderCtx);
  return { text, varsUsed: [...referenced], warnings: [] };
}

// -------------------- Transitive-drift warning --------------------

/**
 * Open Question #6, Option A — hardcode the qa_playbook_block special
 * case.
 *
 * If a template's body inlines `{{qa_playbook_block}}`, the
 * template's required+optional union must contain every variable
 * `qa-playbook-prompt.md` declares. Unit 7's renderer treats each
 * template's frontmatter as the complete variable surface for that
 * template (no transitive walk), so authors of nesting templates
 * must re-declare the inner template's vars manually.
 *
 * Returns an array of warning strings. Empty array means the
 * template is in lockstep with the playbook.
 */
function checkTransitiveDrift(templateText, templatesDir, templateName) {
  const { frontmatter, body } = parseFrontmatter(templateText);
  if (!frontmatter || !body.includes('{{qa_playbook_block}}')) return [];
  const playbookPath = path.join(templatesDir, QA_PLAYBOOK_FILE);
  let playbookText;
  try {
    playbookText = fs.readFileSync(playbookPath, 'utf8');
  } catch (_err) {
    // Playbook not on disk → can't check. Leave silent; the missing
    // playbook will surface as a render-time error elsewhere.
    return [];
  }
  const { frontmatter: pbFm } = parseFrontmatter(playbookText);
  if (!pbFm) return [];
  const playbookVars = [
    ...(Array.isArray(pbFm.required) ? pbFm.required : []),
    ...(Array.isArray(pbFm.optional) ? pbFm.optional : []),
  ];
  const declared = new Set([
    ...(Array.isArray(frontmatter.required) ? frontmatter.required : []),
    ...(Array.isArray(frontmatter.optional) ? frontmatter.optional : []),
  ]);
  const missing = playbookVars.filter((v) => !declared.has(v));
  if (missing.length === 0) return [];
  return [
    `transitive-drift: ${templateName} inlines {{qa_playbook_block}} but ` +
      `does not re-declare ${missing.map((m) => `"${m}"`).join(', ')} in its ` +
      `frontmatter — qa-playbook-prompt.md declares these vars and the ` +
      `re-declaration convention requires X to list every var Y declares ` +
      `when X inlines Y. See templates/README.md "Re-declaration convention".`,
  ];
}

// -------------------- Plan-excerpt extraction --------------------

/**
 * Extract a unit's section from a plan markdown file. Matches the
 * `- [ ] **Unit <marker>:**` (or `- [x]`) heading and captures
 * everything up to the next sibling `- [ ] **Unit ` heading or the
 * end of file.
 *
 * The marker is matched verbatim (regex-escaped); the caller is
 * responsible for the phaseId → unit-marker mapping. The plan uses
 * unit numbers (`Unit 7`, `Unit 4.5`) while phase ids are arbitrary
 * (`phase-7`, `phase-implementation`); making the marker an explicit
 * argument keeps Unit 7 out of the phase→unit mapping policy. Unit
 * 11 (caller) consults the manifest for the mapping.
 *
 * Throws if no matching unit is found.
 */
function extractPlanUnit(planPath, unitMarker) {
  if (typeof unitMarker !== 'string' || unitMarker.length === 0) {
    throw new Error('extractPlanUnit: unitMarker must be a non-empty string');
  }
  const text = fs.readFileSync(planPath, 'utf8');
  const escaped = escapeRegExp(unitMarker);
  // Match a heading bullet whose marker is immediately followed by
  // `:` (the project's plan format always uses `**Unit N: Title**`).
  // Anchoring to `:` rather than the laxer `[:.\s]` lookahead is
  // important because `.` would let marker `4` prefix-match
  // `Unit 4.5` — codex P2 round 1 flagged this drift between intent
  // ("find Unit 4 exactly") and behavior ("find anything starting
  // with Unit 4"). The only valid suffix in our plan format is the
  // colon that introduces the title. Body extends until the next
  // sibling unit heading or EOF.
  const headingRe = new RegExp(
    `^- \\[[ x]\\] \\*\\*Unit ${escaped}:`,
    'm',
  );
  const startMatch = text.match(headingRe);
  if (!startMatch) {
    throw new Error(
      `extractPlanUnit: no unit matching "${unitMarker}" found in ${planPath} ` +
        `(searched for line starting with "- [ ] **Unit ${unitMarker}:")`,
    );
  }
  const startIdx = startMatch.index;
  // From the heading's start, find the next sibling heading.
  const nextRe = /^- \[[ x]\] \*\*Unit /m;
  const tail = text.slice(startIdx + startMatch[0].length);
  const nextMatch = tail.match(nextRe);
  const endIdx =
    nextMatch == null ? text.length : startIdx + startMatch[0].length + nextMatch.index;
  return text.slice(startIdx, endIdx).trimEnd();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------- Previous-phase briefing --------------------

/**
 * Concatenate completion signals from upstream phases, separated by
 * `---` rules so a downstream agent can read each one as its own
 * section. The full file content (frontmatter + body) is passed
 * through; the agent that consumes the briefing already knows the
 * shape of a completion signal and ignores frontmatter as needed.
 *
 * Also parses each signal's frontmatter to extract
 * `dispatcher_advisories`. Non-zero counts surface as warnings the
 * caller (Unit 11) can route to coord investigation. The V1 schema
 * stores the count as a non-negative integer; this parser accepts
 * that form and warns on any other shape (Open Question #5).
 *
 * Returns { briefing: string, warnings: string[] }.
 */
function buildPreviousPhaseBriefing(priorPhaseSignals) {
  if (!Array.isArray(priorPhaseSignals) || priorPhaseSignals.length === 0) {
    return { briefing: '', warnings: [] };
  }
  const sections = [];
  const warnings = [];
  for (const signalPath of priorPhaseSignals) {
    if (typeof signalPath !== 'string' || signalPath === '') continue;
    let content;
    try {
      content = fs.readFileSync(signalPath, 'utf8');
    } catch (err) {
      warnings.push(
        `previous-phase-briefing: cannot read upstream signal at ${signalPath}: ${err.message}`,
      );
      continue;
    }
    sections.push(content.trimEnd());
    // Surface non-zero dispatcher_advisories so the orchestrator can
    // detect dispatcher / prompt-generation bugs from frontmatter
    // alone, without the next agent having to read prose.
    const { frontmatter } = (() => {
      try {
        return parseFrontmatter(content);
      } catch (err) {
        warnings.push(`upstream signal ${signalPath} has malformed frontmatter: ${err.message}`);
        return { frontmatter: null };
      }
    })();
    if (frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, 'dispatcher_advisories')) {
      const v = frontmatter.dispatcher_advisories;
      if (!Number.isInteger(v) || v < 0) {
        warnings.push(
          `upstream signal ${signalPath}: dispatcher_advisories must be a non-negative ` +
            `integer (V1 schema), got ${JSON.stringify(v)}`,
        );
      } else if (v > 0) {
        warnings.push(
          `upstream signal ${signalPath}: dispatcher_advisories=${v} — ` +
            `coord should investigate the dispatcher / prompt generator before ` +
            `the next phase advances`,
        );
      }
    }
  }
  // Two blank lines + an `---` rule + two blank lines is the same
  // section divider used elsewhere in the project's markdown.
  return { briefing: sections.join('\n\n---\n\n'), warnings };
}

// -------------------- Original-prompt preservation --------------------

/**
 * Idempotent pre-recovery preservation. Before overwriting the live
 * `${role}-prompt.md` with a recovery prompt, copy it to
 * `${role}-prompt.original.md` if-not-exists. Re-recovery dispatches
 * see the `.original.md` slot is taken and skip the copy, so the
 * slot continues to hold the FIRST non-recovery prompt across the
 * entire crash chain.
 *
 * The .original.md slot is what the recovery template's audit step
 * reads to distinguish "the briefing was legitimately empty for this
 * phase" from "the recovery dispatch dropped mandatory context."
 * Without the preservation, a recovered impl/qa session has no way
 * to tell those two cases apart and conservatively blocks. See
 * templates/README.md §5 and docs/todos/017.
 *
 * No-op (returns false) if the live file does not exist — the
 * caller is on the very first dispatch for this role and there is
 * nothing to preserve. Returns true if a copy was performed (the
 * common case for first recovery), false if the slot was already
 * taken (re-recovery) or the live file was absent.
 */
function preserveOriginalPrompt(outputDir, effectiveRole) {
  const livePath = path.join(outputDir, `${effectiveRole}-prompt.md`);
  const origPath = path.join(outputDir, `${effectiveRole}-prompt.original.md`);
  if (!fs.existsSync(livePath)) return false;
  if (fs.existsSync(origPath)) return false;
  const live = fs.readFileSync(livePath, 'utf8');
  atomicWrite(origPath, live);
  return true;
}

// -------------------- Atomic write + LF normalization --------------------

/**
 * Normalize all CRLF and bare-CR line endings to LF. Open Question
 * #2 resolution: Unit 7 always writes LF on every platform. Stable
 * diffs across the Windows / Unix mixed authoring this project
 * assumes; agents that read prompts on either OS see the same bytes.
 */
function normalizeLineEndings(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Write `content` to `targetPath` atomically.
 *
 * The tmp file is written into the same directory as the target so
 * the rename is a same-filesystem operation (POSIX `rename(2)` is
 * atomic only within a filesystem; cross-volume returns EXDEV — see
 * docs/todos/037 for the writer-side contract). The tmp basename is
 * deliberately distinct from the FLAG_NAME_RE shape (`.pending-*`)
 * and from the recovery-prompt audit step's `.original.md` shape so
 * a half-written tmp file cannot collide with either invariant.
 */
function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(targetPath);
  const tmpName = `.${base}.gp-tmp-${process.pid}-${Date.now()}`;
  const tmpPath = path.join(dir, tmpName);
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
  fs.renameSync(tmpPath, targetPath);
}

// -------------------- Context assembly --------------------

/**
 * Build the per-render context the templates substitute against,
 * given the public `generatePrompt` opts.
 *
 * Infrastructure variables (role, phase_id, phase_dir, etc.) are
 * derived from top-level opts. Content variables (plan_units,
 * decisions_block, etc.) are taken from opts when supplied or
 * computed from helpers (planPath / priorPhaseSignals) when not.
 * Empty-state placeholders are injected here so renderTemplate's
 * `required` validation passes on legitimately-empty coord blocks.
 */
function buildContext(opts, effectiveRole, derivedWarnings) {
  const ctx = Object.create(null);
  ctx.role = effectiveRole;
  ctx.phase_id = opts.phaseId;
  ctx.project_name = opts.projectName || '';
  ctx.workdir = opts.workdir || '';
  ctx.phase_dir = opts.phaseDir || '';
  ctx.completion_signal_path = opts.completionSignalPath || '';
  ctx.heartbeat_path = opts.heartbeatPath || '';
  ctx.suggested_commit_message = opts.suggestedCommitMessage || '';

  // prior_phase_dirs: newline-joined absolute paths. The header's
  // body uses the variable as a paragraph block, so an empty list
  // renders as the empty string (the header's surrounding prose
  // handles the empty case).
  if (typeof opts.priorPhaseDirsBlock === 'string') {
    ctx.prior_phase_dirs = opts.priorPhaseDirsBlock;
  } else if (Array.isArray(opts.priorPhaseSignals)) {
    ctx.prior_phase_dirs = opts.priorPhaseSignals.filter((p) => typeof p === 'string' && p).join('\n');
  } else {
    ctx.prior_phase_dirs = '';
  }

  // plan_units: caller may pre-render or pass planPath +
  // planUnitMarker for in-generator extraction. Empty string is
  // NOT an explicit pre-rendered plan — like previousPhaseBriefing
  // (codex round 10), only a non-empty string is an explicit
  // override. Codex round 13 caught the same class of bug here.
  if (typeof opts.planUnits === 'string' && opts.planUnits !== '') {
    ctx.plan_units = opts.planUnits;
  } else if (typeof opts.planPath === 'string' && typeof opts.planUnitMarker === 'string') {
    ctx.plan_units = extractPlanUnit(opts.planPath, opts.planUnitMarker);
  } else {
    ctx.plan_units = '';
  }

  // previous_phase_briefing: caller may pre-render, or generator
  // builds from priorPhaseSignals. Either way, parse upstream
  // signals for dispatcher_advisories warnings if they're available.
  //
  // Codex round 6 caught a case where a caller passing BOTH the
  // pre-rendered briefing AND priorPhaseSignals would silently drop
  // the warnings; codex round 10 caught the inverse case where a
  // caller passing an empty-string previousPhaseBriefing (often the
  // default in test helpers) plus non-empty priorPhaseSignals would
  // silently drop the inlined briefing CONTENT. An empty string is
  // not an explicit pre-rendered briefing — it's "I don't have one,
  // build it from signals if available." Only a non-empty string
  // is an explicit override.
  const hasPrerendered =
    typeof opts.previousPhaseBriefing === 'string' && opts.previousPhaseBriefing !== '';
  const hasSignals =
    Array.isArray(opts.priorPhaseSignals) && opts.priorPhaseSignals.length > 0;
  if (hasPrerendered) {
    ctx.previous_phase_briefing = opts.previousPhaseBriefing;
    if (hasSignals) {
      // Keep the caller's pre-rendered text but still parse signals
      // for advisory warnings (independent channel — see codex
      // round 6 above).
      const built = buildPreviousPhaseBriefing(opts.priorPhaseSignals);
      for (const w of built.warnings) derivedWarnings.push(w);
    }
  } else if (hasSignals) {
    const built = buildPreviousPhaseBriefing(opts.priorPhaseSignals);
    ctx.previous_phase_briefing = built.briefing;
    for (const w of built.warnings) derivedWarnings.push(w);
  } else {
    ctx.previous_phase_briefing = '';
  }

  // Pass-through content blocks. Unspecified → empty string. The
  // template prose handles the empty cases (and the three coord
  // blocks below get the explicit placeholder treatment).
  ctx.output_paths = opts.outputPaths || '';
  ctx.pr_or_branch_under_test = opts.prOrBranchUnderTest || '';
  ctx.qa_scope_rows = opts.qaScopeRows || '';
  ctx.test_commands_block = opts.testCommandsBlock || '';
  ctx.qa_playbook_block = opts.qaPlaybookBlock || '';
  ctx.status_summary_block = opts.statusSummaryBlock || '';
  ctx.plan_reference_block = opts.planReferenceBlock || '';
  ctx.project_context_block = opts.projectContextBlock || '';
  ctx.git_details_block = opts.gitDetailsBlock || '';
  ctx.artifact_pointer = opts.artifactPointer || '';
  ctx.coord_next_actions = opts.coordNextActions || '';
  ctx.recovery_checkpoint_path = opts.recoveryCheckpointPath || '';
  ctx.crash_timestamp = opts.crashTimestamp || '';
  ctx.last_heartbeat_timestamp = opts.lastHeartbeatTimestamp || '';
  ctx.prior_session_pid = opts.priorSessionPid || '';
  ctx.completed_checkpoints_block = opts.completedCheckpointsBlock || '';
  ctx.remaining_work_block = opts.remainingWorkBlock || '';

  // Empty-state placeholder owner (Open Question #4). Caller passes
  // "" / null / undefined indifferently; Unit 7 substitutes the
  // canonical placeholder before validation, so a coord briefing
  // with no decisions to record still passes the required-vars
  // check.
  for (const [name, placeholder] of Object.entries(EMPTY_STATE_PLACEHOLDERS)) {
    const optsKey = camelCaseKey(name);
    const v = opts[optsKey];
    if (v === undefined || v === null || (typeof v === 'string' && v === '')) {
      ctx[name] = placeholder;
    } else {
      ctx[name] = String(v);
    }
  }

  return ctx;
}

function camelCaseKey(snake) {
  return snake.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}

// -------------------- Public entrypoint --------------------

/**
 * Generate a prompt and write it to `${outputDir}/${effectiveRole}-prompt.md`.
 *
 * `effectiveRole` is `recoveryRole` when role === 'recovery', the
 * top-level role otherwise — V1 recovery renders with the original
 * role (impl / qa / coord); `recovery` as a distinct role value is
 * reserved for V1.5 (todo 010).
 *
 * Steps:
 *   1. Validate role + phaseId.
 *   2. Build the context (derive infrastructure vars; inject
 *      empty-state placeholders for the three coord blocks).
 *   3. Two-pass for qa: render qa-playbook-prompt.md against the
 *      same context (with test_commands_block applied), pass the
 *      result as {{qa_playbook_block}} when rendering the role
 *      template. Same for qa-recovery (role === 'recovery' &&
 *      recoveryRole === 'qa'). Other recovery roles render the
 *      qa_playbook_block as the empty string — the recovery
 *      template's prose handles that case.
 *   4. Render the protocol header. Render the role template.
 *      Concatenate header + role with one blank line.
 *   5. Run the transitive-drift check on the role template (and on
 *      qa-playbook-prompt.md for completeness). Warnings flow back
 *      to the caller.
 *   6. For recovery dispatches: preserveOriginalPrompt(outputDir,
 *      effectiveRole) before overwriting the live prompt.
 *   7. Normalize line endings to LF. Atomic-write to the live
 *      prompt path.
 *
 * Returns { promptPath, charCount, varsUsed, warnings }.
 */
function generatePrompt(opts) {
  const o = opts || {};
  if (!VALID_ROLES.includes(o.role)) {
    throw new Error(
      `generatePrompt: role must be one of ${VALID_ROLES.join(' | ')}, ` +
        `got ${JSON.stringify(o.role)}`,
    );
  }
  const recovery = o.role === 'recovery';
  if (recovery && !VALID_RECOVERY_ROLES.includes(o.recoveryRole)) {
    throw new Error(
      `generatePrompt: recoveryRole must be one of ${VALID_RECOVERY_ROLES.join(' | ')} ` +
        `when role === 'recovery', got ${JSON.stringify(o.recoveryRole)}`,
    );
  }
  const effectiveRole = recovery ? o.recoveryRole : o.role;
  if (typeof o.phaseId !== 'string' || !VALID_ID_RE.test(o.phaseId)) {
    throw new Error(
      `generatePrompt: phaseId ${JSON.stringify(o.phaseId)} must match ` +
        `VALID_ID_RE ${VALID_ID_RE.source}`,
    );
  }
  if (typeof o.templatesDir !== 'string' || o.templatesDir === '') {
    throw new Error('generatePrompt: templatesDir is required');
  }
  if (typeof o.phaseDir !== 'string' || o.phaseDir === '') {
    throw new Error('generatePrompt: phaseDir is required');
  }
  // phaseDir is the single source of truth for both the rendered
  // {{phase_dir}} variable AND the on-disk write location. Codex
  // round 12 caught a divergence bug from a separate `outputDir`
  // opt: when they differed, the rendered prompt told the agent its
  // protocol files lived under one phase_dir while the file
  // itself was written under another — the agent would look in
  // the wrong place for sibling artifacts (impl-complete.md, etc.).
  // Tests and dry-run redirect the write target by overriding
  // phaseDir, not by introducing a separate outputDir.
  const outputDir = o.phaseDir;
  // Derive the completion-signal path if the caller did not supply
  // one — `${phaseDir}/${effectiveRole}-complete.md` is the
  // protocol-header default.
  const completionSignalPath =
    o.completionSignalPath || path.join(o.phaseDir, `${effectiveRole}-complete.md`);

  const derivedWarnings = [];
  const baseOpts = { ...o, completionSignalPath };
  const context = buildContext(baseOpts, effectiveRole, derivedWarnings);

  // Two-pass: render qa-playbook-prompt.md when the dispatch needs
  // it inlined. Caller can pre-render via opts.qaPlaybookBlock; if
  // they did, skip the in-generator render and trust their value.
  // The hardwiring here is exactly what templates/README.md §4
  // describes — qa-prompt and (when recoveryRole === 'qa')
  // recovery-prompt both inline the playbook with the same
  // test_commands_block override.
  const needsPlaybook =
    !context.qa_playbook_block &&
    (o.role === 'qa' || (recovery && o.recoveryRole === 'qa'));
  let playbookText = '';
  if (needsPlaybook) {
    const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE);
    const rendered = renderTemplate(playbookSrc, context, { templateName: QA_PLAYBOOK_FILE });
    playbookText = rendered.text;
    context.qa_playbook_block = playbookText;
  }

  const headerSrc = readTemplate(o.templatesDir, PROTOCOL_HEADER_FILE);
  const roleTemplateFile = recovery ? ROLE_TEMPLATES.recovery : ROLE_TEMPLATES[o.role];
  const roleSrc = readTemplate(o.templatesDir, roleTemplateFile);

  const headerOut = renderTemplate(headerSrc, context, { templateName: PROTOCOL_HEADER_FILE });
  const roleOut = renderTemplate(roleSrc, context, { templateName: roleTemplateFile });

  // Transitive-drift checks. Run on the role template every time
  // (it might inline qa_playbook_block); also run on the playbook
  // for completeness, though it does not nest anything itself.
  const transitiveWarnings = [
    ...checkTransitiveDrift(roleSrc, o.templatesDir, roleTemplateFile),
    ...checkTransitiveDrift(headerSrc, o.templatesDir, PROTOCOL_HEADER_FILE),
  ];

  // Concatenate header + role. The blank line between is the only
  // structural separator; both sides are already rendered.
  const assembled = `${headerOut.text.trimEnd()}\n\n${roleOut.text}`;
  const finalText = normalizeLineEndings(assembled);

  // Recovery: preserve original BEFORE writing the new prompt.
  // Skip the preservation step on dry-run — preservation is a
  // disk-side effect that would persist past the dry-run.
  if (recovery && !o.dryRun) {
    preserveOriginalPrompt(outputDir, effectiveRole);
  }

  const promptPath = path.join(outputDir, `${effectiveRole}-prompt.md`);
  // dry-run: render, validate, and compute charCount against the
  // EXACT same context a real run would use (no tmp-dir override —
  // codex round 14 caught the divergence). Skip only the actual
  // disk write so the dry-run is purely informational.
  if (!o.dryRun) {
    atomicWrite(promptPath, finalText);
  }

  // Aggregate varsUsed (deduplicated, sorted for determinism).
  const varsUsed = [
    ...new Set([...headerOut.varsUsed, ...roleOut.varsUsed]),
  ].sort();

  // Aggregate warnings: derived (briefing parsing) + transitive +
  // per-template. Order: derived first so the caller sees data-
  // sourced warnings before lint warnings.
  const warnings = [
    ...derivedWarnings,
    ...transitiveWarnings,
    ...headerOut.warnings,
    ...roleOut.warnings,
  ];

  return {
    promptPath,
    // UTF-8 byte count, byte-equal to `fs.readFileSync(promptPath).length`
    // — see Unit 7 design decision #7. `finalText.length` would count
    // UTF-16 code units and underreport the actual on-disk size, since
    // the real templates contain non-ASCII characters (em dashes,
    // smart quotes, ellipses). Codex round 4 caught this drift between
    // the documented metric and the implementation.
    charCount: Buffer.byteLength(finalText, 'utf8'),
    varsUsed,
    warnings,
  };
}

function readTemplate(templatesDir, filename) {
  const p = path.join(templatesDir, filename);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`generatePrompt: cannot read template ${p}: ${err.message}`);
  }
}

// -------------------- CLI --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  generate-prompt.js --role <role> --phase <id> --output <dir>',
      '                     --project <name> [opts]',
      '',
      'Required:',
      '  --role <impl|qa|coord|recovery>',
      '  --phase <id>           phase id (matches VALID_ID_RE)',
      '  --output <dir>         output directory (writes <effectiveRole>-prompt.md)',
      '  --project <name>       project name (substitutes {{project_name}} in the',
      '                         protocol header; non-empty per the template contract)',
      '',
      'Common:',
      '  --templates <dir>      templates dir (default: ../templates)',
      '  --workdir <dir>        spawned session cwd (default: cwd; resolved to absolute)',
      '  --plan <path>          plan markdown file',
      '  --unit-marker <s>      Unit marker to extract (e.g. "7" or "4.5")',
      '  --recovery-role <r>    underlying role when --role recovery',
      '  --context <json-path>  JSON file with content blocks (allowlisted keys only;',
      '                         dispatch-control keys like role/outputDir are dropped)',
      '  --dry-run              do not write; print stats',
      '',
      'Exit codes: 0 = success, 1 = validation/IO error.',
    ].join('\n'),
  );
}

function parseCliArgs(argv) {
  const out = {
    role: null,
    recoveryRole: null,
    phase: null,
    output: null,
    templates: null,
    workdir: null,
    project: null,
    plan: null,
    unitMarker: null,
    contextJson: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--role':
        out.role = next();
        break;
      case '--recovery-role':
        out.recoveryRole = next();
        break;
      case '--phase':
        out.phase = next();
        break;
      case '--output':
        out.output = next();
        break;
      case '--templates':
        out.templates = next();
        break;
      case '--workdir':
        out.workdir = next();
        break;
      case '--project':
        out.project = next();
        break;
      case '--plan':
        out.plan = next();
        break;
      case '--unit-marker':
        out.unitMarker = next();
        break;
      case '--context':
        out.contextJson = next();
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  if (!out.role) fail('--role is required');
  if (!out.phase) fail('--phase is required');
  if (!out.output) fail('--output is required');
  // protocol-header.md declares project_name required and renderTemplate
  // rejects empty required strings — fail at the CLI surface with a
  // clear message rather than letting the operator hit a confusing
  // template-render error deep in the call stack. Codex round 5
  // surfaced the inconsistency between the help text (which listed
  // --project as "Common", i.e. optional) and the template contract.
  if (!out.project) fail('--project is required (substitutes {{project_name}} in the protocol header)');
  return out;
}

function fail(msg) {
  process.stderr.write(`generate-prompt.js: ${msg}\n`);
  process.exit(1);
}

// Keys the CLI's `--context` JSON file is allowed to set. An
// allowlist (rather than a blacklist of dispatch-control keys) is the
// structurally safer approach: any new infrastructure key added to
// generatePrompt later automatically falls outside the allowlist
// and cannot be silently redirected by a content-block JSON.
//
// Codex P2 round 1 (dispatch keys: role, outputDir, phaseId,
// projectName) and P2 round 2 (protocol paths: completionSignalPath,
// heartbeatPath) caught two classes of override bug. The allowlist
// closes both — only content-block keys that the role templates
// substitute as prose are accepted; everything else is dropped on
// load so a content-block file cannot redirect the dispatch or
// the orchestrator's protocol-path agreements.
const CONTEXT_ALLOWLIST = Object.freeze(
  new Set([
    // Impl-specific
    'planUnits',
    'outputPaths',
    'previousPhaseBriefing',
    // QA-specific
    'prOrBranchUnderTest',
    'qaScopeRows',
    'testCommandsBlock',
    'qaPlaybookBlock',
    // Coord-specific
    'statusSummaryBlock',
    'decisionsBlock',
    'openQuestionsBlock',
    'planReferenceBlock',
    'projectContextBlock',
    'gitDetailsBlock',
    'warningsBlock',
    'artifactPointer',
    'coordNextActions',
    // Recovery-specific (recoveryCheckpointPath etc. appear as text
    // in the rendered prompt; they are read references the agent
    // looks up, not files Unit 7 itself reads — so they stay
    // content-only at the CLI surface)
    'recoveryCheckpointPath',
    'crashTimestamp',
    'lastHeartbeatTimestamp',
    'priorSessionPid',
    'completedCheckpointsBlock',
    'remainingWorkBlock',
    // Header content. Note: `priorPhaseSignals` is deliberately NOT
    // in this allowlist. It is an array of paths Unit 7 would
    // fs.readFileSync into the rendered prompt — letting --context
    // name arbitrary local paths would disclose file contents (e.g.
    // /etc/passwd, ~/.aws/credentials) into a prompt the agent then
    // sees, which a sufficiently broad CLI dispatch can also write
    // into completion-signal artifacts. CLI callers wanting to
    // include upstream completion-signal content should pre-render
    // it as `previousPhaseBriefing` (a string content block, no
    // file reads). The JS API path used by Unit 11 still accepts
    // priorPhaseSignals directly because the orchestrator controls
    // those paths. Codex round 9 caught this.
    'priorPhaseDirsBlock',
    'suggestedCommitMessage',
  ]),
);

function main() {
  const args = parseCliArgs(process.argv);
  const templatesDir = args.templates
    ? path.resolve(args.templates)
    : path.resolve(__dirname, '..', 'templates');
  let context = {};
  if (args.contextJson) {
    try {
      context = JSON.parse(fs.readFileSync(args.contextJson, 'utf8'));
    } catch (err) {
      fail(`failed to read --context ${args.contextJson}: ${err.message}`);
    }
  }
  // Allowlist content-block keys only. Infrastructure keys
  // (completionSignalPath, heartbeatPath, phaseDir, outputDir, role,
  // recoveryRole, etc.) are NOT accepted from --context; the CLI
  // derives them from explicit flags or sensible defaults so a
  // content-block JSON cannot redirect the dispatch (codex P2 round
  // 1) or the orchestrator's protocol-path agreements (codex P2
  // round 2). Belt-and-suspenders: the spread of safeContext runs
  // BEFORE the CLI-derived assignments below, so the CLI always
  // wins on any collision the allowlist missed.
  const safeContext = {};
  for (const [k, v] of Object.entries(context)) {
    if (CONTEXT_ALLOWLIST.has(k)) safeContext[k] = v;
  }
  // Resolve workdir to absolute. The protocol-header.md contract
  // documents workdir as an absolute path the spawned agent uses to
  // anchor every protocol-file path; rendering `.` or any relative
  // value verbatim would generate a prompt that violates the
  // "do not interpret relative paths against your shell's cwd"
  // invariant. --output and --templates are already resolved
  // earlier; this normalizes --workdir to match. Codex round 4
  // caught the asymmetry.
  const workdir = path.resolve(args.workdir || process.cwd());
  const opts = {
    ...safeContext,
    role: args.role,
    recoveryRole: args.recoveryRole,
    phaseId: args.phase,
    templatesDir,
    workdir,
    projectName: args.project || '',
    phaseDir: path.resolve(args.output),
    planPath: args.plan,
    planUnitMarker: args.unitMarker,
  };
  if (args.dryRun) {
    // --dry-run: validate + render against the EXACT same context
    // a real run would use, but skip the disk write. Earlier
    // versions redirected phaseDir to a tmp dir to avoid touching
    // --output, but codex round 14 caught that the tmp-dir
    // substitution made the rendered {{phase_dir}}, default
    // completionSignalPath, and reported char_count describe a
    // different prompt than the real run. Now generatePrompt
    // accepts a `dryRun: true` flag that skips the atomic write
    // (and the recovery-side preservation), so dry-run stats
    // describe the actual would-be-written prompt byte-for-byte.
    try {
      const result = generatePrompt({ ...opts, dryRun: true });
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            dry_run: true,
            prompt_path: result.promptPath,
            char_count: result.charCount,
            vars_used: result.varsUsed,
            warnings: result.warnings,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (err) {
      fail(err.message);
    }
    return;
  }
  try {
    const result = generatePrompt(opts);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          prompt_path: result.promptPath,
          char_count: result.charCount,
          vars_used: result.varsUsed,
          warnings: result.warnings,
        },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    fail(err.message);
  }
}

if (require.main === module) main();

module.exports = {
  generatePrompt,
  parseFrontmatter,
  interpolate,
  renderTemplate,
  checkTransitiveDrift,
  extractPlanUnit,
  buildPreviousPhaseBriefing,
  preserveOriginalPrompt,
  normalizeLineEndings,
  atomicWrite,
  VALID_ROLES,
  VALID_RECOVERY_ROLES,
  ROLE_TEMPLATES,
  PROTOCOL_HEADER_FILE,
  QA_PLAYBOOK_FILE,
  EMPTY_STATE_PLACEHOLDERS,
  INTERP_RE,
};
