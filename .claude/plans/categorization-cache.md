# Categorization cache

## Context

`python-port.md` moves the analysis library into `python/`, leaving the product-categorization
cache as a gitignored CSV the library reads from its packaged path; the products each run's LLM
categorized only reach `result_metadata`. This plan moves that cache into Postgres: the parent
worker materializes the **verified** rows into each run directory at claim time; the child
returns the new rows through a contract document; the parent inserts them **unverified**; a human
verifies or edits them in Supabase Studio, outside the app. The parent is long-lived and queries
per claim, so the next spawn always sees the latest verified rows. Python never touches the
database. The library's other two caches (entree classifications, weight patterns) stay
gitignored files in the lab — only the product cache gets a table.

This plan depends on `python-port.md` PR 6 (`analyze()`) having landed, since PR 5 here edits
`categorize_cache.py` and the seam it defines. PRs 1–4 touch only `packages/db`, `contract/`, and
`apps/worker`, and can start any time.

Requirement: REQUIREMENTS.md § Product categorization cache. The seam docstring in `analysis.py`
already commits to this shape ("a Postgres table with a human-approved flag; the parent
materializes it into the run directory per run; the child reports new values back through the
contract; `AnalysisRequest` is where the cache will arrive").

Verified facts that shape it: there is **no cap on unique products per run**
(`apps/web/src/lib/reports/limits.ts`), so inserts are chunked and the contract carries no cap;
uploads are trimmed and control-character-free (`csv/rules/products.ts`) but golden rows are
verbatim — **never trim on import**; no prod deploy/migration pipeline exists yet (ARCHITECTURE.md
§ Hosting is Open), so prod steps are hand-run with `DB_CONNECTION_STRING`; a cache read failure
needs no new error class — `classifyAttemptFailure` already maps `pg` errors to `infrastructure`.

One design point settled up front: **the child parses the cache document and hands the library
plain rows** — `analysis.py` promises the library never sees a contract document, and
`contract_violation` classification belongs in `worker_child`. Seam fields are added by the PR
that first needs them (PR 3 the request field, PR 4 the outcome field), each with a
`stub_analysis` passthrough so earlier callers keep working; PR 5 is the first PR where the
library reads or fills them.

## PR 1 — `product_categorization` table

`packages/db/migrations/002_product_categorization.ts`, in the style of `001_initial_schema.ts`
+ `_shared.ts` (`updatedAtTrigger`). Equivalent DDL:

```sql
CREATE TABLE product_categorization (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  product                    text NOT NULL,      -- verbatim SKU string; exact-match key
  category                   text NOT NULL,      -- vocabulary is the library's YAML, incl. 'No Matches Found'
  cleaned_name               text,               -- LLM-normalized; second match key
  is_verified                boolean NOT NULL DEFAULT false,   -- the reviewer's switch in Studio
  verified_at                timestamptz,        -- maintained by trigger, never by hand
  verified_by                text,               -- free text: 'import:<file>' or a reviewer's name
  source_analysis_attempt_id uuid REFERENCES analysis_attempt(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_categorization_product_key            UNIQUE (product),
  CONSTRAINT product_categorization_product_not_blank      CHECK (btrim(product) <> ''),
  CONSTRAINT product_categorization_product_max_bytes      CHECK (octet_length(product) <= 2000),
  CONSTRAINT product_categorization_category_not_blank     CHECK (btrim(category) <> ''),
  CONSTRAINT product_categorization_cleaned_name_not_blank CHECK (cleaned_name IS NULL OR btrim(cleaned_name) <> '')
);
CREATE INDEX product_categorization_source_analysis_attempt_id ON product_categorization (source_analysis_attempt_id);
-- updatedAtTrigger → product_categorization_set_updated_at
-- BEFORE INSERT OR UPDATE trigger product_categorization_stamp_verified_at:
--   is_verified true  → verified_at := coalesce(verified_at, now());  false → verified_at := NULL
COMMENT ON TABLE product_categorization IS 'Only is_verified rows reach a run; the worker inserts new rows unverified and a human verifies them in Supabase Studio. The app never sets is_verified.';
```

- A **boolean** is the reviewer's switch (a checkbox in Studio); the trigger keeps `verified_at`
  sound. No `CHECK (is_verified = (verified_at IS NOT NULL))` — the trigger makes it unviolable,
  so it could never get the rejection test the README requires; the trigger's transitions are the
  tests. 2000 bytes keeps the unique b-tree entry under Postgres's ~2.7 KB limit while admitting
  golden rows longer than the web's 200-char cells. No partial index: the materialization query
  returns most of the table, so it seq-scans anyway.
- `packages/db/src/types.ts`: `ProductCategorizationId`, `MAX_PRODUCT_BYTES = 2000` (mirrored
  from the CHECK like `MAX_ANALYSIS_ATTEMPTS`); `src/testing/fixtures.ts`:
  `insertProductCategorization(db, {...})` with a random default `product`; regenerate
  `src/generated/**` + `public-schema.sql` (`pnpm migrate && pnpm db:gen-types`, CI checks drift).
- Tests (`packages/db/tests/product-categorization.test.ts`, `withRollback`, asserting
  `{code, constraint}` like `audit-event.test.ts`): defaults; each CHECK by name (the byte check
  with a 4-byte UTF-8 char × 501); duplicate product; the four trigger transitions; FK `SET NULL`.
- Docs: `packages/db/README.md` § The model — the table, and bullets: *is_verified is the
  reviewer's switch, the app never writes it true*; *first suggestion wins; to reject, leave
  unverified; to make the analysis re-suggest, delete*; *`SET NULL` so the cache outlives the
  report*; *the byte bound and why*.

## PR 2 — one-off import script

- `packages/db/src/product-categorization-csv.ts`: `parseCategorizationCsv(text)` — BOM strip,
  line-ending normalization, ~40-line first-party RFC-4180 tokenizer (quoted fields, `""`,
  embedded newlines/commas; malformed quoting throws), header by name (`product`, `category`,
  `cleaned_item_names → cleanedName`, `'' → null`), skips blank or over-long products with line
  numbers, dedupes on exact `product` keeping the first. Not lifted from `apps/web/.../csv/read/`
  — that parser is tuned for validation and browser use. Pure unit tests beside it.
- `packages/db/src/product-categorization.ts`: `upsertVerifiedProductCategorizations(db, rows,
  {verifiedBy})` — chunks of 1,000; `ON CONFLICT (product) DO UPDATE SET category, cleaned_name,
  is_verified = true, verified_by WHERE NOT product_categorization.is_verified`. A re-run is a
  no-op for verified rows (a reviewer's edit is never clobbered); an unverified suggestion is
  promoted to the golden value. Tests: new / promotes unverified / leaves a verified edit alone /
  second run writes 0 / 1,001 rows exercise chunking.
- `packages/db/scripts/import-product-categorizations.ts` (header in the `truncate.ts` style):
  `argv[2]` = CSV path (usage error exit 2), one `withTransaction`, `verifiedBy =
  \`import:${basename(path)}\``, counts to stdout, skips to stderr. Uses `DATABASE` from
  `../src/env.ts`, so `TEST_DB=1` targets the test stack and `DB_CONNECTION_STRING` wins.
  `package.json`: `"import:categorizations"`. The CSV lives outside the repo; the script header
  says so.
- Docs: root `README.md` scripts table row and, beside § Add a database migration, the hand-run
  prod line — explicitly "no deploy pipeline yet".

## PR 3 — contract: cache document in, parent materializes per claim

Both halves + `contract/` together, per `contract/README.md`.

- `contract/contract.json`: `runDirectory.categorizationCache: "input/categorization-cache.json"`.
  **JSON, not CSV**: both halves already have strict JSON parsers, writers, fixtures and atomic
  writes; golden `product` values contain newlines/quotes/commas. Shape:
  `{"rows": [{"product", "category", "cleanedName": str|null}]}`. Valid fixture: 3 made-up
  rows — one `"No Matches Found"` with `cleanedName: null`, one with `\n`, `"` and `,` inside
  `product`. Invalid fixtures (valid JSON, one violation each): `unknown-field`,
  `rows-is-an-object`, `row-unknown-field`, `blank-product`, `cleaned-name-is-a-number`,
  `missing-rows`.
- TS: `apps/worker/src/contract/layout.ts` (+ header diagram), `messages.ts`
  (`CategorizationCacheSchema` valibot `strictObject`, no trimming; `buildCategorizationCache`;
  `parseCategorizationCache` for tests), `fixtures.test.ts`, `child/run-directory.ts`
  (`writeCategorizationCache`). `packages/db/src/product-categorization.ts`:
  `listVerifiedProductCategorizations(db)` — `SELECT product, category, cleaned_name … WHERE
  is_verified ORDER BY product` (one select, ~5 MB; note the `EXPLAIN ANALYZE` in the PR).
  `attempt/lifecycle.ts` `startAttempt`: after `loadAttemptInputs`, before `createRunDirectory`,
  `retryOnTransientDbError(() => listVerifiedProductCategorizations(db), …)` then
  `writeCategorizationCache` beside `writeManifest`. A failure → `recordStartFailure` →
  `failClaimedAttempt` → `infrastructure`. **Not** "run with an empty cache": that silently pays a
  full LLM pass and contradicts `absorb-or-fail`.
- Python: `worker_child/contract/layout.py`, `fields.py` (`objects(key)` → `list[Fields]` at
  path `rows[i]`), `messages.py` (`read_categorization_cache(run_directory) ->
  tuple[CachedCategorization, ...]`), `run.py` (`_produce_result` reads it after the manifest;
  `_build_request` passes it). `analysis.py` gains
  `CachedCategorization(product, category, cleaned_name: str | None)` and
  `AnalysisRequest.categorization_cache: tuple[CachedCategorization, ...]`; `stub_analysis`
  accepts and ignores it; every `_request()` helper and `tests/support/child.py` gain it; the
  `run_directory` fixture writes the valid fixture into `input/`.
- Tests: `lifecycle.test.ts` — seed one verified + one unverified row (random names, deleted in
  `finally`), fake child parks on a sentinel, read `runPath(..., 'categorizationCache')`, assert
  only the verified row; `breakableDatabase` after the claim → `infrastructure`. Python —
  `test_contract.py`, `test_fixtures.py` (valid fixture → expected tuple incl. the newline row;
  every invalid fixture rejected), `test_run.py` (missing doc → `contract_violation`, no
  `result.json`; malformed → `contract_violation`; a recording `analyze` sees the parsed rows),
  `test_library_agreement.py` (the child's row type *is* the library's).
- Docs: `ARCHITECTURE.md` § Worker step 3 + a new `### Product categorization cache` subsection
  (verified-only, per-claim; *Rejected: an in-process cache or TTL* — the parent is long-lived
  and reviewers edit in Studio; *Rejected: a separate suggestions table*); `REQUIREMENTS.md`
  § cache (+ review happens in Studio, no admin UI; negative results are cached too);
  `contract/README.md`. `packages/storage/src/keys.ts` is untouched — no blob object is involved.

## PR 4 — contract: new-categorizations document out, parent harvests

- `contract/contract.json`: `runDirectory.newCategorizations: "output/new-categorizations.json"`;
  `categorization.maxProductBytes: 2000` (TS imports `MAX_PRODUCT_BYTES` from `@gbd/db`, so the
  CHECK, the parser and the contract are one number; both sides assert it). Shape:
  `{"analysisAttemptId", "rows": [{"product", "cleanedName": str|null, "category"}]}`; rows
  unique by product, nothing blank. **Separate document, required on success, written before
  `result.json`** — `resultMetadata` is jsonb and shouldn't carry a table; declared-but-missing =
  `contract_violation`, like the result files. Invalid fixtures: `unknown-field`,
  `duplicate-product`, `blank-category`, `missing-rows`, `analysis-attempt-id-not-a-uuid`,
  `product-over-max-bytes`.
- TS: `layout.ts`, `names.ts` (`CATEGORIZATION`), `messages.ts` (`NewCategorizationsSchema`),
  `child/run-directory.ts` (`readNewCategorizations`); `attempt/verdict.ts` — `Verdict.succeeded`
  carries the rows and `classify` requires the document for `succeeded`, else
  `contract_violation`; `lifecycle.ts` `readChildEnding` reads it in the same `try` as
  `result.json`. `packages/db/src/product-categorization.ts`:
  `insertSuggestedProductCategorizations(db, rows, {sourceAnalysisAttemptId})` — `ON CONFLICT
  (product) DO NOTHING`, chunks of 1,000. **Harvest inside the `markAttemptSucceeded`
  transaction, after the guarded UPDATE and the `result_file` insert** — the shape `result_file`
  already uses: lose the reaping race ⇒ zero-row UPDATE ⇒ nothing written;
  `retryOnTransientDbError` covers it; the parser mirrors every CHECK so the insert can only fail
  for reasons the `result_file` insert already can. `apps/worker/src/testing/fake-child.ts`: the
  `result` step gains `newCategorizations?` (default `[]`) and `withoutNewCategorizations?`.
- Python: `layout.py`, `names.py` (`MAX_PRODUCT_BYTES`), `messages.py`
  (`new_categorizations_payload` enforcing the same rules), `run.py` `_produce_result`: build the
  payload (validates before touching disk) → `place_result_files` → write
  `new-categorizations.json` → write `result.json`; extend the "ordering is load-bearing"
  comment. `analysis.py` gains `NewCategorization(product, cleaned_name, category)` and
  `AnalysisOutcome.new_categorizations: tuple[NewCategorization, ...] = ()`; `stub_analysis`'s
  default is what keeps `WORKER_MODE=stubbed` and `tests/e2e` green.
- Tests: `verdict.test.ts` (result present, document missing → `contract_violation`);
  `lifecycle.test.ts` (success harvests rows with `isVerified false` and `sourceAnalysisAttemptId
  = attemptId`; a pre-existing verified row is untouched; `withoutNewCategorizations` →
  `contract_violation` with no `result_file` and no cache rows; the lost-race test also asserts
  zero cache rows). Python — `test_run.py` (stub writes `rows: []`; scenario rows appear
  verbatim; duplicate product → `contract_violation`), `test_fixtures.py`, `test_contract.py`.
- Docs: `ARCHITECTURE.md` step 5 and the cache subsection (harvest in the verdict transaction;
  first suggestion wins; humans verify/edit/delete in Studio; *Rejected: embedding rows in
  result.json*); `packages/db/README.md` (who writes the table); `contract/README.md`.
- Verify: both gates + `pnpm exec turbo run test:system`.

## PR 5 — library: consume the seam rows, drop the packaged CSV

- `categorize_cache.py` keeps only `normalize_product_name`, `unanimous_index`,
  `build_cleaned_name_reuse_index(historical) -> dict[str, str]`. Deleted: the loader and path
  helper (and the `.gitignore` entry), `save_historical_categorizations`, the unreviewed-web-app
  cache functions, both `promote_*`, `_validate_cache_write_mode`/`cache_write_mode`.
  `categorize_products(df, llm, historical_categorizations: pd.DataFrame, *, ...)` — required
  (an empty frame with the three columns is allowed).
- `analyze()`: `cache = frame_from_rows(request.categorization_cache)` (the one place the seam's
  `cleaned_name` meets the library's `cleaned_item_names`); rows whose `category` is not in
  `get_GBD_categories()` + `"No Matches Found"` are dropped with a warning and counted in
  `metadata` — a reviewer's typo in Studio must not fail every run. `new_categorizations` moves
  from `metadata` into `AnalysisOutcome.new_categorizations` via `rows_from_review_table(ai_review_df)`.
- `categorize_file` (notebook I/O wrapper) → lab `categorize_file.py`. GBD's "categorize →
  review → save to cache" notebook flow becomes a lab tool that emits rows for the import script;
  noted, not designed here.
- Tests: delete the write/promote/web-app tests in `test_categorize_cache`; keep
  `normalize_product_name` and the reuse-index tests; new `test_frame_from_rows`,
  `test_unknown_category_is_dropped_and_counted`; `test_analysis` cache-hit test now passes rows
  instead of patching a path.
- Docs: `analysis.py` cache Open → deleted; REQUIREMENTS.md § Persistence result-metadata Open →
  points at `AnalysisOutcome`.

## Failure-path semantics (PRs 3 + 4)

| Situation | Result |
| --- | --- |
| Cache read fails in `startAttempt` after retries | `failed('infrastructure')`; no child spawned |
| Child fails / crashes / killed / canceled | no harvest |
| Exit 0, `new-categorizations.json` missing or malformed | `failed('contract_violation')` |
| Lost the reaping race | guarded UPDATE matches 0 rows → nothing written, cache rows included |
| Two concurrent attempts suggest the same product | second `DO NOTHING` waits on the first's tuple, then skips |
| Reviewer types a category not in the YAML | child drops the row with a warning and a count in `metadata` |
| Reviewer deletes a row | next run re-suggests it unverified; *leaving* a row unverified is the "reject" state |

## Go-live order

1. Merge PR 1; run the migration against prod by hand (additive; the running worker is unaffected).
2. Merge PR 2; import from a workstation against prod; check counts against the private CSV's row
   count minus reported skips/duplicates; spot-check a `"No Matches Found"` row and a multi-line
   product in Studio.
3. Deploy PR 3 (parent + child ship in one image, so the contract change is atomic). If the import
   is late, the parent writes `{"rows": []}` — costs LLM calls, breaks nothing.
4. Deploy PR 4, then PR 5. If PR 4 lands before the import, harvested unverified rows are later
   promoted by the import's `DO UPDATE … WHERE NOT is_verified`. After PR 5, delete the gitignored
   CSV from developer checkouts; the table is the source of truth.

## Verification

An upload on `mock-llm` produces unverified `product_categorization` rows; tick `is_verified` in
Studio; the next upload of the same file shows those products under
`match_type_counts.raw_product_history` in `result_metadata` and makes fewer LLM calls.
