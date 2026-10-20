# Runbooks

## Context

Some operations are done by hand in a vendor's dashboard, and nothing in the code records how. This
plan collects them until we decide where runbooks belong. **Open:** where that is (a `docs/`
folder, beside the config each one touches, or somewhere outside the repo) and what format they
take. When it's settled, move each entry below to its new home and delete this plan.

## Entries

### Rotate the DigitalOcean deploy token

CI deploys with `DIGITALOCEAN_ACCESS_TOKEN`, a secret in the `production` GitHub Environment. The
token belongs to whoever created it, so it stops working when it expires or when that person
leaves the DigitalOcean team.

1. In the DigitalOcean dashboard, switch to the nonprofit's team. A token only works within the
   team it was created in.
2. Go to **API → Personal access tokens → Generate New Token**.
3. Give it a name, and a fixed expiration rather than none. Set a calendar reminder to rotate it
   before it expires.
4. Choose **Custom Scopes** and select `app:read`, `app:update`, `regions:read`, `sizes:read`, and
   `actions:read`. DigitalOcean requires the last three alongside `app:update`
   ([docs](https://docs.digitalocean.com/reference/api/scopes/app/update/)). Leave off the
   optional associated scopes, along with `app:create` and `app:delete`: CI only updates apps that
   already exist. `doctl apps update --wait` updates the app, polls the deployment, and reads the
   app, and nothing more.
5. Click **Generate Token** and copy it. DigitalOcean shows it only once.
6. Store it from the repo, which prompts for the value so it stays out of shell history:

   ```sh
   gh secret set DIGITALOCEAN_ACCESS_TOKEN --env production
   ```

7. Check that it works by reading an app with it. The app IDs are the Environment's
   `DO_WEB_APP_ID` and `DO_WORKER_APP_ID`:

   ```sh
   read -s "DO_TOKEN?Paste the DigitalOcean token, then press Enter: "; echo
   curl -s -H "Authorization: Bearer $DO_TOKEN" \
     "https://api.digitalocean.com/v2/apps/<app id>" | jq '.app | {id, default_ingress} // .'
   unset DO_TOKEN
   ```

8. Delete the old token in the dashboard.

### Review cache suggestions in Supabase Studio

The worker, and later the lab, insert unverified rows into `product_categorization`,
`entree_classification` and `unit_weight`. Only verified rows are ever used.

1. Open the table in Studio's Table Editor and filter on `is_verified = false`, sorted by
   `created_at`. `suggested_by` says where a row came from.
2. Fix `category` (or the label, or the weight) in place if it's wrong, then tick `is_verified`.
   The next worker claim and the next lab pull pick it up.
3. To reject a suggestion, leave it unverified. To have the pipeline suggest again, delete it.
   To verify many rows at once, run an `UPDATE` in the SQL editor. `TRUNCATE` is refused.

### Write to the database by hand

The database refuses writes and schema changes from Supabase Studio, locally as well as in
production, apart from reviewing the caches above. For anything else, such as making someone a
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
