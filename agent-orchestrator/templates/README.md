# Templates

Prompt templates the orchestrator renders into role-specific prompts
for every spawned Claude Code session. **This README is the
authoritative variable catalog** that Unit 7's
`scripts/generate-prompt.js` validates templates against.

## Template index

| File | Role | Purpose |
|---|---|---|
| `protocol-header.md` | universal | Prepended to every other template. Establishes role, file protocol, completion-signal format, heartbeat cadence, git discipline, scope boundary. Do not duplicate its content in role templates. |
| `impl-prompt.md` | impl | Implementation-session assignment. Layers plan excerpt, previous-phase context, and output contract on top of the header. |
| `qa-prompt.md` | qa | QA-session assignment. Cites the branch under test, per-PR scope rows, and the inlined playbook. |
| `qa-playbook-prompt.md` | qa (fragment) | Reusable playbook rows that apply to every PR. Inlined into `qa-prompt.md` via `{{qa_playbook_block}}` — not dispatched standalone. |
| `coordinator-briefing.md` | coord | Read-only briefing for a coordinator session. Shape-compatible with `~/.claude/skills/session-handoff` `brief coord` output. |
| `recovery-prompt.md` | impl / qa / coord | Respawn prompt after a crash. Wraps the original role with crash context, completed checkpoints, and remaining-work markers. |

## Interpolation contract

Templates are pure text with `{{variable_name}}` holes. Unit 7 fills
them in a single pass over the body, using one regex match-and-replace:

```js
const INTERP_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

function fill(template, vars) {
  return template.replace(INTERP_RE, (_match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return v == null ? '' : String(v);
    }
    // Validation runs before fill(); an undeclared {{var}} reaching
    // here is an internal bug. The renderer throws on this branch.
    throw new Error(`unknown variable {{${name}}}`);
  });
}
```

Two interpolation invariants are load-bearing — both encode contracts
that earlier rounds of pre-Unit-7 review surfaced:

