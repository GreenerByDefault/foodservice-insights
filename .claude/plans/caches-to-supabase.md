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
  would send every product to the LLM, which makes this a launch blocker. Local images hide it because the file is on the developer's disk.
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
  is sending an updated copy with new entries and some cleaning; the go-live import runs on that,
  so these counts will move. A local dry run of the import on the 2026-09-27 copy keeps 38,201
  rows, rewrites 6 whose category differs from a known one only in case, skips the 106 blank
  categories and 371 earlier repeats (11 with a different category), and refuses 14 rows across
  8 unknown categories (`na`, `Mlik`, `Plan-Based Mayo`, `Plant-Based Butter`, `Plant-Based
  Chocolate`, `Plant-Based Cream`, `Coconut milk`, `Stone Fruit`), which go back to the data
  scientist.
- **A temporary go-live import script is on `main`**, in
  `packages/db/scripts/temporary-go-live-cache-import/` and nowhere else, so it never becomes a
  sync tool: until go-live it is how a developer loads the local cache (§ The dress rehearsal),
  § Go-live step 2 runs it once against production, following the directory's `README.md`, and
  PR 5 deletes it. It loads any of the three CSVs
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
  Until go-live it is also the local loader: `--mirror`, which `--production` rejects before
  reading anything, deletes every row of each table it imports inside the same transaction and
  imports around refused rows, listing them, so the local tables become exactly the file's
  usable rows; its counts gain `deleted` (§ The dress rehearsal). A dry run of the same CSVs
  with `--mirror` on 2026-10-13 would have loaded 38,201, 1,989 and 893 rows.
