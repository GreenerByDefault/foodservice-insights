# Pre-port groundwork for the Python library port

## Context

[`.claude/plans/python-port.md`](.claude/plans/python-port.md) moves GBD's 24.8k-line closed-source
analysis library into this repo across seven PRs. Two of those PRs carry changes that do not
actually depend on the ported code existing: PR 5's `run.json` contract change and env-allowlist
trim, and a scattering of gitignore / CI / prefactor work that PRs 1, 2 and 4 would otherwise have
to do inline, inside diffs that are already enormous copy PRs.

Landing that work first shrinks the copy PRs to what a reviewer actually needs to scrutinize —
"is this the source repo's code, and is it safe to publish" — and gets the risky-to-review
contract change reviewed on its own, against a codebase where every test still runs.

Two PRs, both on `main`, order-independent except that PR 1 is the one worth reviewing carefully.

Precedent: #264 (`requiredContractVersion`) and #265 (cap `organization.name` at 100 chars) were
already prep of exactly this kind.

---

## PR 1 — `report.organizationName` in the contract, and the env allowlist trim

Two changes that touch the same files (`contract/names.ts`, `contract.json`, `names.py`,
`turbo.json`, `spawn.test.ts`), so they ride together.

### 1a — `organizationName`

The report PDF's "client" slot is named by the organization, so the manifest must carry it.
`organization.name` is `NOT NULL` with 1–100-length and trimmed CHECKs, so the field is a
**required non-nullable non-empty string** — unlike `name`/`siteName`, which are nullable.

**No `requiredContractVersion` bump.** That column gates worker↔web/database compatibility across
deploys; `run.json` is written and read inside a single worker deployment.

Schema and query:

- [apps/worker/src/contract/messages.ts:25-35](apps/worker/src/contract/messages.ts#L25-L35) —
  `RunManifestSchema.report` gains `organizationName: nonEmptyString` (the helper at :20 already
  exists). [:57-66](apps/worker/src/contract/messages.ts#L57-L66) — `RunManifestInput['report']`
  gains `organizationName: string`. `buildRunManifest`/`parseRunManifest` are schema-driven and
  need no body change.
- [apps/worker/src/attempt/queue.ts:146-163](apps/worker/src/attempt/queue.ts#L146-L163) —
  `loadAttemptInputs` gains a third join,
  `.innerJoin('organization', 'organization.id', 'report.organizationId')`, selecting
  **`'organization.name as organizationName'`**. The alias is load-bearing: `report.name` is
  already selected bare and would collide. Add `organizationName: row.organizationName` to the
  returned `report` at [:175-181](apps/worker/src/attempt/queue.ts#L175-L181). `AttemptInputs.report`
  is `RunManifestInput['report']`, so it widens for free.
- [apps/worker/src/attempt/lifecycle.ts:108-111](apps/worker/src/attempt/lifecycle.ts#L108-L111) —
  no edit; `inputs.report` flows straight through. It is the only production `buildRunManifest`
  call site.

Fixtures (follow [contract/README.md:20-24](contract/README.md#L20-L24)):

- `contract/fixtures/valid/run.json` gains the field.
- **Eleven existing `invalid/run.*.json` fixtures must gain it too** — both stacks parse strictly,
  so a now-missing required field would make each fixture reject for the wrong reason, silently
  un-pinning the violation it exists to pin: `analysis-attempt-id-not-a-uuid`, `bad-month-key`,
  `counts-basis-not-an-enum-value`, `empty-monthly-counts`, `missing-site-name`,
  `monthly-counts-is-an-array`, `name-is-a-number`, `negative-monthly-count`,
  `unit-system-not-an-enum-value`, `unknown-field-in-report`, `unknown-field`. The three that carry
  no report field list (`missing-report`, `report-is-a-string`, `root-is-an-array`) are untouched.
- One new fixture, `invalid/run.missing-organization-name.json`, mirroring `run.missing-site-name`.
  It is picked up automatically by both stacks
  ([fixtures.test.ts:106-111](apps/worker/src/contract/fixtures.test.ts#L106-L111),
  [contract_fixtures.py:36](python/worker_child/tests/support/contract_fixtures.py#L36)); the only
  rule is the `run.` filename prefix. Do **not** add a valid fixture — `fixtures.test.ts:56-61`
  asserts `valid/` is exactly the four documents.
- `contract/contract.json` needs **no change** — it carries only enums, not the report field list,
  so `contract.test.ts` and `test_contract.py` are untouched.

Python:

- [contract/messages.py:26-32](python/worker_child/worker_child/contract/messages.py#L26-L32) —
  `ReportInputs.organization_name: str`; `parse_run_manifest` at :57-63 gains
  `organization_name=report.string("organizationName")`. `Fields.string()` already rejects empty,
  so `fields.py` is untouched.
- [run.py:58-69](python/worker_child/worker_child/run.py#L58-L69) — `_build_request` passes it on.
- [analysis.py:37-48](python/insights/gbd_foodservice_insights/analysis.py#L37-L48) —
  `AnalysisRequest.organization_name: str`. The dataclass has no defaults, so every construction
  updates. `stub_analysis` and `worker_child/testing.py` need no change (they key off
  `report_name` / the output directory only).

Tests:

- [fixtures.test.ts:73-84](apps/worker/src/contract/fixtures.test.ts#L73-L84) — the
  `RunManifestInput` literal compared to the golden fixture.
- [queue.test.ts:334-352](apps/worker/src/attempt/queue.test.ts#L334-L352) — the `toEqual` on the
  whole `AttemptInputs`. `insertOrganization` defaults to a random name, so this test needs an
  explicit `insertOrganization(tx, { name: '…' })` + `insertReport(tx, { organizationId })` to stay
  deterministic. (No change to `packages/db/src/testing/fixtures.ts` is required; a passthrough on
  `insertReport` is optional convenience.)
- [run-directory.test.ts:21-29](apps/worker/src/child/run-directory.test.ts#L21-L29) — the
  module-level `MANIFEST`.
- Python `AnalysisRequest` constructions: `python/insights/tests/test_analysis.py:7-18`,
  `python/insights/tests/test_testing.py:13-24`, `python/worker_child/tests/test_testing.py:26-37`.
- [test_fixtures.py:41-53](python/worker_child/tests/contract/test_fixtures.py#L41-L53) — the
  field-by-field manifest assertion gains `organization_name`.
- Insulated, verify only: `conftest.py`'s `run_directory` fixture writes `VALID_MANIFEST` verbatim,
  which is what keeps `test_run.py`, `test_main.py` and `test_child_process.py` from needing edits.
  `lifecycle.test.ts`, `attempt-fixture.ts`, `worker-harness.ts`, `fake-child.ts` and
  `tests/e2e` all go through the DB fixtures or ignore the manifest — no change.

### 1b — trim the env allowlist

To `PATH, HOME, LANG, TZ, OPENAI_API_KEY`. The PDF extractor (`LLM_WHISPERER_API_KEY`) and the
entree detector (`GEMINI_API_KEY`) both end up in the lab, outside the shipped child.

- [contract/names.ts:9-19](apps/worker/src/contract/names.ts#L9-L19) — `INVOCATION.environmentVariables`, and reword the comment.
- `contract/contract.json` `invocation.environmentVariables` — asserted equal by both stacks.
- [contract/names.py:8-16](python/worker_child/worker_child/contract/names.py#L8-L16).
- `turbo.json` `globalPassThroughEnv` — drop the two keys.
- [spawn.test.ts:39-45](apps/worker/src/child/spawn.test.ts#L39-L45) — the `PARENT_ENVIRONMENT`
  literal. The allowlist assertion at :110-133 is derived and needs no edit.
- [python/README.md:61-64](python/README.md#L61-L64) — the "will want three keys, deliberately
  absent from `.env.example`" paragraph becomes about `OPENAI_API_KEY` alone. Leave `.env.example`
  itself alone; PR 5 of the port adds the key when code reads it.

---

## PR 2 — Groundwork

Four independent small things. None of them is a behaviour change to the product.

### 2a — Gitignore the caches and the client scratch, before any copying

The port plan's hardest safety requirement is that the three cache CSVs and GBD's client working
directories never enter git. These entries must exist **before** the copy PRs, not in them.

Root [`.gitignore`](.gitignore) gains, near the existing Python block:

```
# Handed out privately; see the data_files READMEs. Never committed.
python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv
python/lab/gbd_foodservice_insights_lab/data_files/previously_classified_entrees.csv
python/lab/gbd_foodservice_insights_lab/data_files/previously_classified_weights.csv
.ipynb_checkpoints/
```

Plus three committed files:

- `python/insights/gbd_foodservice_insights/data_files/README.md` and
  `python/lab/gbd_foodservice_insights_lab/data_files/README.md` — what each CSV is, that it is
  obtained out-of-band from GBD, and that a missing file means an empty cache with a warning.
- `python/lab/client_work/.gitignore` containing `*` and `!.gitignore` — the data scientists'
  working directories, present but never committed.

### 2b — Lint the lab in CI, and wire nbstripout

Today a lab-only change is **never linted**: the `python` path filter excludes `python/lab/**`
([`.github/filters.yml:67-72`](.github/filters.yml#L67-L72)), and the `py-lab` job runs only
`just test-lab` ([`ci.yml:231-240`](.github/workflows/ci.yml#L231-L240)). That is a real gap now,
independent of the port.

- Add `just lint` to the `py-lab` job.
- Add `nbstripout` to the root `dev` dependency group; `just lint` gains a verify step and
  `just fmt` the stripping form. **Use a null-safe form** —
  `git ls-files -z '*.ipynb' | xargs -0 -r uv run nbstripout --verify` — because with zero
  notebooks in the repo today, a bare `$(git ls-files '*.ipynb')` gives nbstripout no arguments and
  it blocks reading stdin, hanging CI.
- `uv lock` for the new dev dep.

This is inert until PR 2 of the port drops in four notebooks, which is the point: the check bites
the first time a notebook with outputs is committed rather than after.

### 2c — `errors.py` prefactor

PR 4 of the port needs `AnalysisError` and its three subclasses out of `analysis.py`, because
`llm.py` raises `UpstreamApiError` and importing `analysis` from `llm` would close a
`llm → analysis → categorize` cycle. Doing it now costs three files instead of being buried in
that PR.

- New leaf `python/insights/gbd_foodservice_insights/errors.py` holding `AnalysisError`,
  `UpstreamApiError`, `InvalidInputError`, `UnusableDataError` verbatim from
  [analysis.py:56-70](python/insights/gbd_foodservice_insights/analysis.py#L56-L70).
- `analysis.py` imports and re-exports them, so
  [worker_child/failures.py:11-19](python/worker_child/worker_child/failures.py#L11-L19) and
  `gbd_foodservice_insights/__init__.py` are unchanged. Keep the re-export deliberate (`__all__`
  or an explicit `as` import) so ruff's F401 does not delete it.

### 2d — Doc fix

`ARCHITECTURE.md` and `packages/db/README.md` both link `apps/worker/src/sweeps/reaper.ts`; the
file is `apps/worker/src/sweeps/converge.ts`. Noted at the tail of the port plan; no reason to wait.

---

## Explicitly not done before the port

- **`AnalysisOutcome.metadata` / the `result_metadata` column.** Its shape depends on the ported
  library — [REQUIREMENTS.md:61-65](REQUIREMENTS.md#L61-L65) says so outright, and
  `.claude/plans/categorization-cache.md` already owns the plumbing. Guessing a shape now would be
  a contract change we'd redo.
- **Wiring `WORKER_MODE=mock-llm`.** It needs `worker_child.mock_llm` and `KeywordLlmClient`, which
  do not exist. The named-but-throwing slot in
  [modes.ts:59-64](apps/worker/src/modes.ts#L59-L64) is already the right placeholder.
- **The library's runtime deps (pandas, matplotlib, …) and `uv.lock`.** Unused dependencies would
  bloat the production image and lock versions against nothing.
- **ty overrides and ruff per-file-ignores for ported code.** Which rules fire is only knowable
  once the code is in.
- **Merging the source repo's conventions into `.claude/rules/python.md`.** Documented conventions
  with no code enacting them; the port plan correctly pairs each with its PR.

---

## Verification

Both PRs, from the repo root:

```
pnpm lint && pnpm check && pnpm test
just lint && just check && just test
just test-lab
```

PR 1 additionally:

- `pnpm exec turbo run test:system` — the contract change crosses the parent↔child seam, and the
  system tests are what actually spawn a Python child against a real run directory.
- Confirm both fixture suites *ran*: `apps/worker/src/contract/fixtures.test.ts` and
  `python/worker_child/tests/contract/test_fixtures.py`. The new invalid fixture is auto-discovered,
  so a naming slip shows up as a missing test rather than a failure.
- Manual smoke: `pnpm dev` with `WORKER_MODE=stubbed`, submit a report, and confirm the run
  directory's `input/run.json` carries `report.organizationName` matching the org.

PR 2 additionally:

- `git check-ignore -v python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv`
  (and the other two) reports the new rule — the cheapest proof the paths are right before any CSV
  exists.
- `git status --ignored` after dropping a dummy CSV at each path shows it ignored;
  `git ls-files | grep '\.csv$'` stays empty.
- Touch a file under `python/lab/` in the PR so the `py-lab` job actually fires and its new
  `just lint` step is observed green.
- Add a throwaway `.ipynb` with a cell output locally and confirm `just lint` fails on it, then
  `just fmt` fixes it. Do not commit the notebook.