- **Function-form replacement.** Passing the value `v` directly as the
  second argument to `String.replace` causes JavaScript to interpret
  `$$`, `$&`, `$'`, `` $` ``, and `$<name>` as backreferences. Real
  values like `plan_units` or `previous_phase_briefing` may
  legitimately contain those sequences (shell snippets, regex
  examples, jq filters); only `(_match, name) => ...` passes the
  value through verbatim. PR #6 fix `9a1f927` caught the 2nd-arg
  form silently corrupting a code-fence demo.
- **One-pass.** A single `template.replace(INTERP_RE, ...)` scan
  substitutes every `{{var}}` exactly once; the output is not
  re-scanned. A `{{plan_units}}` value that itself contains the
  literal `{{role}}` (e.g., a code fence demonstrating template
  syntax) survives as text — see Unit 7 design decision #1 below.

**No conditionals. No loops. No Handlebars.** If a template wants
"render this section only when previous_phase_briefing is non-empty",
the render is the template author's responsibility: accept that the
template renders a section with an empty body when the variable is
empty. That is the agreed V1 trade-off.

### Re-declaration convention for nested templates

When template X inlines template Y via `{{var}}` (today the cases are
`qa-prompt.md` inlining `qa-playbook-prompt.md` via
`{{qa_playbook_block}}`, and `recovery-prompt.md` inlining the same
playbook via the same variable for QA recovery), X must re-declare
every variable Y declares in X's own `required` or `optional`
frontmatter. Unit 7's validator treats X's frontmatter as the complete
variable surface for rendering X — it does not transitively walk Y's
frontmatter.

This is manual sync. The trade-off is deliberate: it keeps the
validator's rule simple ("union of `required` + `optional` is the
complete variable surface, no cleverness") at the cost of a one-line
duplication when nested templates evolve. If a third nested template
ever appears, revisit the heavier `inlines:` frontmatter key
(documented as Option C in `docs/todos/011`) to mechanize the union.

Concrete example: `qa-playbook-prompt.md` declares `optional:
[test_commands_block]`. `qa-prompt.md` inlines it as
`{{qa_playbook_block}}`, so `qa-prompt.md` also lists
`test_commands_block` in its own `optional` list. `recovery-prompt.md`
also inlines the playbook (when the recovery role is `qa`) so it too
re-declares `test_commands_block` in its `optional` list.

### Prepending the protocol header

For `impl-prompt.md`, `qa-prompt.md`, and `recovery-prompt.md`, Unit 7
concatenates `protocol-header.md` + role template (with variable
substitution on both) into a single prompt file. `coordinator-briefing.md`
also prepends the header, even though its primary purpose is a read
artifact — this keeps the role-preamble invariant intact. The
`qa-playbook-prompt.md` file is inlined as a variable value, not
prepended separately; it is rendered to text and passed as
`{{qa_playbook_block}}` to **both `qa-prompt.md` and `recovery-prompt.md`
when the recovery role is `qa`**, so a respawned QA gets the same
playbook (with the same `test_commands_block` overrides) the original
dispatch ran. Unit 7 should render the playbook once per recovery
dispatch when `role == qa` and pass it through; for non-QA recoveries
the variable is left empty.

### Frontmatter contract

Every template (including this one's headings convention, and
including `qa-playbook-prompt.md` even though it is a fragment) begins
with YAML frontmatter listing the variables it references:

```yaml
---
required: [role, phase_id, plan_units]
optional: [previous_phase_briefing]
---
```

- **required** — Unit 7 must raise an error if any of these is absent
  from the interpolation context. Rendering a template with a
  `{{role}}` placeholder still visible is worse than failing loudly.
- **optional** — Unit 7 substitutes the empty string when the variable
  is absent. This is acceptable because templates above have been
  written to read correctly with empty optional sections.
- Any `{{var}}` that appears in the template body but is not listed
  in either block is a lint error — Unit 7 should warn and refuse to
  render until the catalog is updated.

## Variable catalog (authoritative)

Every variable used across any template is documented here. **Unit 7's
validator reads this list** (or a machine-readable mirror derived from
it; see the open question at the end) — if a template references a
variable that is not in the list below, the render must fail.

### Universal variables (header + role templates)

| Name | Type | Purpose |
|---|---|---|
| `role` | string enum | `impl` \| `qa` \| `coord` \| `recovery`. Value is the agent's dispatched role. `recovery` is reserved for the V1.5 recovery-analyst agent; V1 `recovery-prompt.md` renders with the original role (`impl`, `qa`, or `coord`) because a respawned session takes on the same role. |
| `phase_id` | string | Phase identifier matching `VALID_ID_RE` (`[A-Za-z0-9._-]+`). The character class is shared with `parse-manifest.js`'s `VALID_ID_RE` and `session-start.js`'s `FLAG_NAME_RE` — change all three sites or none. See `hooks/README.md` "Contract invariants" and `docs/todos/006` / `030` for context. |
| `project_name` | string | Repo slug or user-facing project name. Displayed in the role preamble. |
| `workdir` | absolute path | The spawned session's `cwd`. Every protocol file path is anchored here. |
| `phase_dir` | absolute path | `${workdir}/docs/orchestration/phases/${phase_id}`. All inputs/outputs for this phase live under it. |
| `completion_signal_path` | absolute path | Where the agent writes its completion signal. Unit 7 derives this as `${phase_dir}/${role}-complete.md` unless the manifest overrides it. |
| `prior_phase_dirs` | block (newline-joined absolute paths) | Completion-signal paths from `depends_on` phases. Empty if no upstream deps. |
| `heartbeat_path` | absolute path | `${phase_dir}/heartbeat.jsonl`. Optional — the role prompt may disable heartbeats by passing an empty value. |
| `suggested_commit_message` | string | A commit-message seed drawn from the manifest's phase entry. The agent is free to override it. |

### Impl-specific

| Name | Type | Purpose |
|---|---|---|
| `plan_units` | block | The plan excerpt for this phase. Multi-paragraph markdown extracted from the plan file by Unit 7. |
| `previous_phase_briefing` | block | Concatenated completion signals from upstream phases, inlined for reading. Empty if no upstream deps. Also carried as `optional` by `recovery-prompt.md` so an impl-recovery has the same upstream context as the crashed predecessor. |
| `output_paths` | block (newline-joined relative paths) | Expected artifacts this role must produce, beyond the completion signal. |

### QA-specific

| Name | Type | Purpose |
|---|---|---|
| `pr_or_branch_under_test` | string | The branch name or PR number the QA agent will checkout before running rows. Also carried as `optional` by `recovery-prompt.md` so a qa-recovery has the same artifact-under-test target the original dispatch ran against. |
| `qa_scope_rows` | block | The per-PR numbered scope rows. Generated by Unit 7 from the impl phase's output contract plus manifest-declared verifications. Also carried as `optional` by `recovery-prompt.md` so a qa-recovery resumes against the same scope rows. |
| `qa_playbook_block` | block | The fully-rendered text of `qa-playbook-prompt.md`, inlined into `qa-prompt.md`. Rendered recursively by Unit 7 before interpolating `qa-prompt.md`. Also carried as `optional` by `recovery-prompt.md` so a qa-recovery has the playbook the original dispatch ran. |
| `test_commands_block` | block | Project-specific test-command overrides, rendered into `qa-playbook-prompt.md`. Empty falls back to the playbook's default `npm test` per-workspace behavior. Also re-declared as `optional` by `qa-prompt.md` (which inlines the playbook via `{{qa_playbook_block}}`) and by `recovery-prompt.md` (which also inlines `{{qa_playbook_block}}` for qa-recovery), per the re-declaration convention documented in the Interpolation contract section. |

### Coord-specific

| Name | Type | Purpose |
|---|---|---|
| `status_summary_block` | block | One-paragraph status summary. Imperative present tense. |
| `decisions_block` | block | Session decisions, each tagged `[inferred from session]` when derived rather than user-stated. Always renders; empty state is `(no decisions captured)` literal. |
| `open_questions_block` | block | Unresolved items for the coord to triage. Same inference tagging and empty-state rule as decisions. |
| `plan_reference_block` | block | Repo-relative path(s) to every active plan this briefing touches. |
| `project_context_block` | block | Repo slug, branch, HEAD SHA, worktree clean/dirty flag, latest checkpoint path. |
| `git_details_block` | block | Last N commits and a short status or diff stat. |
| `warnings_block` | block | Every `[warning: source -- reason -- omitted]` line from the briefing generation surface. Always renders; empty state is `(no warnings)` literal. |
| `artifact_pointer` | string | Absolute path to the full briefing on disk, usually under `~/.claude/handoffs/<slug>/`. |
| `coord_next_actions` | block | The specific action the briefing recommends the coord take next. Rendered under the `## Dispatched next action` heading; recommend-only — the coord may override. The heading is deliberately distinct from session-handoff's `## Instructions` (authoritative directive) to make the lower authority visible. |

