# Entree detection to the lab

## Context

The Python port split the private repo's code into `python/insights/` (what the web app ships)
and `python/lab/` (everything else), so the product can be held to more rigor and carry fewer
supply-chain dependencies. Serving-mode entree detection landed on the product side anyway,
though `analyze()` only ever runs procurement. It sits there inert — `analyze()` calls
`categorize_rows`, which no longer knows serving exists, and `GEMINI_API_KEY` is not in the
child's env allowlist.

The categorization entry point has already been decomposed so the move is mechanical. Steps 1–4,
the AI review table and the category-cache write are `categorize_unique_products` in
`categorization/pipeline.py`, which returns a frozen `CategorizedProducts` (the cleaned input,
`unique_products_df`, `ai_review_df`, `match_type_counts`). `categorize_rows` is that followed
by `merge_categorizations`, which takes only the cleaned input and the unique products and
derives its own before-counts. The whole serving branch — `run_entree_detector`, the entree
review table, the entree-cache write and the post-merge filter `filter_to_entrees` — lives in
`categorize_file`, the one product function that still takes `data_type` and `gemini_client`.

Serving mode is two different things, and only one of them moves:

- **Entree detection moves.** That means the Gemini two-pass classifier and `filter_to_entrees`
  (`categorization/entrees.py`), the entree cache and its loader, saver and backfill
  (`categorization/cache.py` § Entree history persistence, plus the entree label constants and
  `_normalize_entree_classification`), `build_entree_human_review_table`, the unused
  `classify_entree` in `categorization/llm.py`, and `prompts/entree_detector_prompt.md`. It adds
  up to about 900 lines of product code plus their tests.
- **Serving report mode stays.** `ReportMode` and the `servings total` metric are threaded
  through `report/`. They're a mode parameter with no dependencies, and the lab's report
  runscript needs them. *Rejected: moving it too, because that means forking the report.*

Why move it:

- It drops `google-genai` from `python/insights/pyproject.toml`. Most of what that package pulls
  in already comes with `openai`. The dependencies unique to it include `google-auth`,
  `cryptography` and `websockets`.
- It stops the product from reading `gemini_models.json` at import time.
- It removes a second LLM provider, and a second retry loop (`_call_gemini_with_retry`), from a
  product whose rule is "`OpenAiLlmClient` is the one retry layer".
- It removes the last `data_type` / `gemini_client: Any` branching from the product, in
  `categorize_file`.

If the web app ever supports serving data, entree detection would be rewritten against
`LlmClient` rather than moved back as is.

## Decisions

- **`gemini.py` and `gemini_models.json` move to the lab whole.** Apart from entree detection,
  only the lab uses them (`extraction/llm.py`, `extraction/pdf.py`, `experiments/`), and most
  keys in the JSON are lab keys. `test_gemini.py` and the `mock_gemini_client` fixture move with
  them. The lab already lists `google-genai` as a dependency.
- **`categorize_file` moves to the lab.** Its only callers are the lab's categorize runscript
  and the tests, and it is where the serving orchestration sits. This follows the precedent
  `run_food_report` set when it moved: the lab owns the file-reading wrapper. The product keeps
  `categorize_unique_products`, `CategorizedProducts` and `categorize_rows`, and the lab's
  `categorize_file` composes them with `merge_categorizations` exactly as it does today.
- **Open: delete `categorize_rows` instead of keeping it.** It is four lines —
  `categorize_unique_products`, `merge_categorizations`, `counts.to_summary()`, attach
  `match_type_counts` — and `categorize_file` repeats them. Its one product caller, `analyze()`,
  keeps `df_final` and discards the summary and `ai_review_df`. Decide before or alongside PR 1,
  since PR 1 is what leaves `categorize_rows` as the product's only row-level entry point.
  - For deleting: `analyze()` calls the two stages itself, and the product loses a public name
    and the duplication with `categorize_file`. Most `test_pipeline.py` tests of
    `categorize_rows` (cache write mode, date and weight cleaning, cleaned-name reuse) exercise
    stage 1 only and would retarget to `categorize_unique_products`.
  - For keeping: `categorization-cache.md` PR 5 routes `ai_review_df` through `analyze()` into
    `AnalysisOutcome.new_categorizations`, and `analysis.py`'s module docstring wants the
    summary in `AnalysisOutcome` too. Then `analyze()` needs all three outputs, which is what
    the wrapper bundles.
  - Worth weighing alongside: whether `analyze()` would rather read `CategorizedProducts` and
    `MergeCounts` directly than the untyped `summary` dict. That argues for deleting even if
    `analyze()` grows the outputs.
