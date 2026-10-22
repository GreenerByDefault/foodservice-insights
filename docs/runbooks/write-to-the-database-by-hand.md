# Write to the database by hand

The database refuses writes and schema changes from Supabase Studio, locally as well as in
production, apart from [reviewing the caches](review-cache-suggestions.md). For anything else, such as making someone a
superadmin, run one transaction in the SQL editor that marks itself as a deliberate writer:

```sql
begin;
set local gbd.writer = 'manual:<your name>';
update app_user set is_superadmin = true
where id = (select id from auth.users where email = '<their email>');
commit;
```

Always `set local` inside the transaction, never a bare `set`: the dashboard may reuse its
connection, and a session-level mark would leave it unguarded for whoever runs SQL next.

If the guard itself misbehaves, this is also how to get past it: `drop event trigger
forbid_unmarked_ddl`, or `create or replace function require_marked_writer`. Then fix it in a
migration.
