# Restore the database

When data is lost or corrupted and fixing forward cannot repair it. A restore throws away
everything since the backup: every report, sign-up and change, in the app and in Supabase Auth.

## Steps

1. Follow [Supabase's guide to restoring a backup](https://supabase.com/docs/guides/platform/backups),
   from [Supabase](https://supabase.com/dashboard/projects) → the production project → Database →
   Backups.
2. **As soon as it finishes, redeploy the web app** by re-running the latest
   [Deploy](https://github.com/GreenerByDefault/foodservice-insights/actions/workflows/deploy.yml)
   run, or pushing to `main`. Any migration that landed after the backup is now unapplied, while
   the running code expects it; the deploy migrates first.
3. **Delete again any organization deleted since the backup.** Its rows come back, but its files
   do not, and its admin asked for it to be gone.

## What the backup leaves out

The blob store is outside it. Files uploaded since the backup stay in storage with no row
pointing at them, which is harmless. An analysis that was `processing` comes back `processing`,
with no worker holding it; once its lease expires, a worker marks it `failed('abandoned')`.

## How you know it worked

The deploy succeeded, and you can sign in and open a recent report from before the backup.
