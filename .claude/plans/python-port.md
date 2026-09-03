# Python port

## Context

Phase 1 of `foodservice-insights` is nearly done; the biggest remaining task is porting GBD's
closed-source Python library (`greener_by_default.foodservice_insights`, 24.8k lines, 34 modules)
into this repo, then archiving that repo. GBD agreed to a monorepo so their data-science code can
import the product library without a cross-repo dependency, and so they can iterate locally on
lab code without being able to break the product.

The repo is already shaped for this: `analysis.py` is the seam (`AnalysisRequest` → `analyze()`
→ `AnalysisOutcome`), `worker_child` calls it, `apps/worker/src/modes.ts` reserves
`WORKER_MODE=mock-llm` as "the slot the port fills", and `.claude/rules/python.md` carries a
*Status: scaffolding* banner plus two Open items the port resolves. The Python workspace has no
LLM SDK, no pandas, no third-party runtime dependency today.

A companion plan, `categorization-cache.md`, moves the product-categorization cache into
Postgres afterward. Nothing here depends on it — this plan leaves all three cache CSVs as
gitignored files at the paths the library already reads them from.

### What this port must get right

1. **The three cache CSVs never enter git.** `previously_categorized_items.csv` (~39k rows of
   `product, category, cleaned_item_names`; most rows are the negative label `"No Matches Found"`,
   the biggest LLM-call saver), `previously_classified_entrees.csv`, and
   `previously_classified_weights.csv` are **gitignored at the packaged paths the library already
   reads**, obtained out-of-band, and a missing file means an empty cache with a loud warning.
   The companion plan replaces the first with a table; the other two stay files in the lab.
2. **Everything not on the product path goes to the lab** (`gbd_foodservice_insights_lab`) —
   extraction, weight cleaning, pilot analysis, procurement-vs-serving comparison, notebook
   tooling, runscripts, and serving mode (entree detection) — so `catering_analysis` can be
   archived whole.
3. **Safe to publish.** The source repo has never committed a secret (verified across its
   history), but it holds one real client's procurement workbooks under `test_data/`, and its
   `AGENTS.md`, `CLAUDE.md`, one reference doc, and its pre-commit config carry a maintainer's
   home directory, an internal email address, staff names, and client names. None of those files
   are ported; the copy PRs grep for a private denylist of those strings, kept outside this repo.
4. **Code quality can lag; safety cannot.** Refactors come after the code is in and working.

### Git history and attribution

Files are copied with `cp`, not merged — no subtree, no history rewrite. Attribution is carried
by `Co-authored-by:` trailers on each copy PR's squash commit, one per author in the source
repo's `git shortlog -sne`, using the email each author already exposes on GitHub.

### Lab deps out of the production image

