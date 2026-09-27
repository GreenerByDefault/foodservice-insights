# Categorization pipeline

## Context

`categorize_unique_products` (`categorization/pipeline.py`) and its steps (`steps.py`) are the
product's categorization path: exact cache match, LLM name cleaning, cleaned-name reuse, LLM
category match, then `merge_categorizations` with the 80% cut. `analyze()` composes it; the lab's
`categorize_spreadsheet_to_csvs` composes it the same way and adds entree detection. The cache is
the gitignored `data_files/previously_categorized_items.csv`, read by
`cache.get_previously_categorized_items()`; `categorization-cache.md` moves it into Postgres later
and is sequenced after this plan. `diagnostics-split.md` PR 1 waits on PR 3 here.

This plan is the product side only: the cache the library reads and the pipeline that reads it.
How new rows get back into the cache — from the web app or from GBD's reviewers — is
`categorization-cache.md`'s problem and is not designed here.

Verified facts, September 2026, against GBD's copy of the cache (38,692 rows) and the code after
#355–#380:

- **The product only reads the cache.** `categorization/cache.py` is the loader, the path
  (`categorization_cache_path()`) and the cleaned-name index; the two writers a data scientist
  runs by hand after review live in the lab's `categorization/product_cache.py`. What the file
  shows of the old auto-writes: 3,212 rows have no cleaned name (promoted from review files,
  which carry none) and 20,008 have the raw SKU as their cleaned name (cache hits saved back with
  `cleaned_item_names = product`).
- **The loader drops nothing and checks nothing.** `pd.read_csv(path)` with default NA handling: a
  product named `NA` or `null` would become NaN, and the 106 rows with a blank category do. The
  pipeline strips the upload's product before matching (`categorize_unique_products`) and so does
  the web (`csv/rules/products.ts`), but the cache is matched verbatim, so its 747 rows with
  surrounding whitespace can never hit; 736 rows collide once stripped, 11 pairs disagreeing on
  the category. 20 rows carry a category that is not in the YAML (`Mlik`, `Plan-Based Mayo`,
  `cheese`, `na`, `Stone Fruit`, ...). Such a row matches in step 1 (`previously_categorized=True`),
  `categorize_with_llm`'s last line rewrites it to `"No Matches Found"`, and because it is
  "previously categorized" it is kept out of the review table: silently dropped, every run, with no
  LLM call. 2,844 rows collide case-insensitively, in 31 groups with conflicting categories.
- **The prompt coaches answers the pipeline drops.** `match_items_to_gbd_categories_prompt.md` says
  *say "None"* when nothing fits and names categories as `"oat milk"`, `"shelled eggs"`, `poultry`,
  `pork`, `"Cow's Milk"` in its own rules; the list is rendered as a Python `list` repr with mixed
  quotes. `OpenAiLlmClient.match_product_to_category` returns `content.strip()` and nothing more,
  so `Cheese.`, `"Butter"` and `oat milk` are all uncategorized. How often gpt-4.1-mini follows
  the rules literally is unmeasured, and `KeywordLlmClient` only ever returns canonical names, so
  no test and no `mock-llm` run can show it. `_strip_pack_counts` deletes every `.` before the
  prompt (`CHEESE 2.5 LB` → `CHEESE 25 LB`), and `test_llm.py` pins that.
- **Tests are hermetic by patching a path.** Below `analyze()` the pipeline reads one file, via
  `cache.categorization_cache_path`, when it is not handed the cache. `test_analysis.py`,
  `worker_child/tests/test_mock_llm.py`, and the lab's `test_serving.py`, `test_entree_cache.py`
  and `test_product_cache.py` monkeypatch it to a path under `tmp_path`; a test that runs the
  pipeline without it reads the developer's `data_files/`. `test_pipeline.py`'s tests pass
  `historical_categorizations` instead. The worker image is not hermetic:
  `apps/worker/Dockerfile` copies the package directory and `.dockerignore` does not exclude the
  CSV, so a local `docker build` ships the developer's cache and CI's ships none. Noted, not fixed
  here — deployment config is off limits.
