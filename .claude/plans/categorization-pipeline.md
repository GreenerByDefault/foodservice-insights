# Categorization pipeline

## Context

`categorize_unique_products` (`categorization/pipeline.py`) and its steps (`steps.py`) are the
product's categorization path: exact cache match, LLM name cleaning, cleaned-name reuse, LLM
category match, then `merge_categorizations` with the 80% cut. `analyze()` composes it; the lab's
`categorize_spreadsheet_to_csvs` composes it the same way and adds entree detection. The cache is
the gitignored `data_files/previously_categorized_items.csv`; `categorization-cache.md` moves it
into Postgres later and is sequenced after this plan. `report-typed-data.md` PR 3 waits on PR 2
here.

This plan is the product side only: the cache the library reads and the pipeline that reads it.
How new rows get back into the cache — from the web app or from GBD's reviewers — is
`categorization-cache.md`'s problem and is not designed here.

Verified facts, September 2026, against GBD's copy of the cache (38,692 rows):

- **The pipeline is handed a `CategorizationCache`; nothing below `analyze()` reads disk.**
  `categorize_unique_products(df, llm, cache)` and both lookup steps take it, required.
  `CategorizationCache.from_frame` (`categorization/cache.py`) is the one place the cache's shape
  is enforced: it strips `product`, drops blank products, drops rows whose category is not a YAML
  name or `"No Matches Found"`, dedupes on `product` keeping the last, WARNs each count, and builds
  the unanimous cleaned-name index. On GBD's copy that is 126 rows with an unknown or blank
  category and 371 later duplicates, in ~70 ms. `load_categorization_cache()` reads the CSV as text
  and calls it; `analyze()` and `categorize_spreadsheet_to_csvs` are its callers in the pipeline.
  The lab's writer, `product_cache.save_historical_categorizations`, deliberately reads the raw
  file through `read_categorization_cache_csv()` instead, so a save never deletes a row the loader
  drops and a person could still fix. **Open:** matching products case-insensitively — 2,844 rows
  collide, in 31 groups with conflicting categories, so GBD has to say which wins; measure the
  extra hit rate on a real upload first. **Open:** whether `from_frame` should raise when more than
  some share of rows are unusable (a category renamed in the YAML would silently turn thousands of
  hits into LLM calls); warn-only until the Postgres cache controls categories at write time.
- **The prompt coaches answers the pipeline drops.** `match_items_to_gbd_categories_prompt.md` says
  *say "None"* when nothing fits and names categories as `"oat milk"`, `"shelled eggs"`, `poultry`,
  `pork`, `"Cow's Milk"` in its own rules; the list is rendered as a Python `list` repr with mixed
  quotes. `OpenAiLlmClient.match_product_to_category` returns `content.strip()` and nothing more,
  so `Cheese.`, `"Butter"` and `oat milk` are all uncategorized. How often gpt-4.1-mini follows
  the rules literally is unmeasured, and `KeywordLlmClient` only ever returns canonical names, so
  no test and no `mock-llm` run can show it. `_strip_pack_counts` deletes every `.` before the
  prompt (`CHEESE 2.5 LB` → `CHEESE 25 LB`), and `test_llm.py` pins that.
- **Tests stay hermetic by patching a path or building the cache.** `test_pipeline.py` and
  `test_steps.py` build a `CategorizationCache.from_frame`; tests that go through `analyze()` or
  `categorize_spreadsheet_to_csvs` — `test_analysis.py`, `worker_child/tests/test_mock_llm.py`, and
  the lab's `test_serving.py`, `test_spreadsheet.py`, `test_entree_cache.py`,
  `test_product_cache.py` — monkeypatch `cache.categorization_cache_path` to a path under
  `tmp_path`. The worker image is not hermetic: `apps/worker/Dockerfile` copies the package
  directory and `.dockerignore` does not exclude the CSV, so a local `docker build` ships the
  developer's cache and CI's ships none. Noted, not fixed here — deployment config is off limits.
