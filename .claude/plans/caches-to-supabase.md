# Caches to Supabase

## Context

Three caches today, all gitignored CSVs handed around by hand:

| Cache | File | Rows | Read by | Written by |
| --- | --- | ---: | --- | --- |
| Product categorization | `python/insights/.../data_files/previously_categorized_items.csv` | 38,692 | the product (`analyze()`) and the lab (step 1, `LLM_testing.py`, the entree backfill) | nothing in the repo since the lab's review-and-promote path was deleted; copies are handed out by hand |
| Entree classification | `python/lab/.../data_files/previously_classified_entrees.csv` | 1,989 | the lab, serving mode only | the lab, **automatically**, with Gemini's unreviewed labels (`spreadsheet.py` → `save_historical_entree_classifications`) |
| Unit weight | `python/lab/.../data_files/previously_classified_weights.csv` | 893 | the lab, step 1.5 | the lab, by hand (`expand_historical_weight_classifications`) |

This plan moves all three into Postgres, with one rule: **a row is used only once a human has
verified it in Supabase Studio.** The worker parent materializes the verified product rows into
each run directory at claim time, so a long-lived worker always runs the latest review; the child
returns what its LLM categorized and the parent inserts those rows unverified; the lab, and a
developer's `live` worker, read the same verified rows and suggest to the same table through a
database role that can do nothing else. The analysis library never touches the database.

Facts that shape the design (the tree as of 2026-10-11, and what GBD has said):

