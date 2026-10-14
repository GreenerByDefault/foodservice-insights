# AI usage and attempt telemetry

## Context

`REQUIREMENTS.md` § Metrics asks for "analysis cost, via AI metrics", and § Persistence carries
two **Open**s: AI usage (model, tokens, cost), and structured result metadata ("rows in, rows
categorized, products uncategorized, ..."). Both were dropped until their shape was known.
`metrics-dashboards.md` leaves AI cost out "until the child reports token usage".

This plan records, as typed rows per analysis attempt:

- what the LLM calls cost;
- how the categorization cache performed;
- how much of the data could be used;
- what the data-quality checks found;
- the report's headline numbers;
- where the time and memory went;
- which build ran it.

That makes the `metrics` views and Grafana panels able to show AI cost per report and per week,
and explain it.

This was built once and removed. #168 (`933a6d28`) dropped `ai_model`, `ai_input_tokens`,
`ai_output_tokens`, `ai_cost_usd numeric(10,4)` and `ai_metadata jsonb` from `analysis_attempt`,
and an `ai` object with a decimal-string cost from `result.json`, for want of a spec. #230
(`1cfb06e8`) dropped `result_metadata jsonb`: "I'd rather have structured fields than this vague
jsonb". It was to have held `{rowsIn, rowsCategorized, productsUncategorized}`. The library is
ported now, so the shape can be read off the code. Worth lifting from #168: the fake child's
default-usage pattern, the `_require` checks, and fixture names like `negative-output-tokens`.

Facts from the tree (2026-10-12, `main` at `10b8388c`, after `notebook-era-leftovers.md`
landed) that shape the design:

- **One place makes every product LLM call, and it already reports each one.**
  `OpenAiLlmClient._complete` (`categorization/llm.py`):
  - calls `chat.completions.create` on `gpt-4.1-mini`, with `max_tokens=30` and `temperature=0`;
  - retries in a hand-written loop of 5 requests, with the SDK's own retries off;
  - hands its `on_call` one frozen `LlmCall` per call, in a `finally`, however the call ended:
    the operation, requested and served model, requests, failed requests and the 429s among
    them, whether the answer hit `MAX_TOKENS`, and the last response's input, cached input and
    output tokens (0 where `usage` or its details are missing).

  It serves two operations (`LlmOperation`, `"clean" | "match"`), one request per product, from
  `map_concurrently`'s thread pool (`LLM_CONCURRENCY = 3`, whose comment says "conservative until
  measured"). So `on_call` runs on any of those threads, and anything that records calls must be
  thread-safe, as `progress_reporter` already is.
- **`analyze(…, report_telemetry=…)` reports most of the run, and nothing passes it yet.**
  `analysis.py` hands the reporter to `OpenAiLlmClient.from_env(on_call=…)`, and re-exports
  `LlmCall`, `LlmOperation`, `cost_micro_usd` and `CategorizationSummary`, so `worker_child`
  imports only from the seam. `type Telemetry = LlmCall | InputSummary | CategorizationSummary |
  ReportSummary | StageFinished`. `analyze` reports, in order:
  - `StageFinished("read", ms)`, then `InputSummary(rows, kilograms, unique_products,
    cache_entries)`. The read stage includes loading the cache. The first three describe the
    upload: kilograms are after lb→kg, and unique products are counted after stripping, as
    `categorize_unique_products` strips. `cache_entries` is the whole cache's size, not this
    upload's hits, and 0 means every product goes to the LLM.
  - `StageFinished("categorize", ms)`, then `CategorizationSummary`, from the pure
    `summarize_categorization` in `categorization/pipeline.py`. It holds the unique products per
    match type, the "No Matches Found" products split by history or LLM, the unrecognized LLM
    answers, and the rows and kilograms categorized. `CategorizedProducts` carries
    `unrecognized_llm_answers`, which `categorize_with_llm` now returns beside its frame; it
    counts unique cleaned names sent to the LLM, not products.
  - `ReportSummary`, from the pure `summarize_report` in `report/food_report.py`, right after
    `build_food_report`, then `StageFinished("report", ms)`. It holds `quality_status`, the
    findings counted per check and status (`FindingCount`s, only the pairs that occurred, sorted),
    `total_co2e_kg`, `co2e_kg_per_diner_or_meal`, `plant_pct`, and `plant_protein_pct` or `None`.
    `total_co2e_kg` and `co2e_kg_per_diner_or_meal` are functions in `food_report.py`, which
    `pdf.py`'s `_executive_narrative` calls too, so the PDF and the record cannot disagree.
  - `StageFinished` for `pdf` and `xlsx`. The report stage begins with `merge_categorizations`,
    so a run that fails the 20% check has already reported its categorization summary and both
    earlier stage times. The pdf stage includes the charts.

  A stage that raises reports no time, timed with `time.monotonic()` in whole milliseconds.
  `stub_analysis` takes `report_telemetry=` and `telemetry=`, and reports those records before
  `raises`.
- **Calls scale with uncached products.** Each uncached raw name costs one `clean` call, and each
  unique uncached cleaned name one `match` call. A first upload can make thousands; a repeat
  upload almost none. Each call is about 1k input tokens, nearly all of it the fixed system
  prompt, and at most 30 output tokens.
- **Spend and counts exist before most failures.**
  - The 20% check in `merge_categorizations` raises `UnusableDataError` after the whole LLM pass,
    with every count already computed. So does `build_food_report`'s all-zero check.
  - A cancel, hang, hard timeout or shutdown kills the child mid-run. The parent reads nothing
    from a killed child, and `failure.json` is a strict three-field object read only on exit 1.
- **`analysis_attempt` freezes when terminal.** `analysis_attempt_terminal_is_final` rejects any
  change to a terminal row except the notification columns. So anything recorded after the
  verdict needs its own table, and a new column on the attempt must be written at claim or in the
  terminal `UPDATE`.
- **Nothing measures memory.** The report's numbers are reported now; peak memory is not.

  The lab keeps its own `MergeCounts.between` and `match_type` `value_counts` for the runscript's
  summary, which also subtracts the non-entree rows.
- **The cache is the cost lever, and its "hit" is not "categorized".** `raw_product_history`
  also counts products whose cached category *is* "No Matches Found". A missing cache CSV only
  warns, and then sends every product to the LLM. That is `caches-to-supabase.md`'s launch blocker.
  `cache_entries` reports it, but nothing records it per attempt yet.
- **Nothing says which build ran an attempt.** `worker_id` is `hostname-pid-uuid`. The SHA
  exists only as the image's OCI label, and both Python packages are version `0.0.0`. Prompts,
  categories and thresholds are packaged files, so the SHA identifies them too.
- **`mock-llm` is what `pnpm test:system` runs** (`partial(analyze, llm=KeywordLlmClient())`).
  So no tier sends a real `OpenAiLlmClient`'s usage through the real parent; the contract
  fixtures on both sides close that gap.
- **The neighbours.**
  - `caches-to-supabase.md` adds `new-categorizations.json` and harvests it after the verdict.
  - `metrics-dashboards.md` adds the `metrics` schema, `metrics_reader` and Grafana, and bans
    free-text columns from `metrics`. Its PR 6 makes a hard delete leave a tombstone in
    `metrics`, so its views keep deleted reports, attempts and users.

  Neither has landed. Only `001_initial_schema.ts` exists, and two plans already claim `002`, so
  each migration here takes the next free number at merge time. The shared test stack refuses to
  migrate a branch that lacks a migration another worktree applied, so expect that error while
  plans overlap.
- **Only deleting an organization removes data.**
  - Deleting a report is soft and "does not delete any data" (`REQUIREMENTS.md` § Data
    deletion). Deleting an organization hard-deletes its reports, which cascades to their
    attempts.
  - A hard delete on request is a GBD-run script, still TBD.
  - `audit_event` already keeps raw `organization_id` and user ids with no FK, so it outlives what
    it names. "The raw user ID stays in the audit log" is the stated precedent.

Out of scope:

- the lab's Gemini and raw-OpenAI calls, which have no database path;
- per-call rows;
- rejections the browser catches before upload, which never reach the server;
  `REQUIREMENTS.md`'s no-client-side-metrics rule makes recording them a product call;
- reconciling estimates against OpenAI's invoice.

## What an attempt can report

The survey behind the choices below. **Bold** is stored; the rest is why not.

**From each LLM call.**

| Available | Decision |
| --- | --- |
| `usage`: **`prompt_tokens`**, **`prompt_tokens_details.cached_tokens`**, **`completion_tokens`**; also `cache_write_tokens`, `reasoning_tokens`, audio and predicted-output tokens | `usage` and both details objects are `Optional`. Cached input bills at a quarter of the price, and the system prompt never changes, so the cached share is worth watching. Reasoning tokens are already in `completion_tokens` and are zero on `gpt-4.1-mini`; they earn a column with a reasoning model |
| **`model`** as served (the resolved snapshot) | Stored beside the requested model, because an alias can move underneath us |
| **`finish_reason == "length"`** | The 30-token cap cut the answer, which then quietly becomes "No Matches Found". Stored as a count |
| Our retry loop: **requests per call**, **failed requests**, **429s among them**; backoff slept | 429s are the measurement `LLM_CONCURRENCY`'s comment asks for |
| `id`, `_request_id`, `system_fingerprint`, `service_tier`; `openai-processing-ms` and rate-limit headers via `with_raw_response` | Per call, high-cardinality, or redundant with request counts |
| Time waiting on OpenAI | Covered by `categorize_ms` below. Per-call timing needs an injected clock for no extra answer |
| Our choices: **operation**, **requested model**, **list-price cost** | The price is ours to know, not the API's |

**From the run.** Unique products are counted after stripping.

| Stage | Available | Decision |
| --- | --- | --- |
| Read | **Rows**, **kilograms** (after lb→kg), **unique products**, **entries in the cache** | Rows and products are the size of the work. An empty cache is the alarm, whether a missing CSV today or an empty verified table after `caches-to-supabase.md` |
| Categorize | **Unique products by match type**; **uncategorized, split by whether the history or the LLM said "No Matches Found"**; **unrecognized LLM answers**; **rows** and **kilograms categorized** | The share of weight left uncategorized is the coverage figure the customer never sees. The products share is what the 20% cutoff tests, so successful runs show how close they came. `MergeCounts`' other fields are redundant with these |
| Report | **`quality_status`**; **per check and status, the number of findings**; **total kg CO2e**, **kg CO2e per diner or meal**, **plant %**, **plant-protein %** | Findings' messages, samples and thresholds are text or constants. `quality_status` can only be `pass` or `warning` today, because no check emits `error`. The impact numbers are for a cross-customer dashboard |
| Every stage | **Milliseconds per stage** (read, categorize, report, pdf, xlsx); **peak memory** | Tests REQUIREMENTS § Performance's "almost entirely the AI tool", and sizes `maxConcurrentAttempts`. A killed run's stage timings say how far it got |
| Failure | Why data was unusable | Derivable: the products categorized fall under 20%, or kilograms categorized are 0 |
| Output | PDF pages, XLSX sheets | Fixed functions of what is already stored; `result_file` has the sizes |
| Environment | Python and package versions, prompt and YAML hashes, CPU time | Pinned in the image, and so implied by the SHA, or too low in value |

**From the parent and the build.**

| Available | Decision |
| --- | --- |
| **The worker's git SHA** | Stored at claim, so abandoned and timed-out attempts carry it too |
| Child runtime (`spawn.ts` `durationMs`); download, upload and park times | The stage timings cover the child; `claimed_at`→`finished_at` covers the rest. Log fields, not columns |
| `WORKER_MODE`, contract version | Production only ever runs `live`; the SHA implies the contract |
| Row count of the upload (computed on the server, then dropped) | Redundant with the child's rows read |

## Decisions

### The shape of what is stored

- **`analysis_attempt_llm_usage`: one row per attempt × operation × requested model.**
  - Counts: `calls`, `requests`, `failed_requests`, `rate_limited_requests`, `truncated_calls`.
  - Tokens: `input_tokens` (cached included, as OpenAI counts them), `cached_input_tokens`,
    `output_tokens`.
  - Model and cost: `served_model` (null when no call got a response; the latest if it changed
    mid-run), `cost_micro_usd`.

  About two rows per attempt. A report's cost is the sum over its attempts, since a retry spends
  again.
  *Rejected: one row per call.* Thousands of rows per first upload, and an appending file, for
  latency percentiles and request ids that are log material.
- **`analysis_attempt_telemetry`: one row per attempt, in column groups that fill in as stages
  finish.**
  - Identity: `analysis_attempt_id`, `report_id`, `organization_id`, `recorded_at`. They are raw
    ids, per § Telemetry outlives what it describes.
  - Input: `input_rows`, `input_kilograms`, `input_unique_products`, `cache_entries`.
  - Categorization:
    - `raw_product_history_products`, `cleaned_name_history_products`, `llm_products`;
    - `history_uncategorized_products`, `llm_uncategorized_products`,
      `unrecognized_llm_answers`;
    - `categorized_rows`, `categorized_kilograms`.
  - Report: `quality_status`, `total_co2e_kg`, `co2e_kg_per_diner_or_meal`, `plant_pct`,
    `plant_protein_pct` (null when the report has no protein share).
  - Timing: `read_ms`, `categorize_ms`, `report_ms`, `pdf_ms`, `xlsx_ms`, and
    `peak_memory_kib`.

  Each group is all null or all set, by named CHECK. The sums the child guarantees are CHECKs
  too: the three match types add up to `input_unique_products`, and categorized rows are at most rows
  read. So a dashboard can tell "never reached the report" from "zero".
  *Rejected: a table per stage.* Every panel would join three or four 1:1 tables.
- **`analysis_attempt_quality_check`: one row per attempt × check × status**, holding the number
  of findings. The status counts per check are what threshold tuning reads, and success rows
  are kept so a firing rate has a denominator. Check names are `QualityCheck`, a `Literal` on
  `make_finding`'s `category`, so the type checker closes the set. The lab's own checks go
  through `diagnostics.make_finding`, typed with a `LabCheck` literal of its own, since their
  names are not the product's.
- **`analysis_attempt.worker_git_sha`**, written at claim, is the one new attempt column. The
  claim is before the row is frozen.
- **Typed columns, never jsonb**, per #230 and the metrics plan's no-free-text rule. The two
  text columns are `served_model` (alongside `model` in the key) and `worker_git_sha`. Each has a
  pattern CHECK, so the metrics conventions test can allowlist them with a reason.
  `integer` for counts and milliseconds, since the worst plausible upload is under 1e9 tokens.
  `double precision` for kilograms, CO2e and percentages.
### Telemetry outlives what it describes

- **No FK from the telemetry tables to `analysis_attempt`, `report` or `organization`.** The
  telemetry row carries the three ids raw, the way `audit_event` does. The usage and quality
  rows FK to the telemetry row, which is written in the same transaction.

  So deleting an organization leaves its spend, its coverage and its stage times in the history.
  These tables are never deleted from, so unlike `metrics-dashboards.md`'s views over live
  tables, they need no tombstone. It also means a parent that settles an attempt after its
  organization was deleted still records the spend, where an FK would have failed with
  `23503`.
- **That is safe to keep because none of it is personal data.** It holds counts, tokens,
  kilograms, emissions, check names, model ids and three uuids. Those uuids resolve to nothing
  once the organization is gone. There are no names, no product text, no user ids and no file
  names.

  The figures describe a business's purchasing, not a person. This is the same call as
  `REQUIREMENTS.md`'s "the raw user ID stays in the audit log", with less in it. A requested
  hard delete, GBD's TBD script, removes these rows by `organization_id`. `REQUIREMENTS.md`
  § Data deletion gains a line saying both.
- **Status comes from a join, not a copy.** A view `LEFT JOIN`s `metrics.attempt` for status,
  failure reason and `worker_git_sha`. Once `metrics-dashboards.md` PR 6 lands, that includes a
  hard-deleted attempt's tombstone, so the outcome survives too.
  *Rejected: copying the verdict onto the telemetry row.* After a fenced or lost ending, the
  parent does not know the final status, and the tombstone already keeps it.
  *Rejected: `ON DELETE SET NULL` FKs.* They would keep the rows but null the very ids that let
  a hard delete find them.
- **`analysis_attempt_id` stays the key.** It is the telemetry table's PK and part of the child
  tables' PKs, so `ON CONFLICT DO NOTHING` still makes a retried insert harmless.

### Cost: list price, computed by the child

- **`MODEL_PRICES` sits beside `DEFAULT_MODEL` in `llm.py`**, as `ModelPrice`s in integer
  micro-USD per million tokens. `gpt-4.1-mini` is 400_000 input, 100_000 cached input and
  1_600_000 output; the comment carries the page's URL and the date it was checked.
- **`OpenAiLlmClient.__post_init__` refuses an unpriced model.** So a model switch cannot ship
  without a price, and a lookup can never fail mid-run. The lab's runscript builds the same class,
  so it is guarded too.
- **The child computes each row's cost from the row's totals**, with the library's
  `cost_micro_usd(model, *, input_tokens, cached_input_tokens, output_tokens)`, rounding half up
  once. It raises on impossible counts (cached above input, or a negative), so a fold bug fails
  loudly instead of being priced. Every number crossing the seam that counts or prices is an
  integer. It assumes the `default` service tier, which is what we request. Tokens are
  stored beside the cost, so a correction is an `UPDATE`.
  *Rejected: a price table in Postgres, joined by a view.* The model is chosen in Python, and a
  switch there would silently produce null cost until someone wrote a migration in the other
  stack.
  *Rejected: a decimal-string cost* (#168).

### One telemetry document, kept current through the run

- **`output/telemetry.json`:** `{llmUsage: [...], input, categorization, report, stageMs,
  peakMemoryKib}`. A stage's object is null until that stage finishes, and `stageMs` holds the
  stages done so far. There is no attempt id: the parent inserts under its own.
- **The library reports facts; the child folds and writes them.** `analyze` takes
  `report_telemetry: ReportTelemetry`, and `Telemetry` is a union of typed records: `LlmCall`,
  `InputSummary`, `CategorizationSummary`, `ReportSummary` and `StageFinished`.
  - `OpenAiLlmClient` reports `LlmCall`s through its `on_call`.
  - `analyze` reports each summary and stage time as it gets one, and so *before* a later check
    raises.

  The child's `telemetry_reporter(run_directory)` folds each record under a lock and rewrites the
  document atomically, as `progress_reporter` does `progress.json`. It reads `ru_maxrss`
  (normalized to KiB) at every write. The library never sees a contract document, as
  `analysis.py` promises.
- **So every ending reports what it knew.** An `unusable_data` failure carries the counts that
  doomed it. A canceled, hung or timed-out run carries its spend and how far it got.
  *Rejected: the fields inside `result.json` and `failure.json`.* Only one of them is written, and
  only by a child that lives to write it.
  *Rejected: the usage inside `progress.json`.* That is the liveness signal.
- **It is the one document not tied to an exit code, and it never decides a verdict.** The parent
  reads it on every ending:
  - **missing** (a spawn failure, or a run that died before reading its input): nothing happens;
  - **malformed**: one `error` log and no rows.
- **`report_telemetry` reaches only the client `analyze` builds.** Pass `llm=` and no calls are
  reported, though the summaries still are. So `mock-llm` records everything but usage, and
  `stubbed` scripts all of it. The seam's docstring says so, and `test_analysis.py` pins it.
- **A write that fails** (a full disk) raises from whichever report triggered it. Inside
  `_complete`'s `finally`, that replaces the call's own error, so the run reads `unknown`.
  `progress.json` has the same exposure. Accepted.
- **Two fsync'd writes per call, instead of one, are probably free**, since a call takes hundreds
  of milliseconds and three are in flight. PR 2 measures it and has a fallback.

### The parent records after the verdict, whatever the ending

- **One rule: only the verdict and its result files go in the verdict's transaction.**
  Everything else comes afterwards:
  - under `retryOnTransientDbError`;
  - if it still fails, it is logged at `error` and dropped;
  - it never changes the verdict.

  That is `caches-to-supabase.md`'s harvest rule too, and `failures.ts`'s `one-retry-layer`
  gains it.
- **`settleAttempt` records the telemetry after `deliverVerdict` or the `unowned` early return,
  and before its `finally` removes the run directory.**
  - The three tables are written in one transaction. A malformed document writes none of them,
    so there are never half the facts.
  - It runs in sequence after the verdict write, because `DATABASE_CONNECTIONS_PER_ATTEMPT = 2`
    budgets for no parallel write.
  - `readChildEnding` reads the document before its `exited` check, so every ending carries it.
- **It is recorded for fenced, lost and lost-race endings too.** The spend happened, and the
  insert touches no state another worker could own. Beyond that:
  - an attempt id is claimed at most once;
  - with no FK to `analysis_attempt`, the insert takes no lock on it and is untouched by the
    terminal trigger;
  - `ON CONFLICT DO NOTHING` covers a retry after an ambiguous commit.
- **Telemetry is lost, by design, when:**
  - the database is down at the verdict write;
  - the worker process dies;
  - calls are in flight at a kill.

  *Rejected: carrying it through a parked verdict.* That is state kept alive for a metric.
- **No `WORKER_CONTRACT_VERSION` bump.** The parent and child ship in one image, and every
  change is additive.

## PR 1 — the three tables and the build's SHA column

`packages/db`, migration `0NN_attempt_telemetry.ts`.

- Enums:
  - `llm_operation ('clean','match')`
  - `quality_status ('pass','warning','invalid')`
  - `diagnostic_status ('success','info','warning','error')`
  - `quality_check` (the six names)
- `analysis_attempt_llm_usage`:
  - PK `(analysis_attempt_id, operation, model)`, with the FK to the telemetry row.
  - Named CHECKs:
    - `calls >= 1`;
    - `requests >= failed_requests >= rate_limited_requests >= 0`;
    - `requests - failed_requests <= calls`;
    - `truncated_calls <= calls`;
    - `0 <= cached_input_tokens <= input_tokens`;
    - the non-negatives;
    - `model` and `served_model` match `^[a-z0-9][a-z0-9._:-]{0,99}$`.
- `analysis_attempt_telemetry`:
  - PK `analysis_attempt_id`, with *no* FK. Also `report_id` and `organization_id` (uuids, no
    FK) and `recorded_at timestamptz DEFAULT now()`, with an index on `(organization_id)` for the
    hard-delete script and one on `(recorded_at)` for the views.
  - The column groups from § Decisions, with one all-or-none CHECK per group.
  - Categorization requires input, and report requires categorization.
  - The match types sum to `input_unique_products`.
  - Categorized rows and kilograms are at most those read.
  - Every count and millisecond is non-negative, `peak_memory_kib > 0`, and the percentages
    are 0–100.
- `analysis_attempt_quality_check`: PK `(analysis_attempt_id, check, status)`, with the FK to
  the telemetry row, and `findings >= 1`.
- `analysis_attempt.worker_git_sha text` with CHECK `^[0-9a-f]{40}$`, nullable.
- The two child FKs are `ON DELETE CASCADE` from the telemetry row, so the hard-delete script
  deletes one table.
- Each table's `COMMENT` says:
  - written after the verdict, on every ending the child left a document for;
  - cost is list price at run time;
  - groups fill as stages finish;
  - the rows outlive the attempt, report and organization they name, and hold no personal data.
    The migration's header carries § Telemetry outlives what it describes.
- Regenerate `public-schema.sql` and `src/generated`. Add a fixture per table to
  `src/testing/fixtures.ts`, with a case each.
- `tests/attempt-telemetry.test.ts`, under `withRollback`, asserting `{code, constraint}`:
  - every CHECK by name;
  - the duplicate keys;
  - deleting the organization leaves all three tables' rows;
  - an insert for an attempt id that no longer exists succeeds;
  - deleting the telemetry row cascades to its usage and quality rows.
- `packages/db/README.md`: the three tables in the model, and one bullet on why they carry raw
  ids rather than FKs. That bullet goes beside the conventions test's FK-index rule, which they
  satisfy through their PKs.
- `REQUIREMENTS.md` § Data deletion: analysis telemetry (counts, tokens, costs and stage times;
  no names, product text or user ids) outlives organization deletion, and a requested hard delete
  removes it by organization. Drop the stale `ai_*` from its line 102 and from `apps/worker/src/attempt/queue.ts:8`,
  and rename the "ai columns" test titles in `lifecycle.test.ts` and `queue.test.ts`.

## PR 2 — the contract, and the child writes `telemetry.json`

Both halves plus `contract/`, per `contract/README.md`. The parent does not read it yet. This
needs PR 1.

- `contract/contract.json`: `runDirectory.telemetry: "output/telemetry.json"`, plus the
  operation, quality-status, diagnostic-status and check vocabularies.
  - One valid fixture: every section set, two usage rows, a null `plantProteinPct`.
  - A second valid fixture: killed during categorization, so `input` is set and the later
    sections are null.
  - One invalid fixture per violation, mirroring the DB CHECKs, plus `unknown-field`,
    `row-unknown-field`, `input-tokens-are-a-bool`, `categorization-without-input` and
    `duplicate-check-and-status`.
- TypeScript:
  - `contract/layout.ts`: the diagram, and a paragraph explaining that the document is written
    throughout the run, read on every ending, and never decides a verdict.
  - `contract/names.ts`: the vocabularies, each `satisfies` its generated enum type.
  - `contract/messages.ts`: `TelemetrySchema`, `parseTelemetry`.
  - `contract.test.ts` and `fixtures.test.ts`.
- Python:
  - `contract/layout.py`, `contract/names.py`.
  - `contract/messages.py`: `telemetry_payload(state)`, which sorts rows and `_require`s the
    invariants.
  - `writer.py`: `telemetry_reporter(run_directory)`, folding through a pure `fold_telemetry`,
    with each usage row's cost recomputed from its totals by the seam's `cost_micro_usd`.
  - `run.py` passes it as `report_telemetry`.
  - Every fake `analyze` takes the keyword: `worker_child/testing.py`'s, the one in
    `tests/support/child.py`, and the local ones in `test_run.py`. A missing one surfaces as a
    `TypeError` turned into `failure.json`, so look for a wrong reason, not a crash.
  - `stubbed` reports a fixed `STUB_TELEMETRY` before every scenario, `!slow` and `!hang`
    included, through `stub_analysis`'s `telemetry=`. `tests/support/child.py` gains a `"telemetry"` key, reported before `hang` or
    `raises`.
- Tests:
  - `test_writer.py`:
    - the first record creates the document;
    - same-key calls fold;
    - the sections fill in order;
    - 50 calls from 8 threads give exact totals and leave no temp file;
    - cost comes from the totals.
  - `test_run.py`:
    - success writes it;
    - telemetry then `raises` writes `failure.json` and the document;
    - nothing reported writes no document.
  - `test_child_process.py`'s hang-and-kill test asserts the document holds the scripted
    records.
  - `test_mock_llm.py`: summaries but empty `llmUsage`.
  - `test_fixtures.py`, `test_contract.py`, `test_library_agreement.py`.
- **Measure the extra write**, with `uptime` checked first.
  - In the worker image, time 5,000 `telemetry_reporter` calls from 3 threads against the same
    number of `progress_reporter` calls, at p50 and p99.
  - Compare `map_concurrently`'s "Categorization: N calls in X s" on a live mid-size file before
    and after.
  - If the two writes cost more than about 2% of a median call, a follow-up drops fsync for both
    documents (the rename is what protects the reader), or limits telemetry to one write a
    second plus a final one.
  - Put the numbers in the PR.

## PR 3 — the parent records telemetry on every ending

`apps/worker`. This is the first PR that writes telemetry in production.

- `child/run-directory.ts`: `readTelemetry`.
- `attempt/lifecycle.ts`:
  - `ReadEnding` gains `telemetry: Telemetry | undefined`, read before the `exited` check. A read
    or parse error is one `error` log and `undefined`.
  - An exported `recordTelemetry(dependencies, prepared, telemetry)` writes the three tables in
    one transaction through `dependencies.db`, under the retry, with `ON CONFLICT DO NOTHING`.
    The identity comes from `prepared`'s `attemptId`, `reportId` and `organizationId`. It never
    throws.
  - `settleAttempt` awaits it after the verdict.
- `testing/fake-child.ts`: a `{ step: 'telemetry', document? }` step and an exported
  `FAKE_TELEMETRY`. `writeRaw` covers malformed documents.
- `failures.ts`: `one-retry-layer` gains this write. Under `fencing`, add that a fenced parent
  may still record what the child observed, because that touches no owned state.
- `lifecycle.test.ts`:
  - the end-to-end success asserts all three tables with `toEqual`;
  - the kills `test.each` scripts a partial document before `waitFor` and asserts the partial
    row for every kill reason, `fenced` and `lost` included;
  - the lost race and an exit-1 `unusable_data` failure assert their rows;
  - an organization deleted while its attempt runs still gets its rows;
  - no document gives no rows and no log;
  - a malformed one leaves the verdict unchanged, with exactly one `error` record and no rows;
  - the database-down park loses the telemetry and logs it.

  `recordTelemetry` is also tested directly: a broken database resolves and logs, and calling it
  twice leaves one set of rows.
- `tests/e2e/specs/report-lifecycle.e2e.ts`: on `mock-llm`, the attempt has a telemetry row with
  every group set and no usage rows.
- Docs:
  - `ARCHITECTURE.md` § Worker, steps 4–5: the child keeps `telemetry.json` current, and the
    parent records it after the verdict whatever the ending. § Failure modes, the Supabase row:
    post-verdict records get the bounded retry, then are dropped.
  - `REQUIREMENTS.md` § Persistence: both **Open**s become statements.
  - `packages/db/README.md`: who writes the tables.
- Go-live: hand-run PR 1's migration against production before dispatching a worker deploy that
  contains this PR. If someone forgets, every settle logs `42P01` and loses that telemetry, but
  verdicts are untouched.

## PR 4 — the build's SHA on every attempt

Independent of PRs 2–3 except PR 1's column. This touches CI and the image, which is this task.

- `.github/actions/build-image/action.yml`: `build-args: GIT_SHA=${{ inputs.sha }}`. Both
  images get it; the web's Dockerfile ignores it.
- `apps/worker/Dockerfile`: `ARG GIT_SHA` and `ENV WORKER_GIT_SHA=$GIT_SHA`, after the last
  `COPY`, so only the final layer varies per commit.
- `apps/worker/src/config.ts` reads `WORKER_GIT_SHA`. It is unset locally and in the e2e build,
  which gives null. A value not matching the pattern stops startup.
  - `main.ts` logs it once at startup.
  - `claimNextAttempt` sets `workerGitSha` beside `workerId`.
- Tests:
  - `queue.test.ts`: a claim with and without a SHA;
  - `config.test.ts`: the variable's three cases;
  - `packages/db`: the pattern CHECK (in PR 1).
- `ARCHITECTURE.md` § Images: the image carries its SHA as an env var as well as the OCI label.
  Promotion keeps it true, since the SHA is the build's.
- Verify after the first deploy: a production attempt's `worker_git_sha` equals the deployed
  commit.

## PR 5 — the views and panels

This needs `metrics-dashboards.md` PR 1. The panels also need its PRs 2 and 4.

- Views, in the next migration. Each reads its telemetry table first, `LEFT JOIN`s
  `metrics.attempt` for status, failure reason and `worker_git_sha`, and buckets by
  `recorded_at`, so deleted work stays in every week it ran.
  - `metrics.attempt` gains `worker_git_sha`. If that plan's PR 6 has landed,
    `metrics.purged_attempt` gains it too, and so does its trigger.
  - `metrics.attempt_llm_usage`: each usage row, with `cost_usd` as a numeric.
  - `metrics.attempt_telemetry`:
    - the telemetry columns;
    - `cache_hit_rate`;
    - `categorized_kilograms_share`;
    - `categorized_products_share`.
  - `metrics.attempt_quality_check`.
  - Each view gets its tests. The conventions test allowlists `model`, `served_model` and
    `worker_git_sha` with their reasons.
- `insertSyntheticHistory`:
  - writes telemetry and usage for every settled attempt that was claimed;
  - writes quality rows and the report group for every succeeded one;
  - gives some failed attempts a categorization group under 20%.

  Without this, that plan's "every panel returns a row" check fails.
- Panels on the product dashboard:
  - AI cost per week, and per succeeded report;
  - reports analyzed and organizations active per week, deleted ones included;
  - cache hit rate;
  - categorized share by kilograms;
  - 429s per week;
  - stage time p50 and p95;
  - which checks warn most;
  - and, on an impact dashboard, CO2e analyzed and plant share per month.
- `metrics-dashboards.md` loses AI cost from its Out of scope.
- This PR deletes this plan. If the metrics plan has not reached PR 1 by then, end this plan at
  PR 4. The rows are queryable in Studio, and this PR moves into `metrics-dashboards.md` as one of
  its "one small PR each" metrics, with the synthetic rows added to its PR 3.

Order: 1, then 2, then 3. PR 4 can go any time after 1. PR 5 is last.

## Failure paths

| Situation | What is recorded |
| --- | --- |
| Success | everything |
| `unusable_data` from the 20% check | usage, input and categorization; the counts that failed it |
| `unusable_data` from all-zero weights | usage, input and categorization, with `categorized_kilograms = 0` |
| `upstream_api` | usage (the failed requests included), input; categorization never finished |
| Canceled, hung, hard timeout, shutdown, killed for a contract violation | usage up to the last finished call, plus every stage that finished, with its time |
| Fenced, lost, or lost the verdict race | the same; the verdict is not ours, the facts are |
| Spawn failed, or died before reading its input | nothing; no document |
| `telemetry.json` malformed | one `error` log, no rows, verdict unchanged |
| Database down at the verdict write | lost and logged; the verdict parks as today |
| Migration not yet applied in production | `42P01` logged per settle; verdicts unaffected |
| Worker process dies | lost with the run directory; `worker_git_sha` was set at claim |
| Organization deleted, before or after the settle | rows kept; status, failure reason and SHA come from `metrics.attempt`'s tombstone once `metrics-dashboards.md` PR 6 lands, and are null before it |
| GBD hard-deletes an organization on request | its telemetry rows go too, by `organization_id` |

## Verification

Each PR runs its stack's gate:

- Python: `just lint && just check && just test`.
- TypeScript: `pnpm lint && pnpm check && pnpm test`, plus `pnpm test:system` for PRs 2 and 3.

Then by hand, against the dev stack:

- After PR 3, on `stubbed`:
  - An upload leaves `STUB_TELEMETRY`'s rows in all three tables.
  - A `!slow` upload canceled from the waiting page leaves its usage and input group on a
    `canceled` attempt.
- After PR 3, on `mock-llm`:
  - An upload leaves a full telemetry row, quality rows, and no usage.
  - Deleting that organization from the app leaves the telemetry and quality rows, with ids
    that no longer join.
  - An upload that is mostly unknown products fails `unusable_data`, with a categorized share
    under 20%.
- After PR 3, on `live`, with a small real file:
  - Usage rows land for both operations, at about 1k input tokens per call.
  - `cost_micro_usd` matches the tokens times the list price, worked by hand.
  - The day's total is close to the usage OpenAI's dashboard shows for the project.
  - The stage times add up to roughly the child's `durationMs` in the worker log.
- After PR 4's first deploy: a production attempt's `worker_git_sha` is the deployed commit.
- After PR 5: every panel draws from `pnpm seed:history`, and a real `live` attempt shows its
  cost.
