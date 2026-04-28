/**
 * Unit 7 test suite. Uses node:test (built-in, Node >= 20).
 * Run: npm test   (from agent-orchestrator/scripts/)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
  EMPTY_STATE_PLACEHOLDERS,
  PROTOCOL_HEADER_FILE,
  QA_PLAYBOOK_FILE,
} = require('./generate-prompt');

// Real templates dir — used by the integration / happy-path tests so
// drift between the catalog and the renderer surfaces as a CI failure.
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

// -------------------- Helpers --------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeTemplateFiles(templatesDir, files) {
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(templatesDir, name), content, 'utf8');
  }
}

function makeBaseOpts(overrides) {
  const phaseDir = overrides.phaseDir || mkTmp('gp-phase');
  return {
    role: 'impl',
    phaseId: 'phase-7',
    templatesDir: TEMPLATES_DIR,
    projectName: 'agent-orchestration',
    workdir: '/tmp/agent-orchestration',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    priorPhaseSignals: [],
    heartbeatPath: path.join(phaseDir, 'heartbeat.jsonl'),
    suggestedCommitMessage: 'feat(phase-7): land prompt generator',
    planUnits: 'Synthetic plan excerpt for tests.\n\n- Build the thing.',
    outputPaths: '- scripts/generate-prompt.js\n- scripts/generate-prompt.test.js',
    previousPhaseBriefing: '',
    statusSummaryBlock: 'Status: Unit 7 in progress.',
    decisionsBlock: '',
    openQuestionsBlock: '',
    planReferenceBlock: 'docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md',
    projectContextBlock:
      '- **Repo:** newton20/agent-orchestration\n- **Branch:** feat/unit-7-prompt-generator\n- **HEAD SHA:** 3fbdb20',
    gitDetailsBlock: '3fbdb20 docs(triage): post-PR-11',
    warningsBlock: '',
    artifactPointer: '/tmp/handoff.md',
    coordNextActions: 'Dispatch Unit 7 codex review.',
    prOrBranchUnderTest: 'feat/unit-7-prompt-generator',
    qaScopeRows: '1. Verify generate-prompt.js exports generatePrompt.',
    testCommandsBlock: '',
    qaPlaybookBlock: '',
    recoveryCheckpointPath: path.join(phaseDir, 'checkpoint.md'),
    crashTimestamp: '2026-04-28T16:30:00Z',
    lastHeartbeatTimestamp: '2026-04-28T16:25:00Z',
    priorSessionPid: '12345',
    completedCheckpointsBlock: '- Wrote generate-prompt.js',
    remainingWorkBlock: '- Add tests\n- Run codex',
    ...overrides,
  };
}

// =========================================================================
// A — parseFrontmatter
// =========================================================================

test('parseFrontmatter: valid frontmatter parses required + optional', () => {
  const text = '---\nrequired: [a, b]\noptional: [c]\n---\nbody\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepStrictEqual(frontmatter, { required: ['a', 'b'], optional: ['c'] });
  assert.strictEqual(body, 'body\n');
});

test('parseFrontmatter: missing leading --- returns null frontmatter', () => {
  const text = 'no frontmatter here\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.strictEqual(frontmatter, null);
  assert.strictEqual(body, text);
});

test('parseFrontmatter: malformed YAML throws', () => {
  const text = '---\n[unclosed\n---\nbody';
  assert.throws(() => parseFrontmatter(text), /frontmatter YAML parse error/);
});

test('parseFrontmatter: tolerates CRLF line endings', () => {
  const text = '---\r\nrequired: [x]\r\n---\r\nbody\r\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepStrictEqual(frontmatter, { required: ['x'] });
  assert.ok(body.startsWith('body'));
});

// =========================================================================
// B — interpolate (function-form replace + one-pass)
// =========================================================================

test('interpolate: substitutes declared vars', () => {
  const out = interpolate('a {{x}} b {{y}} c', { x: '1', y: '2' });
  assert.strictEqual(out, 'a 1 b 2 c');
});

test('interpolate: function-form replace passes $& / $1 / $$ literal', () => {
  // The 2nd-arg form would interpret these as backreferences and
  // corrupt the output. Function-form is load-bearing — see PR #6
  // fix 9a1f927 and the Unit 7 dispatch's invariant A.
  const out = interpolate(
    '{{snippet}}',
    { snippet: '$& $1 $$ $\' $` $<name>' },
  );
  assert.strictEqual(out, '$& $1 $$ $\' $` $<name>');
});

test('interpolate: one-pass — nested {{var}} in value survives as text', () => {
  // Open Question #1: a code-fence example showing template syntax
  // must NOT get re-substituted on the next pass. One-pass scan is
  // what makes nested literals safe.
  const out = interpolate(
    '{{plan_units}}\nrole={{role}}',
    { plan_units: 'demo: `{{role}}` should appear literally', role: 'impl' },
  );
  assert.match(out, /demo: `\{\{role\}\}` should appear literally/);
  assert.match(out, /role=impl/);
});

test('interpolate: null / undefined value renders as empty string', () => {
  const out = interpolate('a={{a}} b={{b}} c={{c}}', { a: null, b: undefined, c: 'ok' });
  assert.strictEqual(out, 'a= b= c=ok');
});

test('interpolate: throws on undeclared body variable', () => {
  assert.throws(
    () => interpolate('{{ghost}}', {}),
    /unknown variable \{\{ghost\}\}/,
  );
});

// =========================================================================
// C — renderTemplate (validation)
// =========================================================================

test('renderTemplate: throws when frontmatter is missing', () => {
  assert.throws(
    () => renderTemplate('no frontmatter\nbody', {}, { templateName: 't.md' }),
    /missing YAML frontmatter/,
  );
});

test('renderTemplate: throws when body references undeclared var', () => {
  const tmpl = '---\nrequired: [a]\noptional: []\n---\n{{a}} {{ghost}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: 'x' }, { templateName: 't.md' }),
    /body references \{\{ghost\}\}/,
  );
});

test('renderTemplate: throws when required var missing from context', () => {
  const tmpl = '---\nrequired: [a, b]\noptional: []\n---\n{{a}} {{b}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: 'x' }, { templateName: 't.md' }),
    /required variable "b" is missing in context/,
  );
});

test('renderTemplate: required empty string is rejected', () => {
  const tmpl = '---\nrequired: [a]\noptional: []\n---\n{{a}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: '' }, { templateName: 't.md' }),
    /required variable "a" coerces to the empty string/,
  );
});

test('renderTemplate: required empty array is rejected (coerces to "")', () => {
  // Codex round 11 — an empty array passes the bare `=== ''` check
  // because it is neither undefined/null nor a string, yet
  // interpolate() renders String([]) as "". Validate
  // POST-coercion so [] / 0 / boolean false coerce-empty cases are
  // caught at validation time, not silently rendered.
  const tmpl = '---\nrequired: [a]\noptional: []\n---\n{{a}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: [] }, { templateName: 't.md' }),
    /required variable "a" coerces to the empty string/,
  );
});

test('generatePrompt: empty-array outputPaths is rejected at render time', () => {
  // End-to-end version of the renderTemplate test above: a caller
  // passing `outputPaths: []` (e.g. via the JS API or a hostile
  // --context with the array form) must fail validation rather
  // than render an impl prompt with an empty Output contract block.
  const phaseDir = mkTmp('gp-empty-array');
  assert.throws(
    () =>
      generatePrompt(
        makeBaseOpts({
          role: 'impl',
          phaseDir,
          outputDir: phaseDir,
          completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
          outputPaths: [],
        }),
      ),
    /required variable "output_paths" coerces to the empty string/,
  );
});

test('renderTemplate: optional missing renders empty', () => {
  const tmpl = '---\nrequired: [a]\noptional: [b]\n---\n[{{a}}][{{b}}]';
  const out = renderTemplate(tmpl, { a: 'X' }, { templateName: 't.md' });
  assert.strictEqual(out.text, '[X][]');
  assert.deepStrictEqual([...out.varsUsed].sort(), ['a', 'b']);
});

test('renderTemplate: declared but unused vars do not break render', () => {
  // The re-declaration convention requires templates that inline
  // qa_playbook_block to declare test_commands_block in their own
  // optional list, even though they do not reference {{test_commands_block}}
  // directly. Renderer must accept this.
  const tmpl = '---\nrequired: []\noptional: [a, b]\n---\n[{{a}}]';
  const out = renderTemplate(tmpl, { a: 'X', b: 'Y' }, { templateName: 't.md' });
  assert.strictEqual(out.text, '[X]');
});

// =========================================================================
// D — checkTransitiveDrift
// =========================================================================

test('checkTransitiveDrift: real qa-prompt.md + qa-playbook-prompt.md is in lockstep', () => {
  const qaPrompt = fs.readFileSync(path.join(TEMPLATES_DIR, 'qa-prompt.md'), 'utf8');
  const warnings = checkTransitiveDrift(qaPrompt, TEMPLATES_DIR, 'qa-prompt.md');
  assert.deepStrictEqual(warnings, []);
});

test('checkTransitiveDrift: real recovery-prompt.md is in lockstep with qa-playbook', () => {
  const recovery = fs.readFileSync(path.join(TEMPLATES_DIR, 'recovery-prompt.md'), 'utf8');
  const warnings = checkTransitiveDrift(recovery, TEMPLATES_DIR, 'recovery-prompt.md');
  assert.deepStrictEqual(warnings, []);
});

test('checkTransitiveDrift: synthetic template missing re-declared var → warning', () => {
  const tmpDir = mkTmp('gp-templates');
  writeTemplateFiles(tmpDir, {
    'qa-playbook-prompt.md':
      '---\nrequired: [shared_var]\noptional: [test_commands_block]\n---\n{{shared_var}} {{test_commands_block}}',
    'broken.md':
      '---\nrequired: [other]\noptional: []\n---\n{{other}}\n{{qa_playbook_block}}',
  });
  const broken = fs.readFileSync(path.join(tmpDir, 'broken.md'), 'utf8');
  const warnings = checkTransitiveDrift(broken, tmpDir, 'broken.md');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /transitive-drift: broken.md/);
  assert.match(warnings[0], /"shared_var"/);
  assert.match(warnings[0], /"test_commands_block"/);
});

test('checkTransitiveDrift: template that does not inline qa_playbook_block returns []', () => {
  const tmpl = '---\nrequired: []\noptional: []\n---\nhello world';
  const warnings = checkTransitiveDrift(tmpl, TEMPLATES_DIR, 't.md');
  assert.deepStrictEqual(warnings, []);
});

// =========================================================================
// E — extractPlanUnit
// =========================================================================

test('extractPlanUnit: finds matching unit and trims at next sibling', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    [
      '# Plan',
      '',
      '- [ ] **Unit 6: Templates**',
      '  body of unit 6',
      '  more lines',
      '',
      '- [ ] **Unit 7: Prompt generator**',
      '  body of unit 7',
      '  ```js',
      '  template.replace(/\\{\\{role\\}\\}/g, () => v ?? \'\')',
      '  ```',
      '  trailing line',
      '',
      '- [ ] **Unit 8: Health checker**',
      '  body of unit 8',
      '',
    ].join('\n'),
  );
  const excerpt = extractPlanUnit(planPath, '7');
  assert.match(excerpt, /^- \[ \] \*\*Unit 7: Prompt generator\*\*/);
  assert.match(excerpt, /trailing line/);
  assert.ok(!/Unit 8/.test(excerpt), 'must stop before next sibling');
});