### Recovery-specific

| Name | Type | Purpose |
|---|---|---|
| `recovery_checkpoint_path` | absolute path | The orchestrator's snapshot of the prior session's state. May point at an empty file, a partial completion signal, or a full `status: partial` signal. |
| `crash_timestamp` | ISO 8601 UTC string | Orchestrator-observed moment the prior session was declared dead. |
| `last_heartbeat_timestamp` | ISO 8601 UTC string \| `null` | Timestamp of the prior session's last heartbeat entry, or `null` if none was emitted. |
| `prior_session_pid` | string | The crashed session's PID, for log correlation. `unknown` if the orchestrator never captured it. |
| `completed_checkpoints_block` | block | Checkpoints reconstructed from prior-session artifacts; each entry is a one-line bullet with a verified-on-disk pointer. |
| `remaining_work_block` | block | The plan excerpt for this phase with completed items marked `[x - done by prior session]` and the rest marked `[ ]`. |

## Empty-state rendering

When an optional variable is empty, Unit 7 substitutes the empty
string. The surrounding template has been written to read correctly in
that case — headings remain, and prose like "If this section is empty,
…" explains the absence. Authors adding new optional variables should
match this convention: write a sentence under the heading that handles
the empty case, rather than relying on the heading alone to convey
meaning.

Three coord-specific blocks (`decisions_block`, `open_questions_block`,
`warnings_block`) render an explicit literal placeholder rather than
empty prose — `(no decisions captured)`, `(no open questions)`, `(no
warnings)`. This matches the session-handoff skill's contract: the
reader must distinguish "we looked and found nothing" from "we forgot
to look." Unit 7 implements this by substituting the placeholder when
the caller passes an empty block, not by leaving the variable blank.

## Unit 7 integration notes

`scripts/generate-prompt.js` (Unit 7) implements:

