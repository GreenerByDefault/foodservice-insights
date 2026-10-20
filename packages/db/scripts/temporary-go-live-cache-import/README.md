# Temporary go-live cache import

Loads GBD's three cache CSVs into `product_categorization`, `entree_classification` and
`unit_weight` as verified rows, when the caches move to Supabase
([`.claude/plans/caches-to-supabase.md`](../../../../.claude/plans/caches-to-supabase.md) § The final import):
first an interim copy, then GBD's final one, which replaces it. It is also how a developer
without the hosted cache loads a CSV into their local database.
**This directory is deleted as soon as the final production import is checked.** After that,
rows reach the tables only through the worker's harvest, the lab's push, or Studio. Don't build
on it.

## What it does

Every file you pass is imported in one transaction, so either everything lands or nothing does.
Before connecting, it prints what it cleaned, skipped and refused for each file, with line
numbers:

- **skipped**: rows nobody could use (a blank product or category) and earlier repeats of a
  product, since the last one wins. The import still runs.
- **rewrote**: values it fixed, such as a category that is a known one in the wrong case.
- **REFUSED**: rows only a person can fix, such as an unknown category. Nothing is written,
  except by a local `--mirror` run, which leaves them out. Send the lines back to whoever owns
  the CSV, and run again on the fixed file.

Then it prints, per table, how many rows it deleted (with `--mirror`), inserted, promoted from
an unverified suggestion, and left alone because they were already verified. Without
`--mirror`, a re-run never overwrites a verified row, so running the same file twice writes
nothing the second time. Without `--write`, it rolls everything back after printing those
counts.

## Running it locally

Safe. It writes to the database in `.env`'s `DB_CONNECTION_STRING`, and refuses any that isn't
on this machine. Relative paths are relative to where you run the command.

To load your local cache, pass `--mirror`, and run it again whenever the CSVs change or the dev
database is emptied (a fresh clone, `pnpm truncate`, `scripts/supabase db reset`). Every worktree
shares the dev database, so once per machine is enough.

```sh
pnpm --filter @gbd/db temporary-go-live-cache-import --mirror --write \
  --products <csv> --entrees <csv> --units <csv>      # pass any of the three
```

`--mirror` makes each table exactly the file's usable rows, as reading the CSV did: it deletes
every row of each table it imports first, verified or not, and imports around refused rows
instead of stopping.

To check a new CSV the way production will see it, run without `--mirror` or `--write`; that dry
run stops on any refused row.

## Running it against production

A big deal: these rows become the cache every production report uses, and anything wrong in
them blocks the pipeline from ever suggesting a fix for those products. Do a clean local dry run
first.

1. Get the direct connection string, as `postgres`, from the Supabase dashboard's Connect
   dialog, exactly as it shows it: no query parameters, which the script refuses. It verifies the
   server against the repo's `supabase-ca.crt` itself. It needs the project's IPv4 add-on, or an
   IPv6 network.
2. Run with `--production --mirror` from your own terminal. It ignores `.env` and asks you to
   paste the connection string; what you paste is not shown, and it never reaches `.env` or
   shell history. It refuses to run without an interactive terminal, so an agent cannot run it.

   ```sh
   pnpm --filter @gbd/db temporary-go-live-cache-import --production --mirror \
     --products <csv> --entrees <csv> --units <csv>
   ```

   `--mirror` deletes every row of the three tables first, harvested suggestions and Studio
   edits included, so production holds exactly the files. That is right only until the final
   import, while nobody reviews production's rows. In production it still stops on a refused
   row.
3. Read the report. Repeat until nothing is refused and every skip makes sense.
4. Run the same command with `--write`. It prints the counts with the transaction still open
   and commits only if you type `COMMIT`; anything else rolls back. Until you answer, a worker run that
   suggests one of the imported products waits on you, as does a deploy whose migration alters
   these tables, so don't run it during a deploy or leave the prompt sitting.
5. Check each table's count in Studio against the CSV's rows minus the reported skips, and
   spot-check a `No Matches Found` row and a product that spans lines.