- **The library is already a reader.** #400 deleted every product-side write;
  `categorize_unique_products` takes a `CategorizationCache` (#423) built by `from_frame`, which
  strips products, drops blank products, drops rows whose category is outside the YAML list,
  keeps the *last* duplicate, and warns per reason (#455, #475). `analyze()` is the one product
  caller of `load_categorization_cache()`, and its seam docstring already promises this plan's
  shape (`AnalysisRequest` is where the cache arrives, `AnalysisOutcome` where new values leave).
- **The parent is long-lived and claims per attempt** (`worker.ts` → `startAttempt`), so a
  per-claim query is the simplest way to always see the latest verified rows.
- **The worker holds one database handle** (`apps/worker/src/db.ts`, from
  `DB_CONNECTION_STRING`), and locally that is the dev stack. So, without more, a developer's
  `pnpm dev:worker` in `live` mode would read an empty local cache and bury its real OpenAI
  categorizations in a database nobody reviews. `live` on a laptop is the same model and the
  same prompts as production; `mock-llm` is a keyword fake whose answers must never reach a
  shared cache.
- **A CI-built worker image has no cache.** The CSV is gitignored, so `live` mode in production
  would send every product to the LLM; `deploy-safety.md` § Before launch names this as a launch
  blocker. Local images hide it because the file is on the developer's disk.
- **No client-side database access and no RLS** (`ARCHITECTURE.md` § Supabase). Both local
  stacks also run with `[api] enabled = false`, so PostgREST is not a path for the lab either.
- **One connection string serves everything, as `postgres`**, and it is the string the Supabase
  dashboard hands out: full access. Nothing in this repo has yet connected to the hosted project
  as anything else. `cache_client` is the first custom role, and only the local stacks have it.
- **The tables and the role exist on `main`, but not yet in production.**
  `packages/db/migrations/002_caches.ts` creates `product_categorization`,
  `entree_classification` and `unit_weight`, the `set_verified_at()` trigger and `cache_client`;
  `public-schema.sql` has their columns and checks, and `tests/caches.test.ts` asserts every
  constraint and the role's exact privileges. `@gbd/db` exports `MAX_CACHE_KEY_BYTES`, and
  `@gbd/db/testing` exports `insertProductCategorization`, `insertEntreeClassification` and
  `insertUnitWeight`, which name only the columns the role may insert.
- **Hosted Supabase facts, from its docs on 2026-10-11.** A custom role is an ordinary
  `CREATE ROLE … LOGIN PASSWORD` that the SQL editor, running as `postgres`, may issue —
  Supabase's own roles post creates one that way; `postgres` is not a superuser but has the
  admin privileges that covers. The shared pooler accepts a custom role as
  `[ROLE].[PROJECT-REF]`, session mode on port 5432, IPv4 on every plan; supplying the bare role
  name gives `Tenant or user not found`. The direct connection is IPv6 unless the IPv4 add-on
  is bought. Dashboard roles: Owner, Administrator and Developer can all run arbitrary SQL;
  Read-Only, which runs SELECT only as `supabase_read_only_user`, exists on Team and Enterprise
  plans only. So on a Free or Pro plan, anyone who can open Studio can drop a table.
- **No prod migration pipeline yet** (`deploy-migrations.md` is unlanded), so prod steps below are
  hand-run against the session-mode pooler URL.
- **GBD's product CSV** (copy dated 2026-09-27): 23,505 of 38,692 rows are `No Matches Found`,
  so negative results are most of the cache's value; 20,008 rows have `cleaned_item_names` equal
  to the raw product, from old cache hits written back verbatim; 747 products carry surrounding
  whitespace; 2 contain newlines and 703 contain quotes; the longest is 435 characters; 106
  categories are blank and a few more are misspelled. The entree file has no whitespace problems;
  the weights file has 7 blank weights and 4 units with surrounding whitespace. A data scientist
  is sending an updated copy with new entries and some cleaning; the go-live import runs on that,
  so these counts will move.
- **Two data scientists run the lab locally and will keep doing so.** They rely heavily on AI
  agents when writing code, so any credential they hold is one an agent may misuse. Their
  current copies of the caches are already behind GBD's.
- **`REQUIREMENTS.md`** § Product categorization cache ("new entries go through human review
  first") and § Security ("minimum permissions — for example, read-only database access").

## Decisions

### Three tables, one shape

- **One table per cache, each its own review queue.** An unverified row *is* the suggestion,
  and `is_verified` is the whole state machine; `verified_at` follows it by trigger.
  `suggested_by` says where a row came from: `attempt:<uuid> <worker id>`, `lab:<name>`,
  `import:<file>`, or the default `manual` for a row a reviewer adds in Studio.
  *Rejected: one wide `cache` table with a `kind` column.* The three keys and value shapes
  differ, and three tables keep the Studio views and the grants plain.
  *Rejected: a separate suggestions table.* The flag does the same job with no second table.
- **Only verified rows are ever used, by anyone.** The parent selects `WHERE is_verified`; the
  lab's pull does the same. The app never writes `is_verified`, and the lab's role cannot.
- **First suggestion wins.** Every automatic write is `INSERT … ON CONFLICT (<key>) DO NOTHING`.
  To reject a suggestion, leave it unverified; to make the pipeline suggest again, delete it; to
  correct it, edit the category and tick the box.
- **Every writer must hand the tables what their checks accept**, because one rejected row
  fails its whole chunk. Products are stripped of Unicode whitespace as Python's `str.strip`
  does, matched case-sensitively, and at most `MAX_CACHE_KEY_BYTES` in UTF-8; a unit is kept
  verbatim under the same bound, since the lab joins on it exactly. Categories are trimmed and
  non-empty. A cleaned name or example list is null or not blank, so a blank one is written as
  null; a cleaned unit is never blank. A weight is positive and finite or null, so pandas's `NaN` is written as
  null. The entree label is the enum `entree_classification_label`: `entree` or `side/add-on`.
- **`category` is `text`, checked only for trimmed and non-empty.** The vocabulary is the
  library's YAML, and the child already drops a row whose category is not in it, with a WARNING.
  *Rejected: a Postgres enum or CHECK of category names.* It would need a migration before the
  YAML could change, and a mismatch would surface as a failing harvest insert at the worst
  moment. The entree label is the opposite case, two values the code owns, so it is an enum.
  **Open:** a reviewer's typo in Studio is today only a child
  WARNING naming the category; if that proves too quiet, a `gbd_category` reference table with
  an FK is the fix.
- **No FK from a cache row to `analysis_attempt`.** A cache row must outlive the report that
  suggested it (deleting an organization cascades to its attempts), and `suggested_by` holds the
  id for a reviewer who wants to look the upload up. *Rejected: `verified_by`.* Nobody will type
  it in Studio; `verified_at` plus Supabase's own dashboard audit is enough.

### The product: materialize per claim, harvest after the verdict

- **The parent reads the verified rows once per claim and writes them into the run directory as
  `input/categorization-cache.json`.** A read that fails after `retryOnTransientDbError` fails
  the attempt as `infrastructure`, like any other input it could not load. *Rejected: running
  with an empty cache instead.* That silently pays a full LLM pass and contradicts
  `absorb-or-fail` in `failures.ts`. *Rejected: an in-process copy with a TTL.* Reviewers edit
  in Studio at any time, the query is a few milliseconds against a run that takes minutes, and a
  per-claim read is one fewer thing to reason about.
- **JSON, not CSV, across the seam.** Both halves already have strict JSON parsers, writers,
  fixtures and atomic writes, and golden products contain newlines, quotes and commas. The
  child parses the document and hands the library plain rows: `analysis.py` promises the library
  never sees a contract document, and a bad one is a `contract_violation` the child classifies.
- **The child writes `output/new-categorizations.json` before `result.json`**: the products the
  LLM categorized this run, with the LLM's cleaned name and its answer, `No Matches Found`
  included — negative results are most of the cache: the `match_type == "llm"` products, which
  the lab pushes too (PR 6). *Rejected: harvesting cleaned-name-history hits
  too.* The pipeline already trusts those without review; suggesting them would fill the queue
  with rows nobody needs to look at, at the price of one name-cleaning call per run.
  *Rejected: carrying the rows inside `result.json`.* A table does not belong in a document the
  parent parses into a row.
- **The parent inserts the harvest after the verdict is recorded, and a harvest failure never
  changes the verdict.** `deliverVerdict` calls the insert only when `recordVerdict` returns
  `won`, under the same `retryOnTransientDbError`; if it still fails, it logs at `error` and the
  attempt stays `succeeded`. A lost race writes nothing. *Rejected: the insert inside the
  `markAttemptSucceeded` transaction* (this plan's earlier draft). The cache must never decide a
  paid-for report's fate, and a future constraint, trigger, or reviewer-caused oddity on this
  table would otherwise fail delivery of a finished report. A lost suggestion costs one LLM call
  on a later run.
- **The document is required on success.** Exit 0 without it, or with a malformed one, is
  `contract_violation`, the same rule as the result files. `stub_analysis` returns no rows, so
  `WORKER_MODE=stubbed` and every existing test write `{"rows": []}` unchanged.
- **No `WORKER_CONTRACT_VERSION` bump.** Parent and child ship in one image, so the run-directory
  change is atomic, and the one schema the worker newly writes is additive and deployed by the
  web side first (`ARCHITECTURE.md` § Worker deploys only on demand).

### Local development: the same cache as production

- **`CACHE_DB_CONNECTION_STRING` points the worker parent's cache reads and writes at another
  database.** Unset, they go through the worker's own handle, which is production's
  configuration and needs no new secret. A developer sets it to the hosted project as
  `cache_client`, and their `live` runs then start from the verified cache and suggest back to
  it, exactly as the fleet does — a local run is a production call with the same model. Reports,
  attempts and files stay in the local stack; only the cache is shared. One startup log line says
  which database the cache is.
  *Rejected: pointing `DB_CONNECTION_STRING` at production.* The worker would claim real
  attempts. *Rejected: pulling the verified rows into the dev database and pushing harvests
  back.* A second mechanism, and a local run's suggestions would sit unreviewed until someone
  remembered to push.
- **Honored only in `live`.** `resolveWorkerMode` refuses to start `mock-llm` or `stubbed` with
  the variable set, naming the reason: a keyword categorization in a shared cache would block
  the real LLM's suggestion for that product forever, since the first suggestion wins. Those
  modes keep the cache in the local database, read and written, which is what the by-hand check
  in § Verification relies on.
- **It is the same variable and the same role the lab uses**, so a developer who also runs the
  lab holds one credential, and a harvested row's `suggested_by` carries the worker id after
  the attempt id, so a reviewer can tell a laptop's run from the fleet's — a laptop's attempt id
  is not in production's `analysis_attempt`.

### A role that can read and suggest, nothing more

- **`cache_client` can read the three tables and insert suggestions, nothing else.** Its
  `INSERT` is column-level, on the key, the values and `suggested_by` only, so every row it
  writes lands unverified with the table's own id and timestamps, and a writer that names any
  other column gets `42501`. It has a statement timeout and an idle-in-transaction timeout, the
  latter so an abandoned transaction holding an uncommitted suggestion cannot block every other
  insert of that key, a production harvest's included; so the lab's `connect()` (PR 5) uses
  autocommit or short transactions.
  *Rejected: read-only.* Then every new row the lab produces would reach the database by hand,
  which is the sync problem this plan exists to end. *Rejected: letting the role verify rows in
  the lab-only tables.* One rule for three tables is easier to hold; revisit if ticking entree
  rows in Studio turns out to be the bottleneck.
- **Its connection limit is 10, and an idle session closes after 10 minutes.** The limit keeps
  the role from starving the production web and worker of the project's shared connections, and
  does nothing for security, which is the grants' job. Ten covers the realistic peak: two data
  scientists with a kernel or two and a runscript each, plus a developer's lab and `live`
  worker, about 6–9. A lower limit would raise `53300 too many connections for role` whenever
  someone has a few notebooks open. The idle-session timeout keeps a forgotten kernel from holding
  a slot indefinitely, which is what would otherwise exhaust any limit over a week. So every
  client of the role opens connections briefly: the worker's cache pool keeps none open while
  idle (PR 2), and the lab connects per command (PR 5). Raising the limit is a one-line
  `ALTER ROLE` migration, if the team grows.
  *Rejected: a limit of 3–5, about one per person.* One person routinely holds several
  connections at once.
- **A human sets its password once, in the hosted SQL editor** (`ALTER ROLE cache_client
  PASSWORD '…'`), so no secret is ever in a migration. A data scientist's or a developer's
  credential is composed, not copied: the session-pooler string from the dashboard's Connect dialog with `postgres.<ref>` replaced by
  `cache_client.<ref>` and the password by the role's. Neither sees the `postgres` password, and
  the string they hold can read three tables and insert unverified rows into them, nothing else.
  *Rejected: giving the data scientists `DB_CONNECTION_STRING`.* It is `postgres`, and an agent
  with it can drop a table. *Considered: Supabase's temporary access*, where a dashboard member
  assumes a Postgres role with their own token as the password, with an expiry and IP allowlist. It needs the person to
  be a dashboard member, which on Free and Pro means Developer and so the SQL editor anyway, and
  its plan availability is undocumented. Worth revisiting if GBD is ever on Team.
- **The hosted path is unproven, so prove it before migrating production** (§ Go-live step
  1), in ten minutes against the real project with a throwaway role: `CREATE ROLE smoke LOGIN
  PASSWORD …` in the SQL editor, `GRANT SELECT` on an existing table, then from a laptop `psql`
  to the session pooler as `smoke.<ref>`; confirm a `SELECT` works and an `UPDATE` and a
  `SELECT` from `report` fail with `42501`; then `DROP ROLE`. `002_caches` grants no `USAGE ON
  SCHEMA public`, because `PUBLIC` holds it on both local stacks; if the smoke test's `SELECT`
  fails on the schema rather than the table, add that grant in a new migration before migrating
  production. If the pooler
  refuses a custom role after all, the fallbacks are the direct connection (IPv6, or the IPv4
  add-on) with the same role; the `postgres` string is the last resort, not the first.
- **The lab reads the worker's `CACHE_DB_CONNECTION_STRING`, never `DB_CONNECTION_STRING`.**
  For the data scientists it is `cache_client.<project-ref>` on the session-mode pooler; a
  developer uses one string for the lab and `pnpm dev:worker` alike, or points it at the local
  dev stack as `postgres`. Unset, every lab command works exactly as today, on whatever CSV is
  on disk, with a WARNING naming the variable and the file's age.
- **`pull` writes the verified rows to the three CSV paths the loaders read today**, atomically,
  with today's column names (`cleaned_item_names`, `llm_cleaned_unit`, …) mapped at the
  boundary. So every loader, runscript, notebook and `LLM_testing.py` is unchanged, runs work
  offline, and a data scientist can still open the file. The categorize runscript pulls at
  start when the variable is set, so freshness needs no discipline. *Rejected: loaders that
  query the database directly.* Every step-1 run would need the network and a credential, the
  gitignored notebooks that call `load_categorization_cache()` would change behaviour, and it
  makes the lab harder to test for no gain over "pull first".
- **`push` inserts new rows unverified, and the lab's local cache writes go away.** Step 1
  pushes the products its LLM categorized — `CategorizedProducts.new_categorizations`, the rows
  the worker harvests, cleaned names included — and, for serving data, the Gemini-labelled
  products instead of appending them to the entree file; the weights step pushes instead of
  rewriting the weights file. Verification for all three happens in Studio, one place, by
  whoever holds dashboard access, which is what `REQUIREMENTS.md` asks for and what the data
  scientists' AI-assisted workflow needs. *Rejected: pushing a hand-reviewed
  `_for_human_review.csv`* (this plan's earlier draft; the file and its promotion step are
  gone). First suggestion wins, so a correction made in the file is silently dropped whenever
  the product is already in the table — from a worker harvest, or from an earlier push of the
  same file — and the file carries no cleaned name. Corrections happen in Studio.
  **Open:** who verifies. On Free and Pro plans every dashboard role that can see data can also
  run any SQL, so dashboard access is full database access, and the reviewer is a human
  decision, not a role this plan can create. The data scientists' scripted path is `cache_client`
  either way; whether one of them is also the reviewer is the call. Studio edits one cell at a
  time; bulk verification is an `UPDATE` in the SQL editor.
- **The analysis library stays free of any database client.** `psycopg` is a lab dependency
  only; the lab is where the sync code lives.

### Open-source contributors

Nothing here needs GBD's data. A fresh clone runs the whole app against its local Supabase with
an empty `product_categorization`, exactly as a missing CSV behaves today; the system e2e runs
the same way; a `live` worker without `CACHE_DB_CONNECTION_STRING` keeps its cache in the local
database, read and written; the lab without it is the lab of today. The lab's push and pull
against a local stack work as `postgres`.

*Rejected: encrypting the CSVs into git.* A multi-megabyte blob per review round is neither
diffable nor mergeable, key rotation rewrites history, and the data scientists need the database
for the product's cache anyway, so it would leave two mechanisms where one does.

### Reviewing in Studio

Not an app feature; recorded here so the table comments and READMEs say the same thing. Filter a
table on `is_verified = false`, order by `created_at`, read `suggested_by` for where a row came
from, fix `category` (or the label, or the weight) in place, tick `is_verified`. The next worker
claim, and the next lab pull, see it.

## PR 1 — temporary go-live import script

**Temporary.** It loads GBD's three CSVs into the tables once, at go-live (§ Go-live step 2), and
PR 1b deletes it as soon as that import is checked. After that the hosted tables are the source
of truth, and rows only reach them through the worker's harvest, the lab's push, or Studio. Every
name says so, even at the cost of length, so nobody mistakes it for a sync tool or builds on it.
*Rejected: keeping it as a permanent seeding tool.* Nobody outside GBD has the CSVs, a fresh
clone works with an empty cache, and a developer who wants real rows points
`CACHE_DB_CONNECTION_STRING` at the hosted project. A CSV that turns up later can be loaded by
restoring the script from git history.

Everything lives in one directory, `packages/db/scripts/temporary-go-live-cache-import/`, so the
deletion is one directory and one `package.json` line. Nothing goes in `packages/db/src/` or
`@gbd/db`'s exports, and no README mentions it. Each file opens with a header naming this plan and
saying the directory is deleted after go-live.

- `csv.ts`: a ~40-line first-party RFC 4180 reader (quoted fields, `""`, embedded newlines; BOM
  and line endings normalized; malformed quoting throws), header by name. Not lifted from
  `apps/web/.../csv/read/`, which is tuned for validation and the browser.
- `clean.ts`: pure functions from CSV records to table rows plus a list of skips, each with its
  line number and reason. This is where the import cleans beyond what the data scientists'
  updated file already does. Product cleaning mirrors `from_frame`:
  - Strip the product and the category. JavaScript's `trim` agrees with the tables' checks.
  - Skip blank products and blank categories.
  - Let a later duplicate win, and report a duplicate whose category differs from the earlier
    one separately from an identical repeat.
  - Check each category against the names in
    `python/insights/.../data_files/GBD_categories.yaml` plus `No Matches Found`, taking the
    names from its top-level `- name:` lines, since adding a YAML dependency is not worth it for
    a script that will be deleted. A category that matches a name case-insensitively is
    rewritten to it. Any other unknown category makes the import refuse, listing each one with
    its count and first line, to be fixed in the CSV. Imported as is, a misspelled verified row
    would block that product's suggestion forever while the child drops it on every run.
  - Never trim `cleaned_name`, and turn a blank one into null. Import a cleaned name equal to its
    product unchanged: it is harmless to the cleaned-name index and not ours to rewrite.

  The entree import normalizes labels the way `_normalize_entree_classification` does. The two
  spellings in the file are already canonical. The unit import keeps the unit verbatim and maps
  a blank weight or example to null. CSV columns map to the table's at the boundary:
  `entree_classification` → `classification`, `llm_cleaned_unit` → `cleaned_unit`,
  `llm_extracted_weight` → `extracted_weight`, `cleaned_item_names` → `cleaned_name`.
- `upsert.ts`: one upsert per table in chunks of 1,000, for example `ON CONFLICT (product) DO
  UPDATE SET category, cleaned_name, is_verified = true, suggested_by WHERE NOT
  product_categorization.is_verified`. A re-run never clobbers a reviewer's edit but does promote
  an unverified harvested suggestion to the golden value (§ Go-live step 3).
- `main.ts`, run as `pnpm --filter @gbd/db temporary-go-live-cache-import <product|entrees|units>
  <csv> [--write]`: one `withTransaction`, `suggestedBy = import:<basename>`. It prints the skip
  report and the counts (inserted, promoted, left alone because already verified). Without
  `--write` it rolls the transaction back, so a dry run against production reports exactly what
  the real run would do and can go back to the data scientist before anything is written. It
  reads `DATABASE` from `src/env.ts`, so `TEST_DB=1` and `DB_CONNECTION_STRING` behave as for
  `migrate`.
- Tests, colocated in the directory (vitest and `tsconfig.json` already cover `scripts/`):
  - the reader on the three awkward shapes;
  - the cleaners: whitespace, blank skips, both kinds of duplicate, the case-insensitive category
    rewrite, refusal on an unknown category, and the name extraction against the real YAML;
  - the upsert: inserts new rows, promotes an unverified row, leaves a verified edit alone,
    writes nothing on a second run, and chunks 1,001 rows;
  - a dry run writes nothing.

## PR 1b — delete the temporary go-live import script

Lands as soon as § Go-live step 2's checks pass, independent of PRs 2–6. It deletes the
directory and its `package.json` script, and removes PR 1 and this PR from this plan.

## PR 2 — contract: cache document in, parent materializes per claim

Both halves plus `contract/`, per `contract/README.md`. The library gains the request field but
ignores it until PR 3, so this PR changes no report.

- `contract/contract.json`: `runDirectory.categorizationCache: "input/categorization-cache.json"`.
  Shape `{"rows": [{"product", "category", "cleanedName": string | null}]}`. Valid fixture:
  three made-up rows, one `No Matches Found` with a null cleaned name, one with `\n`, `"` and
  `,` inside the product. Invalid fixtures, one violation each: `unknown-field`,
  `rows-is-an-object`, `row-unknown-field`, `blank-product`, `cleaned-name-is-a-number`,
  `missing-rows`.
- TypeScript: `contract/layout.ts` (plus its header diagram), `contract/messages.ts`
  (`CategorizationCacheSchema`, a valibot `strictObject` with no trimming;
  `buildCategorizationCache`; `parseCategorizationCache` for the fixture test),
  `child/run-directory.ts` (`writeCategorizationCache`).
  `packages/db/src/product-categorization.ts` (new): `listVerifiedProductCategorizations(db)` —
  `SELECT product, category, cleaned_name WHERE is_verified ORDER BY product`; note the
  `EXPLAIN ANALYZE` in the PR per the db README's convention.
  `attempt/lifecycle.ts` `startAttempt`: the query beside `loadAttemptInputs`, under the same
  retry, before any filesystem work; the write beside `writeManifest`.
  `AttemptDependencies` gains `cacheDb: DatabaseExecutor`, the only handle the cache query uses.
  `main.ts` builds it from `CACHE_DB_CONNECTION_STRING` when set, with `minConnections: 0` and
  `maxConnections: 2`, because the role's 10 connections are shared by everyone who holds it
  (§ A role that can read and suggest); else it passes
  `WORKER_DATABASE`, and logs which at startup; `resolveWorkerMode` takes the variable and throws
  for any mode but `live`. `.env.example` gains the variable with its two forms; the root
  `README.md` § Analysis modes `live` row and `apps/worker/README.md`'s variable table say what
  it does.
- Python: `contract/layout.py`, `contract/fields.py` (`objects(key)` → `list[Fields]` at
  `rows[i]`), `contract/messages.py` (`read_categorization_cache(run_directory)`), `run.py`
  (read after the manifest, pass on the request). `analysis.py` gains
  `CachedCategorization(product, category, cleaned_name: str | None)` and
  `AnalysisRequest.categorization_cache: tuple[CachedCategorization, ...]`; `stub_analysis`
  ignores it, every `_request()` helper and `tests/support/child.py` carry it, and the
  `run_directory` fixture writes the valid fixture into `input/`.
- Tests: `lifecycle.test.ts` seeds one verified and one unverified row with
  `insertProductCategorization` (committed, so deleted in a `finally`; `withCommittedFixture`'s cleanup is keyed on organizations, which
  these rows are not), parks a fake child on a sentinel, reads the document, and sees only the
  verified row; `breakableDatabase` broken after the claim gives `infrastructure` and no spawned
  child; `modes.test.ts` covers the variable with each mode. Python: `test_fixtures.py` (the valid fixture parses to the expected tuple, newline row
  included; every invalid fixture is rejected), `test_run.py` (missing document →
  `contract_violation` and no `result.json`; malformed → `contract_violation`; a recording
  `analyze` receives the parsed rows), `test_library_agreement.py` (the child's row type is the
  library's).
- Docs: `ARCHITECTURE.md` § Worker step 3 and a new `### Categorization caches` subsection with
  the materialize-per-claim rule and its two rejections; `contract/README.md`.

## PR 3 — library: consume the request rows, drop the packaged CSV

The first PR that changes what a production run does. After it, the table is the product's
cache and the worker image needs no file.

- `categorization/cache.py`: `CategorizationCache.from_rows(rows)` beside `from_frame`, the one
  place the seam's `cleaned_name` meets the library's `cleaned_item_names`; it drops an unknown
  category with the same WARNING, since a reviewer's typo must not fail every run.
  `categorization_cache_path`, `read_categorization_cache_csv` and `load_categorization_cache`
  move to a new lab module, `categorization/product_cache.py`, with their tests; `entree_cache.py` and
  `experiments/LLM_testing.py` import from there.
- `analyze()`: `CategorizationCache.from_rows(request.categorization_cache)`, and no file read.
  `test_analysis.py`'s `cache_path` fixture and its cache-hit test pass rows on the request.
- The file paths: `.worktreeinclude` names the lab's copy of the product CSV (`.gitignore`'s
  glob already covers it); `python/insights/.../data_files/README.md` loses the cache; the lab's
  gains it;
  the root `README.md` paragraph about getting the CSV from GBD becomes a pointer to
  `python/lab/README.md`; `analysis.py`'s cache **Open** is deleted; `deploy-safety.md`
  § Before launch drops its cache bullet.

## PR 4 — contract: new-categorizations document out, parent harvests

- `contract/contract.json`: `runDirectory.newCategorizations: "output/new-categorizations.json"`
  and `categorization.maxProductBytes: 2000` (TypeScript imports `MAX_CACHE_KEY_BYTES` from
  `@gbd/db`; both sides assert the contract value). Shape `{"analysisAttemptId", "rows":
  [{"product", "cleanedName": string | null, "category"}]}`, rows unique by product, nothing
  blank, product stripped and within the byte bound — the same rules the table checks
  (§ Decisions), so a harvest insert never fails on a row the parser let through. Invalid fixtures: `unknown-field`,
  `duplicate-product`, `blank-category`, `missing-rows`, `analysis-attempt-id-not-a-uuid`,
  `product-over-max-bytes`, `product-not-stripped`.
- Library: `categorization/pipeline.py` gains `NewCategorization(product, cleaned_name,
  category)` and `CategorizedProducts.new_categorizations: tuple[NewCategorization, ...]`, which
  `categorize_unique_products` fills from `unique_products_df` where `match_type == "llm"`, with
  that frame's `cleaned_item_names` — one definition of "new" for the worker and the lab's push
  (PR 6). It lives under `categorization/`, not `analysis.py`, because `analysis.py` imports the
  pipeline. `AnalysisOutcome.new_categorizations: tuple[NewCategorization, ...] = ()`, which
  `analyze()` passes through; `stub_analysis`'s default keeps every existing caller writing
  `rows: []`.
- Python: `layout.py`, `names.py` (`MAX_PRODUCT_BYTES`), `messages.py`
  (`new_categorizations_payload`, validating before anything touches disk, and writing a blank
  LLM cleaned name as null rather than failing the report on it), `run.py`: build the
  payload → `place_result_files` → write the document → write `result.json`, extending the
  "ordering is load-bearing" comment. `tests/support/child.py` gains `newCategorizations` and
  `withoutNewCategorizations`.
- TypeScript: `layout.ts`, `messages.ts` (`NewCategorizationsSchema`), `run-directory.ts`
  (`readNewCategorizations`); `verdict.ts` — the `succeeded` verdict carries the rows and
  `classify` requires the document, else `contract_violation`; `lifecycle.ts` `readChildEnding`
  reads it in the same `try` as `result.json`. `packages/db/src/product-categorization.ts`:
  `insertSuggestedProductCategorizations(db, rows, {suggestedBy})`, `DO NOTHING` in chunks of
  1,000, naming only the columns `cache_client` may insert, since a developer's worker writes
  through that role. `lifecycle.ts` exports `harvestSuggestions(dependencies, attempt, rows)`: through
  `cacheDb`, with `suggestedBy` naming the attempt and then the worker id, the retry, the `error`
  log on exhaustion, never a throw; `deliverVerdict` calls it after `recordVerdict` returns
  `won`. `testing/fake-child.ts`'s `result` step gains `newCategorizations` (default
  `[]`) and `withoutNewCategorizations`.
- Tests: `verdict.test.ts` (result present, document missing → `contract_violation`);
  `harvestSuggestions` directly — rows land with `isVerified false` and a `suggestedBy` naming
  the attempt and the worker, a pre-existing verified row is untouched, 1,001 rows chunk, a broken database
  resolves with an `error` log and no throw; `lifecycle.test.ts`'s end-to-end success asserts the
  rows landed, `withoutNewCategorizations` → `contract_violation` with no `result_file` and no
  cache rows, and the lost-race test asserts zero cache rows. Python: `test_run.py` (the stub
  writes `rows: []`; scenario rows appear verbatim; a duplicate product → `contract_violation`),
  `test_fixtures.py`, `test_contract.py`, `test_pipeline.py` (the full-pipeline test asserts
  `new_categorizations`: the LLM rows only, cleaned names included), `test_analysis.py` (the
  golden run harvests nothing;
  a keyword run harvests exactly the LLM-categorized products with the keyword client's cleaned
  names, `No Matches Found` included). Optionally one assertion in
  `tests/e2e/specs/report-lifecycle.e2e.ts` that `beef` reached the run database unverified —
  the one tier where the real child meets the real parent.
- Docs: `ARCHITECTURE.md` step 5 and the caches subsection (harvest after the verdict, first
  suggestion wins, the rejection of the in-transaction insert); `REQUIREMENTS.md` § Product
  categorization cache (review happens in Studio; negative results are cached);
  `packages/db/README.md` (who writes the table); `contract/README.md`.
- Verify with both gates and `pnpm test:system`.

## PR 5 — the lab pulls

- `python/lab/pyproject.toml` gains `psycopg[binary]` (check its Python 3.14 wheel at PR time).
- `gbd_foodservice_insights_lab/cache_sync.py`: `connect()` reading `CACHE_DB_CONNECTION_STRING`
  via the lab's existing dotenv loading, in autocommit (§ Decisions: the role's idle timeouts).
  Each command opens its own connection and closes it on the way out, never one held in a
  notebook global, which the role's idle-session timeout would close after 10 minutes.
  `pull(connection)` selecting the verified rows of each
  table and writing the three CSVs through a temp file and rename, column names mapped to what
  the loaders expect (`cleaned_name` → `cleaned_item_names`, `classification` →
  `entree_classification`, `cleaned_unit` → `llm_cleaned_unit`, `extracted_weight` →
  `llm_extracted_weight`), `""` for a null; the pure frame-building functions separate
  from the connection so they test without a database. `python -m
  gbd_foodservice_insights_lab.cache_sync pull`, and `just pull-caches`.
- The categorize runscript pulls first when the variable is set, and otherwise logs one WARNING
  with the variable's name and each file's age; step 0.5 reaches it through step 1 unchanged.
  The loaders themselves do not change.
- Tests: the frame builders; a `db`-marked round trip (`pytest` marker added to the root
  `pyproject.toml`) that runs when `CACHE_DB_CONNECTION_STRING` is set — random keys, deleted in
  `finally`, since the test stack is shared across worktrees — and the runscript's pull-or-warn
  branch through `test_runscript.py`'s module-loading pattern. CI: the `py-lab` job gains
  `setup-node`, `setup-supabase` and `TEST_DB=1 pnpm migrate`, and sets the variable to the test
  stack's `postgres` URL from `.env.test`; `.github/filters.yml`'s `python_lab` filter stops
  excluding `packages/db/migrations/**`, so a schema change reruns the round trip on the PR and
  not only on `main`.
- `.env.example`'s `CACHE_DB_CONNECTION_STRING` comment, added in PR 2, now names the lab too.
  `python/lab/README.md`:
  the "handed out privately" paragraph becomes pull, with the hosted username format; the lab's
  `data_files/README.md` says the files are pulled, never committed.

## PR 6 — the lab pushes, and stops writing its files

- `cache_sync.py`: `push_product_categorizations(connection, frame, suggested_by)`,
  `push_entree_classifications`, `push_unit_weights` — `INSERT … ON CONFLICT DO NOTHING` in
  chunks, columns mapped back, naming only the columns `cache_client` may insert. Each
  validates against the tables' rules in § Decisions before sending anything: stripped keys
  within the byte bound, blank values and `NaN` weights as null.
- `spreadsheet.py`: step 1 pushes `categorized.new_categorizations` through
  `push_product_categorizations` and, for serving data, the Gemini-labelled products through
  `push_entree_classifications`, both as `lab:<getpass.getuser()>`. One `push_suggestions` flag
  replaces `update_historical_entree_classifications`: on by default when the connection is
  configured, skipped with a WARNING when not. Turning it off is how a prompt experiment keeps
  its answers out of the table, where the first suggestion would block the real one.
  `entree_cache.py`: `save_historical_entree_classifications` goes. `entrees.py`:
  `build_entree_human_review_table` and the `_entree_for_human_review.csv` it feeds go, for the
  reason the product one is gone; the backfill script and
  `build_entree_cleaned_name_reuse_index` are unchanged. `clean_product_weights.py`: `expand_historical_weight_classifications` pushes
  instead of rewriting the file; the 1.5 runscript's commented call is renamed to match.
- Tests: the row mappers and validators; a `db`-marked round trip that a push lands unverified
  and a second push of the same keys writes nothing; `test_spreadsheet.py`'s serving test asserts
  the push, not a file write, and a test with `push_suggestions=False` asserts no push.
- `python/lab/README.md` § Working on a client: step 1 suggests its new answers, someone
  verifies them in Studio, and the next pull brings the verified rows down.
  `REQUIREMENTS.md` § Product categorization cache names the lab's two caches under the same
  rule. This PR deletes this plan.

PRs 1–4 and 5–6 are two chains, and they interleave freely.
2 and 3 can merge into one PR if the reviewer prefers one behaviour change over two commits; so
can 5 and 6.

## Failure paths

| Situation | Result |
| --- | --- |
| Cache read fails in `startAttempt` after retries | `failed('infrastructure')`; no child spawned |
| Child fails, crashes, is killed, or is canceled | no harvest |
| Exit 0, `new-categorizations.json` missing or malformed | `failed('contract_violation')` |
| Verdict recorded, harvest insert fails after retries | `succeeded` stands; one `error` log line; the products cost an LLM call next time |
| Lost the reaping race | zero-row verdict update, nothing written, no harvest |
| Two attempts suggest the same product | the second `DO NOTHING` waits on the first's tuple, then skips |
| Reviewer types a category not in the YAML | the child drops the row with a WARNING; the product goes to the LLM, and its suggestion is skipped because the row exists |
| Reviewer deletes a row | the next run suggests it again, unverified |
| `CACHE_DB_CONNECTION_STRING` set with `mock-llm` or `stubbed` | the worker refuses to start, naming the reason |
| A `live` worker without `CACHE_DB_CONNECTION_STRING` | the cache is the worker's own database, read and written; one startup log line says so |
| Lab push names `is_verified` | `42501` from the role; the push code never does |
| All 10 of `cache_client`'s connections are in use | the next connection fails with `53300`; the production web and worker are unaffected |
| A notebook leaves a connection idle for 10 minutes | the server closes it; the next lab command opens a new one |
| Data scientist runs without `CACHE_DB_CONNECTION_STRING` | today's behaviour on today's file, plus a WARNING with the file's age |

## Go-live

Hand-run until `deploy-migrations.md` lands, against the session-mode pooler URL with
`DB_CONNECTION_STRING` set for the one command. If that plan lands first, its first deploy applies
`002_caches`, the first incremental migration to reach the hosted database through the pipeline
— the rehearsal that plan asks for — and step 1's migrate is that deploy. Either way, the hand-run migrate and
the import both connect through `buildPoolConfig`, so the pooler's acceptance of its startup
`options` (`deploy-migrations.md` § Connectivity) is checked once, by whichever runs first.

1. Run the smoke test in § A role that can read and suggest; then `pnpm --filter @gbd/db
   migrate` against prod (additive; the running worker is unaffected); `ALTER ROLE cache_client PASSWORD '…'` in the SQL editor; compose your own
   `CACHE_DB_CONNECTION_STRING` from the Connect dialog's session-pooler string with
   `cache_client.<project-ref>` and that password, and check it from a laptop with `psql`.
2. Merge PR 1. From a workstation, dry-run each of the three CSVs against prod; take any
   refused category or surprising skip back to the data scientist and repeat until the report is
   clean; then run each with `--write`. Check each count against the CSV's rows minus the
   reported skips and duplicates, and spot-check a `No Matches Found` row and a multi-line
   product in Studio. Then merge PR 1b.
3. Merge PRs 2–4 and dispatch a worker deploy. If 2 is deployed before the import, the parent
   writes `{"rows": []}` and the run costs LLM calls, nothing more; if 4 lands before the import,
   the import's `DO UPDATE … WHERE NOT is_verified` later promotes any harvested rows the CSV
   knows. From here, every developer's `live` worker runs with `CACHE_DB_CONNECTION_STRING` set.
4. Merge PRs 5–6; hand each data scientist the same composed string, checked with `psql`
   first (if the project ever turns on network restrictions, their addresses need allowing);
   they set `CACHE_DB_CONNECTION_STRING`, pull once, and delete
   their hand-copied files. `.worktreeinclude` keeps copying the pulled files into new
   worktrees, now a convenience rather than the only way to get them.

## Verification

Each PR: `pnpm lint && pnpm check && pnpm test` and `just lint && just check && just test`, plus
`just test-lab` for 3, 5 and 6 and `pnpm test:system` for 2 and 4. Then by hand, on `mock-llm`:
an upload of `apps/web/sample-reports/valid.csv` produces unverified `product_categorization`
rows with `suggested_by = attempt:<id>`; in Studio, change one row's category to something the
keyword fake would never answer and tick `is_verified`; a second upload of the same file reports
that product under the new category in its workbook, which only a cache hit can explain (the
child logs at WARNING, so the match-type counts are not visible from the worker). On `live`
with `CACHE_DB_CONNECTION_STRING` at the hosted project: a local upload's new products appear in
production's Studio unverified, with the laptop's worker id in `suggested_by`, and the same
variable under `mock-llm` stops the worker at startup. On the lab:
`just pull-caches` writes three files whose row counts match the verified counts in Studio; a
step 1 run's new categorizations appear in Studio unverified as `lab:<user>`; a second run of
the same file adds nothing.
