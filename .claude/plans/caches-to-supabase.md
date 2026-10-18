# Caches to Supabase

## Where this stands (2026-10-18)

The product side is done and live. `packages/db/migrations/002_caches.ts` created
`product_categorization`, `entree_classification`, `unit_weight` and the `cache_client` role.
The worker reads the verified product rows on every claim and inserts what its LLM categorized
as unverified suggestions. Production runs `live` on the interim copy of GBD's caches, loaded by
the temporary import. A developer's `live` worker reads and suggests to the hosted cache through
`CACHE_DB_CONNECTION_STRING` (root `README.md` § The categorization cache).

What's left is the lab, which still reads and writes hand-copied CSVs, and the final import:

| Step | Stack | Needs |
| --- | --- | --- |
| PR 1 — the lab pulls | Python | — |
| PR 2 — the lab pushes, and stops writing its files | Python | 1, and the strings ready to hand out |
| Hand the data scientists the string | — | 2, the day it lands |
| The final import | — | GBD's final CSVs |
| PR 3 — delete the import | `packages/db`, docs | the final import |

Whichever of PRs 2 and 3 lands last deletes this plan.

## Context

**The lab's three caches**, gitignored CSVs in `python/lab/gbd_foodservice_insights_lab/data_files/`:

| Table | File | Loader | Written today by |
| --- | --- | --- | --- |
| `product_categorization` | `previously_categorized_items.csv` | `load_categorization_cache()` (`categorization/product_cache.py`) | nothing; copies are handed out |
| `entree_classification` | `previously_classified_entrees.csv` | `get_previously_classified_entrees()` (`categorization/entree_cache.py`), serving mode only | step 1, appending Gemini's unreviewed labels (`save_historical_entree_classifications`) |
| `unit_weight` | `previously_classified_weights.csv` | `get_previously_classified_weights()` (`clean_product_weights.py`) | a data scientist, by hand (`expand_historical_weight_classifications`) |

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
- **Pull writes the verified rows to the three files the loaders read today**, so every loader,
  runscript, notebook and `LLM_testing.py` is unchanged, runs work offline, and a data scientist
  can still open the file. Step 1 pulls at start, so freshness needs no discipline. *Rejected:
  loaders that query the database directly.* Every run would need the network and a credential,
  and the gitignored notebooks that call the loaders would change behaviour.
- **Push inserts new rows unverified, and the lab's local cache writes go away.** Step 1 pushes
  `new_categorizations` and, for serving data, Gemini's entree labels; the weights step pushes
  instead of rewriting its file. All three are verified in Studio, by whoever holds dashboard
  access. *Rejected: pushing a hand-reviewed `_for_human_review.csv`.* First suggestion wins, so
  a correction made in the file is silently dropped whenever the product is already in the
  table.
- **The data scientists get the string the day PR 2 lands.** Each half is a loss without the
  other. PR 1 alone: every step 1 pull overwrites the entree file the lab still appends to and
  the weights file a data scientist expands by hand, before PR 2 can push either. PR 2 without
  the string: it ends those local writes, so a repeat serving run re-asks Gemini for every
  product the file would have gained. So PR 1 merges any time, and PR 2 merges when the strings
  are ready to hand out.
- **`psycopg` is a lab dependency only.** The analysis library never touches the database.
- *Rejected: a role per person.* Revoking one person means `ALTER ROLE cache_client PASSWORD`
  and re-handing the string to everyone else, which is acceptable for a role that can only read
  three tables and suggest rows.
- **Open:** who verifies. On Free and Pro plans every dashboard role that can see data can also
  run any SQL, so the reviewer is a human decision, not a role this plan can create.
- **Open:** a reviewer's category typo in Studio is today only a WARNING in the run that skips
  the row. If that proves too quiet, a `gbd_category` reference table with an FK is the fix.

## PR 1 — the lab pulls

- `python/lab/pyproject.toml` gains `psycopg[binary]>=3.3,<4`; 3.3.6 ships `cp314` wheels
  (checked 2026-10-18). The frames are built from cursor rows. *Rejected: `pandas.read_sql`.*
  It wants SQLAlchemy for any driver but `sqlite3`, and warns on a bare psycopg connection.