test('extractPlanUnit: missing unit throws with helpful message', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(planPath, '- [ ] **Unit 6: Templates**\n  body\n');
  assert.throws(
    () => extractPlanUnit(planPath, '99'),
    /no unit matching "99" found/,
  );
});

test('extractPlanUnit: nested {{var}} literals inside code fences survive', () => {
  // Caller passes the extracted text as planUnits to generatePrompt,
  // and one-pass interpolation guarantees the nested literals are
  // not double-substituted (Open Question #1 resolution).
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    [
      '- [ ] **Unit 7: Prompt generator**',
      '  ```text',
      '  Templates use {{role}} and {{phase_id}} placeholders.',
      '  ```',
      '',
      '- [ ] **Unit 8: Other**',
    ].join('\n'),
  );
  const excerpt = extractPlanUnit(planPath, '7');
  assert.match(excerpt, /\{\{role\}\}/);
  assert.match(excerpt, /\{\{phase_id\}\}/);
});

test('extractPlanUnit: marker "4" does NOT prefix-match "Unit 4.5"', () => {
  // Codex P2 round 1 — the previous lookahead `[:.\s]` allowed `.`,
  // which let marker "4" silently match `Unit 4.5: Spike` when the
  // plan had no `Unit 4: ...`. Anchoring the suffix to `:` (the
  // project's plan format) eliminates the prefix-match.
  const tmp = mkTmp('gp-plan-prefix');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    '- [ ] **Unit 4.5: Spike**\n  body\n\n- [ ] **Unit 5: Hook**\n  body\n',
  );
  assert.throws(
    () => extractPlanUnit(planPath, '4'),
    /no unit matching "4" found/,
    'marker "4" must not match "Unit 4.5"',
  );
});