- **GBD's final CSVs are a week or two away** (as of 2026-10-13). Everything in this plan except
  touching production lands before then, as a dress rehearsal against each developer's local
  database (§ The dress rehearsal).
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
- **Honored only in `live`.** In `mock-llm` and `stubbed` the worker ignores the variable and
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
- **What an app developer who never opens the lab does**, and what the root `README.md`
  § Analysis modes says once production holds the cache (PR 5; until then, § The dress
  rehearsal):
  1. Ask whoever holds dashboard access (Eric, until § Reviewing in Studio's **Open** is
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
  `push_suggestions=False` case (PR 6) on the worker side. With the variable unset, the
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
  insert of that key, a production harvest's included; so the lab's `connect()` (PR 4) uses
  autocommit or short transactions. The role's settings are a floor for clients that send none:
  the worker's cache handle (PR 1) sends `DEFAULT_LIMITS` as startup parameters, the same values
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
  idle (PR 1), and the lab connects per command (PR 4). Raising the limit is a one-line
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
- **The hosted path is unproven, so prove it before migrating production** (§ Go-live step
  1), in ten minutes against the real project with a throwaway role: `CREATE ROLE smoke LOGIN
  PASSWORD …` in the SQL editor, `GRANT SELECT` on an existing table, then from a laptop `psql`
  to the direct host as `smoke`, with TLS; confirm a `SELECT` works and an `UPDATE` and a
  `SELECT` from `report` fail with `42501`; then `DROP ROLE`. `002_caches` grants no `USAGE ON
  SCHEMA public`, because `PUBLIC` holds it on both local stacks; if the smoke test's `SELECT`
  fails on the schema rather than the table, add that grant in a new migration before migrating
  production.
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

### The dress rehearsal: local first, production at go-live

The code is ready before GBD's final CSVs are, so PRs 1–4 land first and every process runs
against the local database; § Go-live, then PRs 5 and 6, follow once the files arrive.

- **Until go-live, the CSV is the human copy and the local database is loaded from it.** A
  developer keeps GBD's three files and runs the import with `--mirror --write`; once PR 2 lands,
  nothing else reads the product CSV. After go-live the arrow reverses: the hosted table is the
  source, and a CSV is only ever a pulled snapshot.

  | Process | Until go-live | After |
  | --- | --- | --- |
  | Worker parent | the local database, through its own handle; `CACHE_DB_CONNECTION_STRING` unset, which is production's configuration | the hosted project: the fleet through its own handle, a laptop's `live` worker through the variable |
  | Lab, a developer rehearsing it | the variable at the dev stack as `postgres`; `pull` writes the lab's CSV paths | the hosted project as `cache_client` |
  | Lab, a data scientist | the variable unset; the file on disk, as today | the hosted project as `cache_client` |

- **`--mirror`, local only, makes the tables exactly the CSV's usable rows**, which is what the
  product got from reading the file. In the import's one transaction, it deletes every row of
  each table it imports, unverified harvests included, before inserting; and it skips a refused
  row, still listing it, rather than stopping. Without it the
  rehearsal breaks twice: the 2026-09-27 copy's 14 refused rows stop the whole import, although
  `from_frame` drops the same rows with a WARNING today; and a re-import of a changed CSV leaves
  every changed row alone as already verified and keeps every row the file dropped, so the
  local cache drifts from the human copy. `--production` rejects it: there a refused row goes
  back to the data scientist, and a verified row may be a reviewer's edit.
  Both forms are idempotent: without `--mirror` a second run writes nothing; with it, a second
  run deletes and reinserts the same rows.
  *Rejected: hand-fixing the 14 rows in each developer's copy.* The copies drift, and GBD's
  final file is coming anyway. *Rejected: a `TRUNCATE` in the README instead.* One more command
  to get wrong, and a dry run would not show it.
- **One import serves every worktree, and anything that empties the dev database empties the
  cache.** Worktrees share `supabase-dev`, so the import runs once per machine. A fresh clone,
  `pnpm truncate` and `scripts/supabase db reset` need it again, beside `pnpm migrate` and
  `pnpm seed:identity`. A developer who skips it is a fresh clone: every product goes to the
  LLM, and nothing breaks.
- **Docs say only what works today.** PR 2 replaces the root README's "place the CSV in
  `data_files/`" with the import command, and adds it to the after-a-reset line. § Local
  development's four developer steps, which hand out a production string, wait for PR 5; the
  lab README's hosted string waits for PR 6.
- **PR 2 moves the product CSV's path into the lab.** A data scientist moves their file once;
  the lab's missing-file WARNING names the new path.
- **`pull` overwrites the lab's CSV paths.** A developer rehearsing the lab keeps GBD's
  originals elsewhere, which is where the import reads them from: a pulled file holds the
  database's rows, without the skipped and refused ones.
- **PR 6 waits for go-live step 4.** It ends the lab's automatic entree-file append, and until
  a data scientist has a database to push to, that is only a loss: a repeat serving run re-asks
  Gemini for every product the file would have gained, and can label it differently than last
  time. PR 4 is safe now, since with the variable unset the lab is unchanged.
- **A production worker deployed during the rehearsal is no worse off than today.** A CI-built
  image has had no cache since the CSV was gitignored; from PR 2 it reads an empty production
  table instead, and from PR 3 it suggests into it, which the import later promotes.

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

## PR 1 — contract: cache document in, parent materializes per claim

Both halves plus `contract/`, per `contract/README.md`. The library gains the request field but
ignores it until PR 2, so this PR changes no report.

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
  (§ A role that can read and suggest), and with no `ssl` of its own: this string is only ever
  composed by hand on a laptop and carries its TLS as `sslmode` and `sslrootcert`, which `pg`
  reads from the URL; `DB_SSL_CA` belongs to the production handles alone
  (`ARCHITECTURE.md` § Supabase); else it passes
  `WORKER_DATABASE`, and logs which at startup; `resolveWorkerMode` takes the variable and says
  whether the mode uses it, and `main.ts` logs the WARNING when it is set but unused, which is in
  `stubbed` and `mock-llm`. `.env.example` gains the variable,
  commented out, with its two forms and a warning on it and on `DB_CONNECTION_STRING` that a
  production string never goes in the latter; `.env.test` never sets it, so no test can reach
  the hosted project. `apps/worker/README.md`'s variable table says what it does. The root
  `README.md`'s developer steps wait for PR 5, since they hand out a production string.
- Rehearse: with the variable unset, the parent materializes the dev stack's verified rows.
  Pointing the variable at the dev stack as `postgres` exercises the second handle; the local
  `cache_client` has no password, so its grants stay covered by `tests/caches.test.ts`.
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
  child; `modes.test.ts` covers the variable with each mode, `off` included. Python: `test_fixtures.py` (the valid fixture parses to the expected tuple, newline row
  included; every invalid fixture is rejected), `test_run.py` (missing document →
  `contract_violation` and no `result.json`; malformed → `contract_violation`; a recording
  `analyze` receives the parsed rows), `test_library_agreement.py` (the child's row type is the
  library's).
- Docs: `ARCHITECTURE.md` § Worker step 3 and a new `### Categorization caches` subsection with
  the materialize-per-claim rule and its two rejections; `contract/README.md`.

## PR 2 — library: consume the request rows, drop the packaged CSV

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
  gains it; `analysis.py`'s cache **Open** is deleted.
- The root `README.md`'s paragraph about placing the CSV in `data_files/` becomes the local
  import, `pnpm --filter @gbd/db temporary-go-live-cache-import --products <csv> --mirror
  --write`, run once per machine, and its after-a-reset line names it beside `pnpm migrate` and
  `pnpm seed:identity` (§ The dress rehearsal). Merging this tells each developer who has the
  CSV to run it once; until they do, `live` runs send every product to the LLM.

## PR 3 — contract: new-categorizations document out, parent harvests

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

## PR 4 — the lab pulls

- `python/lab/pyproject.toml` gains `psycopg[binary]` (check its Python 3.14 wheel at PR time).
- `gbd_foodservice_insights_lab/cache_sync.py`: `connect()` reading `CACHE_DB_CONNECTION_STRING`
  via the lab's existing dotenv loading, in autocommit (§ Decisions: the role's idle timeouts);
  psycopg reads the string's `sslmode` and `sslrootcert` itself, so TLS needs no code.
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
  `pyproject.toml`) that runs when `TEST_DB=1`, connecting with `.env.test`'s
  `DB_CONNECTION_STRING` as the TypeScript tests do. Random keys are deleted in `finally`, since
  the test stack is shared across worktrees. It never reads `CACHE_DB_CONNECTION_STRING`: on a
  developer's laptop that is production, where the test would leave its rows in the review queue
  because `cache_client` cannot delete them. The runscript's pull-or-warn branch is tested
  through `test_runscript.py`'s module-loading pattern. CI: the `py-lab` job gains
  `setup-node`, `setup-supabase` and `TEST_DB=1 pnpm migrate`, and sets `TEST_DB=1`; `.github/filters.yml`'s `python_lab` filter stops
  excluding `packages/db/migrations/**`, so a schema change reruns the round trip on the PR and
  not only on `main`.