- **`test_categorize_unique_products_characterization` pins today's silent drops.** It runs
  `categorize_unique_products` on an already-typed frame with `test_pipeline.py`'s
  `ScriptedLlmClient`, which answers verbatim by cleaned name and raises `KeyError` for an
  unscripted item. Its cache holds a trailing-space row (a hit), a `cheese` row and a
  blank-category row (both dropped by `from_frame`, so their products reach the LLM and the review
  table), and one good hit. Every scripted answer — `Cheese.`, `"Butter"`, `pork`, `cheese` —
  comes out `No Matches Found` today. It has no `None` answer since the trailing-space row began
  hitting. The fake lives in the test module, not the shipped `testing.py`, because only insights
  tests use it; move it to a shared place if a second test file needs it.
- **All the wall time is LLM calls.** Loading the cache and matching 208 products with no LLM
  calls takes ~100 ms on a loaded laptop. The two loops in `clean_product_names` and
  `categorize_with_llm` are one call at a time, two calls per new product; ARCHITECTURE.md
  § Concurrency and scaling names a `ThreadPoolExecutor` inside the library as the lever. The
  parent kills a child after 20 minutes total (`killAfterTotalRuntimeMs`), and there is no cap on
  unique products per upload.
- **`categorize_unique_products` re-parses parsed input.** `read_input_csv` already yields
  `datetime64` dates and float weights; re-running `parse_and_validate_date_column` and
  `clean_weight_column` changes no value, but `max_future_days=30` uses the container's local date
  while `apps/web` uses UTC (`calendar.ts`), so a row dated exactly 30 days out can pass the web
  and fail the run as `unknown`. The NaN check after `astype(str)` on `product` is dead.

## Decisions

- **The product library never writes the cache.** New rows leave the library only as a return
  value (`categorization-cache.md` PR 4–5); writing the reviewed file is the lab's, by hand after
  review. *Rejected: keeping a `"reviewed"` auto-write as a lab option* — it writes unreviewed LLM
  output into the reviewed file, and the data shows it was used.
- **Normalize the model's answer; no second prompt.** Casefold and strip whitespace,
  quotes and a trailing period from the answer, match against the canonical list plus
  `"No Matches Found"`, and log anything still unrecognized at WARNING with the item. An
  unrecognized answer is uncategorized and reaches the review table. *Rejected: reviving the fuzzy
  step* (an LLM call re-matching a non-canonical answer, deleted because `categorize_with_llm`'s
  rewrite made it unreachable) — it is a second prompt to maintain
  for a residual the corrected prompt and normalization already cover, and the WARNING count on
  real data decides whether the prompt needs another rule, not whether to add a call.
- **The prompt names categories exactly**: every rule uses the YAML name, the no-match answer is
  `No Matches Found`, and the list is one category per line. It is the one PR here that changes
  categorizations on real data, so it ships alone, with a before/after diff GBD's data scientist
  has seen.
- **`categorize_unique_products` parses nothing.** It requires non-empty `str` products, a
  `datetime64` `date` and a float `weight` and raises `ValueError` otherwise; `date_format` goes and
  the lab parses messy input before calling it. *Rejected: passing `max_future_days` through from
  `analyze()`* — a second copy of a web rule in the library.
- **LLM calls run through a bounded `ThreadPoolExecutor`**, via one helper shared by the two loops:
  results in input order, progress per completion, the first exception propagates after
  `shutdown(cancel_futures=True)` so nothing queued starts. `OpenAiLlmClient` is a frozen dataclass
  over a thread-safe SDK client whose `with_options` copy is per call, and its backoff sleeps per
  thread; `worker_child`'s progress reporter is lock-protected; the interpreter is a GIL build, so
  `KeywordLlmClient.calls` is safe. Concurrency is a constant beside the retry constants in
  `llm.py`: API load is workers × children × threads, and a 429 storm costs threads × 5 attempts.
  *Rejected: `asyncio`* — ARCHITECTURE.md. *Rejected: several products per prompt* — it changes the
  model's task, and every cache and review row is per product.
