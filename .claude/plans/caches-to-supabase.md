# Caches to Supabase

## Where this stands (2026-10-18)

The product side is done and live. `packages/db/migrations/002_caches.ts` created
`product_categorization`, `entree_classification`, `unit_weight` and the `cache_client` role.
The worker reads the verified product rows on every claim and inserts what its LLM categorized
as unverified suggestions. Production runs `live` on the interim copy of GBD's caches, loaded by
the temporary import. A developer's `live` worker reads and suggests to the hosted cache through
`CACHE_DB_CONNECTION_STRING` (root `README.md` § The categorization cache).

The lab pulls. `gbd_foodservice_insights_lab/cache_sync.py` overwrites the lab's three cache
files with the verified rows whenever step 1 starts with `CACHE_DB_CONNECTION_STRING` set, and on
`just pull-caches`; unset, step 1 runs on the files on disk and warns how old they are. Nobody in
the lab holds the string yet, so the lab still reads hand-copied files and writes its entree and
weight files locally.

What's left is the lab's pushes and the final import:

| Step | Stack | Needs |
| --- | --- | --- |
| PR 1 — the lab pushes, and stops writing its files | Python | the strings ready to hand out |
| Hand the data scientists the string | — | 1, the day it lands |
| The final import | — | GBD's final CSVs |
| PR 2 — delete the import | `packages/db`, docs | the final import |

Whichever of PRs 1 and 2 lands last deletes this plan.

## Context

**The lab's three caches**, gitignored CSVs in `python/lab/gbd_foodservice_insights_lab/data_files/`,
which a pull overwrites:

| Table | File | Loader | Written today by |
| --- | --- | --- | --- |
| `product_categorization` | `previously_categorized_items.csv` | `load_categorization_cache()` (`categorization/product_cache.py`) | nothing; copies are handed out |
| `entree_classification` | `previously_classified_entrees.csv` | `get_previously_classified_entrees()` (`categorization/entree_cache.py`), serving mode only | step 1, appending Gemini's unreviewed labels (`save_historical_entree_classifications`) |
| `unit_weight` | `previously_classified_weights.csv` | `get_previously_classified_weights()` (`clean_product_weights.py`) | a data scientist, by hand (`expand_historical_weight_classifications`) |

- **`cache_sync.py` describes each cache once**, in `CACHE_TABLES`: its table, its table-to-CSV
  column mapping (key first), and the loader's own path function. The pushes map columns back
  through the same mapping. `connect()` opens a short-lived autocommit connection as
  `application_name='lab-cache'`; every command opens one as `with connect() as connection:`,
  never in a notebook global, which the idle-session timeout would close. A failure the person
  running the lab must fix raises `CachePullError`.
- **The lab's database tests** use the `test_database` fixture in `python/lab/tests/conftest.py`:
  `postgres` on `.env.test`'s stack inside a forced rollback, skipped without `TEST_DB`. A test
  runs `SET LOCAL ROLE cache_client` to exercise the role's grants, and filters to a random
  prefix, since the test database is shared. It never reads `CACHE_DB_CONNECTION_STRING`, which
  on a developer's laptop is production. CI's `py-lab` job runs them against the migrated test
  stack, and runs on a migration change too.
- **The tables are the source of truth for their rules.** `002_caches.ts` holds the columns,
  the CHECKs every writer must satisfy, and `cache_client`'s grants; `tests/caches.test.ts`
  asserts each. In short: `cache_client` can `SELECT` the three tables and `INSERT` only the
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
  so harvests, lab pushes and Studio edits made before it are gone. GBD's final CSVs are a week
  or two away, as of 2026-10-18.
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
- **Pull writes the verified rows to the three files the loaders read**, so the loaders,
  runscripts and notebooks never touch the database, and runs work offline. Push is the only
  other place the lab talks to it. *Rejected: loaders that query the database directly.* Every
  run would need the network and a credential, and the gitignored notebooks that call the loaders
  would change behaviour.
- **Push inserts new rows unverified, and the lab's local cache writes go away.** Step 1 pushes
  `new_categorizations` and, for serving data, Gemini's entree labels; the weights step pushes
  instead of rewriting its file. All three are verified in Studio, by whoever holds dashboard
  access. *Rejected: pushing a hand-reviewed `_for_human_review.csv`.* First suggestion wins, so
  a correction made in the file is silently dropped whenever the product is already in the
  table.
