# Python port

## Context

GBD's analysis library now lives here, copied from the private `catering_analysis` repo: the
product package in `python/insights/` (`afd0d26`, #322) and the lab in `python/lab/`
(`b70dddab`). Categorization no longer sees a provider SDK: `categorize_products(df, llm, …)`,
`categorize_file(input_filepath, llm, …)` and the three LLM steps take an `LlmClient`
(`categorization/llm.py`) with three operations — clean a product name, match a cleaned name to a
category, fuzzy-match a label to a category. `OpenAiLlmClient.from_env()` is the real one;
`testing.KeywordLlmClient`, shipped beside `stub_analysis`, is the offline one and records every
operation in `calls`. What remains is to implement the `analyze()` seam the worker already calls,
wire `WORKER_MODE=mock-llm`, and archive the source repo.

The monorepo side is ready. `analysis.py` is the seam (`AnalysisRequest` → `analyze()` →
`AnalysisOutcome`), still raising `NotImplementedError`; `worker_child` calls
`analyze(request, report_progress=…)` and moves the declared files into place;
`apps/worker/src/modes.ts` reserves `mock-llm` as the slot this fills. `report.organizationName`
is in the manifest, and the child's env allowlist is `PATH, HOME, LANG, TZ, OPENAI_API_KEY`. The
three cache CSVs are gitignored under any `python/**/data_files/` and obtained out-of-band; the
suite runs green without them, which is how CI runs it.

The source repo is archived once one real client analysis has been run from `python/lab/` —
one README line there ("archived into `foodservice-insights` at commit …"), then archive it on
GitHub. Nothing else is done there.

A companion plan, `categorization-cache.md`, moves the product-categorization cache into
Postgres afterwards. This plan leaves all three caches as gitignored files at the paths the
library reads them from; that plan's library PR depends on PR 1 here.

## Decisions

- **Behavioural changes to ported code are each their own PR**, never folded into a larger
  one — the copies landed verbatim so their diffs could be reviewed as copies.
- **Library modules import `PACKAGE_DIR` from the package root**, and `__init__.py` defines it
  *above* the re-export of `analysis`. Keep it there: once `analysis` imports the library, any
  module importing `PACKAGE_DIR` runs while `__init__` is still initializing.
- **The lab stays out of the worker image with no extra tooling.** uv workspaces already do it:
  the Dockerfile's `uv sync --package worker-child` selects `worker_child`,
  `gbd_foodservice_insights` and their deps; the lab member and its deps (`llmwhisperer-client`,
  `PyPDF2`, `ipython`, …) are simply not selected. The lab must stay its own workspace member for
  this to hold. A test-only dependency goes in its member's `[dependency-groups] dev`, as
  `PyPDF2` does for `python/insights/`; the image syncs `--no-dev`.
- **Serving mode stays in the library, inert.** `analyze()` always runs procurement, and
  `GEMINI_API_KEY` is not in the env allowlist, so no Gemini client is ever built in the child.
  The cost is that `google-genai` ships as a dependency and `gemini.py` reads `gemini_models.json`
  at import time. Moving entree detection to the lab needs `categorize_products` decomposed — a
  real refactor, listed under later cleanups, not on the path to a working product.
- **`OpenAiLlmClient` is the one retry layer** (`apps/worker/src/failures.ts` § one-retry-layer):
  it turns the SDK's retries off on whatever client it is given, then makes five attempts with
  2/4/8/16 s backoff and a 30 s request timeout. Only
  transient failures (connection, timeout, 408/409/425/429/5xx) become `UpstreamApiError` on
  exhaustion; a 400 or 401 propagates unchanged and lands as `unknown`, since `upstream_api` tells
  the user a retry may help.
  *Rejected: an OpenAI-shaped fake that dispatches on prompt text* — routing mocks by prompt
  content is brittle.
- **Progress is reported without touching the categorization loops**: `analyze()` wraps whatever
  `LlmClient` it was given so every call reports progress, and `run_food_report` reports at each
  stage boundary. So `mock-llm` gets a real cadence for free.

## PR 1 — `analyze()`

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
        df,
        llm,
        historical_categorizations=get_previously_categorized_items(),
        cache_write_mode="none",
        dayfirst_preference=False,
    )
    # The stem names the outputs: food_report_report.{pdf,xlsx}.
    report_input = request.work_directory / "categorized_report.csv"
    df_final.rename(columns={"weight": "kilos_total"})[
        ["date", "product", "category", "kilos_total"]
    ].to_csv(report_input, index=False)
    (request.work_directory / "client_metadata.json").write_text(
        json.dumps(
            {
                "client": _title(request),
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
            }
        )
    )
    result = run_food_report(
        input_file=report_input,
        diner_meal_mapping=dict(request.monthly_counts),  # the library checks isinstance(x, dict)
        output_dir=request.work_directory / "report",
        procurement_serving="procurement",
        diner_or_meal={"people": "diner", "meals": "meal"}[request.counts_basis],
        region="us",
        missing_data_policy="warn_continue",
        show_quality_successes=False,
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

## PR 2 — `WORKER_MODE=mock-llm`

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
  helpers in the product's `gemini.py`, and the unused `classify_entree`. Drops `google-genai` and the
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
- PR 1: the live run above, direct call then through the app; `pnpm exec turbo run test:system`.
- PR 2: the e2e happy path on `mock-llm`, and `pnpm dev` with no API key at all still produces
  a report.

## Risks

- **Fonts.** The report asks for Lato and Montserrat and falls back to DejaVu Sans, which
  matplotlib bundles. The worker image has neither GBD font, so production PDFs render in
  DejaVu until the fonts ship — in the image (deployment config, not this plan) or in the
  package's `data_files/` via `font_manager.addfont` (both are OFL-licensed). Decide before the
  first real client sees a PDF.
- **`killAfterNoProgressMs` vs backoff**: about 3 min worst case per LLM call (five 30 s
  timeouts plus 30 s of backoff), against a ten-minute kill; progress is reported after every
  successful call and at every report stage.
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