- **`test_categorize_unique_products_characterization` pins today's silent drops.** It runs
  `categorize_unique_products` on an already-typed frame with `test_pipeline.py`'s
  `ScriptedLlmClient`, which answers verbatim by cleaned name (`Cheese.`, `"Butter"`, `pork`,
  `None`) and raises `KeyError` for an unscripted item. Its cache holds a `cheese` row, a trailing-space row and
  a blank-category row — the last two with no cleaned name, so the cleaned-name step cannot rescue
  them — plus one good hit. Today every scripted answer and the `cheese` row come out
  `No Matches Found`, the `cheese` row is absent from the review table, and the trailing-space and
  blank rows reach the LLM. The fake lives in the test module, not the shipped `testing.py`,
  because only insights tests use it; move it to a shared place if a second test file needs it.
- **All the wall time is LLM calls.** Loading the cache, building the cleaned-name index (9,925
  entries) and matching 208 products with no LLM calls takes ~100 ms on a loaded laptop. The two
  loops in `clean_product_names` and `categorize_with_llm` are one call at a time, two calls per
  new product; ARCHITECTURE.md § Concurrency and scaling names a `ThreadPoolExecutor` inside the
  library as the lever. The parent kills a child after 20 minutes total
  (`killAfterTotalRuntimeMs`), and there is no cap on unique products per upload.
- **Two merges without `validate=`.** `categorize_using_historical_classifications` dedupes the
  cache on `product` with `keep="last"` before merging, silently choosing; `merge_categorizations`
  merges rows onto `unique_products_df` on `product` with no guard, so a duplicate product there
  would fan out rows (the b531ca1 lesson). Nothing upstream produces one today.
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
- **The pipeline is handed the cache; nothing below `analyze()` reads disk.** `categorize_unique_products`
  and the two steps take a `CategorizationCache`; the `None`-means-read-the-file defaults go
  (`categorize_using_cleaned_name_history` already requires its `reuse_index`). That
  is what makes tests hermetic and is the shape `categorization-cache.md` PR 5 needs (`analyze()`
  builds the cache from seam rows instead of the file).
- **One type owns the cache's shape.** `CategorizationCache.from_frame(df)` is the only constructor:
  it strips `product`, drops rows whose category is not a YAML name or `"No Matches Found"`,
  dedupes on `product` keeping the last, logs every count it dropped at WARNING, and builds the
  cleaned-name index once. A bad row therefore costs LLM calls and a review-table entry, never a
  silently dropped product. `load_categorization_cache()` reads the CSV as text
  (`dtype=str, keep_default_na=False`, the `read_input_csv` precedent) and calls `from_frame`.
  *Rejected: raising on a bad row* — a typo among 39k hand-maintained rows must not fail every
  report. *Rejected: matching products case-insensitively* — 31 conflicting pairs in the file mean
  GBD has to say which wins; **Open:** measure the extra hit rate on a real upload and ask.
  **Open:** whether `from_frame` should raise when more than some share of rows are unusable (a
  category renamed in the YAML would silently turn thousands of hits into LLM calls); warn-only
  until the Postgres cache controls categories at write time.
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
- **`validate="many_to_one"` on both merges.** A duplicate product in a cache someone built by hand
  raises rather than silently picking one; `from_frame` guarantees the loader never produces one.
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

PR order: 1, 2 and 3 any time; 4 after 2, since both edit `categorize_with_llm`.

## PR 1 — one loader, one type

- `cache.py`: `CategorizationCache` (frozen; `products: pd.DataFrame` with `product`, `category`,
  `cleaned_item_names` as `str`, unique stripped products, canonical categories; and
  `cleaned_name_index: Mapping[str, str]`), `CategorizationCache.from_frame(df)` enacting the
  decision above, and `load_categorization_cache() -> CategorizationCache` replacing
  `get_previously_categorized_items` (missing file → empty cache and the existing warning;
  missing column → `ValueError`). `build_cleaned_name_reuse_index` folds into `from_frame`.
