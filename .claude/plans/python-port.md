# Python port

## Context

GBD's analysis library now lives here, copied from the private `catering_analysis` repo: the
product package in `python/insights/` (`afd0d26`, #322) and the lab in `python/lab/`
(`b70dddab`). Categorization no longer sees a provider SDK: `categorize_products(df, llm, …)`,
`categorize_file(input_filepath, llm, …)` and the three LLM steps take an `LlmClient`
(`categorization/llm.py`) with three operations — clean a product name, match a cleaned name to a
category, fuzzy-match a label to a category. `OpenAiLlmClient.from_env()` is the real one;
`testing.KeywordLlmClient`, shipped beside `stub_analysis`, is the offline one and records every
operation in `calls`.

`analyze(request, *, report_progress, llm=None)` in `analysis.py` is implemented, and
`WORKER_MODE=live` produces a real report with an `OPENAI_API_KEY`. It checks `input.csv` against
the contract, converts lb to kg, runs `categorize_products` and then `run_food_report`, and moves
the PDF and workbook into `output_directory`. `llm` defaults to `OpenAiLlmClient.from_env()`, so
any other `LlmClient` swaps in without touching the seam — which is all `mock-llm` needs.
`worker_child` calls `analyze(request, report_progress=…)` and places the declared files;
`apps/worker/src/modes.ts` still reserves `mock-llm` as a named-but-unavailable slot. The child's
env allowlist is `PATH, HOME, LANG, TZ, OPENAI_API_KEY`. The three cache CSVs are gitignored under
any `python/**/data_files/` and obtained out-of-band; the suite runs green without them, which is
how CI runs it.

A monthly count now has to be at least 1: `apps/web` (`metadata.ts`), the parent's own manifest
contract (`apps/worker/src/contract/messages.ts`), and the child's contract check
(`contract/fields.py`) all reject 0, matching what `run_food_report` already required.

What remains is to wire `WORKER_MODE=mock-llm` and archive the source repo.

The source repo is archived once one real client analysis has been run from `python/lab/` —
one README line there ("archived into `foodservice-insights` at commit …"), then archive it on
GitHub. Nothing else is done there.

A companion plan, `categorization-cache.md`, moves the product-categorization cache into
Postgres afterwards. This plan leaves all three caches as gitignored files at the paths the
library reads them from, and `AnalysisOutcome` stays `pdf` and `xlsx` until that plan adds the
new categorizations to it.

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
  real refactor, planned in `entree-detection-to-lab.md`, not on the path to a working product.
- **`OpenAiLlmClient` is the one retry layer** (`apps/worker/src/failures.ts` § one-retry-layer):
  it turns the SDK's retries off on whatever client it is given, then makes five attempts with
  2/4/8/16 s backoff and a 30 s request timeout. Only
  transient failures (connection, timeout, 408/409/425/429/5xx) become `UpstreamApiError` on
  exhaustion; a 400 or 401 propagates unchanged and lands as `unknown`, since `upstream_api` tells
  the user a retry may help.
  *Rejected: an OpenAI-shaped fake that dispatches on prompt text* — routing mocks by prompt
  content is brittle.
- **Progress is reported without touching the categorization loops**: `analyze()` wraps whatever
  `LlmClient` it was given so every call reports progress, and `run_food_report` takes a
  `report_progress` keyword it calls at each of its fifteen stages. So `mock-llm` gets a real
  cadence for free.
- **`input.csv` is checked once, at the seam, and nowhere else.** `input_csv.read_input_csv` raises
  `InvalidInputError` for any broken contract promise; past it, a library `ValueError` is our bug
  and lands as `unknown` with a traceback. *Rejected: mapping library `ValueError`s to
  `InvalidInputError`* — it would report our bugs as `apps/web` validation holes.
- **`run_food_report`'s file couplings are satisfied inside `work_directory`**, which is
  discarded: its input CSV, the `client_metadata.json` it reads from beside that input, and the
  graphs, QA workbook, manifest and log it writes. Only the two deliverables are moved out.
- **`run_food_report` runs with `missing_data_policy="hard_fail"`.** Past `read_input_csv` and
  `apps/web`'s month-coverage check, an error finding can only be our bug, so it lands as
  `unknown` rather than shipping a report with sheets silently missing. It also aborts on a
  diagnostics failure, although that only feeds the discarded QA workbook.
  *Rejected: `warn_continue`* — a rejected `monthly_counts` shipped a report with no per-diner
  figures and no error.

## PR 1 — `WORKER_MODE=mock-llm`

- `python/worker_child/worker_child/mock_llm.py`, on the `worker_child.testing` precedent:
  `main(argv)` → `run(Path(argv[1]), analyze=functools.partial(analyze, llm=KeywordLlmClient()))`.
  The root per-file-ignores list it under the existing `**/testing.py` TID251 comment. Test: a
  real run directory with a real `input.csv` → `EXIT_WROTE_RESULT`, `%PDF`, `result.json`. Lift
  `_sample_rows`/`_write_csv` and the product lists out of `insights/tests/test_analysis.py` into
  a shared `gbd_foodservice_insights.testing.sample_input_csv()`, so both packages' tests use one.
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

- **Entree detection to the lab**: its own plan, `entree-detection-to-lab.md`.
- `run_food_report(df, *, client_name, output_dir, export_graphs)`: no input file, no stem, no
  `client_metadata.json`; skipping the 300-dpi PNGs `analyze()` discards is the main
  end-to-end speedup. The lab's report runscript becomes the file-reading wrapper.
- `ThreadPoolExecutor` over the per-product LLM loops (`writer.py`'s progress reporter is
  already lock-protected.
- AI usage (model, tokens, cost) onto the seam — `REQUIREMENTS.md` § Persistence's Open.

## Verification

- Every PR: `just lint && just check && just test`, plus `just test-lab` when the lab is touched
  and `pnpm lint && pnpm check && pnpm test` when TypeScript is.
- PR 1: `pnpm exec turbo run test:system` with the e2e happy path on `mock-llm`, and `pnpm dev`
  with no API key at all still produces a report. Set `WORKER_MODE` in `.env`, not the shell:
  turbo drops undeclared env vars before they reach the worker.

## Risks

- **Fonts — resolved.** The Lato and Montserrat Regular/Bold OFL files ship in
  `gbd_foodservice_insights/data_files/fonts/` and `setup_gbd_fonts()` registers them via
  `font_manager.addfont`, so the report no longer depends on the OS or worker image having
  either font installed.
- **`killAfterNoProgressMs` vs backoff**: about 3 min worst case per LLM call (five 30 s
  timeouts plus 30 s of backoff), against a ten-minute kill; progress is reported after every
  successful call and at every report stage.
- **Memory**: a child's RSS is dominated by the pandas, matplotlib and seaborn imports (roughly
  300 MB) — the real constraint on children per worker. Figures are closed by the PDF builder,
  so about fifteen stay alive until then.
- **The 80% check as a user-facing failure**: `merge_categorizations` raises `UnusableDataError`
  → "contact GBD". With an empty cache on day one it can fire legitimately; watch the
  `unusable_data` rate.
- **Whitespace**: the cache's `product` values are verbatim, some with leading spaces or embedded
  newlines, while `apps/web` trims uploads; expect exact-match misses that the cleaned-name pass
  catches. Do not "fix" it by trimming the cache.
- **CI and image time**: `uv sync` now installs the scientific stack (cached by `setup-uv`), and
  the system-e2e image build grows with it.