- **The data scientists get the string the day PR 1 lands, and not before.** Each half is a loss
  without the other. The string alone: every step 1 pull overwrites the entree file the lab still
  appends to and the weights file a data scientist expands by hand, before anything can push
  either. PR 1 without the string: it ends those local writes, so a repeat serving run re-asks
  Gemini for every product the file would have gained. So PR 1 merges when the strings are ready
  to hand out.
- **`psycopg` is a lab dependency only.** The analysis library never touches the database.
- *Rejected: a role per person.* Revoking one person means `ALTER ROLE cache_client PASSWORD`
  and re-handing the string to everyone else, which is acceptable for a role that can only read
  three tables and suggest rows.
- **Open:** who verifies. On Free and Pro plans every dashboard role that can see data can also
  run any SQL, so the reviewer is a human decision, not a role this plan can create.
- **Open:** a reviewer's category typo in Studio is today only a WARNING in the run that skips
  the row. If that proves too quiet, a `gbd_category` reference table with an FK is the fix.

## PR 1 — the lab pushes, and stops writing its files

Merges when the strings are ready to hand out. Rehearse it beforehand against the dev stack as
`postgres`.

- `cache_sync.py`: `push_product_categorizations(connection, frame, suggested_by)`,
  `push_entree_classifications` and `push_unit_weights`.
  - Each runs `INSERT … ON CONFLICT DO NOTHING` in chunks, maps the columns back through
    `CACHE_TABLES`, and names only the columns `cache_client` may insert.
  - Before sending anything, each makes the rows pass the tables' CHECKs: products stripped as
    Python's `str.strip` does, and failing loudly over `MAX_CACHE_KEY_BYTES` in UTF-8; units kept
    verbatim, since the lab joins on them exactly; blank values and `NaN` weights as null.
- `spreadsheet.py`:
  - Step 1 pushes `categorized.new_categorizations` through `push_product_categorizations`. For
    serving data, it also pushes the Gemini-labelled products through
    `push_entree_classifications`. Both use `lab:<getpass.getuser()>`.
  - One `push_suggestions` flag replaces `update_historical_entree_classifications`. It is on by
    default when the variable is set, and skipped with a WARNING when it is not. Turning it off
    is how a prompt experiment keeps its answers out of the table, where the first suggestion
    would block the real one.
- These go:
  - `entree_cache.py`: `save_historical_entree_classifications`.
  - `entrees.py`: `build_entree_human_review_table` and the `_entree_for_human_review.csv` it
    feeds, for the same reason the product one is gone. The backfill script and
    `build_entree_cleaned_name_reuse_index` are unchanged.
- `clean_product_weights.py`: `expand_historical_weight_classifications` pushes instead of
  rewriting the file. Rename the 1.5 runscript's commented call to match.
- Tests:
  - The row mappers and validators.
  - A database round trip through `test_database`, as `cache_client`: a push lands unverified,
    and a second push of the same keys writes nothing.
  - `test_spreadsheet.py`'s serving test asserts the push, not a file write.
  - A test with `push_suggestions=False` asserts no push.
- Docs:
  - `python/lab/README.md` § Working on a client: step 1 suggests its new answers, someone verifies them in Studio, and
    the next pull brings the verified rows down.
  - `docs/requirements.md` § Product categorization cache names the lab's two caches under the same
    rule.
- If PR 2 has landed, this PR deletes this plan.

## Hand the data scientists the string

The day PR 1 lands. Check the composed string with `psql` first; the CA it points at is already
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
4. Merge PR 2, and start reviewing suggestions in Studio. Until now nobody reviews unverified
   rows, since this import deletes them.

## PR 2 — delete the import

- Deletes `packages/db/scripts/temporary-go-live-cache-import/`, `@gbd/db`'s
  `temporary-go-live-cache-import` script, and the root `README.md`'s link to it at the end of
  § The categorization cache.
- If PR 1 has landed, it deletes this plan. Otherwise it removes this PR and § The final
  import.

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

PR 1: `just lint && just check && just test && TEST_DB=1 just test-lab`. PR 2:
`pnpm lint && pnpm check && pnpm test`.

By hand, once PR 1 is in and the string is out: `just pull-caches` writes three files whose row
counts match the verified counts in Studio; a step 1 run's new categorizations appear in Studio
unverified as `lab:<user>`; a second run of the same file adds nothing.