1. **Frontmatter is the authoritative variable surface per template.**
   The renderer reads each template's YAML frontmatter (`required`
   + `optional`) and treats their union as the complete variable list
   for that template. The variable catalog above is the human-facing
   pairwise reference; V1 does not regex-parse the README tables.
   The substantive lockstep invariant — every body `{{var}}` is
   declared in frontmatter — is enforced at render time and also
   re-checked across every real template by the
   `every real template parses + has valid required/optional shape`
   test in `generate-prompt.test.js`. If a second consumer of the
   catalog appears or catalog ↔ frontmatter drift becomes
   load-bearing, revisit per Unit 7 design decision #3.
2. **Template validation.** For every template loaded: parse the
   frontmatter, confirm every `{{var}}` in the body appears in
   `required ∪ optional` (lint error if not — undeclared body
   variables would otherwise ship to the agent verbatim), and
   confirm every `required` variable is present and non-empty in
   the render context.
3. **Interpolation.** Render with the one-pass `String.replace` form
   above. Missing required variable → throw. Missing optional
   variable → substitute empty string. Empty value for one of the
   three coord-specific blocks (`decisions_block`,
   `open_questions_block`, `warnings_block`) → substitute the
   canonical placeholder per design decision #4.
4. **Concatenation.** For role templates that need the header
   (`impl`, `qa`, `recovery`, and `coord`), concatenate after
   rendering: `protocol-header.md` first, then the role template,
   joined by a blank line. For `qa-prompt.md`, render
   `qa-playbook-prompt.md` first and pass its output as
   `{{qa_playbook_block}}`. **For `recovery-prompt.md` when the
   recovery role is `qa`**, do the same playbook pre-render and pass
   the result as `{{qa_playbook_block}}`, plus pass through the same
   `test_commands_block` override the original QA dispatch used.
   Otherwise (`role != qa` recovery), pass `qa_playbook_block` as
   empty — the recovery template's prose handles the empty case.
5. **Original-prompt preservation for recovery dispatches.** Before
   writing a recovery prompt at `${phase_dir}/${role}-prompt.md`
   (where `${role}` is the original role being respawned, e.g.
   `impl`, `qa`), preserve the original (non-recovery) dispatch
   prompt at `${phase_dir}/${role}-prompt.original.md` — but ONLY if
   that path does not already exist. The preservation is one-shot:
   the first recovery dispatch for a given phase/role copies the
   prior non-recovery prompt into the `.original.md` slot; every
   subsequent recovery dispatch (re-recovery after a second crash)
   sees the file already present and skips the copy, so the slot
   continues to hold the FIRST non-recovery prompt across the entire
   crash chain. Pseudocode:

   ```
   original = `${phase_dir}/${role}-prompt.original.md`
   if not exists(original): copy `${phase_dir}/${role}-prompt.md` → original
   write recovery_prompt → `${phase_dir}/${role}-prompt.md`
   ```

   The recovery template's "Previous-phase briefing" audit step reads
   this preserved-original file to distinguish "briefing was
   legitimately empty for this phase" from "the recovery dispatch
   dropped mandatory context." Without this preservation step, a
   recovered impl/qa session has no way to tell those two cases apart
   and will conservatively block. The preservation is path-scoped (no
   other agent reads or writes the `.original.md` suffix).

   **Re-recovery briefing invariant.** On a re-recovery dispatch (the
   second or later recovery for the same phase/role), the
   `previous_phase_briefing` passed to the recovery prompt MUST equal
   the briefing from the most-recent prior recovery dispatch (or, if
   none, the original dispatch). The recovery template's audit step
   compares against `${role}-prompt.original.md` — drift between the
   original and a re-recovery's briefing will produce a false
   `status: blocked`. If a future Unit 7 change ever needs to refresh
   `previous_phase_briefing` on recovery (e.g., because an upstream
   completed in the interim), the audit step's contract has to evolve
   in the same PR — see todo 017 for the full rationale.

## Unit 7 design decisions

These are the seven interpolation edge cases the template author
flagged for Unit 7's design phase. PR #13 (Unit 7) decided each one;
the resolutions below are the contract every future change to Unit 7
must respect. Where a decision references an Open Question number, it
matches the original numbering in this section's prior incarnation
plus the seventh decision the dispatch handoff added.

