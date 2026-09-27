# Categorization pipeline

## Context

`categorize_unique_products` (`categorization/pipeline.py`), its steps and the merge-back
`merge_categorizations` (`categorization/steps.py`) are the product's categorization path: exact
cache match, LLM name cleaning, cleaned-name reuse, LLM category match, then the merge-back with
the 80% cut. `analyze()` composes the two stages itself. An audit of the ported code in
September 2026 found that the step meant to rescue near-miss model answers is dead, that the
prompt coaches the model toward answers the pipeline then drops, that the product re-parses
input the seam already parsed, and that every LLM call runs serially.
`categorize_spreadsheet_to_csvs` now lives in the lab
(`gbd_foodservice_insights_lab/categorization/spreadsheet.py`). `categorization-cache.md` PR 5
replaces the cache this path reads, so the PRs here are sequenced around it.

Verified facts (each reproduced with a scripted `LlmClient` on inline frames):

- `categorize_with_llm` ends by rewriting **every** value in the frame that is not byte-equal to
  a YAML name to `"No Matches Found"`, cached rows included. So `fuzzy_match_GBD_categories`,
  `LlmClient.fuzzy_match_category`, `fuzzy_match_gbd_category_prompt.md` and the fake's method
  are unreachable: `Cheese.`, `pork`, `"Butter"`, `Cow's Milk` and `None` all became
  uncategorized, and the step logged "All categories are standard".
  `OpenAiLlmClient.match_product_to_category` returns `content.strip()` and nothing more, while
  `match_items_to_gbd_categories_prompt.md` says *say "None"* when nothing fits and writes
  `"oat milk"`, `"shelled eggs"`, `poultry`, `pork` and `"Cow's Milk"` in its own rules. It also
  renders the category list as a Python `list` repr with mixed quote styles. How often
  gpt-4.1-mini follows the rules literally is unmeasured.
- A dropped product counts toward the 80% cut and appears in the review table as
  "No Matches Found" rather than as a near-miss. A cache row whose category differs only by case
  or whitespace is dropped **and** kept out of the review table, because it is
  `previously_categorized`. `categorization-cache.md` PR 5 drops such rows before step 1; its
  test should assert the product reaches the LLM, not only that a warning is logged.
- `KeywordLlmClient` ignores its `categories` argument and only ever returns canonical names, so
  no test and no `mock-llm` run can surface any of the above.
- Re-running `parse_and_validate_date_column` and `clean_weight_column` on `read_input_csv`'s
  output changes no value, but its `max_future_days=30` uses the container's local date while
  `apps/web` uses UTC (`calendar.ts`), so a row dated exactly 30 days out can pass the web and
  fail the run as `unknown`.
- `merge_categorizations` merges on `product` without `validate=`; handed duplicate products it
  fans out silently (3 rows in, 5 out). Nothing upstream produces duplicates today.
- `_strip_pack_counts` (`categorization/llm.py`) deletes every `.` before the prompt:
  `CHEESE 2.5 LB` becomes `CHEESE 25 LB` and `MILK 1.5% GAL` becomes `MILK 15% GAL`. Harmless to
  the category, and `test_llm.py` pins it as intended.
- `check_GBD_categories` (`categories.py`) logs every category absent from the upload on every
  run and can never warn on the product path; `categorize_with_llm`'s `nan_categories` list and
  the NaN check that follows `astype(str)` in `categorize_unique_products` are dead.
- ARCHITECTURE.md § Concurrency and scaling names a `ThreadPoolExecutor` inside the library as
  the lever for a faster individual attempt; the loops in `clean_product_names` and
  `categorize_with_llm` are one call at a time.

## Decisions

- **Behavioural changes to ported code are each their own PR.**
- **Normalize the model's answer before matching, and make the fuzzy step live.** Casefold and
  strip quotes, periods and whitespace from both sides before comparing against the canonical
  list; anything still unmatched goes through `fuzzy_match_category` once, and only then does the
  catch-all apply. This is the shape the ported code intended. *Rejected: deleting the fuzzy step
  outright* — until the near-miss rate under the corrected prompt is measured, one extra call per
  near-miss is cheaper than a dropped product. **Open:** measure that rate on a real upload after
  PR 2; if it stays near zero, delete the step, its protocol method, its prompt and the fake's
  method in one PR.
- **The prompt names categories exactly**: every rule uses the YAML name, the no-match answer is
  `"No Matches Found"`, and the list is one category per line.
- **`categorize_unique_products` parses nothing.** It requires a `datetime64` `date` column and
  a float `weight` column and raises `ValueError` otherwise; `date_format` goes. The lab's
  `categorize_spreadsheet_to_csvs` parses messy input before calling it. *Rejected: passing `max_future_days` through from `analyze()`* —
  it keeps a second copy of a web rule in the library.