test('extractPlanUnit: tolerates Unit numbers with dots (Unit 4.5)', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    '- [ ] **Unit 4.5: Spike**\n  body\n\n- [ ] **Unit 5: Hook**\n  body\n',
  );
  const excerpt = extractPlanUnit(planPath, '4.5');
  assert.match(excerpt, /Unit 4\.5: Spike/);
  assert.ok(!/Unit 5/.test(excerpt));
});

// =========================================================================
// F — buildPreviousPhaseBriefing
// =========================================================================

test('buildPreviousPhaseBriefing: no upstream signals returns empty briefing', () => {
  const r = buildPreviousPhaseBriefing([]);
  assert.strictEqual(r.briefing, '');
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: single upstream signal inlined as-is', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\ndispatcher_advisories: 0\n---\n## Summary\nDid the thing.\n',
  );
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.match(r.briefing, /## Summary\nDid the thing/);
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: multiple signals concatenated with --- divider', () => {
  const tmp = mkTmp('gp-signal');
  const a = path.join(tmp, 'a.md');
  const b = path.join(tmp, 'b.md');
  fs.writeFileSync(a, '---\nschema_version: 1\n---\n## Summary\nA.\n');
  fs.writeFileSync(b, '---\nschema_version: 1\n---\n## Summary\nB.\n');
  const r = buildPreviousPhaseBriefing([a, b]);
  assert.match(r.briefing, /## Summary\nA\./);
  assert.match(r.briefing, /## Summary\nB\./);
  assert.match(r.briefing, /\n\n---\n\n/);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories=0 produces no warning', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: 0\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories=2 surfaces a warning', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: 2\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /dispatcher_advisories=2/);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories non-integer warns', () => {
  // V1 schema is `dispatcher_advisories: <int>`. Anything else is
  // either a typo or pre-evolution to the structured-array form
  // (Open Question #5) — surface it so the orchestrator can route.
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: "bad"\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /must be a non-negative integer/);
});

test('buildPreviousPhaseBriefing: missing signal file warns and continues', () => {
  const r = buildPreviousPhaseBriefing(['/nonexistent/path/sig.md']);
  assert.strictEqual(r.briefing, '');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /cannot read upstream signal/);
});

// =========================================================================
// G — atomicWrite + normalizeLineEndings
// =========================================================================

test('normalizeLineEndings: CRLF and bare CR collapse to LF', () => {
  assert.strictEqual(normalizeLineEndings('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('atomicWrite: writes file and leaves no temp artifact behind', () => {
  const dir = mkTmp('gp-atomic');
  const target = path.join(dir, 'out.md');
  atomicWrite(target, 'hello');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
  const leftover = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('.') && n.includes('gp-tmp-'));
  assert.deepStrictEqual(leftover, []);
});

test('atomicWrite: target dir is created if missing', () => {
  const root = mkTmp('gp-atomic-root');
  const nested = path.join(root, 'a', 'b', 'c');
  const target = path.join(nested, 'out.md');
  atomicWrite(target, 'hello');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
});

// =========================================================================
// H — preserveOriginalPrompt (idempotent)
// =========================================================================

test('preserveOriginalPrompt: first call copies live to .original', () => {
  const dir = mkTmp('gp-preserve');
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v1');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'impl-prompt.original.md'), 'utf8'), 'live v1');
});

test('preserveOriginalPrompt: second call is a no-op (.original already exists)', () => {
  const dir = mkTmp('gp-preserve');
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v1');
  preserveOriginalPrompt(dir, 'impl');
  // Simulate re-recovery: live prompt has been overwritten with v2
  // (a recovery prompt) and we're about to overwrite again with v3.
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v2 (recovery prompt)');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, false);
  // .original must STILL hold v1 — the FIRST non-recovery prompt.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'impl-prompt.original.md'), 'utf8'), 'live v1');
});

test('preserveOriginalPrompt: live missing returns false (no-op)', () => {
  const dir = mkTmp('gp-preserve');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, false);
  assert.ok(!fs.existsSync(path.join(dir, 'impl-prompt.original.md')));
});