No extra tooling: uv workspaces already do this. `uv sync --package worker-child --no-dev`
installs `worker_child` + `gbd_foodservice_insights` and their deps — the lab member and its deps
(`llmwhisperer-client`, `PyPDF2`, `ipython`, …) are simply not selected. `--all-packages` is the
developer's command, `--package worker-child` is the image's. That is the whole answer; the lab
must stay its own workspace member for it to work (an "extra" on one project would install the
lab's code everywhere).

## Target layout (after PR 1)

The current `python/gbd_foodservice_insights/src/gbd_foodservice_insights/…` repeats the name
three times. PR 1 flattens it: **project directories get short names, the `src/` level goes, and
the import names stay**. Hatchling takes `packages = ["gbd_foodservice_insights"]` directly.

```
python/
  insights/                          distribution gbd-foodservice-insights (ships)
    pyproject.toml
    gbd_foodservice_insights/
      analysis.py                    the seam
      errors.py                      AnalysisError + the three seam exceptions (leaf)
      testing.py                     stub_analysis + KeywordLlmClient (shipped test double)
      llm.py                         provider clients, one retry layer, LlmClient protocol
      categorize.py categorize_steps.py categorize_cache.py categorize_reviews.py
      categories.py emissions.py utils.py
      food_report.py report_*.py plotting_utils.py
      data_files/                    GBD_categories.yaml diagnostic_thresholds.yaml gemini_models.json
                                     README.md + gitignored previously_categorized_items.csv
      prompts/                       match_items_to_gbd_categories, clean_item_name, fuzzy_match_gbd_category
    tests/                           conftest.py, data/, test_*.py
  lab/                               distribution gbd-foodservice-insights-lab (ships nothing)
    pyproject.toml  README.md
    gbd_foodservice_insights_lab/
      serving.py                     entree detection + serving-mode orchestration
      llm_extraction.py              the LLMWhisperer/PDF/unit half of the old LLMs.py
      extract_pdf.py extract_other.py extract_tabular_io.py extract_tabular_inspection.py
      clean_product_weights.py pilot_analysis.py pilot_plots.py procurement_serving_comparison.py
      notebook_runscript_setup.py notebook_utils.py plotting_extras.py LLM_testing.py gemini_api_examples.py
      scripts/backfill_entree_cleaned_names.py
      data_files/                    README.md + gitignored previously_classified_{entrees,weights}.csv
      prompts/                       entree_detector, extract_weight, clean_units, *pdf_extraction*
    runscripts/                      the 5 runscript .py + 4 .ipynb (outputs stripped)
    client_work/.gitignore           "*" + "!.gitignore" — never committed
    test_data/                       anonymized fixtures only
    tests/
  worker_child/                      distribution worker-child (ships)
    pyproject.toml
    worker_child/                    …/contract/, run.py, testing.py, mock_llm.py
    tests/                           support/ stays here (root pytest `pythonpath` depends on it)
```

Root `pyproject.toml`, `uv.lock`, `.python-version`, `Justfile` stay at the repo root: uv finds
the workspace by walking up, and `just test` from anywhere is worth keeping. (Moving them under
`python/` would need `--project python` on every uv call and a second lockfile location; not
worth it.)

Every PR ends with `just lint && just check && just test` (+ `just test-lab` when the lab is
touched), and `pnpm lint && pnpm check && pnpm test` when TS is touched.

### Copy mechanics (PRs 2 and 3)

Copy with `cp`, then fix up until CI is green; commits at the author's convenience (the PR
squash-merges). Reviewer checklist: the sensitive-content grep on the diff is empty (one known
hit to reword: a comment in `plotting_utils.standardize_title_case`); no `.csv` under a package
directory except the gitignored names (`git status --ignored` shows them, `git ls-files` does
not); new runtime deps exactly as listed; no `[tool.ruff]` in a member pyproject; CI green with
the unmocked end-to-end report test *running*, not skipped. Fix-ups, in order:

1. Rename `greener_by_default.foodservice_insights` → `gbd_foodservice_insights`; hard-coded
   logger names → `logging.getLogger(__name__)`.
2. `ruff format` (line-length 100), then `ruff check --fix --unsafe-fixes`. Measured against the
   root config: ~25 manual fixes remain for the library, ~40 for the lab — **no per-file-ignores
   block for ported code**. Test files: ~270 one-line docstrings that restate the test name
   trigger E501; delete them (scripted, deleted-lines-only).
3. Packaged data via a new `_resources.py`: `files("gbd_foodservice_insights") / relative`
   (`importlib.resources`). Resolves the python.md Open item; the package is always installed
   from source, so `files()` returns a real `Path`.
4. Dead code and its tests go; deps into the member pyproject + `uv lock`.
5. ty: one `[[tool.ty.overrides]]` per failing module in the root pyproject, listing only the
   rules that fire, headed: *"Ported modules were never typechecked. A PR that edits one of these
   files for any other reason deletes its entry and fixes what surfaces."*

## PR 1 — Prefactor: flatten the Python layout

Pure moves and path updates; no behaviour change. `git mv`:
`python/gbd_foodservice_insights/src/gbd_foodservice_insights` → `python/insights/gbd_foodservice_insights`
(+ `tests/`, `pyproject.toml`); the lab → `python/lab/gbd_foodservice_insights_lab`;
`python/worker_child/src/worker_child` → `python/worker_child/worker_child`.