- **`validate="many_to_one"` on the merge-back**, the b531ca1 lesson.
- **Two test clients, both in `testing.py`.** `KeywordLlmClient` honours `categories` (returns
  `NO_MATCH` when its keyword's category is not in the list), and a new `ScriptedLlmClient`
  returns whatever answer it was given per item, verbatim, so a test can make the model say
  `Cheese.`.
- **LLM calls run through a bounded `ThreadPoolExecutor`.** `executor.map` keeps input order;
  progress is reported per completed call (`_ReportingLlmClient` already reports per call, and
  `worker_child`'s reporter is lock-protected); the first exception propagates and cancels what
  has not started. `OpenAiLlmClient` is a frozen dataclass over a thread-safe SDK client, and its
  backoff sleeps per thread. Concurrency is a module constant; API load is
  workers × children × threads, so check the account's rate limit for the model before raising
  it. *Rejected: `asyncio`* — ARCHITECTURE.md. *Rejected: several products per prompt* — it
  changes the model's task, and every cache and review row is per product.

## PR 1 — test clients and a characterization (test only)

- `testing.py`: `ScriptedLlmClient`; `KeywordLlmClient.match_product_to_category` honours
  `categories`. `test_testing.py` pins both.
- A characterization test in `tests/categorization/test_pipeline.py`:
  `categorize_unique_products` on an inline frame with scripted answers `Cheese.`, `pork`,
  `"Butter"`, `Cow's Milk`, `None`, plus a cache row categorized `cheese`, asserting today's
  `unique_products_df` and `ai_review_df` with `assert_frame_equal` (every one
  `No Matches Found`; the cache row absent from the review table). Stop short of
  `merge_categorizations`: with every product uncategorized, its 80% cut raises. PR 2's diff of this test is the review.

## PR 2 — accept what the model means

- `steps.py`: normalize-then-match in `categorize_with_llm`; its final catch-all moves to the end
  of `fuzzy_match_GBD_categories`, after the fuzzy call, and `nan_categories` goes.
  `_strip_pack_counts` keeps a `.` between digits. The prompt is rewritten as decided.
- Until `categorization-cache.md` PR 5 lands, a cache row with a non-canonical category now costs
  one fuzzy call per run instead of being dropped; say so in the PR body.
- Tests: the characterization flips to the intended output; `test_llm.py` pins the new
  `_strip_pack_counts` and that `match_product_to_category` returns the model's text untouched
  (normalization belongs to the step, not the client); `test_steps.py` covers the fuzzy path with
  `ScriptedLlmClient`; `test_llm_prompts.py` asserts the match prompt contains
  `No Matches Found` and not `say "None"`.
- Verification beyond the suite: run 200 products from a real upload through the old and new
  prompt with `OpenAiLlmClient` and count answers that needed normalization or the fuzzy step.
  That number decides the **Open** above.

## PR 3 — typed input, guarded merge

- `categorize_unique_products` asserts dtypes and
  drops the parsing parameters, `check_GBD_categories` call and the dead NaN check; the lab's
  `categorize_spreadsheet_to_csvs` calls `parse_and_validate_date_column` and
  `clean_weight_column` itself.
- `merge_categorizations` gets `validate="many_to_one"`.
- Tests: `test_pipeline.py` hands typed frames; a `str` date column is rejected; a duplicate
  product in `categorized_products_df` raises; lab `test_runscript.py` unchanged.

## PR 4 — concurrent LLM calls

- `steps.py`: the two loops become one `_map_llm_calls(fn, items)` helper over a
  `ThreadPoolExecutor(LLM_CONCURRENCY)`; `print_progress` per completion.
- Tests: a client that sleeps 50 ms per call categorizes 16 products in well under 800 ms;
  results are in input order; an exception from one call propagates and no call starts after it
  (a counter in the fake); `test_reports_progress_after_every_llm_call` asserts the count and
  the set of calls rather than their order.
- The PR body carries wall time before and after on a 2k-product upload, either
  `WORKER_MODE=live` or the sleeping fake.

## Verification

- Every PR: `just lint && just check && just test`; PR 3 also `just test-lab`.
- PRs 2–4 change what `analyze()` runs: also `pnpm test:system`.
- PR 2: the live 200-product sample, and a diff of `1. Categorize Runscript.py`'s output on a
  real client file before and after the prompt change.

## Risks

- The prompt rewrite changes categorizations on real data; the runscript diff is the check.
- Rate limits: with N threads a 429 storm costs N × 5 attempts before `upstream_api`; start
  with a small constant.
- Conflicts: `categorization-cache.md` PR 5 edits the same functions; whichever lands second
  rebases.