- `.env.example`'s `CACHE_DB_CONNECTION_STRING` comment, added in PR 1, now names the lab too.
  `python/lab/README.md` gains `just pull-caches`, says that unset is today's behaviour and that
  a pull overwrites the three files, and keeps the "handed out privately" paragraph until PR 6.
- Rehearse: point the variable at the dev stack as `postgres` after a `--mirror` import; a pull
  writes three files whose row counts match the import's, and a categorize run on
  `test_data/` reads them.

## PR 5 — go-live for developers: delete the import, hand out the hosted cache

Lands as soon as § Go-live step 2's checks pass. It deletes
`packages/db/scripts/temporary-go-live-cache-import/` and `@gbd/db`'s
`temporary-go-live-cache-import` script; turns the root `README.md`'s import paragraph and
after-a-reset mention into § Analysis modes' `live` row pointing to a short subsection with
§ Local development's four developer steps and the prompt-experiment rule; and removes this PR,
the Context bullets about the script and § The dress rehearsal from this plan.
*Rejected: keeping it as a seeding tool.* Nobody outside GBD has the CSVs, a fresh clone works
with an empty cache, and a developer who wants real rows points `CACHE_DB_CONNECTION_STRING` at
the hosted project; a CSV that turns up later can be loaded by restoring the script from git
history.

## PR 6 — the lab pushes, and stops writing its files

Merges at § Go-live step 4, not before (§ The dress rehearsal). Rehearse it beforehand against
the dev stack as `postgres`.

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
- `python/lab/README.md`: the "handed out privately" paragraph becomes pull, with the hosted
  string's form, TLS parameters included, pointing at the repo's `supabase-ca.crt`; the lab's
  `data_files/README.md` says the files are pulled, never committed. § Working on a client:
  step 1 suggests its new answers, someone verifies them in Studio, and the next pull brings the
  verified rows down.
  `REQUIREMENTS.md` § Product categorization cache names the lab's two caches under the same
  rule. This PR deletes this plan.

