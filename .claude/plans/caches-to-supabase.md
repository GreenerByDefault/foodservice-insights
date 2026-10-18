# Caches to Supabase

## Context

Three caches today, all gitignored CSVs handed around by hand:

| Cache | File | Rows | Read by | Written by |
| --- | --- | ---: | --- | --- |
| Product categorization | `python/lab/.../data_files/previously_categorized_items.csv` | 38,692 | the lab (step 1, `LLM_testing.py`, the entree backfill) | nothing in the repo since the lab's review-and-promote path was deleted; copies are handed out by hand |
| Entree classification | `python/lab/.../data_files/previously_classified_entrees.csv` | 1,989 | the lab, serving mode only | the lab, **automatically**, with Gemini's unreviewed labels (`spreadsheet.py` → `save_historical_entree_classifications`) |
| Unit weight | `python/lab/.../data_files/previously_classified_weights.csv` | 893 | the lab, step 1.5 | the lab, by hand (`expand_historical_weight_classifications`) |

This plan moves all three into Postgres, with one rule: **a row is used only once a human has
verified it in Supabase Studio.** The worker parent materializes the verified product rows into
each run directory at claim time, so a long-lived worker always runs the latest review; the child
returns what its LLM categorized and the parent inserts those rows unverified; the lab, and a
developer's `WORKER_MODE=live` worker (the real analysis, categorized by OpenAI), read the same verified rows and suggest to the same table through a
database role that can do nothing else. The analysis library never touches the database.

Facts that shape the design (the tree as of 2026-10-18, and what GBD has said):