- `gbd_foodservice_insights_lab/cache_sync.py`:
  - `CACHE_TABLES` describes each cache once: its table, its table-to-CSV column mapping (key
    first), and the loader's own path function, looked up at call time so each path keeps one
    definition. The renamed columns:

    | Table column | CSV column |
    | --- | --- |
    | `cleaned_name` | `cleaned_item_names` |
    | `classification` | `entree_classification` |
    | `cleaned_unit` | `llm_cleaned_unit` |
    | `extracted_weight` | `llm_extracted_weight` |

  - `connect()` reads `CACHE_DB_CONNECTION_STRING` from the environment, which the caller has
    loaded from `.env`, and fails naming the variable and the lab README when it is unset. It
    passes `autocommit=True`, so a connection never sits idle in a transaction;
    `connect_timeout=10`, since libpq otherwise waits indefinitely on an unreachable host; and
    `application_name='lab-cache'`, beside the worker's `worker-cache` in `pg_stat_activity`.
    psycopg reads the string's `sslmode` and `sslrootcert` itself. Every command opens it as
    `with connect() as connection:`, never in a notebook global, which the idle-session timeout
    would close.
  - `pull(connection)` runs `SELECT <columns> FROM <table> WHERE is_verified ORDER BY <key>`
    for each table, composed with `psycopg.sql` identifiers, then writes each CSV through
    `tempfile.mkstemp` in `data_files/` and `Path.replace`, so a reader or a concurrent pull never
    sees half a file. It fetches all three before writing any, so a failed query leaves every
    file as it was. `ORDER BY` keeps a re-pull diffable. Nulls need no mapping: `to_csv` writes
    them empty, which every loader already reads as missing. It logs the database once as
    `user@host:port/dbname` from `connection.info`, never the password, and each table's row
    count and file.
  - `pull_caches_if_configured()` is what step 1 calls. Set, it connects and pulls, and
    re-raises a `psycopg.Error` (chained) as one that names the variable and says to comment it
    out to run on the files on disk. Unset, it logs one WARNING naming the variable and each
    file's age in days, or that it is missing.
  - `python -m gbd_foodservice_insights_lab.cache_sync` loads `.env` with
    `find_dotenv(usecwd=True)`, as the runscripts do, and pulls; `just pull-caches` runs it.
    *Rejected: a `pull` verb.* PR 2's pushes run inside step 1, so pull is the module's only
    command.
- `1. Categorize Runscript.py` calls `pull_caches_if_configured()` right after `load_dotenv`,
  before it builds any API client. Step 0.5 launches that runscript as a subprocess, so it pulls
  too. The loaders do not change.
- Tests:
  - **One database round trip.** A lab `conftest.py` fixture connects to `.env.test`'s
    `DB_CONNECTION_STRING`, read with `dotenv_values`, and yields the connection inside
    `transaction(force_rollback=True)`: the Python counterpart of `withRollback`, which the root
    README § Tests and the database requires. Without `TEST_DB` it skips, naming the variable.
    The test inserts, as `postgres`, a verified and an unverified row in each table under a
    random prefix: a product with a comma, a quote and a newline, a null cleaned name, a null
    weight, and a unit with surrounding whitespace. It then runs `SET LOCAL ROLE cache_client`,
    pulls into `tmp_path` (the three path functions monkeypatched), and reads each file back
    through its loader. It filters to its prefix, since the test database is shared, and asserts
    only the verified rows came back, with their values intact. That covers the SQL, the role's
    `SELECT` grant, the column mapping, and the loaders reading what `pull` writes.
    - It never sees `CACHE_DB_CONNECTION_STRING`. On a developer's laptop that string points at
      production, where `cache_client` could not delete what a test inserted.
    - *Rejected: a `db` pytest marker.* The fixture's skip already says why, and nothing selects
      by it.
    - *Rejected: separate tests of the frame builders.* With no null mapping, a builder is a
      rename; tested alone, it re-tests pandas.
  - **`pull_caches_if_configured`, without a database.** Unset: the exact WARNING, with one file
    three days old (`os.utime`) and two missing. Set to `postgresql://nobody@127.0.0.1:1/x`: a
    real refused connection raises the error naming the variable. Set and reachable:
    `connect` and `pull` monkeypatched, asserting `pull` gets the connection.
  - `test_runscript.py`'s existing test records the pull and the categorize call, and asserts
    the pull comes first.