// =========================================================================
// I — generatePrompt validation surface
// =========================================================================

test('generatePrompt: invalid role throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ role: 'sysadmin' })),
    /role must be one of/,
  );
});

test('generatePrompt: invalid phaseId fails VALID_ID_RE', () => {
  // VALID_ID_RE rejects anything outside [A-Za-z0-9._-]+
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseId: '../escape' })),
    /must match VALID_ID_RE/,
  );
});

test('generatePrompt: empty phaseId throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseId: '' })),
    /must match VALID_ID_RE/,
  );
});

test('generatePrompt: missing templatesDir throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ templatesDir: '' })),
    /templatesDir is required/,
  );
});

test('generatePrompt: missing phaseDir throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseDir: '' })),
    /phaseDir is required/,
  );
});

test('generatePrompt: recovery without recoveryRole throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ role: 'recovery', recoveryRole: null })),
    /recoveryRole must be one of/,
  );
});

// =========================================================================
// J — generatePrompt happy paths (real templates)
// =========================================================================

test('generatePrompt: impl happy path renders header + impl-prompt with all vars substituted', () => {
  const phaseDir = mkTmp('gp-impl');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'impl-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Header content present
  assert.match(text, /Orchestration Protocol Header/);
  // Role substitution worked
  assert.match(text, /You are a \*\*impl\*\* agent/);
  assert.match(text, /phase \*\*phase-7\*\*/);
  // Plan units interpolated
  assert.match(text, /Synthetic plan excerpt for tests/);
  // No orphan {{var}} placeholders (one-pass leaves nested in code
  // fences, but the synthetic planUnits in this test has none)
  assert.ok(!/\{\{[a-z_]+\}\}/.test(text), 'no orphan {{...}} placeholders');
});

test('generatePrompt: impl with empty optional previousPhaseBriefing renders cleanly', () => {
  const phaseDir = mkTmp('gp-impl-empty');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    previousPhaseBriefing: '',
    priorPhaseSignals: [],
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /Previous phase context/);
  // Empty optional renders as empty string. The surrounding prose
  // says "If this section is empty, this phase has no upstream
  // dependencies — you may start directly from the plan excerpt below."
  assert.match(text, /If this section is empty/);
});

test('generatePrompt: qa happy path two-pass renders playbook into qa-prompt', () => {
  const phaseDir = mkTmp('gp-qa');
  const opts = makeBaseOpts({
    role: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '', // force in-generator render
    testCommandsBlock: '`npm test --workspaces`',
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'qa-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Header
  assert.match(text, /You are a \*\*qa\*\* agent/);
  // Playbook content inlined
  assert.match(text, /P1 — Test suite, every workspace/);
  // test_commands_block override visible inside the inlined playbook
  assert.match(text, /npm test --workspaces/);
  assert.ok(!/\{\{qa_playbook_block\}\}/.test(text), 'playbook variable substituted');
});

test('generatePrompt: qa with empty test_commands_block falls back to playbook prose', () => {
  const phaseDir = mkTmp('gp-qa-empty');
  const opts = makeBaseOpts({
    role: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '',
    testCommandsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // The playbook's "Test commands (project-specific)" section ends
  // with the prose: "If this section is empty, fall back to `npm
  // test` per-workspace as described in P1."
  assert.match(text, /If this section is empty, fall back to `npm test`/);
});

test('generatePrompt: coord happy path renders coordinator-briefing as coord-prompt.md', () => {
  const phaseDir = mkTmp('gp-coord');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  const result = generatePrompt(opts);
  // Output path uses role-name form, NOT the template filename.
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'coord-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /Coordinator briefing — phase phase-7/);
  assert.match(text, /Status: Unit 7 in progress\./);
});

// =========================================================================
// K — generatePrompt empty-state placeholder ownership (Open Q #4)
// =========================================================================

test('generatePrompt: coord empty decisionsBlock renders "(no decisions captured)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-d');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    decisionsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no decisions captured\)/);
});

test('generatePrompt: coord empty openQuestionsBlock renders "(no open questions)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-q');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    openQuestionsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no open questions\)/);
});

test('generatePrompt: coord empty warningsBlock renders "(no warnings)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-w');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    warningsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no warnings\)/);
});

test('generatePrompt: coord undefined decisionsBlock also renders the placeholder', () => {
  const phaseDir = mkTmp('gp-coord-undef-d');
  const base = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  delete base.decisionsBlock;
  const result = generatePrompt(base);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no decisions captured\)/);
});