- **The library is already a reader.** #400 deleted every product-side write;
  `categorize_unique_products` takes a `CategorizationCache` (#423) built by `from_frame`, which
  strips products, drops blank products, drops rows whose category is outside the YAML list,
  keeps the *last* duplicate, and warns per reason (#455, #475). `analyze()` builds it with
  `CategorizationCache.from_rows(request.categorization_cache)`, which goes through `from_frame`
  and so drops a reviewer's unknown category with the same WARNING, and reads no file. Only the
  lab still calls `load_categorization_cache()`, which with the CSV reader lives in
  `categorization/product_cache.py`. `AnalysisOutcome.new_categorizations` is how the
  products the LLM categorized leave it.
- **The parent is long-lived and claims per attempt** (`worker.ts` → `startAttempt`), so a
  per-claim query is the simplest way to always see the latest verified rows.
- **The worker's own database handle** (`WORKER_DATABASE` in `apps/worker/src/db.ts`, from
  `DB_CONNECTION_STRING`) is the dev stack locally. So, without more, a developer's
  `pnpm dev:worker` with `WORKER_MODE=live` would read an empty local cache and bury its real OpenAI
  categorizations in a database nobody reviews. `live` on a laptop is the same model and the
  same prompts as production; `mock-llm` (the real analysis, a keyword list instead of OpenAI) is a keyword fake whose answers must never reach a
  shared cache.
- **The worker has a separate handle for the cache.** `AttemptDependencies.cacheDb` (threaded from `WorkerDependencies.cacheDb` in
  `createWorker`) is the only handle the cache queries may use. `resolveWorkerMode` takes
  `CACHE_DB_CONNECTION_STRING` and returns `cacheDatabase: CacheDatabase` (`modes.ts`): `{kind:
  'separate', connectionString, redacted}` in `live` with the variable set, otherwise `{kind:
  'worker', ignoredVariable}`, where `ignoredVariable` marks `stubbed` or `mock-llm` with it set.
  `main.ts` then builds the handle with `initializeCacheDatabase` (`db.ts`: `DEFAULT_LIMITS` with
  `minConnections: 0` and `maxConnections: 2`, `application_name` `worker-cache`, no `sslCa`) or
  passes `WORKER_DATABASE`; logs `cacheDatabase` on its `Worker started` line, as
  `user@host:port/database` or `worker`, never the password; and warns when the variable is
  ignored. An unparseable string fails startup without echoing it. Production's `.do/worker.yaml`
  does not set the variable, so the fleet's cache is its own `postgres` handle. The test
  harnesses pass their `db` as `cacheDb`, so a test that reads or writes the cache through
  either sees the same rows. `.env.example` carries the variable commented out, in its hosted
  `cache_client` form only, and warns on both variables that a production string never goes in
  `DB_CONNECTION_STRING`.
- **The worker image needs no cache file.** The product reads only what the parent materializes,
  so the gitignored CSV no longer matters to it. Until § Go-live step 2 the production table is
  empty, and a `live` fleet would send every product to the LLM.
- **No client-side database access and no RLS** (`ARCHITECTURE.md` § Supabase). Both local
  stacks also run with `[api] enabled = false`, so PostgREST is not a path for the lab either.
- **One connection string serves everything, as `postgres`**, and it is the string the Supabase
  dashboard hands out: full access. Nothing in this repo has yet connected to the hosted project
  as anything else. `cache_client` is the first custom role, and nobody has logged in as it on
  the hosted project, where it has no password yet.
- **The tables and the role exist on `main`**, and reach production through `deploy.yml` (below).
  `packages/db/migrations/002_caches.ts` creates `product_categorization`,
  `entree_classification` and `unit_weight`, the `set_verified_at()` trigger and `cache_client`;
  `public-schema.sql` has their columns and checks, and `tests/caches.test.ts` asserts every
  constraint and the role's exact privileges. `@gbd/db` exports `MAX_CACHE_KEY_BYTES` and the two
  product queries the parent will make:
  `listVerifiedProductCategorizations(db)` returns `{product, category, cleanedName}` for the
  verified rows ordered by product (`EXPLAIN ANALYZE` on 38,000 verified rows: an index scan on
  the unique `product` key, 5 ms), and `insertSuggestedProductCategorizations(db, rows,
  {suggestedBy})` takes rows of the same shape and runs `ON CONFLICT (product) DO NOTHING` in
  chunks of 1,000, naming only the columns `cache_client` may insert. Its test runs the insert
  under `SET LOCAL ROLE cache_client`, so a column the role cannot insert fails there, not on a
  developer's worker. `@gbd/db/testing` exports `insertProductCategorization`,
  `insertEntreeClassification` and
  `insertUnitWeight`, which name only the columns the role may insert.
- **The parent materializes the cache per claim, and the child hands it to `analyze()`.** `startAttempt`
  calls `listVerifiedProductCategorizations(cacheDb)` under its own `retryOnTransientDbError`
  right after `loadAttemptInputs` and before any filesystem work, so a read that still fails
  fails the attempt as `infrastructure` with no child spawned (the reasoning is a comment on that
  call); it writes the rows with `writeCategorizationCache` (`child/run-directory.ts`) beside
  `writeManifest`. `lifecycle.test.ts` § the categorization cache covers both. The child's
  `run.py` reads it after the manifest with `read_categorization_cache`
  (`contract/messages.py`); a missing or malformed document is a `contract_violation`.
- **The run directory's two cache documents are defined on `main`.** `contract/contract.json` names `input/categorization-cache.json` (parent →
  child, `{"rows": [{"product", "category", "cleanedName"}]}`) and
  `output/new-categorizations.json` (child → parent, `{"analysisAttemptId", "rows": [{"product",
  "cleanedName", "category"}]}`), with valid and invalid fixtures for each. The parent has
  `buildCategorizationCache(rows)`, which `writeCategorizationCache` calls, and
  `parseNewCategorizations`, which `readNewCategorizations` calls (`apps/worker/src/contract/messages.ts`).
  The child writes the second document: `run.py` builds it with `new_categorizations_payload`
  (`worker_child/contract/messages.py`) before placing any result file, so a row the contract
  refuses fails the run with no files left behind, then writes it before `result.json`.
  `CategorizedProducts.new_categorizations` holds the `match_type == "llm"`
  products with that frame's cleaned names, and is the one definition of "new" for the worker and
  the lab's push (PR 2); `analyze()` passes it through as `AnalysisOutcome.new_categorizations`,
  default `()`, which `stub_analysis` takes as a keyword. The child test double's scenario
  carries it as `newCategorizations`. The library's row types are `CachedCategorization`
  (`categorization/cache.py`) and `NewCategorization` (`categorization/pipeline.py`), both
  re-exported from `analysis.py`, which the child uses directly. Both sides of the new-categorizations document
  enforce every `product_categorization` CHECK — products stripped and at most
  `MAX_CACHE_KEY_BYTES` (`contract.json`'s `categorization.maxProductBytes`, pinned to it by
  test), categories stripped and non-empty, each product once — and the child's builder writes
  a blank cleaned name as null, so a harvest insert never fails on a row that parsed.
- **The parent requires the document and harvests it.** `readChildEnding` reads it with
  `readNewCategorizations` beside `result.json`, and `classifyVerdict` makes exit 0 without it
  a `contract_violation`, so the `succeeded` verdict carries the rows. `deliverVerdict` calls
  `harvestSuggestions` (`attempt/lifecycle.ts`) only once `recordVerdict` returns `won`, so a
  parked verdict harvests on the resume that lands it; it inserts through `cacheDb` with
  `suggested_by` `attempt:<uuid> <worker id>`, under the retry, and logs at `error` rather
  than throw. Every successful run, `mock-llm` included, now suggests its LLM's answers to
  whichever database `cacheDb` is. The TypeScript fake child's `result` step writes the
  document, `newCategorizations` defaulting to none, unless `withoutNewCategorizations`.
- **The production worker has never harvested, and its next deploy sets `WORKER_MODE=live`.** Its last deploy
  (2026-10-16, `509f916b`) reads the cache per claim but predates #622 and #627, so production's
  tables should hold no harvested rows; the interim import's `deleted` count confirms it.
  `.do/worker.yaml` now sets `WORKER_MODE` to `live`, with `OPENAI_API_KEY` from the `production`
  GitHub Environment through `deploy.yml`, so the next dispatched deploy is both the first `live`
  fleet and the first that harvests.