- Each member `pyproject.toml`: `[tool.hatch.build.targets.wheel] packages = ["<import name>"]`.
- Root `pyproject.toml`: per-file-ignores paths (`python/lab/**`, `python/insights/tests/**`,
  `python/worker_child/tests/**`); `pythonpath = ["python/worker_child/tests"]` is unchanged.
- `Justfile`: `test` → `python/insights python/worker_child`; `test-lab` → `python/lab`;
  `check` → `ty check python/insights python/worker_child scripts` (explicit list; the lab is
  excluded from typechecking from here on — it "carries none of the product's guarantees").
- `.github/filters.yml`: `python/gbd_foodservice_insights_lab/**` → `python/lab/**` (two
  places); `scripts/ci/check_filters.py` fails CI otherwise. This is the one CI touch, required
  by the rename.
- `apps/worker` spawns `python -m worker_child` with `PYTHON_BIN=.venv/bin/python` — module
  names are unchanged, so no TS change; run `pnpm exec turbo run test:system` to prove it.
- Docs: `.claude/rules/python.md` (paths; add the lab-is-not-typechecked line under § The lab
  boundary), `python/README.md`, `ARCHITECTURE.md` component table, `apps/worker/README.md`
  and `tests/e2e/README.md` links, `AGENTS.md` table row.

## PR 2 — Copy the product closure into `insights/`

Goal: `categorize_products` and `run_food_report` work in the monorepo; the unmocked end-to-end
report test passes; **no cache CSV is committed**.

- Modules (the transitive closure of the six entry points the throwaway PoC used — 21 with
  `__init__`): `categories`, `categorize`, `categorize_cache`, `categorize_entrees`,
  `categorize_reviews`, `categorize_steps`, `emissions`, `food_report`, `LLMs`, `plotting_utils`,
  `report_aggregation`, `report_artifacts`, `report_builder`, `report_diagnostics`,
  `report_excel`, `report_plots`, `report_quality`, `report_run_logging`, `report_schema`,
  `report_utils`, `utils`; `data_files/{GBD_categories.yaml,diagnostic_thresholds.yaml,gemini_models.json}`;
  `prompts/{clean_item_name,match_items_to_gbd_categories,fuzzy_match_gbd_category,entree_detector}_prompt.md`.
- **The cache CSV**: add `python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv`
  to `.gitignore` **before copying anything**; the loader `get_previously_categorized_items()`
  returns an empty frame with the three columns + `logger.warning(...)` naming
  `data_files/README.md` when the file is absent (test with `caplog`). `data_files/README.md`
  (committed) says what the file is and that it is handed out privately. Source tests already
  patch the loader, so none read the real file; delete the two that test the file itself.
  `analyze()` (PR 6) passes `cache_write_mode="none"` — product code never writes it.
- **Split `LLMs.py` here**: delete the LLMWhisperer/PDF/unit/weight functions, the `whisper=`
  branch of `setup_api_clients`, `DEFAULT_PDF_MODEL`, and the `unstract`/`requests` imports, so
  the shipped library never depends on `llmwhisperer-client`. PR 3 re-copies the source file
  verbatim as the lab's `llm_extraction.py` and deletes the other half there.
- **Keep the report pipeline's own "serving" axis** (`report_schema.ReportMode`, ~35 references)
  in the library, inert — `analyze()` always passes `"procurement"`. Only the entree detector
  moves (PR 4).
- Dead code dropped: `report_diagnostics.{clean_column_names,validate_date_column,
  baseline_pre_flight_checks}`; the 11 `plotting_utils` helpers only `pilot_plots` calls (→ lab
  `plotting_extras.py` in PR 3); `food_report`'s two `*diner_meal_mapping*` compat wrappers;
  `tests/test_package_imports.py` (builds a pip venv).