1. **Plan-excerpt literals — interpolation is one-pass.** If
   `{{plan_units}}` contains a markdown fenced code block that itself
   has `{{…}}` literals (e.g., a code sample showing template syntax),
   the simple regex replace would double-substitute under a multi-pass
   reduce. Unit 7 uses one `String.replace(INTERP_RE, fn)` scan over
   the body — substituted content is not re-scanned, so nested
   `{{role}}` / `{{phase_id}}` tokens inside `plan_units` survive as
   literal text. Tested by `nested {{role}} inside planUnits code fence
   survives one-pass`.

2. **Newline normalization — LF on write, every platform.** Templates
   check into the repo with LF endings, but the generated prompts go
   through atomic-rename + read paths that may convert to CRLF on
   Windows. Unit 7's `atomicWrite` runs the assembled text through
   `normalizeLineEndings` (CRLF and bare-CR collapse to LF) before
   writing, regardless of platform. Diffs of the generated prompt
   remain stable across the Windows / Unix mixed authoring this
   project assumes; agents that read prompts on either OS see the
   same bytes. Tested by `output is LF only on disk (no CRLF)
   regardless of input templates`.

3. **Catalog sync — README-only.** Unit 7 parses the variable-catalog
   tables in this README directly (one regex per table); no
   `templates/variables.json` mirror exists. The mirror would pay
   for itself once a second consumer beyond Unit 7 exists or once
   the catalog grows past ~15 variables. Today it is 31 entries with
   one consumer; the duplication cost outweighs the maintenance
   cost. Revisit if Unit 11's dashboard or an automated triager
   begins reading the catalog.

4. **Empty-state placeholder owner — Unit 7 injects.** When the
   caller passes `""` / `null` / `undefined` for `decisions_block`,
   `open_questions_block`, or `warnings_block`, Unit 7 substitutes
   the canonical placeholder (`(no decisions captured)`,
   `(no open questions)`, `(no warnings)`) before frontmatter
   validation runs. Callers can pass empty values indifferently;
   they must not pre-inject the placeholders. Tested by the four
   `coord empty / undefined / non-empty …Block` tests in
   `generate-prompt.test.js`.

5. **`dispatcher_advisories` parser — accepts integer V1 form.** The
   field is `dispatcher_advisories: <int>` in V1 (count only;
   evidence lives under `## Advisories` in the body). Unit 7's
   `buildPreviousPhaseBriefing` parses upstream signals' frontmatter
   and surfaces non-zero counts as warnings the orchestrator can
   route to coord investigation. The parser **rejects** any
   non-integer or negative form with an explicit warning so the
   eventual evolution to a structured array
   `dispatcher_advisories: [{row, original_in_handoff,
   rewritten_in_dispatch}, ...]` (Open Question #5; gated on a
   second consumer like a dashboard or automated triager) does not
   silently mis-parse against the V1 contract.

6. **Re-declaration transitive drift defense — Option A
   (lint warning, hardcoded `qa_playbook_block` special case).**
   When a template's body inlines `{{qa_playbook_block}}`, its
   required+optional union must contain every variable
   `qa-playbook-prompt.md` declares. Unit 7's `checkTransitiveDrift`
   reads the playbook's frontmatter and emits a **warning** (not an
   error) for each missing var — present-tense observation, not a
   render-blocker. Today the only nesting case is the playbook
   inlined into qa-prompt and recovery-prompt; if a third nested
   template ever appears, revisit Option B (frontmatter
   `inlines:` key) to mechanize the union — see `docs/todos/011`.

7. **A1 render-size methodology — post-frontmatter,
   post-substitution, pre-write.** The `charCount` field returned by
   `generatePrompt` measures the assembled, LF-normalized text
   actually written to disk: header rendered + role template
   rendered + concatenation + line-ending normalization, byte-equal
   to `fs.readFileSync(promptPath).length`. Reproducible across
   runs; suitable for the per-template render-size budgets PR #6 QA
   asked for.

Adding new variables, nested-template cases, or empty-state
placeholders should fold the resulting design call back into this
section rather than letting it live only in `generate-prompt.js`
code comments.

## Changing a template

1. Update the template file.
2. If you add a `{{new_variable}}`, add it to the table above.
3. If you remove a variable, remove it from the template frontmatter
   and from the table.
4. Run the Unit 7 lint / validator (once it exists) to confirm the
   template still renders cleanly with a representative fixture.
5. Ship the change in a single PR — templates and catalog must not
   drift.