test('generatePrompt: caller-supplied non-empty decisionsBlock passes through unchanged', () => {
  const phaseDir = mkTmp('gp-coord-nonempty-d');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    decisionsBlock: '- Picked Option B for V1.',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // The supplied value renders right after the `## Decisions` heading.
  // The placeholder string `(no decisions captured)` ALSO appears
  // verbatim in the surrounding prose paragraph (the template
  // explains the empty-state contract to readers, with backticks
  // around the literal). Anchor the negative assertion to the
  // substitution position (preceded by a blank line, followed by a
  // newline, no surrounding backticks) so it does not false-trigger
  // on the prose mention.
  assert.match(text, /## Decisions\n\n- Picked Option B for V1\.\n/);
  assert.ok(
    !/\n\n\(no decisions captured\)\n/.test(text),
    'placeholder must not be injected at the substitution position when the caller supplied a value',
  );
});

// =========================================================================
// L — generatePrompt recovery dispatches
// =========================================================================

test('generatePrompt: recovery (impl) writes impl-prompt.md, role var = impl', () => {
  const phaseDir = mkTmp('gp-rec-impl');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  // Output filename uses effectiveRole, not 'recovery'.
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'impl-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // {{role}} substitutes to 'impl', not 'recovery'
  assert.match(text, /You are a \*\*impl\*\* agent/);
  // recovery-prompt.md content present
  assert.match(text, /recovery \/ resume/);
  assert.match(text, /Crash context/);
});

test('generatePrompt: recovery (qa) two-pass renders playbook into recovery-prompt', () => {
  const phaseDir = mkTmp('gp-rec-qa');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '', // force two-pass
    testCommandsBlock: '`npm test --workspaces`',
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'qa-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Recovery template's qa-recovery branch should have a populated
  // {{qa_playbook_block}} (the playbook is inlined into the
  // recovery prompt so the respawned QA gets the same playbook the
  // crashed predecessor ran).
  assert.match(text, /P1 — Test suite, every workspace/);
  assert.match(text, /npm test --workspaces/);
});

test('generatePrompt: recovery (coord) does not run two-pass; qa_playbook_block stays empty', () => {
  const phaseDir = mkTmp('gp-rec-coord');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'coord-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // {{qa_playbook_block}} substituted to empty — no playbook content.
  assert.ok(!/P1 — Test suite, every workspace/.test(text), 'playbook content must be absent');
});

test('generatePrompt: recovery preserves the prior live prompt to .original.md (idempotent)', () => {
  const phaseDir = mkTmp('gp-rec-preserve');

  // First dispatch (non-recovery): writes the original impl prompt.
  const baseOpts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: 'ORIGINAL plan excerpt v1',
  });
  generatePrompt(baseOpts);
  const originalText = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  assert.match(originalText, /ORIGINAL plan excerpt v1/);

  // First recovery: should preserve original to .original.md and overwrite live.
  const recOpts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  generatePrompt(recOpts);
  const original1 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.original.md'), 'utf8');
  assert.match(original1, /ORIGINAL plan excerpt v1/);
  const live1 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  assert.match(live1, /recovery \/ resume/);

  // Second recovery (re-recovery): MUST NOT overwrite .original.md.
  generatePrompt(recOpts);
  const original2 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.original.md'), 'utf8');
  assert.strictEqual(
    original2,
    original1,
    '.original.md must hold the FIRST non-recovery prompt across the entire crash chain',
  );
});

// =========================================================================
// M — function-form replace + LF normalization integration
// =========================================================================

test('generatePrompt: planUnits with backreference-like sequences pass through verbatim', () => {
  const phaseDir = mkTmp('gp-funcform');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: 'A regex example: /(\\w+)/ replaced via $&-substitution and $1 captures.',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\$&-substitution/);
  assert.match(text, /\$1 captures/);
});

test('generatePrompt: nested {{role}} inside planUnits code fence survives one-pass', () => {
  const phaseDir = mkTmp('gp-nested');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: '```text\nUse {{role}} and {{phase_id}} verbatim.\n```',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Nested literals INSIDE the planUnits value survive (one-pass).
  assert.match(text, /Use \{\{role\}\} and \{\{phase_id\}\} verbatim/);
  // The header's own {{role}} is still substituted at top-of-file.
  assert.match(text, /You are a \*\*impl\*\* agent/);
});

test('generatePrompt: output is LF only on disk (no CRLF) regardless of input templates', () => {
  // Synthesize a template dir whose files use CRLF line endings.
  // Unit 7 must normalize on write so the rendered prompt matches
  // the cross-platform convention (Open Question #2).
  const tmpTpl = mkTmp('gp-lf-tpl');
  const realHeader = fs.readFileSync(path.join(TEMPLATES_DIR, PROTOCOL_HEADER_FILE), 'utf8');
  const realImpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'impl-prompt.md'), 'utf8');
  fs.writeFileSync(
    path.join(tmpTpl, PROTOCOL_HEADER_FILE),
    realHeader.replace(/\n/g, '\r\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmpTpl, 'impl-prompt.md'),
    realImpl.replace(/\n/g, '\r\n'),
    'utf8',
  );
  // qa-playbook required even though impl doesn't use it (some
  // checkTransitiveDrift codepath may try to read it; copy real one).
  fs.copyFileSync(
    path.join(TEMPLATES_DIR, QA_PLAYBOOK_FILE),
    path.join(tmpTpl, QA_PLAYBOOK_FILE),
  );

  const phaseDir = mkTmp('gp-lf-out');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    templatesDir: tmpTpl,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  const buf = fs.readFileSync(result.promptPath);
  assert.ok(!buf.includes(0x0d), 'rendered prompt must contain no CR (0x0d) bytes');
});

// =========================================================================
// N — determinism
// =========================================================================

test('generatePrompt: same inputs produce byte-identical output (modulo .tmp- filename)', () => {
  const phaseDirA = mkTmp('gp-det-a');
  const phaseDirB = mkTmp('gp-det-b');
  const optsA = makeBaseOpts({
    role: 'impl',
    phaseDir: phaseDirA,
    outputDir: phaseDirA,
    completionSignalPath: path.join(phaseDirA, 'impl-complete.md'),
    heartbeatPath: '/abs/path/heartbeat.jsonl',
  });
  const optsB = makeBaseOpts({
    role: 'impl',
    phaseDir: phaseDirA, // same paths so substituted strings match
    outputDir: phaseDirB,
    completionSignalPath: path.join(phaseDirA, 'impl-complete.md'),
    heartbeatPath: '/abs/path/heartbeat.jsonl',
  });
  const ra = generatePrompt(optsA);
  const rb = generatePrompt(optsB);
  const a = fs.readFileSync(ra.promptPath, 'utf8');
  const b = fs.readFileSync(rb.promptPath, 'utf8');
  assert.strictEqual(a, b, 'byte-identical output for byte-identical context');
});

