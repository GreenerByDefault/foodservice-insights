# Caches to Supabase

## Where this stands (2026-10-25)

The product side is done and live. `packages/db/migrations/002_caches.ts` created
`product_categorization`, `entree_classification` and the `cache_client` role (`unit_weight` too,
since dropped by `016_drop_unit_weight.ts` when GBD retired the weights cache).
The worker reads the verified product rows on every claim and inserts what its LLM categorized
as unverified suggestions. Production runs `live` on the interim copy of GBD's caches, loaded by
the temporary import. A developer's `live` worker reads and suggests to the hosted cache through
`CACHE_DB_CONNECTION_STRING` (`apps/worker/README.md` § The categorization cache).

The lab pulls and pushes, through `gbd_foodservice_insights_lab/cache_sync.py`. It overwrites
the lab's two cache files with the verified rows whenever step 1 starts with
`CACHE_DB_CONNECTION_STRING` set, and on `just pull-caches`. Step 1 then suggests its new
categorizations and, for serving data, Gemini's entree labels (`push_suggestions_if_configured`),
as `lab:<user>`. Nothing in the lab writes its cache files any more except a pull. Unset, step 1
runs on the files on disk, warns how old they are, and warns what it left unsuggested. Nobody in
the lab holds the string yet.

What's left is handing out the string and the final import:

| Step | Stack | Needs |
| --- | --- | --- |
| Hand the data scientists the string | — | nothing |
| The final import | — | GBD's final CSVs, which arrived 2026-10-25 |
| PR 1 — delete the import | `packages/db`, docs | the final import |

PR 1 deletes this plan.

## Context

**The lab's two caches**, gitignored CSVs in `python/lab/gbd_foodservice_insights_lab/data_files/`,
which a pull overwrites:

| Table | File | Loader | Suggested by |
| --- | --- | --- | --- |
| `product_categorization` | `previously_categorized_items.csv` | `load_categorization_cache()` (`categorization/product_cache.py`) | step 1 |
| `entree_classification` | `previously_classified_entrees.csv` | `get_previously_classified_entrees()` (`categorization/entree_cache.py`), serving mode only | step 1, serving mode |

- **`cache_sync.py` describes each cache once**, as a `CacheTable` in `CACHE_TABLES`: its
  table, its table-to-CSV column mapping (key first), and the loader's own path function. The
  pushes map columns back through the same mapping, make every row pass the table's CHECKs
  before sending anything, and insert in one transaction. `connect()` opens a short-lived
  autocommit connection as `application_name='lab-cache'`; every command opens one as
  `with connect() as connection:`, never in a notebook global, which the idle-session timeout
  would close. A failure the person running the lab must fix raises `CacheSyncError`.
- **The lab's database tests** use the `test_database` fixture in `python/lab/tests/conftest.py`:
  `postgres` on `.env.test`'s stack inside a forced rollback, skipped without `TEST_DB`. A test
  runs `SET LOCAL ROLE cache_client` to exercise the role's grants, and filters to a random
  prefix, since the test database is shared. It never reads `CACHE_DB_CONNECTION_STRING`, which
  on a developer's laptop is production, and an autouse fixture unsets it for every lab test.
  CI's `py-lab` job runs them against the migrated test stack, and runs on a migration change
  too.
- **The tables are the source of truth for their rules.** `packages/db/public-schema.sql` holds
  the columns and the CHECKs every writer must satisfy, and `002_caches.ts` `cache_client`'s
  grants; `tests/caches.test.ts` asserts each. In short: `cache_client` can `SELECT` the two tables and `INSERT` only the
  key, value and `suggested_by` columns, so every row it writes lands unverified. It has a
  60-second idle-in-transaction timeout, a 10-minute idle-session timeout, and 10 connections
  (`packages/db/src/budget.ts`). One rejected row fails its whole `INSERT`.
- **The hosted string** is `cache_client` on the direct host with
  `sslmode=verify-full&sslrootcert=<absolute path to supabase-ca.crt>`, in the form
  `.env.example` shows. Everyone who holds it holds the same password.
- **"New" has one definition.** `CategorizedProducts.new_categorizations` holds the products the
  LLM categorized this run (`match_type == "llm"`), with cleaned names. The worker harvests
  exactly these, and the lab pushes the same rows.
- **Two data scientists run the lab locally**, and lean heavily on AI agents, so any credential
  they hold is one an agent may misuse. Their copies of the caches are already behind GBD's.
- **The final import deletes every row first.** It runs the temporary import with `--mirror`,
  so harvests, lab pushes and Studio edits made before it are gone. GBD's final CSVs arrived on
  2026-10-25.
- **Studio review** is an entry in [`runbooks.md`](runbooks.md), until that plan settles where
  runbooks live.

## Decisions

- **Only verified rows are ever used, and the first suggestion wins.** Every automatic write is
  `INSERT … ON CONFLICT (<key>) DO NOTHING`, so a correction happens in Studio: edit the value
  and tick `is_verified`. To reject a suggestion, leave it unverified; to have it suggested
  again, delete it.