- **Hosted Supabase facts, from its docs on 2026-10-11.** A custom role is an ordinary
  `CREATE ROLE … LOGIN PASSWORD` that the SQL editor, running as `postgres`, may issue —
  Supabase's own roles post creates one that way; `postgres` is not a superuser but has the
  admin privileges that covers. Every process reaches the project over the direct connection,
  `db.<project-ref>.supabase.co`, with the IPv4 add-on and TLS
  ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Supabase), so a custom role logs in under its
  bare name, as on the local stacks. Dashboard roles: Owner, Administrator and Developer can all
  run arbitrary SQL;
  Read-Only, which runs SELECT only as `supabase_read_only_user`, exists on Team and Enterprise
  plans only. So on a Free or Pro plan, anyone who can open Studio can drop a table.
- **`deploy.yml` migrates the hosted project** on every push to `main`, so `002_caches` reaches
  prod without a hand-run step; what § Go-live hand-runs is everything else.
- **GBD's product CSV** (copy dated 2026-09-27): 23,505 of 38,692 rows are `No Matches Found`,
  so negative results are most of the cache's value; 20,008 rows have `cleaned_item_names` equal
  to the raw product, from old cache hits written back verbatim; 747 products carry surrounding
  whitespace; 2 contain newlines and 703 contain quotes; the longest is 435 characters; 106
  categories are blank and a few more are misspelled. The entree file has no whitespace problems;
  the weights file has 7 blank weights and 4 units with surrounding whitespace. A data scientist
  is sending an updated copy with new entries and some cleaning; the final import runs on that,
  so these counts will move. A local dry run of the import on the 2026-09-27 copy keeps 38,201
  rows, rewrites 6 whose category differs from a known one only in case, skips the 106 blank
  categories and 371 earlier repeats (11 with a different category), and refuses 14 rows across
  8 unknown categories (`na`, `Mlik`, `Plan-Based Mayo`, `Plant-Based Butter`, `Plant-Based
  Chocolate`, `Plant-Based Cream`, `Coconut milk`, `Stone Fruit`), which go back to the data
  scientist.
- **The interim copy is the 2026-09-27 copy, cleaned on 2026-10-18 by the cache's own rules.**
  Products are stripped; blank categories and earlier repeats of a product are dropped; the six
  case-only categories are corrected; `Mlik` becomes `Milk (Cow's milk)` and `Coconut milk`
  becomes `Almond/Coconut Milk`; and the other 12 refused rows are dropped. That is exactly what
  the import would load from the 2026-09-27 copy, plus those two rows: 38,203 products, with the
  entree and weight files unchanged at 1,989 and 893. Checked against a replica of `clean.ts`,
  every row of all three files imports, with nothing skipped, rewritten or refused. No product
  spans lines once stripped. Eric holds the copy.
- **A temporary go-live import script is on `main`**, in
  `packages/db/scripts/temporary-go-live-cache-import/` and nowhere else, so it never becomes a
  sync tool: until the final import it is how a developer loads the local cache (§ Go live on
  the interim copy), § Go-live runs it twice against production, following the directory's
  `README.md` — on the interim copy, then on the final one — and PR 3 deletes it. It loads any
  of the three CSVs
  as verified rows in one transaction, `import:<file>` in `suggested_by`, cleaning products as
  `from_frame` does and refusing a category outside the YAML's `cool_food_pledge_name`s (what
  `category_names()` returns, not the short `name`) unless it differs only in case. Its upsert
  promotes an unverified row and leaves a verified one alone, so a re-run never clobbers a
  reviewer's edit, and a second run of the same file writes nothing. Without `--write` it rolls
  back after printing what it would do. A local run
  takes `DB_CONNECTION_STRING` from `.env` and refuses any host but loopback; either way it
  refuses a connection string with query parameters, which could override the host or TLS; `--production`
  ignores the environment, needs a person at a terminal, reads the `postgres` connection string
  from a prompt that does not echo it, verifies TLS against `supabase-ca.crt`, and commits only after that person reads the counts and
  types `COMMIT`. A dry run of every local CSV on 2026-10-13 still refused the 14 rows above.
  `--mirror` deletes every row of each table it imports inside the same transaction, and its
  counts gain `deleted`; production's `COMMIT` prompt then says it replaces every row. Locally it
  imports around refused rows, listing them, so the local tables become exactly the file's usable
  rows; in production a refused row still stops it (`importsAroundRefusedRows` in `target.ts`,
  whose header says why production may delete). A dry run of the 2026-09-27 CSVs with `--mirror`
  on 2026-10-13 would have loaded 38,201, 1,989 and 893 rows.