- CI, which only ever reaches the local test stack, never the hosted cache:
  - `py-lab` sets `TEST_DB: '1'` job-wide and, after `just lint` so lint still fails fast,
    gains `setup-node`, `setup-supabase` and `pnpm migrate`. On a recent run `py-lab` took about
    25 s, `setup-node` 19 s and `setup-supabase` 68 s, so the job becomes about 2 minutes. It runs
    beside the other jobs, so only a lab-only PR waits longer.
  - `.github/filters.yml`'s `python_lab` filter starts matching `packages/db/migrations/**`.
    `ts_workspace` excludes all of `packages/**`, and `check_filters.py` uses git's glob, which
    has no extglob, so `'!packages/**'` moves out of the anchor into `python`, and `python_lab`
    lists one exclusion per other path: the four other packages, then `packages/db/*`,
    `packages/db/scripts/**`, `packages/db/src/**` and `packages/db/tests/**`. A migration PR
    already runs the long TypeScript jobs, so this adds no wall-clock time there; without it, a
    migration that breaks the pull is caught only by the merge queue, which runs everything. A
    new package triggers `py-lab` until someone excludes it, which fails safe.
- Docs:
  - `python/lab/README.md` § Working on a client: the "handed out privately" paragraph becomes:
    with the string (ask GBD; put it in `.env` as `CACHE_DB_CONNECTION_STRING`, in the form
    `.env.example` shows, CA path absolute), step 1 pulls at start and stops if it cannot;
    `just pull-caches` pulls on demand; a pull overwrites the three files, hand edits included.
    Without the string, the files are handed out as today, and each step 1 warns how old they
    are.
  - The lab's `data_files/README.md`: the files are pulled, or handed out until you hold the
    string, and are never committed.
  - `python/README.md` § Testing: the lab's database tests run only with `TEST_DB=1`, against
    the running, migrated test stack (root README § The two databases).
  - `.env.example`'s `CACHE_DB_CONNECTION_STRING` comment names the lab too.
  - The root `README.md` § The categorization cache gains one line: the lab reads the same
    variable, linking `python/lab/README.md`.
- Rehearse: after a local `--mirror` import, set the variable to the dev stack as `postgres`.
  `just pull-caches` writes three files whose row counts match the import's, and a categorize
  run on `test_data/` reads them. Point it at `127.0.0.1:1` and step 1 stops with the message.
  Run `TEST_DB=1 just test-lab` against the test stack.

## PR 2 — the lab pushes, and stops writing its files

Merges when the strings are ready to hand out. Rehearse it beforehand against the dev stack as
`postgres`.

- `cache_sync.py`: `push_product_categorizations(connection, frame, suggested_by)`,
  `push_entree_classifications` and `push_unit_weights`.
  - Each runs `INSERT … ON CONFLICT DO NOTHING` in chunks, maps the columns back, and names only
    the columns `cache_client` may insert.
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
  - A database round trip, as `cache_client`: a push lands unverified, and a second push of the
    same keys writes nothing.
  - `test_spreadsheet.py`'s serving test asserts the push, not a file write.
  - A test with `push_suggestions=False` asserts no push.
- Docs:
  - `python/lab/README.md` and the lab's `data_files/README.md` drop PR 1's hand-out fallback.
  - § Working on a client: step 1 suggests its new answers, someone verifies them in Studio, and
    the next pull brings the verified rows down.
  - `REQUIREMENTS.md` § Product categorization cache names the lab's two caches under the same
    rule.
- If PR 3 has landed, this PR deletes this plan.

## Hand the data scientists the string

The day PR 2 lands. Check the composed string with `psql` first; the CA it points at is already
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
4. Merge PR 3, and start reviewing suggestions in Studio. Until now nobody reviews unverified
   rows, since this import deletes them.

## PR 3 — delete the import

- Deletes `packages/db/scripts/temporary-go-live-cache-import/`, `@gbd/db`'s
  `temporary-go-live-cache-import` script, and the root `README.md`'s link to it at the end of
  § The categorization cache.
- If PR 2 has landed, it deletes this plan. Otherwise it removes this PR and § The final
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

Each PR: `just lint && just check && just test && TEST_DB=1 just test-lab`, plus
`pnpm lint && pnpm check && pnpm test` for PR 3.

By hand, once PR 2 is in and the string is out: `just pull-caches` writes three files whose row
counts match the verified counts in Studio; a step 1 run's new categorizations appear in Studio
unverified as `lab:<user>`; a second run of the same file adds nothing.
