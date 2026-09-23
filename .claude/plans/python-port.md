# Python port

## Context

GBD's analysis library lives in the private `catering_analysis` repo. This plan copies it into
`python/insights/` (the product package) and `python/lab/` (everything else), implements the
`analyze()` seam the worker already calls, wires `WORKER_MODE=mock-llm`, and archives the
source repo.

The monorepo side is ready. `analysis.py` is the seam (`AnalysisRequest` → `analyze()` →
`AnalysisOutcome`, raising `NotImplementedError` today); `errors.py` and
`testing.stub_analysis` exist; `worker_child` calls `analyze(request, report_progress=…)` and
moves the declared files into place; `apps/worker/src/modes.ts` reserves `mock-llm` as the slot
this fills. Groundwork already on `main`: the three cache CSVs are gitignored at their packaged
paths with a `data_files/README.md` beside each, `python/lab/client_work/.gitignore` exists,
`just lint`/`just fmt` run nbstripout and the `py-lab` job lints, `report.organizationName` is in
the manifest, and the child's env allowlist is `PATH, HOME, LANG, TZ, OPENAI_API_KEY`.

The source side is ready too. `catering_analysis/Docs/monorepo_migration/prework.md` records
twenty-seven PRs that aligned that repo with this one before any copy: Ruff with this repo's rule
set and line length, Python 3.14, ty-clean, the package renamed to `gbd_foodservice_insights`
and flattened to the repo root, `LLMs.py` split into `llm`, `llm_prompts`, `categorize_llm` and
the lab-bound `llm_extraction`, the lab split into its own `gbd_foodservice_insights_lab`
package with Ruff's `TID251` ban on product → lab imports, cache loaders that tolerate a missing
file, the tests split into `tests/insights/` and `tests/lab/` under `--import-mode=importlib`,
and `Customer template/` renamed to `runscripts/`. **The copy is therefore a `cp -r` of two
package directories and two test directories with no import rewriting.** That doc's "Notes for
the monorepo copy" are all folded in below.

The source's *internal* layout may still change before the copy (modules nested rather than
flat). This plan copies package directories whole and names functions rather than files wherever
a PR edits ported code; where a filename appears it is today's name for finding the function,
not a commitment to the path.

A companion plan, `categorization-cache.md`, moves the product-categorization cache into
Postgres afterwards. This plan leaves all three caches as gitignored files at the paths the
library reads them from; that plan's library PR depends on PR 4 here.

## Decisions

- **Copy first, change after.** PRs 1 and 2 are copies plus only what CI needs; every behavioural
  change is its own PR. *Rejected: refactor during the copy* — it buries the diff that needs the
  most attention, and the source repo's suite and live client runs are the safety net only until
  the copy lands.
- **Copy from a recorded `main` SHA with `git archive`, never the working tree** — `build/` on
  disk there is a stale, gitignored duplicate of the package. No subtree, no history rewrite:
  history stays in the archived repo. Attribution is `Co-authored-by:` trailers on each copy PR's
  squash commit, one per human author in `git shortlog -sne` (the two bots dropped), with the
  email each author is happy to expose on GitHub — ask, don't assume.
- **Gitignore the caches by name under any `data_files/`**: the three existing `.gitignore`
  lines become `python/**/data_files/<name>.csv`. That survives nesting, and it closes a hole:
  the entree-cache loader is product-side until serving mode moves, so it resolves under
  `python/insights/`, where that name is not ignored today.
- **The lab stays out of the worker image with no extra tooling.** uv workspaces already do it:
  the Dockerfile's `uv sync --package worker-child` selects `worker_child`,
  `gbd_foodservice_insights` and their deps; the lab member and its deps (`llmwhisperer-client`,
  `PyPDF2`, `ipython`, …) are simply not selected. The lab must stay its own workspace member for
  this to hold.