- **GBD's final CSVs are still a week or two away** (as of 2026-10-18), and until production
  holds a cache the fleet cannot run `live`. Only GBD staff use the site until the final import,
  so production goes live now on the interim copy, and the final import replaces it (§ Go live
  on the interim copy).
- **The root `README.md` documents the hosted cache.** § The categorization cache gives a
  developer's steps and rules, and `.env.example`'s `CACHE_DB_CONNECTION_STRING` comment points
  there. They work once § Go-live step 4 hands out the strings.
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
  library's YAML (each category's `cool_food_pledge_name`), and the child already drops a row whose category is not in it, with a WARNING.
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
  the lab pushes too (PR 2). *Rejected: harvesting cleaned-name-history hits
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
- **Honored only with `WORKER_MODE=live`.** In `mock-llm` and `stubbed` the worker ignores the variable and
  logs one startup WARNING naming it: a keyword categorization in a shared cache would block
  the real LLM's suggestion for that product forever, since the first suggestion wins. Those
  modes keep the cache in the local database, read and written, which is what the by-hand check
  in § Verification relies on. `off` spawns nothing and ignores it silently. So a developer
  leaves the line in `.env` and switches modes with `WORKER_MODE` alone.
  *Rejected: refusing to start in those modes.* It protects nothing more, since the shared
  cache is untouched either way, and it makes every mode switch a two-line edit.
- **It is the same variable and the same role the lab uses**, so a developer who also runs the
  lab holds one credential, and a harvested row's `suggested_by` carries the worker id after
  the attempt id, so a reviewer can tell a laptop's run from the fleet's — a laptop's attempt id
  is not in production's `analysis_attempt`.
- **What an app developer who never opens the lab does**, which the root `README.md` § The
  categorization cache gives as steps:
  1. Ask whoever holds dashboard access (Eric, until the **Open** on who verifies is
     settled) for the composed `cache_client` string, delivered the way `OPENAI_API_KEY` is,
     never in a chat that an agent or a log can read.
  2. Put it in the repo root's `.env` as `CACHE_DB_CONNECTION_STRING`, beside
     `WORKER_MODE=live`. In `.env`, not a shell export: turbo's strict env mode drops undeclared
     variables before `pnpm dev:worker` starts, and the worker reads `.env` itself. Any file
     path inside the string, such as a CA certificate, must be absolute, because the worker runs
     from `apps/worker` and the lab from wherever the notebook is. `.worktreeinclude` already
     copies `.env` into new worktrees.
  3. Never put a production string in `DB_CONNECTION_STRING`. The worker would claim real
     attempts, and the web app would serve real reports. `.env.example`'s comment says so on
     both variables.
  4. Start the worker and read its startup line naming the cache database.

  That's all there is to "pulling": every claim reads the latest verified rows, so there is no
  sync step and nothing goes stale. "Updating" is automatic too: every `live` run suggests its new
  products. Only a human with dashboard access can *verify* a suggestion. `cache_client` cannot,
  by design, so a developer who wants a row corrected asks the reviewer, or fixes it in Studio
  if they are one.
- **A developer changing the categorization prompt or model unsets the variable first.** An
  experiment's answers would otherwise become the first suggestion for every product they
  touch and block the real model's suggestion until a reviewer deletes them, which is the lab's
  `push_suggestions=False` case (PR 2) on the worker side. With the variable unset, the
  experiment's cache is the local database. The README says this beside step 2.
- **The string is one shared password.** Everyone who holds `cache_client` holds the same one,
  so revoking a single person means `ALTER ROLE cache_client PASSWORD` and handing the new string
  to everyone else. That's acceptable for a role that can only read three tables and insert
  unverified rows. *Rejected: a role per person.* Every grant, limit and password would be
  multiplied, for a credential this weak, held by a handful of people.

### A role that can read and suggest, nothing more

- **`cache_client` can read the three tables and insert suggestions, nothing else.** Its
  `INSERT` is column-level, on the key, the values and `suggested_by` only, so every row it
  writes lands unverified with the table's own id and timestamps, and a writer that names any
  other column gets `42501`. It has a statement timeout and an idle-in-transaction timeout, the
  latter so an abandoned transaction holding an uncommitted suggestion cannot block every other
  insert of that key, a production harvest's included; so the lab's `connect()` (PR 1) uses
  autocommit or short transactions. The role's settings are a floor for clients that send none:
  the worker's cache handle sends `DEFAULT_LIMITS` as startup parameters, the same values
  today, and those override them; only the lab's psycopg relies on the role's.
  *Rejected: read-only.* Then every new row the lab produces would reach the database by hand,
  which is the sync problem this plan exists to end. *Rejected: letting the role verify rows in
  the lab-only tables.* One rule for three tables is easier to hold; revisit if ticking entree
  rows in Studio turns out to be the bottleneck.
