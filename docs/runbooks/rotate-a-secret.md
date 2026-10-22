# Rotate a secret

Every production credential is a secret in the `production` GitHub Environment; its name is in
[`deploy.yml`](../../.github/workflows/deploy.yml). Every rotation takes the same steps:

1. Mint the new value at the vendor, as the credential's section below says. Leave the old one
   working.
2. Store it from the repo, which prompts for the value so it stays out of shell history:

   ```sh
   gh secret set <NAME> --env production
   ```

3. Redeploy both apps, since each receives its secrets only at deploy. The web redeploys on the
   next push to `main`, or re-run the latest Deploy run while `main` is still at its commit: once
   `main` has moved on, a re-run skips itself. The worker redeploys only when you dispatch Deploy
   from Actions.
4. Only then delete the old value at the vendor.

A rollback in DigitalOcean restores that deployment's env too, so it undoes any rotation since.

## The DigitalOcean deploy token

`DIGITALOCEAN_ACCESS_TOKEN`, with which CI updates both apps. Rotate it when it may have leaked,
when the person who created it leaves the DigitalOcean team, or when its scopes need to change.

1. In the DigitalOcean dashboard, switch to GBD's team, logged in as GBD staff who will stay on
   it. A token only works within the team it was created in, and stops working when its creator
   leaves that team.
2. Go to **API → Personal access tokens → Generate New Token**.
3. Give it a name, and no expiration. An expiry would surface months later as a failed deploy,
   after the migrate step has already run.
   *Rejected: an expiring token with a calendar reminder,* which lands on a part-time maintainer,
   and a rotation done once a year is where a mis-scoped token comes from.
4. Choose **Custom Scopes** and select `app:read`, `app:update`, `regions:read`, `sizes:read`, and
   `actions:read`. DigitalOcean requires the last three alongside `app:update`
   ([docs](https://docs.digitalocean.com/reference/api/scopes/app/update/)). Leave off the
   optional associated scopes, along with `app:create` and `app:delete`: CI only updates apps that
   already exist. `doctl apps update --wait` updates the app, polls the deployment, and reads the
   app, and nothing more.
5. Click **Generate Token** and copy it. DigitalOcean shows it only once.
6. Store it as `DIGITALOCEAN_ACCESS_TOKEN`, step 2 above. Neither app holds it, so nothing
   redeploys.
7. Check that it works by reading an app with it. The app IDs are the Environment's
   `DO_WEB_APP_ID` and `DO_WORKER_APP_ID`:

   ```sh
   read -s "DO_TOKEN?Paste the DigitalOcean token, then press Enter: "; echo
   curl -s -H "Authorization: Bearer $DO_TOKEN" \
     "https://api.digitalocean.com/v2/apps/<app id>" | jq '.app | {id, default_ingress} // .'
   unset DO_TOKEN
   ```

8. Delete the old token in the dashboard.
