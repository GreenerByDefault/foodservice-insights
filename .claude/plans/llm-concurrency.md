# Concurrent LLM calls

## Context

`categorize_unique_products` (`categorization/pipeline.py`) and its steps (`steps.py`) are the
product's categorization path: exact cache match, LLM name cleaning, cleaned-name reuse, LLM
category match, then `merge_categorizations` with the 80% cut. `analyze()` composes it; the lab's
`categorize_spreadsheet_to_csvs` composes it the same way and adds entree detection. The pipeline
is handed a `CategorizationCache` (`categorization/cache.py`) and takes typed rows; nothing below
`analyze()` reads disk. The cache moving into Postgres is `categorization-cache.md`, sequenced
after this plan.

Verified facts, October 2026:

- **All the wall time is LLM calls.** Loading the cache and matching 208 products with no LLM
  calls takes ~100 ms on a loaded laptop. The two loops in `clean_product_names` and
  `categorize_with_llm` are one call at a time, two calls per new product; ARCHITECTURE.md
  § Concurrency and scaling names a `ThreadPoolExecutor` inside the library as the lever. The
  parent kills a child after 20 minutes total (`killAfterTotalRuntimeMs`), and there is no cap on
  unique products per upload.
- **`categorize_with_llm` normalizes each answer itself.** It matches the model's text to a
  YAML category or `"No Matches Found"` with `normalize_product_name`, ignoring case and
  punctuation, and counts anything else in one WARNING after the loop, with the five most common
  answers. `OpenAiLlmClient.match_product_to_category` still returns the model's text untouched,
  so only the call belongs in a thread; normalizing and counting can stay on the results. Whether
  the corrected prompt needs another rule is decided by the WARNING count on a real upload, which
  has not been measured; `KeywordLlmClient` only returns canonical names, so no test or `mock-llm`
  run shows it.
- **`test_categorize_unique_products_characterization`** (`test_pipeline.py`) runs the pipeline
  with a `ScriptedLlmClient` that answers verbatim by cleaned name and raises `KeyError` for an
  unscripted item, and pins near-miss answers resolving and `pork` / `None` being counted. It is the
  regression net for the loop rewrite. The fake lives in the test module because only insights
  tests use it; move it to a shared place if a second test file needs it.
- **Tests stay hermetic by patching a path or building the cache.** `test_pipeline.py` builds a
  `CategorizationCache.from_frame` and `test_steps.py` constructs one directly; tests that go
  through `analyze()` or `categorize_spreadsheet_to_csvs` monkeypatch
  `cache.categorization_cache_path` to a path under `tmp_path`.

## Decisions

- **LLM calls run through a bounded `ThreadPoolExecutor`**, via one helper shared by the two loops:
  results in input order, progress per completion, the first exception propagates after
  `shutdown(cancel_futures=True)` so nothing queued starts. `OpenAiLlmClient` is a frozen dataclass
  over a thread-safe SDK client whose `with_options` copy is per call, and its backoff sleeps per
  thread; `worker_child`'s progress reporter is lock-protected; the interpreter is a GIL build, so
  `KeywordLlmClient.calls` is safe. Concurrency is a constant beside the retry constants in
  `llm.py`: API load is workers × children × threads, and a 429 storm costs threads × 5 attempts.
  *Rejected: `asyncio`* — ARCHITECTURE.md. *Rejected: several products per prompt* — it changes the
  model's task, and every cache and review row is per product.

## The change

- `steps.py`: `_map_llm_calls(fn, items)` over `ThreadPoolExecutor(LLM_CONCURRENCY)` as decided,
  used by `clean_product_names` and `categorize_with_llm`; `print_progress` per completion.
  `llm.py`: `LLM_CONCURRENCY: Final = 8` with the load arithmetic in its comment. `analysis.py`'s
  docstring says `report_progress` may be called from worker threads.
- Tests, deterministic rather than timed: a fake whose calls wait on a
  `threading.Barrier(LLM_CONCURRENCY, timeout=...)` proves that many calls run at once; a fake with
  random sleeps proves results come back in input order; with concurrency 1, a fake whose first
  call raises proves the error propagates and no later item is called.
  `test_reports_progress_after_every_llm_call` stays as is: its two calls are in different steps.
  The characterization test must pass unchanged.
- The PR body carries wall time before and after on a 2k-product upload, `WORKER_MODE=live` or
  the sleeping fake, with the machine's load noted.

## Verification

`just lint && just check && just test`, and `pnpm test:system` since this changes what `analyze()`
runs.

## Risks

- Rate limits: with N threads a 429 storm costs N × 5 attempts before `upstream_api`; start at the
  constant and check the account's tier for gpt-4.1-mini before raising it.
- Conflicts: `categorization-cache.md` PR 5 edits the same functions; whichever lands second
  rebases.