- **Its connection limit is 10, and an idle session closes after 10 minutes.** The limit keeps
  the role from starving the production web and worker of the project's shared connections, and
  does nothing for security, which is the grants' job. It is a row in
  [`budget.ts`](../../packages/db/src/budget.ts), whose test keeps the sum against
  `max_connections`. Ten covers the realistic peak: two data
  scientists with a kernel or two and a runscript each, plus a developer's lab and `live`
  worker, about 6–9. A lower limit would raise `53300 too many connections for role` whenever
  someone has a few notebooks open. The idle-session timeout keeps a forgotten kernel from holding
  a slot indefinitely, which is what would otherwise exhaust any limit over a week. So every
  client of the role opens connections briefly: the worker's cache pool keeps none open while
  idle, and the lab connects per command (PR 1). Raising the limit is a one-line
  `ALTER ROLE` migration, if the team grows.
  *Rejected: a limit of 3–5, about one per person.* One person routinely holds several
  connections at once.
- **A human sets its password once, in the hosted SQL editor** (`ALTER ROLE cache_client
  PASSWORD '…'`), so no secret is ever in a migration. A data scientist's or a developer's
  credential is composed, not copied:
  `postgresql://cache_client:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<path to the repo's supabase-ca.crt>`
  — the dashboard's *Direct connection* string with the role, its password, and the TLS
  parameters that psycopg, `psql` and `pg` all read from a URL
  ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Supabase). Neither sees the `postgres` password, and
  the string they hold can read three tables and insert unverified rows into them, nothing else.
  *Rejected: giving the data scientists `DB_CONNECTION_STRING`.* It is `postgres`, and an agent
  with it can drop a table. *Considered: Supabase's temporary access*, where a dashboard member
  assumes a Postgres role with their own token as the password, with an expiry and IP allowlist. It needs the person to
  be a dashboard member, which on Free and Pro means Developer and so the SQL editor anyway, and
  its plan availability is undocumented. Worth revisiting if GBD is ever on Team.
- **The hosted path is unproven, so prove it before handing out a string** (§ Go-live step
  4), in ten minutes against the real project with a throwaway role: `CREATE ROLE smoke LOGIN
  PASSWORD …` in the SQL editor, `GRANT SELECT` on an existing table, then from a laptop `psql`
  to the direct host as `smoke`, with TLS; confirm a `SELECT` works and an `UPDATE` and a
  `SELECT` from `report` fail with `42501`; then `DROP ROLE`. `002_caches` grants no `USAGE ON
  SCHEMA public`, because `PUBLIC` holds it on both local stacks; if the smoke test's `SELECT`
  fails on the schema rather than the table, add that grant in a new migration, and let it reach
  production before handing out the string.
- **The lab reads the worker's `CACHE_DB_CONNECTION_STRING`, never `DB_CONNECTION_STRING`.**
  For the data scientists it is `cache_client` on the direct host, with TLS — the string above;
  a developer uses one string for the lab and `pnpm dev:worker` alike, or points it at the local
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

### Go live on the interim copy; the final import replaces it

Production goes live on the interim copy (§ Context), and everything but deleting the import
lands before GBD's final files: the strings go out once the smoke test passes, and the lab's PRs
merge when they are ready.