- `categorize_unique_products(df, llm, cache)`, `categorize_using_historical_classifications(
  unique_products_df, cache)` and `categorize_using_cleaned_name_history(products_df, cache)`
  take the cache, required; the step's `drop_duplicates(keep="last")` goes and its merge gets
  `validate="many_to_one"`, as does `merge_categorizations`.
- `analyze()` and the lab's `categorize_spreadsheet_to_csvs` load the cache and pass it;
  `entree_cache.py`, `backfill_entree_cleaned_names`, `experiments/LLM_testing.py` and the lab's
  `product_cache.save_historical_categorizations` use the new loader, the last appending to
  `cache.products`.
- Tests: `test_cache.py` rewritten around `from_frame` — a product named `NA` survives, stripping,
  blank and non-canonical categories dropped with the warning, duplicates keep the last, missing
  column raises, missing file warns; `test_steps.py`: a duplicate product raises; the
  characterization test flips — the trailing-space row is a cache hit, and the `cheese` row joins
  the blank one at the LLM and in the review table, so it needs a scripted answer.
  `test_analysis.py`'s fixture keeps writing a CSV the loader reads, and the patches of
  `categorization_cache_path` stay.

## PR 2 — accept what the model means

- `steps.py`: `categorize_with_llm` maps each answer through a normalized-name table built from
  the canonical list plus `"No Matches Found"`; an unrecognized answer becomes
  `"No Matches Found"` with one WARNING naming the item and the answer.
- `match_items_to_gbd_categories_prompt.md` rewritten as decided; `_categories_prompt` renders one
  category per line. The domain rules keep their content — they are GBD's knowledge — and only
  their category references change. `_strip_pack_counts` keeps a `.` between digits.
- Tests: the characterization test flips (`Cheese.` → `Cheese`, `"Butter"` → `Butter`; `pork` and
  `None` stay `No Matches Found`, now with a warning each); `test_llm.py` pins the new
  `_strip_pack_counts` and that `match_product_to_category` still returns the model's text
  untouched (normalization is the step's, not the client's); `test_llm_prompts.py` asserts the
  match prompt contains `No Matches Found`, not `say "None"`, and lists categories one per line.
- Verification beyond the suite, in the PR body: 200 products from a real upload through the old
  and new prompt with `OpenAiLlmClient`, counting answers that needed normalization and answers
  still unrecognized; and a diff of `1. Categorize Runscript.py`'s output on a real client file
  before and after, reviewed by GBD's data scientist.

## PR 3 — typed input, no re-parsing

- `categorize_unique_products` asserts its dtypes, drops `date_format`, the two parsing calls and
  the dead NaN check, and keeps the `product` strip (it is the match key rule, and cheap).
- `categorize_spreadsheet_to_csvs` runs `parse_and_validate_date_column`, `clean_weight_column`
  and the product cleaning itself, with the two "cleaning leaves missing values" tests moving from
  `test_pipeline.py` to the lab's `test_spreadsheet.py`.
- Tests: `test_pipeline.py` hands typed frames; a `str` date column and a NaN product are rejected.
  `diagnostics-split.md` PR 1 then moves `parse_and_validate_date_column` whole to the lab.

## PR 4 — concurrent LLM calls

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

- Every PR: `just lint && just check && just test`; PRs 1 and 3 also `just test-lab`.
- Every PR changes what `analyze()` runs: also `pnpm test:system`.
- PR 1: `python -m worker_child.mock_llm` on a run directory both with and without
  `data_files/previously_categorized_items.csv` present.
- PR 2: the live 200-product sample and the runscript diff above.

## Risks

- The prompt rewrite changes categorizations on real data; the runscript diff is the check, and
  it needs `OPENAI_API_KEY` and a client file only GBD has.
- PR 1 turns 126 silently dropped cache rows into LLM calls the first time each product appears;
  the WARNING names them so GBD can fix the file.
- Rate limits: with N threads a 429 storm costs N × 5 attempts before `upstream_api`; start at the
  constant and check the account's tier for gpt-4.1-mini before raising it.
- Conflicts: `categorization-cache.md` PR 5 and `diagnostics-split.md` PR 1 edit the same
  functions; whichever lands second rebases.