- **Serving mode stays in the library, inert.** `analyze()` always runs procurement, and
  `GEMINI_API_KEY` is not in the env allowlist, so no Gemini client is ever built in the child.
  The cost is that `google-genai` ships as a dependency and `llm.py` reads `gemini_models.json`
  at import time. Moving entree detection to the lab needs `categorize_products` decomposed — a
  real refactor, listed under later cleanups, not on the path to a working product.
- **The `LlmClient` protocol is built here, not as prework**, because its shape is dictated by
  `analyze()` and the keyword fake; the source repo's categorize runscript needs only a one-line
  wrap. Its OpenAI implementation is the one retry layer (`apps/worker/src/failures.ts` rules it),
  with the SDK's own retries disabled. *Rejected: an OpenAI-shaped fake that dispatches on prompt
  text* — routing mocks by prompt content is brittle.
- **Progress is reported without touching the categorization loops**: `analyze()` wraps whatever
  `LlmClient` it was given so every call reports progress, and `run_food_report` reports at each
  stage boundary. So `mock-llm` gets a real cadence for free.
- **Safe to publish.** The source repo never committed a secret (verified across its history),
  but it holds one real client's workbooks under `test_data/baseline_comparison/`, and client
  and staff names and a maintainer's home directory in a handful of files. Those files are not
  ported, and every copy PR greps its diff against a private denylist kept outside this repo.
  Known hits still in tracked files today: `Nuffield` in two runscripts' comments, `Carle Health`
  in one test, `Rush_health` in `test_data/create_test_data_v2.py`, the home directory in
  `Docs/reference/editing_pdf_reports.md`.

## PR 1 — Copy the product library into `python/insights/`

Goal: `categorize_products` and `run_food_report` work here; `just test` runs the source's
unmocked end-to-end report test; no cache CSV is committed.

```sh
SRC=~/code/gbd/catering_analysis; SHA=$(git -C "$SRC" rev-parse main)   # record the SHA in the PR
git -C "$SRC" archive "$SHA" gbd_foodservice_insights | tar -x -C python/insights
git -C "$SRC" archive "$SHA" tests/insights | tar -x --strip-components=2 -C python/insights/tests
```

- Two files exist on both sides. Keep the monorepo's `__init__.py` (it re-exports the seam;
  drop its "scaffold" wording) and the monorepo's `data_files/README.md` (it already says
  obtained out-of-band, missing → empty cache and a warning). `git checkout` both back after
  extracting. Nothing inside the package is curated: the promote script and the entree code
  ride along, and the cache plan deletes what it supersedes.
- `.gitignore`: the three cache lines become `python/**/data_files/<name>.csv`. Prove it with
  `git status --ignored` (the CSVs show if present) and `git ls-files` (they never do).
