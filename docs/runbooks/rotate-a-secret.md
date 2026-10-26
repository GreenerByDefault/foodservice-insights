# Rotate a secret

Every production credential is a secret in the `production` GitHub Environment, under the name
[`deploy.yml`](../../.github/workflows/deploy.yml) uses for it. Rotating one always takes the same
steps; each credential's section below says where to mint it and anything that differs.

1. Mint the new value at the vendor, and leave the old one working.
2. Store it in GitHub under
   [**Settings → Environments**](https://github.com/GreenerByDefault/foodservice-insights/settings/environments)
   → `production`: edit the secret, paste the new value, and save.
3. Redeploy both apps, since each reads its secrets only when it is deployed. The web app
   redeploys on the next push to `main`; to redeploy it sooner, re-run the latest Deploy run,
   which works only while `main` is still at that run's commit. The worker redeploys only when you
   dispatch [Deploy](https://github.com/GreenerByDefault/foodservice-insights/actions/workflows/deploy.yml)
   from Actions. A secret that only CI uses needs no redeploy; its section says how to check it
   instead.
4. Only then delete the old value at the vendor.

Warning: rolling back a deployment in DigitalOcean also restores that deployment's env, which
undoes any rotation since.

## The DigitalOcean deploy token

CI uses `DIGITALOCEAN_ACCESS_TOKEN` to update both apps; neither app holds it. The token never
expires, so rotate it only when it may have leaked, when its creator leaves GBD's DigitalOcean
team, or when its scopes need to change.

To mint it:

1. Log in to the [DigitalOcean dashboard](https://cloud.digitalocean.com) as GBD staff who will
   stay on GBD's team, and switch to that team. A token works only within the team it was created
   in, and stops working when its creator leaves that team.
2. Go to **API → Personal access tokens → Generate New Token**. Name it, and set no expiration.
3. Choose **Custom Scopes** and select `app:read`, `app:update`, `regions:read`, `sizes:read`, and
   `actions:read`. DigitalOcean requires the last three alongside `app:update`
   ([docs](https://docs.digitalocean.com/reference/api/scopes/app/update/)). Leave off the
   optional associated scopes, and `app:create` and `app:delete` too.
4. Click **Generate Token** and copy it. DigitalOcean shows it only once.

Then continue from shared step 2. At step 3, instead of redeploying, check the token by
dispatching Deploy on `main` at a quiet time, since that restarts the worker. If the worker job
passes, the token works.