// =========================================================================
// O — return value shape
// =========================================================================

test('generatePrompt: charCount equals UTF-8 byte length of the file on disk', () => {
  // Codex round 4 — `finalText.length` counts UTF-16 code units,
  // which under-reports prompt size for non-ASCII content (em
  // dashes, smart quotes — the real protocol-header has both).
  // Unit 7 design decision #7 documents the metric as
  // byte-equal-to-disk; this test is the lockstep guard.
  const phaseDir = mkTmp('gp-bytes');
  const result = generatePrompt(
    makeBaseOpts({
      role: 'impl',
      phaseDir,
      outputDir: phaseDir,
      completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
      // Force non-ASCII into the substituted content so the test
      // proves the bug it guards against.
      planUnits: 'Plan with em dash — and ellipsis … and smart quote “x”.',
    }),
  );
  const onDisk = fs.readFileSync(result.promptPath).length;
  assert.strictEqual(
    result.charCount,
    onDisk,
    'charCount must equal UTF-8 byte length of the rendered file on disk',
  );
});

test('generatePrompt: return value carries promptPath, charCount, varsUsed, warnings', () => {
  const phaseDir = mkTmp('gp-ret');
  const result = generatePrompt(
    makeBaseOpts({
      role: 'impl',
      phaseDir,
      outputDir: phaseDir,
      completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    }),
  );
  assert.strictEqual(typeof result.promptPath, 'string');
  assert.ok(result.charCount > 0);
  // varsUsed is the union of body-referenced vars in header + role
  // template (deduplicated, sorted for determinism).
  assert.ok(Array.isArray(result.varsUsed));
  assert.ok(result.varsUsed.includes('role'));
  assert.ok(result.varsUsed.includes('phase_id'));
  assert.ok(result.varsUsed.includes('plan_units'));
  // varsUsed is sorted — a determinism guarantee we expose to callers.
  const sorted = [...result.varsUsed].sort();
  assert.deepStrictEqual(result.varsUsed, sorted);
  assert.ok(Array.isArray(result.warnings));
});

test('generatePrompt: dispatcher_advisories>0 in upstream signal surfaces in warnings', () => {
  const sigDir = mkTmp('gp-adv-sig');
  const sigPath = path.join(sigDir, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\ndispatcher_advisories: 3\n---\n## Summary\nUpstream had 3 advisories.\n',
  );
  const phaseDir = mkTmp('gp-adv');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    priorPhaseSignals: [sigPath],
    previousPhaseBriefing: undefined, // force in-generator briefing build
  });
  const result = generatePrompt(opts);
  const advisoryWarnings = result.warnings.filter((w) => /dispatcher_advisories=3/.test(w));
  assert.strictEqual(advisoryWarnings.length, 1);
});

test('generatePrompt: empty-string previousPhaseBriefing + priorPhaseSignals derives briefing from signals', () => {
  // Codex round 10 — an empty string for previousPhaseBriefing must
  // NOT count as "explicit pre-rendered briefing." Test helpers
  // (and real callers using shared defaults) often initialize the
  // field as "". When priorPhaseSignals is supplied, the
  // rendered briefing should come from the signals — anything
  // else silently drops the inlined upstream context for phases
  // with depends_on entries.
  const sigDir = mkTmp('gp-empty-rerender-sig');
  const sigPath = path.join(sigDir, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\n---\n## Summary\nUPSTREAM-CONTENT-FROM-SIGNAL\n',
  );
  const phaseDir = mkTmp('gp-empty-rerender');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    // Empty-string default (the makeBaseOpts default), plus signals.
    previousPhaseBriefing: '',
    priorPhaseSignals: [sigPath],
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /UPSTREAM-CONTENT-FROM-SIGNAL/, 'briefing must be derived from signals when previousPhaseBriefing is empty');
});

test('generatePrompt: pre-rendered briefing + priorPhaseSignals still surfaces advisory warnings', () => {
  // Codex round 6 — a caller passing BOTH a pre-rendered
  // previousPhaseBriefing and the priorPhaseSignals array would
  // previously silently drop dispatcher_advisories warnings (the
  // briefing-text branch short-circuited the parse). The warning
  // channel is independent of the briefing-text channel; the
  // orchestrator must not lose the routing signal just because
  // the caller chose to pre-render the briefing prose.
  const sigDir = mkTmp('gp-adv-prerendered');
  const sigPath = path.join(sigDir, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\ndispatcher_advisories: 5\n---\n## Summary\nUpstream had 5 advisories.\n',
  );
  const phaseDir = mkTmp('gp-adv-pre');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    priorPhaseSignals: [sigPath],
    // Caller pre-rendered the briefing prose; this used to suppress
    // the parse of priorPhaseSignals for advisory warnings.
    previousPhaseBriefing: 'CALLER PRE-RENDERED BRIEFING TEXT',
  });
  const result = generatePrompt(opts);
  // The pre-rendered briefing wins for the body content.
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /CALLER PRE-RENDERED BRIEFING TEXT/);
  // But the advisory warnings still surface — that's the contract.
  const advisoryWarnings = result.warnings.filter((w) => /dispatcher_advisories=5/.test(w));
  assert.strictEqual(
    advisoryWarnings.length,
    1,
    'pre-rendered briefing must NOT suppress dispatcher_advisories warnings',
  );
});

