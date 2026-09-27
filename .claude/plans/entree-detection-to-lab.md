# Entree detection to the lab

## Context

The Python port split the private repo's code into `python/insights/` (what the web app ships)
and `python/lab/` (everything else), so the product can be held to more rigor and carry fewer
supply-chain dependencies. Serving-mode entree detection landed on the product side anyway,
though `analyze()` only ever runs procurement. The port left it there inert — `analyze()`
always runs procurement and `GEMINI_API_KEY` is not in the child's env allowlist — because
moving it needs `categorize_products` decomposed, a real refactor that was not on the path to a
working product.

Serving mode is two different things, and only one of them moves:

- **Entree detection moves.** That means the Gemini two-pass classifier (`categorization/entrees.py`),
  the entree cache and its loader, saver and backfill (`categorization/cache.py` § Entree history
  persistence, plus the entree label constants and `_normalize_entree_classification`),
  `build_entree_human_review_table`, the unused `classify_entree` in `categorization/llm.py`,
  and `entree_detector_prompt.md`. It adds up to about 900 lines of product code plus their tests.
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
- It removes the `data_type` / `gemini_client: Any` branching from the product's categorization
  entry point.

If the web app ever supports serving data, entree detection would be rewritten against
`LlmClient` rather than moved back as is.

## Decisions

- **`gemini.py` and `gemini_models.json` move to the lab whole.** Apart from entree detection,
  only the lab uses them (`extraction/llm.py`, `extraction/pdf.py`, `experiments/`), and most
  keys in the JSON are lab keys. `test_gemini.py` and the `mock_gemini_client` fixture move with
  them. The lab already lists `google-genai` as a dependency.
- **`categorize_file` moves to the lab.** Its only callers are the lab's categorize runscript
  and `test_pipeline.py`, and it is where the serving orchestration will sit (see PR 1). This
  follows the precedent `run_food_report` set when it moved: the lab owns the file-reading
  wrapper.
- **The cache helpers that both caches share become public in the product**:
  `_normalize_product_name`, `_first_non_empty_value` and `_unanimous_index`, all in `cache.py`.
  The lab's entree cache imports them. *Rejected: copying them into the lab, because two copies
  of product-name normalization would let the two caches key the same product differently.*
- **The entree filter runs after the merge, in the lab.** Today `merge_categorizations` applies
  it *after* the check that raises `UnusableDataError` when more than 80% of products are
  eliminated, and after `n_products_after` is computed. Filtering the rows before the merge
  would count non-entrees against that 80% threshold, so serving data could trip it when it
  shouldn't. The lab filters `df_final`, looking each product's classification up in
  `unique_products_df`, then rewrites the row-count fields of the summary and adds the
  `rows_eliminated_non_entree*` keys itself. Nothing outside the categorization code reads those
  keys.
- **A lint rule enforces the boundary.** Add `google.genai` to
  `[tool.ruff.lint.flake8-tidy-imports.banned-api]` in `python/pyproject.toml`. `python/lab/**`
  is already exempt from TID251. Without the rule, nothing would catch a product import of
  Gemini: the workspace venv installs every member's dependencies, so product tests would still
  pass.

## PR 1: take serving out of `categorize_products` (prefactor, product only)

- Split `categorize_products` at step 5. Steps 1–4, the AI review table and the category-cache
  write become a public stage that returns the cleaned input, `unique_products_df`,
  `ai_review_df` and the before-counts. `categorize_products` keeps procurement's behavior as
  that stage followed by `merge_categorizations`, and loses `data_type`, `gemini_client` and
  `historical_entree_*`. `analyze()`'s call site barely changes.
- The serving branch (entree detection, the entree review table, the entree-cache write, the
  post-merge filter) moves into `categorize_file`, which is still in the product for now.
  `merge_categorizations` loses `data_type` and the `entree_classification` merge column.
- Check before relying on it: today the category-cache write sees `unique_products_df` *after*
  entree detection has added columns. `save_historical_categorizations` keeps only the existing
  cache columns, so moving the write earlier should change nothing. Confirm it for the
  `web_app_unreviewed` saver too.

**Testing:**

- **First commit, before touching any code: a serving characterization test.** No test runs
  serving end to end today. `test_categorize_file_writes_entree_human_review_csv` patches out
  `categorize_products` entirely. Add one that runs `categorize_file(data_type="serving")` on a
  small fixture CSV, with:
  - `KeywordLlmClient` (from `gbd_foodservice_insights.testing`)
  - `call_gemini_api` patched as `test_entrees.py` does, returning `entree`, `side/add-on` and
    one `unsure` that escalates
  - an in-memory entree history

  Assert the full `df_final` (`pd.testing.assert_frame_equal`), the full summary dict and the
  review CSV contents. It has to pass unchanged, byte for byte, after the refactor. It is also
  what PR 2 carries into the lab.
- Include a case where more than 80% of rows are side/add-ons but few products are
  uncategorized. It must *not* raise `UnusableDataError`, which pins the filter-ordering
  decision above.
- `test_steps.py::test_merge_categorizations_serving_filters_side_add_on` becomes a test of the
  post-merge filter, the one that will move to the lab.
- The procurement path is covered by `test_analysis.py` and `test_pipeline.py` as they stand.
  Tests that pass `data_type="procurement"` just drop the argument.

## PR 2: move entree detection to the lab

- Move `entrees.py`, the entree half of `cache.py`, `build_entree_human_review_table`,
  `gemini.py`, `categorize_file` (with its serving orchestration) and `entree_detector_prompt.md`
  into `gbd_foodservice_insights_lab`. Prompts load through the lab's `llm_prompts.py`.
  `previously_classified_entrees.csv` resolves under the lab's `data_files/`: move its line from
  the product's `data_files/README.md` to the lab's.
- Delete `classify_entree`. Make the shared cache helpers public.
- Point the lab's imports at their new homes: the categorize runscript,
  `scripts/backfill_entree_cleaned_names.py`, `extraction/llm.py`, `extraction/pdf.py`,
  `experiments/gemini_api_examples.py` and `notebook_runscript_setup.py`.
- Drop `google-genai` from `python/insights/pyproject.toml`, run `uv lock`, add the ruff ban, and
  fix the `gemini.py` docstring's claim about who uses it.

**Testing:**

- These move to `python/lab/tests/` with their assertions unchanged: `test_entrees.py`,
  `test_gemini.py`, the entree tests in `test_cache.py` (the classified-entrees loader and
  saver, the cleaned-name backfill), the entree case in `test_reviews.py`, the serving tests in
  `test_pipeline.py`, and PR 1's characterization and post-merge filter tests. An unchanged
  assertion is how the move shows it changed no behavior.
- `test_runscript.py` already fakes `categorize_file`. Update the monkeypatch target to the
  module's new name.
- Add a test that `uv sync --package worker-child` resolves without `google-genai`: assert it is
  absent from `uv tree --package gbd-foodservice-insights`. **Open:** is this worth a test,
  given the ruff ban already stops the import? A lockfile check catches the dependency coming
  back; the ban catches the code coming back.

## Verification

- Both PRs: `just lint && just check && just test && just test-lab`.
- PR 2: build the worker image, or run `uv sync --package worker-child --no-dev` into a fresh
  venv, and confirm `import google.genai` fails while `analyze()` still runs via
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