- **The cache helpers that both caches share become public in the product**:
  `_normalize_product_name`, `_first_non_empty_value` and `_unanimous_index`, all in `cache.py`.
  The lab's entree cache imports them. *Rejected: copying them into the lab, because two copies
  of product-name normalization would let the two caches key the same product differently.*
- **The entree filter runs after the merge.** `filter_to_entrees` takes `merge_categorizations`'
  output and `MergeCounts`, looks each row's classification up in the classified unique
  products, and returns updated counts with `n_rows_non_entree` set, which is what adds the
  `rows_eliminated_non_entree*` keys to the summary. Only serving summaries carry those keys;
  nothing outside the categorization code reads them. Filtering before the merge would count
  non-entrees against its "over 80% of products eliminated" `UnusableDataError` check, so a file
  that is mostly sides would be rejected; `n_products_after` keeps its pre-filter value for the
  same reason. The filter does not check for missing classifications: `run_entree_detector`
  raises on those first. `test_serving.py` pins the ordering.
- **A lint rule enforces the boundary.** Add `google.genai` to
  `[tool.ruff.lint.flake8-tidy-imports.banned-api]` in the root `pyproject.toml`.
  `python/lab/**` is already exempt from TID251. Without the rule, nothing would catch a product
  import of Gemini: the workspace venv installs every member's dependencies, so product tests
  would still pass.

## PR 1: move entree detection to the lab

- Move `entrees.py`, the entree half of `cache.py`, `build_entree_human_review_table`,
  `gemini.py`, `categorize_file` (with its serving orchestration) and `entree_detector_prompt.md`
  into `gbd_foodservice_insights_lab`. Prompts load through the lab's `llm_prompts.py`.
  `previously_classified_entrees.csv` resolves under the lab's `data_files/`: move its line from
  the product's `data_files/README.md` to the lab's. Update `pipeline.py`'s module docstring,
  which still lists `categorize_file` and `entrees.py`.
- Delete `classify_entree`. Make the shared cache helpers public.
- Point the lab's imports at their new homes: the categorize runscript,
  `scripts/backfill_entree_cleaned_names.py`, `extraction/llm.py`, `extraction/pdf.py` and
  `experiments/gemini_api_examples.py`.
- Drop `google-genai` from `python/insights/pyproject.toml`, run `uv lock`, add the ruff ban, and
  fix the `gemini.py` docstring's claim about who uses it.
- Worth doing while it moves: `run_entree_detector` writes its review sheet to
  `classified_products_with_entree.csv` in the working directory by default, and
  `categorize_file` never overrides it. Writing it next to the other review CSVs would let
  `test_serving.py` drop its `monkeypatch.chdir`.

**Testing:**

- These move to `python/lab/tests/` with their assertions unchanged: `test_serving.py` (the
  end-to-end serving characterization), `test_entrees.py` (including the `filter_to_entrees`
  tests), `test_gemini.py`, the entree tests in `test_cache.py` (the classified-entrees loader
  and saver, the cleaned-name backfill) and the entree case in `test_reviews.py`. An unchanged
  assertion is how the move shows it changed no behavior. `test_serving.py` redirects the caches
  by patching `cache._historical_cache_path`, `cache._web_app_unreviewed_cache_path` and
  `cache.get_previously_classified_entrees_location`, and patches `entrees.call_gemini_api`; only
  those targets change.
- `test_runscript.py` already fakes `categorize_file`. Update the monkeypatch target to the
  module's new name.
- `test_pipeline.py::test_categorize_file_writes_human_review_csv` moves with `categorize_file`.
- Add a test that `uv sync --package worker-child` resolves without `google-genai`: assert it is
  absent from `uv tree --package gbd-foodservice-insights`. **Open:** is this worth a test,
  given the ruff ban already stops the import? A lockfile check catches the dependency coming
  back; the ban catches the code coming back.

## Verification

- `just lint && just check && just test && just test-lab`.
- Build the worker image, or run `uv sync --package worker-child --no-dev` into a fresh venv,
  and confirm `import google.genai` fails while `analyze()` still runs via
  `WORKER_MODE=mock-llm`.
- Run the lab's categorize runscript once in serving mode against a real Gemini key, on a small
  file, and diff its output and review CSV against a run from `main`. The unit tests fake Gemini;
  only this proves the prompt and model wiring survived the move.

## Risks

- **Lab-only regressions are silent.** No product test or CI job exercises serving against a
  real model, which is why the real-key diff above is part of verification, not an extra.
- **Prompt-loader scoping.** Each package's `llm_prompts.py` resolves against its own
  directory, and `test_llm_prompts.py::test_does_not_read_lab_prompts` holds that line. After the
  move, the product must not still load `entree_detector_prompt.md`.