- **One behaviour change per PR.** Each PR's diff of the characterization test
  is its review.

PR order: 1 and 2 any time; 3 after 1, since both edit `categorize_with_llm`.

## PR 1 — accept what the model means

- `steps.py`: `categorize_with_llm` maps each answer through a normalized-name table built from
  the canonical list plus `"No Matches Found"` (`cache.NO_MATCHES_FOUND`); an unrecognized answer
  becomes `"No Matches Found"` with one WARNING naming the item and the answer.
- `match_items_to_gbd_categories_prompt.md` rewritten as decided; `_categories_prompt` renders one
  category per line. The domain rules keep their content — they are GBD's knowledge — and only
  their category references change. `_strip_pack_counts` keeps a `.` between digits.
- Tests: the characterization test flips (`Cheese.` → `Cheese`, `"Butter"` → `Butter`,
  `cheese` → `Cheese`; `pork` stays `No Matches Found`, now with a warning) and gains a product
  scripted to answer `None`, which stays `No Matches Found` with a warning; `test_llm.py` pins the
  new `_strip_pack_counts` and that `match_product_to_category` still returns the model's text
  untouched (normalization is the step's, not the client's); `test_llm_prompts.py` asserts the
  match prompt contains `No Matches Found`, not `say "None"`, and lists categories one per line.
- Verification beyond the suite, in the PR body: 200 products from a real upload through the old
  and new prompt with `OpenAiLlmClient`, counting answers that needed normalization and answers
  still unrecognized; and a diff of `1. Categorize Runscript.py`'s output on a real client file
  before and after, reviewed by GBD's data scientist.

## PR 2 — typed input, no re-parsing

- `categorize_unique_products` asserts its dtypes, drops `date_format`, the two parsing calls and
  the dead NaN check, and keeps the `product` strip (it is the match key rule, and cheap).
- `categorize_spreadsheet_to_csvs` runs `parse_and_validate_date_column`, `clean_weight_column`
  and the product cleaning itself, with the two "cleaning leaves missing values" tests moving from
  `test_pipeline.py` to the lab's `test_spreadsheet.py`.
- Tests: `test_pipeline.py` hands typed frames; a `str` date column and a NaN product are rejected.
  `report-typed-data.md` PR 3 then moves `report/parsing.py` whole to the lab.

## PR 3 — concurrent LLM calls

- `steps.py`: `_map_llm_calls(fn, items)` over `ThreadPoolExecutor(LLM_CONCURRENCY)` as decided,
  used by `clean_product_names` and `categorize_with_llm`; `print_progress` per completion.
  `llm.py`: `LLM_CONCURRENCY: Final = 8` with the load arithmetic in its comment. `analysis.py`'s
  docstring says `report_progress` may be called from worker threads.
- Tests, deterministic rather than timed: a fake whose calls wait on a
  `threading.Barrier(LLM_CONCURRENCY, timeout=...)` proves that many calls run at once; a fake with
  random sleeps proves results come back in input order; with concurrency 1, a fake whose first
  call raises proves the error propagates and no later item is called.
  `test_reports_progress_after_every_llm_call` stays as is: its two calls are in different steps.
- The PR body carries wall time before and after on a 2k-product upload, `WORKER_MODE=live` or
  the sleeping fake, with the machine's load noted.

## Verification

- Every PR: `just lint && just check && just test`; PR 2 also `just test-lab`.
- Every PR changes what `analyze()` runs: also `pnpm test:system`.
- PR 1: the live 200-product sample and the runscript diff above.

## Risks

- The prompt rewrite changes categorizations on real data; the runscript diff is the check, and
  it needs `OPENAI_API_KEY` and a client file only GBD has.
- Rate limits: with N threads a 429 storm costs N × 5 attempts before `upstream_api`; start at the
  constant and check the account's tier for gpt-4.1-mini before raising it.
- Conflicts: `categorization-cache.md` PR 5 edits the same functions; whichever lands second
  rebases.