- `python/insights/pyproject.toml` dependencies, from the package's imports: `pandas`, `numpy`,
  `matplotlib`, `seaborn`, `PyYAML`, `Levenshtein` (the import name — the source declares the
  `python-Levenshtein` shim), `openpyxl` (pandas' engine in the report workbooks), `openai`,
  `google-genai`. Not `requests`, not `python-dotenv`. Ranges as the source pins them; `just sync`
  updates `uv.lock`. Ruff is the same version in both repos; ty here is the version the source was
  verified clean under.
- Root `pyproject.toml` `[tool.ruff.lint]` gains the source's `allowed-confusables`
  (`×`, `–`, `ℹ` — deliberate typography in plot labels). *Rejected: replace the characters.*
- Then `just fmt` and `just lint && just check && just test`. Expect nothing to a handful of
  fix-ups: the rule set, line length, target version, `--import-mode=importlib` and the ty
  version all already match. No `[[tool.ty.overrides]]`.
- Reviewer checklist: the denylist grep on the diff is empty; `git ls-files python | grep
  '\.csv$'` shows only test fixtures; dependencies exactly as listed; no `[tool.ruff]` in the
  member pyproject; CI green with `test_food_report_end_to_end_produces_valid_artifacts`
  *running*, not skipped; the system-e2e job's Docker build still passes — the image now installs
  the scientific stack with no Dockerfile change.
- Docs. `.claude/rules/python.md`: Status banner → "library landed; the lab and the seam
  follow"; § Style gains the library-wide conventions from the source `AGENTS.md` §9–10 — fail
  loudly on bad data with no silent skipping, every pipeline step asserts row counts and logs
  before/after shape, datasets are thousands of rows so plain pandas is fine; the
  `importlib.resources` Open is resolved on the existing "Packaged assets" bullet — packaged
  files are read with `Path(__file__)`, and the package is always installed from files on disk
  (the worker image installs `--no-editable` into site-packages, never a zip).
  "`GBD_categories.yaml` is the single source of truth for categories and emissions factors"
  becomes the header comment of the module that loads it. `REQUIREMENTS.md` gains GBD's
  substitution rule — a report never frames a shift from beef or lamb to chicken or fish as a
  win — since it is product intent that constrains report wording. `.env.example` gains
  `OPENAI_API_KEY=`; `python/README.md`
  § API keys points at it. A short `python/insights/README.md`: one paragraph on what the package
  is, plus the "which module owns which report change" ownership table from the source's
  `editing_pdf_reports.md`, minus its commands and personal path.

## PR 2 — Copy the lab into `python/lab/`

Goal: `catering_analysis` can be archived whole; GBD's manual workflow runs from this repo.

- Same `git archive` mechanics: the lab package → `python/lab/`; `tests/lab` →
  `python/lab/tests/`; the runscripts directory → `python/lab/<its name at the SHA>/` (the four
  notebooks are already output-stripped by the source's pre-commit hook, and `just lint`
  verifies that); `test_data/` minus `baseline_comparison/` → `python/lab/test_data/`, the
  runscripts' anonymized sample dataset (its README says so). Keep the monorepo's `__init__.py`
  and `data_files/README.md` as in PR 1.
- `python/lab/pyproject.toml` dependencies: `chardet`, `google-genai`, `ipython`,
  `llmwhisperer-client`, `matplotlib`, `numpy`, `openai`, `openpyxl`, `pandas`, `PyPDF2`,
  `python-dotenv`, `requests` (imported by the extraction module but never declared in the
  source — it arrives transitively there), `seaborn`, `thefuzz`. Not `python-docx`.
- `client_work/` is the data scientists' working directory, gitignored except its own
  `.gitignore`; the `client_metadata.json`-in-cwd convention is unchanged; `.env` is the repo
  root's. `.env.example` gains `GEMINI_API_KEY=` and `LLM_WHISPERER_API_KEY=` marked lab-only.
- Gate: `just lint && just check && just test-lab` green **with none of the three cache CSVs
  present**; the denylist grep on the diff is empty.
- Docs. New `python/lab/README.md`: what the lab is and is not (ships nothing, carries none of
  the product's guarantees — `python.md` § The lab boundary has the rule); pipeline steps ↔
  runscripts as one table (replaces the source's `pipeline_diagram.md`); working in
  `client_work/`; obtaining the two cache CSVs and where they go; the lab-workflow conventions
  from the source `AGENTS.md` — CSV intermediates, `client/period/step` filenames, the common
  shapes of broken client data; `just fmt` before committing a notebook. `python.md`'s
  conventions Open is deleted — PR 1 and this README split it between them.
- Not ported: `AGENTS.md` and `CLAUDE.md` (bound to one machine and to the Analyses Drive;
  `python.md` and the two READMEs replace them), `.pre-commit-config.yaml` and `.github/` (this
  repo's CI), `Docs/dead_code/`, `Docs/monorepo_migration/`, the source `README.md` and
  `example_dot_env.md` (folded into the READMEs and `.env.example`), both `SCRIPT_DESCRIPTIONS.md`
  (per-module prose the module docstrings already carry), `pipeline_diagram.md` (the lab
  README's table), `Docs/reference/example_client_metadata.json` (no reader), `LICENSE` (this
  repo's MIT covers the tree, same holder).
- Source repo afterwards: once one real client analysis has been run from `python/lab/` — the
  mirror of `prework.md`'s "before the copy" check — add one README line ("archived into
  `foodservice-insights` at commit …") and archive it on GitHub. Nothing else is done there.

## PR 3 — `LlmClient` protocol, one retry layer, keyword fake

- A `Protocol` with the three operations that are the live contents of `categorize_llm.py`:
  clean a product name, match a cleaned name to a category, fuzzy-match a label to a category.
  `OpenAiLlmClient` (frozen dataclass: `client`, `model="gpt-4.1-mini"`, `sleep=time.sleep`)
  implements it and has `from_env()` reading `OPENAI_API_KEY` into
  `openai.OpenAI(max_retries=0, timeout=60)`.
- Retry: five attempts, exponential 2/4/8/16 s plus jitter — about 30 s worst case per call,
  asserted `< 60 s` in a test, far below the parent's `killAfterNoProgressMs`. Retryable:
  `APIConnectionError`, `APITimeoutError`, `RateLimitError`, `InternalServerError`, and
  `APIStatusError` in `{408, 409, 425, 429, 500, 502, 503, 504}`; any other `openai.APIError`
  → `UpstreamApiError` at once; exhaustion → `UpstreamApiError`. Imports `errors.py` directly,
  the leaf. Today the categorization path has **no retry at all** — one 429 discards every paid
  call in the run.
- Threading it through: `categorize_products(df, llm, …)`, `categorize_file(…, llm)` and the
  three step functions take an `LlmClient` where they took `openai_client: Any`. The lab's
  categorize runscript and `LLM_testing.py` wrap `setup_api_clients()["openai_client"]` in
  `OpenAiLlmClient`. The Gemini entree function is untouched.
- `testing.KeywordLlmClient`, shipped beside `stub_analysis`: an ordered keyword → category table
  (specific before generic, else `"No Matches Found"`), a small name-cleaning pass,
  `difflib.get_close_matches` for fuzzy matching, and a `calls` list so tests can count LLM
  calls.
- Tests: the retry schedule with a recording `sleep`; exhaustion; a 401 fails immediately; every
  keyword-table value is in `get_GBD_categories()`; the `patch.object` stacks in
  `test_categorize_steps` become a tiny in-test `LlmClient`.
- Docs: `python.md` gains § LLM providers — OpenAI does categorization; GBD prefers Gemini for
  new work; the OpenAI class is where a swap happens. `ARCHITECTURE.md`'s failure row "e.g.
  Gemini" → OpenAI.

## PR 4 — `analyze()`

Goal: the seam is implemented; `WORKER_MODE=live` works with a real key. This is the PR
`categorization-cache.md` waits on.

```python
LB_TO_KG: Final = 0.45359237


def analyze(request, *, report_progress=_ignore, llm: LlmClient | None = None) -> AnalysisOutcome:
    llm = _reporting(llm if llm is not None else OpenAiLlmClient.from_env(), report_progress)
    df = _read_input_csv(request.input_csv)  # InvalidInputError on any broken promise
    if request.unit_system == "lb":
        df["weight"] *= LB_TO_KG
    df_final, summary, ai_review_df = categorize_products(
        df, llm, historical_categorizations=get_previously_categorized_items(),
        cache_write_mode="none", dayfirst_preference=False,
    )
    # The stem names the outputs: food_report_report.{pdf,xlsx}.
    report_input = request.work_directory / "categorized_report.csv"
    df_final.rename(columns={"weight": "kilos_total"})[
        ["date", "product", "category", "kilos_total"]
    ].to_csv(report_input, index=False)
    (request.work_directory / "client_metadata.json").write_text(json.dumps({
        "client": _title(request),
        "baseline_pilot": "baseline",
        "procurement_serving": "procurement",
    }))
    result = run_food_report(
        input_file=report_input,
        diner_meal_mapping=dict(request.monthly_counts),  # the library checks isinstance(x, dict)
        output_dir=request.work_directory / "report",
        procurement_serving="procurement",
        diner_or_meal={"people": "diner", "meals": "meal"}[request.counts_basis],
        region="us", missing_data_policy="warn_continue", show_quality_successes=False,
        report_progress=report_progress,
    )
    return AnalysisOutcome(
        pdf=_move(Path(result["pdf_path"]), request.output_directory),
        xlsx=_move(Path(result["client_excel_path"]), request.output_directory),
    )
```

- `matplotlib.use("Agg")` at the top of `analysis.py`, before the report module is imported.
- `_read_input_csv` checks what the contract promises — the three columns, at least one row,
  numeric weights, ISO dates, non-empty products — and raises `InvalidInputError`. Library
  `ValueError`s are *not* blanket-mapped: past that check they are our bug and belong to
  `unknown` with a traceback.
- `_reporting(llm, report_progress)` is a small forwarding `LlmClient` that calls
  `report_progress()` after each operation. The one report-module edit is a `report_progress`
  keyword on `run_food_report`, called from `_log_stage` (fifteen stage boundaries; the plot and
  PDF stages take tens of seconds).
- `merge_categorizations`' ">80% of products eliminated" `AssertionError` becomes
  `raise UnusableDataError(...)` at the raise site. `UpstreamApiError` propagates from the
  client. A missing `OPENAI_API_KEY` raises from `from_env()` and lands as `unknown` — a
  deployment bug, not an upstream failure.
- `run_food_report`'s two file couplings — output names derived from the input stem, and
  `client_metadata.json` read from and written beside the input — are satisfied inside
  `work_directory`, which is discarded. Refactoring them away is a later cleanup.
- `_title(request)` is `organization_name`, with ` — {site_name}` when present.
- `AnalysisOutcome` stays `pdf` and `xlsx`. Product code never writes the cache; the products
  this run's LLM categorized are lost until `categorization-cache.md` adds
  `new_categorizations` to the outcome — that plan also needs `build_ai_review_table` to return
  `cleaned_item_names`, which it returns without today.
- Tests in `python/insights/tests/test_analysis.py`, all on `KeywordLlmClient` with no network:
  end to end on a synthetic CSV (three months, a dozen keyword-table products, two unknowns) —
  `%PDF` magic, the workbook opens with the expected sheets, `report_progress` was called at
  least once per LLM call and per stage; a cache hit (a temp CSV patched in as the loader's path)
  shortens `llm.calls` and shows in `summary["match_type_counts"]`; lb → kg; `counts_basis=
  "meals"`; each `InvalidInputError` branch; `UnusableDataError` when every product is unknown;
  `UpstreamApiError` passthrough from a raising fake. The end-to-end case is 8–20 s; keep it in
  the default suite. Delete the two "not ported yet" tests (`test_analysis.py` here and
  `test_run.py` in `worker_child`); the latter becomes "the default `analyze` with no key fails
  `unknown` naming the key".
- Manual `WORKER_MODE=live`: `.env` with `OPENAI_API_KEY`; first call `analyze()` from
  `uv run python` on a 20-row CSV in a temp directory and read the PDF; then `pnpm dev`, upload
  the same CSV, watch `output/progress.json` tick, download both files. About forty
  `gpt-4.1-mini` calls.
- Docs: `REQUIREMENTS.md` § Processing "the existing AI library" → the package;
  `apps/worker/README.md`'s `live` row loses "Raises NotImplementedError"; `analysis.py`'s two
  "once the library is ported" Opens now point at the real shapes (the `summary` dict for
  result metadata, `OpenAiLlmClient` for token counts); its cache Open stays.

## PR 5 — `WORKER_MODE=mock-llm`

- `python/worker_child/worker_child/mock_llm.py`, on the `worker_child.testing` precedent:
  `main(argv)` → `run(Path(argv[1]), analyze=functools.partial(analyze, llm=KeywordLlmClient()))`.
  The root per-file-ignores list it under the existing `**/testing.py` TID251 comment. Test: a
  real run directory with a real `input.csv` → `EXIT_WROTE_RESULT`, `%PDF`, `result.json`. A
  shared `gbd_foodservice_insights.testing.sample_input_csv()` feeds both packages' tests.
- `apps/worker/src/modes.ts`: `MOCK_LLM_MODULE = 'worker_child.mock_llm'`, delete the throw,
  `ResolvedWorkerMode` gains `'mock-llm'` with `overrides: {}` — it *is* `live` minus the API,
  and the point is a real `killAfterNoProgressMs` against a real workload. `modes.test.ts`
  replaces the "not available yet" test.
- `tests/e2e`: the happy path moves to its own Playwright project on `WORKER_MODE=mock-llm` —
  own database, bucket and worker, as its README already specifies, since one queue cannot serve
  two modes. `!fail:unusable-data` stays on `stubbed`. The keyword fake ships in `testing.py`, so
  the worker image already contains it.
- Docs: `apps/worker/README.md`'s `WORKER_MODE` rows; `tests/e2e/README.md`'s Open resolved;
  `python.md`'s Status banner removed.

## Later cleanups (optional; the product works without them)

- **Serving mode to the lab**: entree detection, the entree cache and its loader, the Gemini
  helpers in `llm.py` and `setup_api_clients`' Gemini branch. Drops `google-genai` and the
  import-time `gemini_models.json` read from the shipped package. Needs `categorize_products`
  split so the lab can run its entree detector on `unique_products_df` before the merge.
- `run_food_report(df, *, client_name, output_dir, export_graphs)`: no input file, no stem, no
  `client_metadata.json`; skipping the 300-dpi PNGs `analyze()` discards is the main
  end-to-end speedup. The lab's report runscript becomes the file-reading wrapper.
- `ThreadPoolExecutor` over the per-product LLM loops (`writer.py`'s progress reporter is
  already lock-protected); `print_progress` → logging.
- `plt.close("all")` after plot export, for the lab's long-lived kernels.
- AI usage (model, tokens, cost) onto the seam — `REQUIREMENTS.md` § Persistence's Open.

## Verification

- Every PR: `just lint && just check && just test`, plus `just test-lab` when the lab is touched
  and `pnpm lint && pnpm check && pnpm test` when TypeScript is.
- PR 1 additionally proves the unmocked report test *ran*, and that `git ls-files` holds no
  cache CSV.
- PR 2: `just test-lab` green with none of the three CSVs present.
- PR 4: the live run above, direct call then through the app; `pnpm exec turbo run test:system`.
- PR 5: the e2e happy path on `mock-llm`, and `pnpm dev` with no API key at all still produces
  a report.

## Risks

- **Fonts.** The report asks for Lato and Montserrat and falls back to DejaVu Sans, which
  matplotlib bundles. The worker image has neither GBD font, so production PDFs render in
  DejaVu until the fonts ship — in the image (deployment config, not this plan) or in the
  package's `data_files/` via `font_manager.addfont` (both are OFL-licensed). Decide before the
  first real client sees a PDF.
- **`killAfterNoProgressMs` vs backoff**: about 30 s worst case per LLM call, against a
  ten-minute kill; progress is reported after every successful call and at every report stage.
- **Memory**: a child's RSS is dominated by the pandas, matplotlib and seaborn imports (roughly
  300 MB) — the real constraint on children per worker. Figures are closed by the PDF builder,
  so about fifteen stay alive until then.
- **The 80% assertion as a user-facing failure**, now `UnusableDataError` → "contact GBD". With
  an empty cache on day one it can fire legitimately; watch the `unusable_data` rate.
- **`warn_continue` still raises for programming errors** (a category not tagged food or drink,
  say) → `unknown` with a traceback — desired.
- **Whitespace**: the cache's `product` values are verbatim, some with leading spaces or embedded
  newlines, while `apps/web` trims uploads; expect exact-match misses that the cleaned-name pass
  catches. Do not "fix" it by trimming the cache.
- **CI and image time**: `uv sync` now installs the scientific stack (cached by `setup-uv`), and
  the system-e2e image build grows with it.