- **The lab reads `CACHE_DB_CONNECTION_STRING`, never `DB_CONNECTION_STRING`**, the same
  variable as a developer's worker, so a developer holds one credential. Unset, the lab works
  exactly as today, on whatever files are on disk, and step 1 warns how old they are.
  *Rejected: giving the data scientists `DB_CONNECTION_STRING`.* It is `postgres`, and an agent
  with it can drop a table.
- **Set, a pull that fails stops step 1** before it calls any LLM, and the error says to comment
  the variable out to run on the files on disk. *Rejected: warning and running on the files on
  disk.* A rotated password or a typo in the string would go unnoticed for weeks behind one line
  in step 1's long log, while every run quietly paid for LLM calls a fresh cache would have
  answered.
- **Pull writes the verified rows to the two files the loaders read**, so the loaders,
  runscripts and notebooks never touch the database, and runs work offline. Push is the only
  other place the lab talks to it. *Rejected: loaders that query the database directly.* Every
  run would need the network and a credential, and the gitignored notebooks that call the loaders
  would change behaviour.
- **Push inserts new rows unverified, and the lab's local cache writes are gone.** Both tables
  are verified in Studio, by whoever holds dashboard access. `push_suggestions=False` keeps a
  prompt experiment's answers out, where the first suggestion would block the real one.
  *Rejected: pushing a hand-reviewed `_for_human_review.csv`.* First suggestion wins, so a
  correction made in the file is silently dropped whenever the product is already in the table.
- **The data scientists get the string as soon as the pushes are on `main`.** Until then, a
  repeat serving run re-asks Gemini for every product the entree file used to gain locally.
- **`psycopg` is a lab dependency only.** The analysis library never touches the database.
- *Rejected: a role per person.* Revoking one person means `ALTER ROLE cache_client PASSWORD`
  and re-handing the string to everyone else, which is acceptable for a role that can only read
  two tables and suggest rows.
- **Open:** who verifies. On Free and Pro plans every dashboard role that can see data can also
  run any SQL, so the reviewer is a human decision, not a role this plan can create.
- **Open:** a reviewer's category typo in Studio is today only a WARNING in the run that skips
  the row. If that proves too quiet, a `gbd_category` reference table with an FK is the fix.

## Hand the data scientists the string

Now. Check the composed string with `psql` first; the CA it points at is already
in their checkout. If the project ever turns on network restrictions, their addresses need
allowing. Each sets `CACHE_DB_CONNECTION_STRING` in `.env`, runs `just pull-caches` once, and
deletes their hand-copied files.

## The final import

When GBD's final CSVs arrive, follow the import's
[`README.md`](../../packages/db/scripts/temporary-go-live-cache-import/README.md) with
`--production --mirror`:

1. Dry-run the final copy against production. Take every refused row, and any surprising skip,
   back to the data scientist, and repeat until the report is clean. `deleted` should be the
   interim rows plus every harvest and push since; each table's inserted count, the file's rows
   minus the reported skips.
2. Run it again with `--write`, read the counts, and type `COMMIT`.
3. Check each table's count in Studio, and spot-check a `No Matches Found` row and, if the copy
   has one, a multi-line product.
4. Merge PR 1, and start reviewing suggestions in Studio. Until now nobody reviews unverified
   rows, since this import deletes them.

## PR 1 — delete the import

- Deletes `packages/db/scripts/temporary-go-live-cache-import/`, `@gbd/db`'s
  `temporary-go-live-cache-import` script, and `apps/worker/README.md`'s link to it at the end of
  § The categorization cache. With them: `packages/db/src/client.ts`'s `hostedFromACheckout`
  option and the refusal it skips (its comment says "Delete this with the script"),
  `.claude/settings.json`'s `temporary-go-live-cache-import` ask rule, and `runbooks.md`'s
  sentence naming it as the one production-touching script.
- Deletes this plan.

*Rejected: keeping it as a seeding tool.* Nobody outside GBD has the CSVs, a fresh clone works
with an empty cache, and a developer who wants real rows points `CACHE_DB_CONNECTION_STRING` at
the hosted project. A CSV that turns up later can be loaded by restoring the script from git.

## Failure paths

| Situation | Result |
| --- | --- |
| Lab runs without `CACHE_DB_CONNECTION_STRING` | today's behaviour on today's files, plus a WARNING with each file's age |
| Variable set, step 1's pull fails | step 1 stops before any LLM call; the error names the variable and says to comment it out; every file is as it was |
| A push names `is_verified` | `42501` from the role; the push code never does |
| All 10 of `cache_client`'s connections are in use | the next connection fails with `53300`; production is unaffected |
| A notebook holds a connection idle for 10 minutes | the server closes it; the next command opens a new one |
| A reviewer verifies or edits a row before the final import | the final import deletes it |

## Verification

PR 1: `pnpm lint && pnpm check && pnpm test`.

By hand, once the string is out: `just pull-caches` writes two files whose row
counts match the verified counts in Studio; a step 1 run's new categorizations appear in Studio
unverified as `lab:<user>`; a second run of the same file adds nothing.