// =========================================================================
// P — Real-template lockstep (regression guard)
// =========================================================================

test('VALID_ROLES enumerates the four documented dispatch roles', () => {
  // Cross-checks the public constant against the dispatch contract
  // ("role ∈ {impl, qa, coord, recovery}") — drift here is a
  // contract change worth a coord triage.
  assert.deepStrictEqual([...VALID_ROLES].sort(), ['coord', 'impl', 'qa', 'recovery']);
});

test('EMPTY_STATE_PLACEHOLDERS matches templates/README.md "Empty-state rendering"', () => {
  // The three coord-specific blocks rendered with explicit literal
  // placeholders. Drift between this constant and the README's
  // documented strings would silently change agent-facing prose.
  assert.deepStrictEqual(EMPTY_STATE_PLACEHOLDERS, {
    decisions_block: '(no decisions captured)',
    open_questions_block: '(no open questions)',
    warnings_block: '(no warnings)',
  });
});

test('CLI: --context JSON cannot override --role / --output dispatch keys', () => {
  // Codex P2 round 1 + round 2 — a `--context` file should never be
  // able to redirect the dispatch (round 1: role/outputDir) or the
  // protocol-path agreement (round 2: completionSignalPath,
  // heartbeatPath). The CONTEXT_ALLOWLIST in generate-prompt.js
  // accepts only content-block keys; infrastructure / control keys
  // are dropped on load so even a hostile JSON cannot move the
  // write target or the polled completion signal location.
  const phaseDir = mkTmp('gp-cli-ctx');
  const ctxPath = path.join(mkTmp('gp-ctx-json'), 'ctx.json');
  const blockedSignal = path.join(mkTmp('gp-blocked'), 'qa-complete.md');
  const blockedHeartbeat = path.join(mkTmp('gp-blocked-hb'), 'heartbeat.jsonl');
  fs.writeFileSync(
    ctxPath,
    JSON.stringify({
      // Dispatch-control keys (round 1) — must be dropped:
      role: 'qa',
      outputDir: '/tmp/elsewhere',
      phaseId: '../escape',
      projectName: 'should-not-override',
      // Protocol-path keys (round 2) — must also be dropped:
      completionSignalPath: blockedSignal,
      heartbeatPath: blockedHeartbeat,
      phaseDir: '/tmp/blocked-phasedir',
      // Content blocks the renderer needs (these should flow through):
      planUnits: 'Override-attempt content block.',
      outputPaths: '- foo.js',
    }),
  );
  const out = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-prompt.js'),
      '--role',
      'impl',
      '--phase',
      'phase-7',
      '--output',
      phaseDir,
      '--templates',
      TEMPLATES_DIR,
      '--workdir',
      '/tmp/wd',
      '--project',
      'cli-project',
      '--context',
      ctxPath,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(out.status, 0, `cli stderr: ${out.stderr}`);
  // Output landed at the CLI-controlled location.
  const promptPath = path.join(phaseDir, 'impl-prompt.md');
  assert.ok(fs.existsSync(promptPath), 'CLI --output must control the write location');
  const text = fs.readFileSync(promptPath, 'utf8');
  // Role / project came from CLI flags, not the context.
  assert.match(text, /You are a \*\*impl\*\* agent/);
  assert.match(text, /"cli-project"/);
  assert.ok(!/should-not-override/.test(text));
  // The content-block override DID flow through.
  assert.match(text, /Override-attempt content block\./);
  // Critical: completionSignalPath in the rendered prompt must point
  // at the CLI-derived default (${phaseDir}/impl-complete.md), NOT
  // the blocked override the context attempted to inject. This is
  // what guarantees the orchestrator and the spawned agent agree
  // on where the completion signal will be written.
  assert.match(text, new RegExp(escapeRegExpForTest(path.join(phaseDir, 'impl-complete.md'))));
  assert.ok(
    !text.includes(blockedSignal),
    'context.completionSignalPath must NOT have been honored',
  );
  // Same for heartbeatPath — the protocol-header substitutes
  // {{heartbeat_path}} verbatim, and a hostile context shouldn't
  // be able to relocate where the agent emits heartbeats.
  assert.ok(
    !text.includes(blockedHeartbeat),
    'context.heartbeatPath must NOT have been honored',
  );
});

function escapeRegExpForTest(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('CLI: --workdir is resolved to absolute before rendering', () => {
  // Codex round 4 — `--output` and `--templates` are resolved via
  // path.resolve(); `--workdir` must be too, otherwise a caller
  // passing `--workdir .` (or any relative path) would render a
  // protocol-violating relative workdir into the prompt. The
  // protocol-header.md contract documents workdir as absolute.
  // Codex round 5 — extract the rendered workdir and verify
  // path.isAbsolute() rather than hard-coding a Windows drive
  // prefix; the assertion must hold cross-platform.
  const phaseDir = mkTmp('gp-cli-workdir');
  const out = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-prompt.js'),
      '--role',
      'impl',
      '--phase',
      'phase-7',
      '--output',
      phaseDir,
      '--templates',
      TEMPLATES_DIR,
      '--workdir',
      '.',
      '--project',
      'cli-project',
      '--context',
      (() => {
        const ctxPath = path.join(mkTmp('gp-ctx-wd'), 'ctx.json');
        fs.writeFileSync(
          ctxPath,
          JSON.stringify({
            planUnits: 'Test workdir resolution.',
            outputPaths: '- foo.js',
          }),
        );
        return ctxPath;
      })(),
    ],
    { encoding: 'utf8', cwd: __dirname },
  );
  assert.strictEqual(out.status, 0, `cli stderr: ${out.stderr}`);
  const text = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  // Extract the workdir from the rendered protocol header.
  const m = text.match(/Your working directory is\s+\*\*([^*]+)\*\*/);
  assert.ok(m, 'protocol header must render the workdir line');
  const renderedWorkdir = m[1];
  // Cross-platform absolute-path check (Linux/macOS render `/...`;
  // Windows renders `C:\...`).
  assert.ok(
    path.isAbsolute(renderedWorkdir),
    `rendered workdir must be absolute, got ${JSON.stringify(renderedWorkdir)}`,
  );
  // And specifically must not be the literal `.` we passed.
  assert.notStrictEqual(renderedWorkdir, '.');
});

