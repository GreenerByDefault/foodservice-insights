# Python port

## Context

GBD's analysis library now lives here, copied from the private `catering_analysis` repo: the
product package in `python/insights/` (`afd0d26`, #322) and the lab in `python/lab/`
(`b70dddab`). Categorization no longer sees a provider SDK: `categorize_products(df, llm, …)`,
`categorize_file(input_filepath, llm, …)` and the three LLM steps take an `LlmClient`
(`categorization/llm.py`) with three operations — clean a product name, match a cleaned name to a
category, fuzzy-match a label to a category. `OpenAiLlmClient.from_env()` is the real one;
`testing.KeywordLlmClient` is the offline one and records every operation in `calls`.

`analyze(request, *, report_progress, llm=None)` in `analysis.py` checks `input.csv` against the
contract, converts lb to kg, runs `categorize_products` and then `run_food_report`, and moves the
PDF and workbook into `output_directory`. `WORKER_MODE=live` runs it on OpenAI;
`WORKER_MODE=mock-llm` runs the same `analyze()` through `worker_child.mock_llm` with
`KeywordLlmClient`, so a real report needs no API key. The child's env allowlist is
`INVOCATION.environmentVariables` in `apps/worker/src/contract/names.ts`. The three cache CSVs
are gitignored under any `python/**/data_files/` and obtained out-of-band; the suite runs green
without them, which is how CI runs it.

What remains is archiving the source repo, plus the optional cleanups below.

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
  `report_progress` keyword it calls at each of its fifteen stages. That is also what gives
  `mock-llm` a real cadence, so it runs on production timings.
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
- **The system tier (`tests/e2e`) runs on `mock-llm`**, and its failure spec provokes
  `unusable_data` for real, by uploading a product `KeywordLlmClient` cannot categorize. So a
  change to the 80% check in `merge_categorizations`, or to `KEYWORD_CATEGORIES`, is one that
  tier sees.

## Later cleanups (optional; the product works without them)

- **Entree detection to the lab**: its own plan, `entree-detection-to-lab.md`.
- **`run_food_report` split into an in-memory core and a lab bundle**: its own plan,
  `food-report-split.md`.
- `ThreadPoolExecutor` over the per-product LLM loops (`writer.py`'s progress reporter is
  already lock-protected).
- AI usage (model, tokens, cost) onto the seam — `REQUIREMENTS.md` § Persistence's Open.

## Verification

- Every PR: `just lint && just check && just test`, plus `just test-lab` when the lab is touched
  and `pnpm lint && pnpm check && pnpm test` when TypeScript is.
- A change to `analyze()`, `run_food_report` or `worker_child`: also `pnpm test:system`, which
  runs a real report through both images on `mock-llm`.

## Risks

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