- **Go live on the interim copy rather than wait for the final one.** Its rows are GBD's own
  answers, cleaned only by rules the cache applies anyway, so a report on it is what a report on
  the CSV gave the lab. What the final copy adds, new entries and the data scientist's
  cleaning, matters for clients, not for GBD staff checking the site. *Rejected: waiting for
  the final files* (this plan's earlier draft). It blocked `live` on a delivery date outside our
  control.
- **The interim cleaning decides nothing a person did not.** Two categories are typos with one
  possible meaning, so they are fixed. The 12 rows whose category is not in the YAML and has no
  single match are dropped, so the LLM answers for them. *Rejected: mapping those to `No Matches
  Found` or a near category.* A dropped row costs an LLM call per run, but a guessed verified row
  is used silently. The 20,008 cleaned names equal to their product are left for the data
  scientist.
- **Both production imports delete every row of the three tables, then load their copy, in one
  transaction.** That is `--mirror`, which production takes. The interim import deletes whatever
  a deploy harvested before it; the final one deletes the interim rows, every harvest and push
  since, and any Studio edit. So the tables become exactly the file's usable rows, and the count
  check stays "the file's rows minus the reported skips". In production a refused row still
  stops the import.
  *Rejected: a plain re-import.* Its upsert leaves every verified row alone, so it would replace
  nothing the interim import loaded. *Rejected: deleting only verified rows, keeping the
  interim's harvests as the review queue.* The count check gains an unknown term, and a lost
  suggestion costs one LLM call. *Rejected: a `DELETE` in the SQL editor, then a plain import.*
  Between the two every report runs on an empty cache, and a failed import leaves it empty.
- **Until the final import, unverified rows are ignored.** The product never reads them, and
  nobody reviews or verifies them in Studio, since the final import deletes them. Review starts
  after it.
- **The strings go out before the final import.** The fleet needs no custom role, but developers
  and data scientists use the hosted cache as soon as the smoke test passes (§ Go-live step 4).
  Whatever they suggest before the final import is deleted by it, which costs an LLM call per
  product the next time it is seen. *Rejected: holding the strings until the final import*
  (this plan's previous draft). It saves only those calls, and blocks the lab's PRs.
- **From go-live on, the hosted table is the source**, and a CSV is a pulled snapshot or the
  local loader's input. A developer's `live` worker reads it through `CACHE_DB_CONNECTION_STRING`
  (README § The categorization cache), and the lab pulls it once a data scientist holds the
  string (PR 1). Without the string, a developer's cache is their local database: empty, unless
  they load a CSV with the import's local `--mirror --write`, until PR 3 deletes it.
- **Locally, `--mirror` makes the tables exactly the CSV's usable rows**, which is what the
  product got from reading the file. In the import's one transaction, it deletes every row of
  each table it imports, unverified harvests included, before inserting; and locally it skips a
  refused row, still listing it, rather than stopping. Without it a local import breaks twice: a
  copy with a refused row, like the 2026-09-27 one, stops the whole import, although
  `from_frame` drops the same rows with a WARNING; and a re-import of a changed CSV leaves every
  changed row alone as already verified and keeps every row the file dropped, so the local cache
  drifts from the human copy. Both forms are idempotent: without `--mirror` a second run writes
  nothing; with it, a second run deletes and reinserts the same rows.
  *Rejected: a `TRUNCATE` in the README instead.* One more command to get wrong, and a dry run
  would not show it.
- **`pull` overwrites the lab's CSV paths.** A developer rehearsing the lab keeps GBD's
  originals elsewhere, which is where the import reads them from: a pulled file holds the
  database's rows, without the skipped and refused ones.
- **PR 2 waits for the data scientists to hold the string**, not for the final import. It ends
  the lab's automatic entree-file append, and until a data scientist has a database to push to,
  that is only a loss: a repeat serving run re-asks Gemini for every product the file would have
  gained, and can label it differently than last time. PR 1 is safe any time, since with the
  variable unset the lab is unchanged.

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

Not an app feature. The steps are an entry in [`runbooks.md`](runbooks.md), until that plan
settles where runbooks live.

## The PRs

Each PR is either TypeScript or Python, never both, and each is safe to merge alone. Going live
needs none of them.

| PR | Stack | Needs | What a production run does differently |
| --- | --- | --- | --- |
| 1 — the lab pulls | Python | — | nothing |
| 2 — the lab pushes | Python | 1, § Go-live step 4 | nothing |
| 3 — delete the import | `packages/db`, docs | § Go-live step 5 | nothing |

Whichever of PRs 2 and 3 lands last deletes this plan.

## PR 1 — the lab pulls

- `python/lab/pyproject.toml` gains `psycopg[binary]`. Check for its Python 3.14 wheel when
  writing the PR.
- `gbd_foodservice_insights_lab/cache_sync.py`:
  - `connect()` reads `CACHE_DB_CONNECTION_STRING` through the lab's existing dotenv loading
    and connects in autocommit, because of the role's idle timeouts (§ Decisions). psycopg reads
    the string's `sslmode` and `sslrootcert` itself, so TLS needs no code.
  - Each command opens its own connection and closes it on the way out. A connection is never
    held in a notebook global, because the role's idle-session timeout would close it after 10
    minutes.
  - `pull(connection)` selects the verified rows of each table and writes the three CSVs through
    a temp file and rename. Column names are mapped to what the loaders expect:

    | Table column | CSV column |
    | --- | --- |
    | `cleaned_name` | `cleaned_item_names` |
    | `classification` | `entree_classification` |
    | `cleaned_unit` | `llm_cleaned_unit` |
    | `extracted_weight` | `llm_extracted_weight` |

    A null becomes `""`. The pure frame-building functions are kept separate from the
    connection, so they can be tested without a database.
  - It runs as `python -m gbd_foodservice_insights_lab.cache_sync pull`, and as
    `just pull-caches`.
- The categorize runscript pulls first when the variable is set. Otherwise, it logs one WARNING
  with the variable's name and each file's age. Step 0.5 reaches it through step 1 unchanged.
  The loaders themselves do not change.
- Tests:
  - The frame builders.
  - A `db`-marked round trip, with the `pytest` marker added to the root `pyproject.toml`. It
    runs when `TEST_DB=1` and connects with `.env.test`'s `DB_CONNECTION_STRING`, as the
    TypeScript tests do.
    - Its random keys are deleted in a `finally`, because the test stack is shared across
      worktrees.
    - It never reads `CACHE_DB_CONNECTION_STRING`. On a developer's laptop that string points at
      production, where the test would leave its rows in the review queue, because
      `cache_client` cannot delete them.
  - The runscript's pull-or-warn branch, tested through `test_runscript.py`'s module-loading
    pattern.
- CI:
  - The `py-lab` job gains `setup-node`, `setup-supabase` and `TEST_DB=1 pnpm migrate`, and
    sets `TEST_DB=1`.
  - `.github/filters.yml`'s `python_lab` filter stops excluding `packages/db/migrations/**`. A
    schema change then reruns the round trip on its PR, not only on `main`.
- Docs:
  - `.env.example`'s `CACHE_DB_CONNECTION_STRING` comment, which names only the worker, now names
    the lab too, and gains the dev-stack-as-`postgres` form the lab rehearses with.
  - `python/lab/README.md` gains `just pull-caches`. It says that leaving the variable unset
    keeps today's behaviour and that a pull overwrites the three files. It keeps the "handed out
    privately" paragraph until PR 2.
- Rehearse: point the variable at the dev stack as `postgres` after a `--mirror` import. A pull
  writes three files whose row counts match the import's, and a categorize run on `test_data/`
  reads them.

## PR 2 — the lab pushes, and stops writing its files

This PR merges once the data scientists hold the string (§ Go-live step 4), not before (§ Go
live on the interim copy). Rehearse it beforehand against the dev stack as `postgres`.

- `cache_sync.py`: `push_product_categorizations(connection, frame, suggested_by)`,
  `push_entree_classifications` and `push_unit_weights`.
  - Each runs `INSERT … ON CONFLICT DO NOTHING` in chunks, maps the columns back, and names only
    the columns `cache_client` may insert.
  - Before sending anything, each validates against the tables' rules in § Decisions: keys are
    stripped and within the byte bound, and blank values and `NaN` weights become null.
- `spreadsheet.py`:
  - Step 1 pushes `categorized.new_categorizations` through `push_product_categorizations`. For
    serving data, it also pushes the Gemini-labelled products through
    `push_entree_classifications`. Both use `lab:<getpass.getuser()>`.
  - One `push_suggestions` flag replaces `update_historical_entree_classifications`. It is on by
    default when the connection is configured, and skipped with a WARNING when it is not.
    Turning it off is how a prompt experiment keeps its answers out of the table, where the first
    suggestion would block the real one.
- These go:
  - `entree_cache.py`: `save_historical_entree_classifications`.
  - `entrees.py`: `build_entree_human_review_table` and the `_entree_for_human_review.csv` it
    feeds, for the same reason the product one is gone. The backfill script and
    `build_entree_cleaned_name_reuse_index` are unchanged.
- `clean_product_weights.py`: `expand_historical_weight_classifications` pushes instead of
  rewriting the file. Rename the 1.5 runscript's commented call to match.
- Tests:
  - The row mappers and validators.
  - A `db`-marked round trip: a push lands unverified, and a second push of the same keys writes
    nothing.
  - `test_spreadsheet.py`'s serving test asserts the push, not a file write.
  - A test with `push_suggestions=False` asserts no push.
- Docs:
  - `python/lab/README.md`: the "handed out privately" paragraph becomes pull. It gives the
    hosted string's form, TLS parameters included, pointing at the repo's `supabase-ca.crt`.
  - The lab's `data_files/README.md` says the files are pulled, never committed.
  - § Working on a client: step 1 suggests its new answers, someone verifies them in Studio, and
    the next pull brings the verified rows down.
  - `REQUIREMENTS.md` § Product categorization cache names the lab's two caches under the same
    rule.
- If PR 3 has landed, this PR deletes this plan.

## PR 3 — delete the import

This PR lands once the final import's checks pass (§ Go-live step 5).

- It deletes `packages/db/scripts/temporary-go-live-cache-import/`, `@gbd/db`'s
  `temporary-go-live-cache-import` script, and the root `README.md`'s link to it at the end of
  § The categorization cache.
- If PR 2 has landed, it deletes this plan. Otherwise it removes this PR, the Context bullets
  about the script and the interim copy, and § Go live on the interim copy.

*Rejected: keeping it as a seeding tool.* Nobody outside GBD has the CSVs, and a fresh clone
works with an empty cache. A developer who wants real rows points `CACHE_DB_CONNECTION_STRING`
at the hosted project. A CSV that turns up later can be loaded by restoring the script from git
history.

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
| `CACHE_DB_CONNECTION_STRING` set with `mock-llm` or `stubbed` | ignored with one startup WARNING; the cache is the local database |
| `CACHE_DB_CONNECTION_STRING` set with `off` | ignored; nothing runs |
| A production string put in `DB_CONNECTION_STRING` by mistake | the local worker claims real attempts; prevented only by `.env.example`'s warning and the README, since the worker cannot tell a hosted database from a local one |
| A `live` worker without `CACHE_DB_CONNECTION_STRING` | the cache is the worker's own database, read and written; one startup log line says so |
| Lab push names `is_verified` | `42501` from the role; the push code never does |
| All 10 of `cache_client`'s connections are in use | the next connection fails with `53300`; the production web and worker are unaffected |
| A notebook leaves a connection idle for 10 minutes | the server closes it; the next lab command opens a new one |
| Data scientist runs without `CACHE_DB_CONNECTION_STRING` | today's behaviour on today's file, plus a WARNING with the file's age |
| `--mirror` with `--production` | deletes every row of each table it imports, in the import's transaction; a refused row still stops it |
| A reviewer verifies or edits a row before the final import | the final import deletes it |
| The worker is deployed before the interim import | every product goes to the LLM, and its suggestions land unverified; the import's `--mirror` deletes them |
| `OPENAI_API_KEY` missing from the `production` Environment | the worker deploy fails before submitting anything, and the fleet keeps running its previous deploy |

## Go-live

`deploy.yml`'s migrate step applies `002_caches` with every web deploy, and the import fails
loudly on a missing table. The import's `--production` prompts for the direct-connection
`postgres` string and verifies TLS itself (its `README.md`); a hand-run `psql` connects directly
with `sslmode=verify-full&sslrootcert=…`, the way a hand-composed string does (§ A role that can
read and suggest).

Now, on the interim copy:

1. Store `OPENAI_API_KEY` in the `production` GitHub Environment (`.do/README.md`). Without it,
   the next worker deploy fails before submitting anything.
2. From a workstation terminal, dry-run all three files of the interim copy against prod in one
   run: `pnpm --filter @gbd/db temporary-go-live-cache-import --production --mirror --products
   <csv> --entrees <csv> --units <csv>`, pasting the string at the prompt. Before it prompts, it
   should report every row of each file importing, with nothing skipped, rewritten or refused.
   Expect nothing deleted, and 38,203, 1,989 and 893 inserted; a deleted row is a harvest
   (§ Context). Run it again with `--write`, read the counts, and type `COMMIT`. Check each
   table's count in Studio, and spot-check a `No Matches Found` row, a product with commas and
   quotes, and the two corrected typos.
3. Dispatch a worker deploy: the first since 2026-10-16, the first `live` fleet, and the first
   that harvests. Upload `apps/web/sample-reports/valid.csv` on the production site: the report
   completes, and its new products appear in Studio unverified, with `attempt:<uuid> <worker
   id>` in `suggested_by`.
4. Run the smoke test in § A role that can read and suggest; `ALTER ROLE cache_client PASSWORD
   '…'` in the SQL editor; compose your own `CACHE_DB_CONNECTION_STRING` in the form § A role
   that can read and suggest gives, with that password, and check it from a laptop with `psql`.
   Hand each app developer the composed string the way `OPENAI_API_KEY` is, and have them follow
   the root README's § The categorization cache. Once PR 1 has landed, hand each data scientist
   the same string, checked with `psql` first — the CA it points at is already in their checkout
   (if the project ever turns on network restrictions, their addresses need allowing); they set
   `CACHE_DB_CONNECTION_STRING`, pull once, and delete their hand-copied files.
   `.worktreeinclude` keeps copying the pulled files into new worktrees, now a convenience rather
   than the only way to get them.

When GBD's final files arrive:

5. Dry-run the final copy against prod with `--production --mirror`. Take every refused row, and
   any surprising skip, back to the data scientist and repeat until the report is clean.
   `deleted` should be the interim rows plus every harvest and push since, and each table's
   inserted count the file's rows minus the reported skips. Run it again with `--write`, read the
   counts, and type `COMMIT`. Check each table's count in Studio, and spot-check a `No Matches
   Found` row and, if the copy has one, a multi-line product. Then merge PR 3, and start
   reviewing suggestions in Studio.

## Verification

Each PR: `pnpm lint && pnpm check && pnpm test` and `just lint && just check && just test`, plus
`just test-lab` for every Python PR, since the lab imports the library.

The local loader, by hand, once PR 1 is in: a `--mirror --write` import of the interim copy
loads 38,203, 1,989 and 893 rows; a second identical run ends with the same row counts; a `live` upload of `apps/web/sample-reports/valid.csv` with the variable unset
starts from those rows, and its new products land unverified in the dev stack; `just pull-caches`
with the variable at the dev stack writes three files whose row counts match the import's.

Then by hand, on `mock-llm`:
an upload of `apps/web/sample-reports/valid.csv` produces unverified `product_categorization`
rows with `suggested_by = attempt:<id>`; in Studio, change one row's category to something the
keyword fake would never answer and tick `is_verified`; a second upload of the same file reports
that product under the new category in its workbook, which only a cache hit can explain (the
child logs at WARNING, so the match-type counts are not visible from the worker). After
§ Go-live step 4, on `live` with `CACHE_DB_CONNECTION_STRING` at the hosted project: a local upload's new products appear in
production's Studio unverified, with the laptop's worker id in `suggested_by`, and the same
variable under `mock-llm` logs the WARNING and its upload's suggestions land in the local
database, not production's. On the lab:
`just pull-caches` writes three files whose row counts match the verified counts in Studio; a
step 1 run's new categorizations appear in Studio unverified as `lab:<user>`; a second run of
the same file adds nothing.