The dress rehearsal is PRs 1–4, as two chains, 1–3 and 4, that interleave freely. Go-live is PRs 5 and 6, each at its step. 1 and 2 can merge into one PR if the reviewer
prefers one behaviour change over two commits.

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
| Before go-live, a developer has not imported since a fresh clone, `truncate` or `db reset` | an empty local cache: every product goes to the LLM, as with no CSV today |
| Before go-live, the human copy changes | the next `--mirror` import makes the local tables match it; without `--mirror`, changed rows are left alone and counted as already verified |
| `--mirror` with `--production` | refused before anything is read |

## Go-live

`deploy.yml`'s migrate step applies `002_caches` with the first deploy after the hosted project is
set up. Each hand-run step below connects directly, with `DB_CONNECTION_STRING` set for the one
command, carrying `sslmode=verify-full&sslrootcert=…` the way a hand-composed string does (§ A role
that can read and suggest).

1. Run the smoke test in § A role that can read and suggest; then `pnpm --filter @gbd/db
   migrate` against prod, which reports no pending migrations once a deploy has applied `002`;
   `ALTER ROLE cache_client PASSWORD '…'` in the SQL editor; compose your own
   `CACHE_DB_CONNECTION_STRING` in the form § A role that can read and suggest gives, with that
   password, and check it from a laptop with `psql`.
2. From a workstation terminal, dry-run all three CSVs against prod in one run:
   `pnpm --filter @gbd/db temporary-go-live-cache-import --products <csv> --entrees <csv>
   --units <csv> --production`, pasting the direct-connection `postgres` string at the prompt.
   Take any refused row or surprising skip back to the data scientist and repeat until the
   report is clean; then run it again with `--write`, read the counts, and type `COMMIT`. Check
   each table's count against the CSV's rows minus the reported skips, and spot-check a `No
   Matches Found` row and a multi-line product in Studio.
3. Merge a PR that sets `.do/worker.yaml`'s `WORKER_MODE` to `live` and adds `OPENAI_API_KEY` as a
   secret, with the key stored in the `production` Environment first (`.do/README.md`). The
   production worker runs `mock-llm` until then. Dispatch a worker deploy, so the fleet runs PRs
   1–3 against the imported table; any rows an
   earlier deploy harvested were promoted by step 2's `DO UPDATE … WHERE NOT is_verified` if the
   CSV knows them. Merge PR 5. From here, every developer's `live` worker runs with
   `CACHE_DB_CONNECTION_STRING` set: hand each app developer the composed string the same way as
   in step 4, and have them follow § Local development's steps. Their local tables keep the
   rehearsal's rows, which `mock-llm` still reads.
4. Merge PR 6; hand each data scientist the same composed string, checked with `psql`
   first — the CA it points at is already in their checkout (if the project ever turns on
   network restrictions, their addresses need allowing);
   they set `CACHE_DB_CONNECTION_STRING`, pull once, and delete
   their hand-copied files. `.worktreeinclude` keeps copying the pulled files into new
   worktrees, now a convenience rather than the only way to get them.

## Verification

Each PR: `pnpm lint && pnpm check && pnpm test` and `just lint && just check && just test`, plus
`just test-lab` for 2, 4 and 6 and `pnpm test:system` for 1 and 3.

The rehearsal, by hand, once PRs 1–4 are in: a `--mirror --write` import of every local CSV
reports the 14 refused rows as skipped and loads the rest; a second identical run ends with the
same row counts; a `live` upload of `apps/web/sample-reports/valid.csv` with the variable unset
starts from those rows, and its new products land unverified in the dev stack; `just pull-caches`
with the variable at the dev stack writes three files whose row counts match the import's.

Then by hand, on `mock-llm`:
an upload of `apps/web/sample-reports/valid.csv` produces unverified `product_categorization`
rows with `suggested_by = attempt:<id>`; in Studio, change one row's category to something the
keyword fake would never answer and tick `is_verified`; a second upload of the same file reports
that product under the new category in its workbook, which only a cache hit can explain (the
child logs at WARNING, so the match-type counts are not visible from the worker). After
go-live, on `live` with `CACHE_DB_CONNECTION_STRING` at the hosted project: a local upload's new products appear in
production's Studio unverified, with the laptop's worker id in `suggested_by`, and the same
variable under `mock-llm` logs the WARNING and its upload's suggestions land in the local
database, not production's. On the lab:
`just pull-caches` writes three files whose row counts match the verified counts in Studio; a
step 1 run's new categorizations appear in Studio unverified as `lab:<user>`; a second run of
the same file adds nothing.
