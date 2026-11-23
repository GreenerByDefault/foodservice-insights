# Change a user's email

When a user is locked out of the address they sign in with and asks GBD to change it
([`docs/requirements.md`](../requirements.md) § Account recovery). They keep their account, their
organizations and their reports.

## Steps

1. **Verify them out of band.** Anyone can claim an address, so ask them to name their
   organization and reports they ran recently, and check those in the app.
2. **Run this** as [Write to the database by hand](write-to-the-database-by-hand.md) describes,
   with both addresses in lowercase. Supabase's Users page cannot change an email, and Supabase
   Auth keeps the address in two tables, so update both:

   ```sql
   begin;
   set local gbd.writer = 'manual:<your name>';
   update auth.identities
   set identity_data = jsonb_set(identity_data, '{email}', to_jsonb('<new email>'::text))
   where provider = 'email'
     and user_id = (select id from auth.users where email = '<old email>');
   update auth.users set email = '<new email>' where email = '<old email>';
   commit;
   ```

   Each `update` should change one row. If either changed none, check the old address and run it
   again.
3. **Re-send any invite still pending for the old address.** Invites match on the address, so an
   admin of that organization must invite the new one.

## How you know it worked

They sign in with the new address and see their organizations and reports. The old address can
no longer sign in to this account.