- Tests → `python/insights/tests/`: `test_{aggregate,categories,categorize,categorize_cache,
  categorize_entrees,categorize_reviews,categorize_steps,emissions,integration_food_report,llms,
  plotting_utils,report_aggregation,report_builder,report_diagnostics,report_outputs,
  report_refactor,utils}.py` + `conftest.py` (`MPLBACKEND=Agg` before any matplotlib import;
  the `sample_*` and mock-client fixtures). Drop unregistered markers (`--strict-markers`). The
  16 `test_report_diagnostics` tests that import `extract_*` move to the lab in PR 3. Fixture:
  the source repo's anonymized `test_data/step_2_output/aggregated_baseline.csv` (documented
  there as anonymized) is copied to `tests/data/` (user-approved).
- Deps: `matplotlib>=3.10`, `numpy>=2.2`, `pandas>=2.2`, `PyYAML>=6`, `seaborn>=0.13`,
  `openpyxl>=3.1`, `Levenshtein>=0.27` (the real import name), `openai>=2.15`,
  `google-genai>=1.62` (Gemini helpers stay as provider helpers for the lab). All ship 3.13 wheels.
- Docs: python.md Status banner → "library landed; lab, serving split and the seam follow";
  § Style gains the two library-wide conventions from the source AGENTS.md (fail loudly on bad
  data, no silent skipping; every pipeline step asserts row counts and logs before/after shape).
  "GBD_categories.yaml is the single source of truth for categories and emissions factors"
  becomes the header comment of `categories.py`.
- `.env.example` gains `OPENAI_API_KEY=` and `GEMINI_API_KEY=` (lab) with one-line comments;
  `python/README.md` § API keys points there.

## PR 3 — Copy everything else into `lab/`

Goal: `catering_analysis` is fully archived; GBD's manual workflow runs from the monorepo.

