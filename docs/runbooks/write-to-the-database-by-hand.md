# Write to the database by hand

The database refuses writes and schema changes made from Supabase Studio, locally as well as in
production. [Reviewing cache suggestions](review-cache-suggestions.md) is the one exception. For
anything else, mark your transaction as a deliberate write.

## Where to run it

- **Production:** [Supabase](https://supabase.com/dashboard/projects) → the production project →
  SQL Editor.
- **Locally:** the dev stack's Studio → SQL Editor. Its address is in the
  [root README](../../README.md) § Signing in for real.

## Steps

1. Write the statements you need.
2. Wrap them in this template, replacing `<your name>` and the comment:

   ```sql
   begin;
   set local gbd.writer = 'manual:<your name>';
   -- your statements
   commit;
   ```

3. Run the whole block at once in the SQL Editor.

Always use `set local` inside the transaction, never a bare `set`.

If the write is refused with a hint naming this runbook, the transaction was not marked: check
that the `set local` line ran in the same block as your statements.

## Example: make someone a superadmin

```sql
begin;
set local gbd.writer = 'manual:<your name>';
update app_user set is_superadmin = true
where id = (select id from auth.users where email = '<their email>');
commit;
```

If the guard refuses something it should allow, fix it in a migration. Never drop or replace the
guard by hand: production would stay unguarded, and its schema would drift from the migrations.