test('CLI: --context cannot trigger arbitrary file reads via priorPhaseSignals', () => {
  // Codex round 9 — `priorPhaseSignals` is a file-reading input
  // (buildPreviousPhaseBriefing → fs.readFileSync). Allowlisting it
  // for --context would let a hostile JSON name arbitrary local
  // paths and have their contents inlined into the prompt (and from
  // there, into completion artifacts). Removing it from the
  // allowlist means a context-supplied path is silently ignored;
  // callers should pre-render the briefing as a
  // `previousPhaseBriefing` string instead.
  const phaseDir = mkTmp('gp-cli-fileread');
  const secretDir = mkTmp('gp-secret');
  const secretPath = path.join(secretDir, 'secret-impl-complete.md');
  // Make the file look like a valid completion signal so it would
  // pass parseFrontmatter if it ever got read.
  fs.writeFileSync(
    secretPath,
    '---\nschema_version: 1\n---\n## Summary\nSECRET-CONTENT-MUST-NOT-LEAK\n',
  );
  const ctxPath = path.join(mkTmp('gp-ctx-fileread'), 'ctx.json');
  fs.writeFileSync(
    ctxPath,
    JSON.stringify({
      // The hostile attempt:
      priorPhaseSignals: [secretPath],
      // Plus a valid content block so the render still succeeds:
      planUnits: 'Test file-read defense.',
      outputPaths: '- foo.js',
    }),
  );
  const out = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-prompt.js'),
      '--role',
      'impl',
      '--phase',
      'phase-7',
      '--output',
      phaseDir,
      '--templates',
      TEMPLATES_DIR,
      '--workdir',
      '/tmp/wd',
      '--project',
      'cli-project',
      '--context',
      ctxPath,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(out.status, 0, `cli stderr: ${out.stderr}`);
  const text = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  // Context's planUnits was honored (legit content block).
  assert.match(text, /Test file-read defense\./);
  // But the secret file's content must NOT have been read and inlined.
  assert.ok(
    !text.includes('SECRET-CONTENT-MUST-NOT-LEAK'),
    'CLI --context must not be able to trigger arbitrary file reads via priorPhaseSignals',
  );
});

test('CLI: --dry-run render errors print through fail() not as uncaught stack trace', () => {
  // Codex round 7 — the dry-run path used to escape the non-dry
  // path's try/catch, so a render-time validation error (e.g.,
  // recovery dry-run without --recovery-role) printed as an
  // uncaught stack trace instead of the documented
  // `generate-prompt.js: <message>` envelope. Wrapping the
  // dry-run render in the same try/catch unifies the UX.
  const phaseDir = mkTmp('gp-cli-dry');
  const out = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-prompt.js'),
      '--role',
      'recovery',         // requires --recovery-role; we omit it
      '--phase',
      'phase-7',
      '--output',
      phaseDir,
      '--templates',
      TEMPLATES_DIR,
      '--workdir',
      '/tmp/wd',
      '--project',
      'cli-project',
      '--dry-run',
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /^generate-prompt\.js: /m);
  assert.match(out.stderr, /recoveryRole must be one of/);
  // Must NOT contain a Node.js stack-trace envelope.
  assert.ok(!/^\s+at\s/m.test(out.stderr), 'dry-run errors must not surface a stack trace');
});

test('CLI: --project is required (matches the protocol-header contract)', () => {
  // Codex round 5 — protocol-header.md declares project_name
  // required, and renderTemplate rejects empty required strings.
  // The CLI must surface this as a clear up-front error rather
  // than letting the operator hit a deep template-render error.
  const phaseDir = mkTmp('gp-cli-noproj');
  const out = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-prompt.js'),
      '--role',
      'impl',
      '--phase',
      'phase-7',
      '--output',
      phaseDir,
      '--templates',
      TEMPLATES_DIR,
    ],
    { encoding: 'utf8' },
  );
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /--project is required/);
});

test('every real template parses + has valid required/optional shape', () => {
  const files = ['protocol-header.md', 'impl-prompt.md', 'qa-prompt.md', 'qa-playbook-prompt.md', 'coordinator-briefing.md', 'recovery-prompt.md'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
    const { frontmatter, body } = parseFrontmatter(text);
    assert.ok(frontmatter, `${f} must have frontmatter`);
    assert.ok(Array.isArray(frontmatter.required) || frontmatter.required === undefined, `${f}: required must be array or absent`);
    assert.ok(Array.isArray(frontmatter.optional) || frontmatter.optional === undefined, `${f}: optional must be array or absent`);
    // Every body {{var}} must be in declared union.
    const declared = new Set([
      ...(frontmatter.required || []),
      ...(frontmatter.optional || []),
    ]);
    const referenced = new Set();
    body.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, name) => {
      referenced.add(name);
      return '';
    });
    for (const name of referenced) {
      assert.ok(
        declared.has(name),
        `${f} body references {{${name}}} but frontmatter does not declare it`,
      );
    }
  }
});