- Modules → `python/lab/gbd_foodservice_insights_lab/` (flat; the source was flat): `extract_pdf`,
  `extract_other`, `extract_tabular_io`, `extract_tabular_inspection`, `clean_product_weights`,
  `pilot_analysis`, `pilot_plots`, `procurement_serving_comparison`, `notebook_runscript_setup`,
  `LLM_testing`, `gemini_api_examples`; new `llm_extraction.py` (source `LLMs.py` minus the half
  PR 2 kept), `notebook_utils.py` (`get_head_and_tail`/`is_interactive`/`remove_file` out of the
  library's `utils`), `plotting_extras.py` (the 11 helpers PR 2 dropped);
  `scripts/backfill_entree_cleaned_names.py` (the promote script is dead — drop);
  `prompts/{cbord_pdf_extraction,clean_units,extract_pdf,extract_weight,standard_pdf_extraction}_prompt.md`.
  Two seds: the package rename, then `gbd_foodservice_insights.<lab module>` →
  `gbd_foodservice_insights_lab.<lab module>` for the lab list only.
- **The two lab caches**: gitignore `python/lab/gbd_foodservice_insights_lab/data_files/previously_classified_{entrees,weights}.csv`
  **before copying**; loaders return an empty frame + warning when absent; `data_files/README.md`.
- `runscripts/`: the 5 runscript `.py` and 4 `.ipynb` under their verbatim names. Notebooks stay
  notebooks (user decision). **nbstripout**: add to the root `dev` group; `just lint` gains
  `uv run nbstripout --verify $(git ls-files '*.ipynb')`, `just fmt` the stripping form; the lab
  README says "run `just fmt` before committing a notebook". All 4 have zero outputs today.
  Ruff already lints/formats notebook code cells natively.
- CI: `py-lab` runs only `just test-lab`, and the `python` filter excludes the lab, so a lab-only
  change is never linted today. Add `just lint` to the `py-lab` job — a one-line CI change that
  is what makes the nbstripout check bite.
- `notebook_runscript_setup.get_project_root()` → monorepo root; runscripts `load_dotenv` from
  there. `client_work/` is gitignored wholesale (`*` + `!.gitignore`) — the data scientists'
  working directories, with the existing `client_metadata.json`-in-cwd convention unchanged.
- `test_data/`: only the anonymized directories (`raw_data`, `step_*_output`); the real-client
  directory is never copied — the tests that read it already `pytest.skip` when absent.
- Drop: `Docs/Devlog/*` + its test, the stray 2-row CSV at the source root, `example_dot_env.md`
  (→ `.env.example`), `example_metadata.json` (no reader), `SCRIPT_DESCRIPTIONS.md`.
- Tests → `python/lab/tests/`: `test_{clean_product_weights,extract_other_compat,extract_pdf,
  extract_tabular_inspection,extract_tabular_io,notebook_runscript_setup,pilot_analysis,
  procurement_serving_comparison,categorize_runscript}.py`, `test_report_diagnostics_extract.py`
  (the 16 lifted tests), `test_llm_extraction.py` (the PDF/whisper classes from `test_llms`).
- Lab deps: `gbd-foodservice-insights` (workspace), `chardet`, `google-genai`, `ipython`,
  `llmwhisperer-client`, `matplotlib`, `numpy`, `openai`, `openpyxl`, `pandas`, `PyPDF2`,
  `python-dotenv`, `requests`, `seaborn`, `thefuzz`. Not `python-docx` (imported nowhere).
- Docs: lab `README.md` (pipeline steps ↔ runscripts from the source `pipeline_diagram.md`; lab
  conventions from the source AGENTS.md — CSV intermediates, `client/period/step` filenames,
  common broken-data shapes; `client_work/`; obtaining the CSVs). Library `README.md` (new,
  short): "editing the report — which module owns which change", from the source reference doc
  minus its personal path. python.md Open item on the source conventions → resolved.
- Source repo afterwards: one README line ("archived into `foodservice-insights` at commit …"),
  then archive. Nothing else is done there.

## PR 4 — Move serving mode into the lab

Goal: the library's categorization path is procurement-only; the lab composes library steps
with its own entree detector.

- → `gbd_foodservice_insights_lab/serving.py`: `categorize_entrees.py` wholesale; from
  `categorize_cache.py` the entree-cache functions (`get_previously_classified_entrees` now reads
  the lab's gitignored file), `_normalize_entree_classification`,
  `build_entree_cleaned_name_reuse_index`, `save_historical_entree_classifications`,
  `backfill_entree_cleaned_names`; `categorize_reviews.build_entree_human_review_table`;
  `LLMs.classify_entree`; `ENTREE_SERVING_SIZE_MAP`.
- Library generalisations: `categorize_products` loses `data_type`, `gemini_client`,
  `historical_entree_classifications`, `update_historical_entree_classifications` and the
  `"serving"` blocks, and is split into `_prepare(df)`, `_categorize_unique_products(...)`,
  `merge_categorizations(...)` so the lab's `categorize_serving_products` can insert
  `run_entree_detector` before the merge (it needs `unique_products_df`, never returned today).
  `merge_categorizations(..., *, extra_merge_columns=(), keep_rows=None)` — the entree filter
  becomes the lab's `keep_rows=`. `_normalize_product_name`/`_unanimous_index` become public.
- Tests: `test_categorize_entrees.py` → lab `test_serving.py`; the serving `merge_categorizations`
  test and the 4 entree `test_categorize_cache` tests → lab; one new library test for `keep_rows`.

## PR 5 — `LlmClient` protocol, one retry layer, keyword fake

- `LLMs.py` → `llm.py`:

  ```python
  class LlmClient(Protocol):
      def clean_product_name(self, product: str) -> str: ...
      def categorize(self, cleaned_name: str, categories: Sequence[str]) -> str: ...
      def fuzzy_match_category(self, label: str, categories: Sequence[str]) -> str: ...

  @dataclass(frozen=True)
  class OpenAiLlmClient:      # openai.OpenAI(max_retries=0, timeout=60): this loop is the one retry layer
      client: openai.OpenAI
      model: str = "gpt-4.1-mini"
      sleep: Callable[[float], None] = time.sleep
      @classmethod
      def from_env(cls) -> "OpenAiLlmClient": ...   # OPENAI_API_KEY
  ```

  `MAX_ATTEMPTS = 5`, exponential 2/4/8/16 s + jitter (≈30 s worst case per call, asserted
  `< 60 s` in a test — far below the parent's `killAfterNoProgressMs`, since a sleep reports no
  progress). Retryable: `APIConnectionError`, `APITimeoutError`, `RateLimitError`,
  `InternalServerError`, `APIStatusError` in `{408,409,425,429,500,502,503,504}`; other
  `openai.APIError` → `UpstreamApiError` at once; exhaustion → `UpstreamApiError`. The SDK's own
  `max_retries=2` is disabled so there is exactly one retry layer (as `apps/worker/src/failures.ts`
  rules). Today the categorization path has **no retry at all** — a single 429 kills a run.
- New leaf `errors.py` holds `AnalysisError` + the three subclasses; `analysis.py` re-exports
  them (avoids an `llm.py → analysis.py → categorize.py` cycle); `worker_child` imports unchanged.
- `categorize_steps`: `clean_product_names(df, llm, *, report_progress)`,
  `categorize_with_llm(df, llm, *, report_progress)`, `fuzzy_match_GBD_categories(df, llm)` —
  each loop body calls `llm.<op>()` then `report_progress()`. `categorize_products(df, llm,
  historical_categorizations=None, *, report_progress=_ignore, ...)` (`None` → the packaged
  loader, as today).
- `testing.KeywordLlmClient`: the throwaway PoC's 100-entry ordered keyword→category table
  (specific before generic, else `"No Matches Found"`), its name-cleaning regexes,
  `difflib.get_close_matches` for fuzzy matching (stdlib), and a `calls` list so tests can count
  LLM calls. **No prompt fingerprinting** (the PoC routed mocks by prompt substrings — brittle).
- Tests: retry schedule with a recording `sleep`; exhaustion; non-retryable 401; every keyword
  table value ∈ `get_GBD_categories()`; the `patch.object` stacks in `test_categorize_steps`
  become a tiny in-test `LlmClient`.
- Docs: python.md § LLM providers (OpenAI for categorization in `llm.py`; GBD prefers Gemini for
  new work; `llm.py` is where a swap happens). ARCHITECTURE.md failure row "e.g. Gemini" → OpenAI.

## PR 6 — `analyze()` and `organizationName`

Goal: the seam is implemented; `WORKER_MODE=live` works with a real key.

- **Small contract change**: `run.json` gains `report.organizationName` (the PDF's "client"
  slot names the organization — user decision). `contract/fixtures/valid/run.json` + an
  `invalid/run.organization-name-blank.json`; `buildRunManifest` (`apps/worker/src/contract/messages.ts`,
  non-blank string); `loadAttemptInputs` (`attempt/queue.ts`) joins `organization.name`; Python
  `RunManifest`; `AnalysisRequest.organization_name: str`; `stub_analysis`, `_build_request`, and
  every `_request()` test helper pass it. Same PR: trim the env allowlist to
  `PATH, HOME, LANG, TZ, OPENAI_API_KEY` — the PDF extractor and the entree detector that used the
  other two keys live in the lab now (also `turbo.json` `env`, `spawn.test.ts`'s parent-only half,
  `python/README.md`).
- `analyze()`:

  ```python
  LB_TO_KG: Final = 0.45359237

  def analyze(request, *, report_progress=_ignore, llm: LlmClient | None = None) -> AnalysisOutcome:
      llm = llm if llm is not None else OpenAiLlmClient.from_env()
      df = _read_input_csv(request.input_csv)              # InvalidInputError on any shape problem
      if request.unit_system == "lb": df["weight"] *= LB_TO_KG
      df_final, summary, ai_review_df = categorize_products(
          df, llm, get_previously_categorized_items(), dayfirst_preference=False, report_progress=report_progress)
      report_input = request.work_directory / "categorized_report.csv"      # stem → food_report_report.{pdf,xlsx}
      df_final.rename(columns={"weight": "kilos_total"})[["date", "product", "category", "kilos_total"]].to_csv(report_input, index=False)
      (request.work_directory / "client_metadata.json").write_text(json.dumps(
          {"client": _title(request), "baseline_pilot": "baseline", "procurement_serving": "procurement"}))
      result = run_food_report(input_file=report_input, diner_meal_mapping=dict(request.monthly_counts),
          output_dir=request.work_directory / "report", procurement_serving="procurement",
          diner_or_meal={"people": "diner", "meals": "meal"}[request.counts_basis], region="us",
          missing_data_policy="warn_continue", show_quality_successes=False, report_progress=report_progress)
      pdf = _move(Path(result["pdf_path"]), request.output_directory)        # place_result_files renames
      xlsx = _move(Path(result["client_excel_path"]), request.output_directory)
      return AnalysisOutcome(pdf=pdf, xlsx=xlsx, metadata=json_safe(_metadata(summary, result, ai_review_df)))
  ```

- `matplotlib.use("Agg")` at the top of `analysis.py` before `food_report` is imported.
- `run_food_report`'s two file couplings (stem-derived identity; `client_metadata.json` sibling)
  are worked around in `work_directory` (discarded) and refactored in PR 8. The one
  `food_report.py` change: `report_progress`, called from `_log_stage` (15 stage boundaries;
  plot/PDF stages take tens of seconds). `dict(request.monthly_counts)` because the library does
  `isinstance(x, dict)` and the manifest hands a `MappingProxyType`.
- `_title(request)` → `organization_name`, with ` — {site_name}` appended when present.
- Exception mapping by construction: `_read_input_csv` raises `InvalidInputError` for wrong
  columns / zero rows / non-numeric weight / non-ISO date / empty product, so library
  `ValueError`s are *not* blanket-mapped. `merge_categorizations`'s >80%-eliminated
  `AssertionError` becomes `raise UnusableDataError(...)`. `UpstreamApiError` propagates from
  `OpenAiLlmClient`. Everything else → `unknown` with a traceback — correct, it is our bug.
- `metadata` = `{"categorization": {n_products_before, n_products_after, pct_remaining,
  n_rows_before, n_rows_after, row_elimination_details, match_type_counts,
  new_categorizations: [{product, cleaned_name, category}, …]}, "report": {quality_status,
  quality_summary, findings}}` through `json_safe()` (numpy scalars, `pd.Period`, `Path`, NaN →
  None; `worker_child`'s writer refuses NaN). `new_categorizations` is every product the LLM
  categorized this run, incl. `"No Matches Found"` — kept in `result_metadata` so the
  categorization-cache plan can backfill from it and nothing the LLM did is lost. It needs
  `build_ai_review_table` to return `cleaned_item_names` too (it returns only
  `[category, product, occurrence_count]` today — the gap that left the PoC without cleaned
  names).
- Tests (`python/insights/tests/test_analysis.py`, `KeywordLlmClient`, no network): end-to-end on
  a synthetic CSV (3 months, ~12 keyword-table products, 2 unknowns) — `%PDF` magic, xlsx sheet
  names, one `new_categorizations` row per unique product with a non-empty cleaned name,
  `match_type_counts == {"llm": n}`, `report_progress` count; keep it in the default suite
  (8–20 s; PR 8's graph-export skip is the real speedup). Cache hit (a temp CSV patched in as the
  loader's path) changes `match_type_counts` and shortens `llm.calls`; lb→kg;
  `counts_basis="meals"`; each `InvalidInputError` branch; `UnusableDataError`; `UpstreamApiError`
  passthrough; `json_safe`.
- Manual `WORKER_MODE=live`: `.env` with `OPENAI_API_KEY`, `PYTHON_BIN=.venv/bin/python`; first
  call `analyze()` from `uv run python` on a 20-row CSV in a temp dir and inspect the PDF; then
  `pnpm dev`, upload the same CSV, watch `output/progress.json` tick, download both files.
  ~40 `gpt-4.1-mini` calls.
- Docs: REQUIREMENTS.md "the existing AI library" → the package; `apps/worker/README.md` `live`
  row loses "Raises NotImplementedError"; `analysis.py`'s AI-usage Open points at
  `OpenAiLlmClient` as where tokens would be counted; its cache Open stays, pointing at the
  categorization-cache plan.

## PR 7 — `WORKER_MODE=mock-llm`

- `python/worker_child/worker_child/mock_llm.py`, following the `worker_child.testing`
  precedent: `main(argv)` → `run(Path(argv[1]), analyze=functools.partial(analyze,
  llm=KeywordLlmClient()))`. Root per-file-ignores gains this file under the existing
  `**/testing.py` TID251 comment. Test: a real run directory with a real `input.csv` →
  `EXIT_WROTE_RESULT`, `%PDF`, `result.json` present. A shared
  `gbd_foodservice_insights.testing.sample_input_csv()` feeds both packages' tests.
- `apps/worker/src/modes.ts`: `MOCK_LLM_MODULE = 'worker_child.mock_llm'`, delete the throw,
  `ResolvedWorkerMode` gains `'mock-llm'` with `overrides: {}` (it *is* `live` minus the API —
  the point is a real `killAfterNoProgressMs` against a real workload). `modes.test.ts` replaces
  the "not available yet" test.
- `tests/e2e`: the happy path moves to its own Playwright project on `WORKER_MODE=mock-llm`
  (own DB, bucket, worker — its README already specifies this); `!fail:unusable-data` stays on
  `stubbed`.
- Docs: `apps/worker/README.md` `WORKER_MODE` rows; `tests/e2e/README.md` Open resolved;
  python.md Status banner removed and both Open items deleted.

## PR 8 — Later cleanups (optional; not needed for the product to work)

- `run_food_report(df, *, client_name, output_dir, export_graphs: bool, ...)`: no input file, no
  stem, no `client_metadata.json`; skipping the 300-dpi PNGs `analyze()` discards is the main
  e2e-test speedup. The lab's report runscript becomes the file-reading wrapper.
- `ThreadPoolExecutor(max_workers=4)` over the per-product LLM loops (`report_progress` is
  already lock-protected in `writer.py`).
- `plt.close("all")` at the end of `export_report_plots` for the lab's long-lived kernels.
- Retire the remaining ty overrides for `report_*`; bump `gpt-4.1-mini` after a before/after on a
  known client (GBD's call); AI usage (tokens, cost) into `metadata`.

## Verification

- Per PR: the gates above; PR 2 additionally proves `test_food_report_end_to_end_produces_valid_artifacts`
  *ran*; PR 1 and PR 6 run `pnpm exec turbo run test:system`.
- After PR 6: `WORKER_MODE=live` with a real key on a 20-row CSV, direct call then through the app.
- After PR 7: the e2e happy path on `WORKER_MODE=mock-llm`; `pnpm dev` with no API key at all
  still produces a report.
- After PR 3: `just test-lab` green with none of the three CSVs present, and `git ls-files | grep
  '\.csv$'` shows only `tests/data/` fixtures.

## Risks

- **`killAfterNoProgressMs` vs backoff**: ≈30 s worst case per LLM call ≪ 10 min; progress is
  reported after every successful call and at every report stage.
- **Memory**: a child's RSS is dominated by pandas+matplotlib+seaborn imports (~300 MB) — the
  real constraint on children per worker. Figures are closed by `build_pdf_report`; ~15 stay
  alive until then.
- **The 80% assertion as a user-facing failure**: now `UnusableDataError` → "contact GBD". With
  an empty cache on day one this can fire legitimately; watch the `unusable_data` rate.
- **`warn_continue` still raises for programming errors** (e.g. a category not tagged
  food/drink) → `unknown` with a traceback — desired.
- **Whitespace**: the golden cache's `product` values are verbatim (some with leading spaces or
  embedded newlines) while `apps/web` trims uploads; expect some exact-match misses that the
  cleaned-name pass catches. Do not "fix" by trimming the cache.

Also fold in while touching docs: ARCHITECTURE.md and `packages/db/README.md` link
`apps/worker/src/sweeps/reaper.ts`, but the file is `sweeps/converge.ts` — the code wins.
