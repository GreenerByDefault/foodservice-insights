# Rotate a secret

Every production credential is a secret in the `production` GitHub Environment, under the name
[`deploy.yml`](../../.github/workflows/deploy.yml) uses for it, except the two in the last
sections below. The Environment's variables are not secrets and never need rotating.

## If a secret may have leaked

1. **Rotate it now**, before you confirm the leak. A needless rotation costs minutes.
2. **Rotate what it reaches.** `DB_CONNECTION_STRING` logs in as `postgres`, which can set any
   role's password, so rotate `cache_client` and `METRICS_DB_CONNECTION_STRING` with it.
3. **Find the copy that leaked.** GitHub never shows a stored secret again, so the leak is a copy
   made elsewhere: a laptop's `.env`, a paste into a chat or a ticket, or the vendor itself.
4. **Check what it did meanwhile** in the vendor's own activity, usage or log pages: for a
   database credential, Supabase's Postgres logs.

## The steps every rotation shares

1. Mint the new value at the vendor, and leave the old one working.
2. Store it in GitHub under
   [**Settings → Environments**](https://github.com/GreenerByDefault/foodservice-insights/settings/environments)
   → `production`: edit the secret, paste the new value, and save.
3. Redeploy both apps, since each reads its secrets only when it is deployed. The web app
   redeploys on the next push to `main`; to redeploy it sooner, re-run the latest Deploy run,
   which works only while `main` is still at that run's commit. Then
   [deploy the worker](deploy-the-worker.md). A secret only CI uses needs no redeploy; check it
   instead by the next Deploy run passing the step that uses it.
4. Only then delete the old value at the vendor.

| Secret | Mint it at | What differs |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | [Anthropic](https://platform.claude.com) → the production workspace → API keys | Only the worker uses it, so deploy only the worker |
| `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` | [Supabase](https://supabase.com/dashboard/projects) → the production project → Storage → S3 access keys → New access key | A pair: replace both secrets before redeploying |
| `BETTER_STACK_TOKEN` | [Better Stack Telemetry](https://telemetry.betterstack.com) → Sources → the source | Set up a new Source in Better Stack, then connect it to Digital Ocean, by following [this guide](https://betterstack.com/docs/logs/digital-ocean-apps/#set-up-better-stack-digital-ocean-source) |
| `POSTMARK_SERVER_TOKEN` | [Postmark](https://account.postmarkapp.com) → the production server → API Tokens → Generate | A server holds at most three tokens |
| `GRAFANA_TOKEN` | [Grafana Cloud](https://grafana.com/auth/sign-in) → GBD's stack → Administration → Users and access → Service accounts → the deploy account → Add service account token | CI only: "Push dashboards to Grafana Cloud" |
| `METRICS_DB_CONNECTION_STRING` | Supabase's SQL editor, as the header of [`apps/grafana/scripts/deploy.ts`](../../apps/grafana/scripts/deploy.ts) says | `ALTER ROLE` ends the old password at once, so the dashboards fail until the next Deploy run |

## `DB_CONNECTION_STRING`, the `postgres` password

Supabase's reset ends the old password at once, so shared step 1 cannot hold: from the reset
until each app redeploys, any new database connection fails. Do it at a quiet time, in one
sitting.

1. [Supabase](https://supabase.com/dashboard/projects) → the production project → Project
   Settings → Database → Reset database password.
2. In the project's **Connect** dialog, copy the direct connection's URI, not the pooler's, and
   put the new password in it. Store that as the secret.
3. Redeploy both apps, as in shared step 3. The web app's Deploy run migrates with the new string
   first, so a wrong one fails there, before anything deploys.

## `DIGITALOCEAN_ACCESS_TOKEN`

CI uses it to update both apps; neither app holds it. The token never expires, so rotate it only
when it may have leaked, when its creator leaves GBD's DigitalOcean team, or when its scopes need
to change.

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
[deploying the worker](deploy-the-worker.md). If the run passes, the token works.

## `DEPLOY_TAGS_SSH_KEY`

The private half of a deploy key with write access. A tag ruleset lets only deploy keys move the
`deploy/*` tags, and the worker deploys the commit `deploy/web` names, so this key decides what
the worker can deploy. Every deploy key with write access can move those tags: never give another
one write access.

1. In a scratch directory, run `ssh-keygen -t ed25519 -N '' -C deploy-tags -f deploy-tags`.
2. Add `deploy-tags.pub` under the repo's
   [**Settings → Deploy keys**](https://github.com/GreenerByDefault/foodservice-insights/settings/keys),
   with write access, beside the old key, so a Deploy run already in flight can still move its
   tag.
3. Store the whole of `deploy-tags`, every line, as the secret. Then delete both files.
4. Nothing redeploys. Once the next Deploy run's "Move the deploy/web tag" step passes, delete the
   old deploy key.

## The `cache_client` password

Not in the Environment: production never uses it. Developers and data scientists use it to share
production's categorization cache, and it is one password shared by all of them
([`002_caches.ts`](../../packages/db/migrations/002_caches.ts)). So rotate it when anyone who held
it leaves, as well as on a leak.

1. Generate a password of letters and digits only, since it goes inside a URL.
2. In Supabase's SQL editor, run `alter role cache_client password '<the password>';`. The write
   guard allows it. The old password stops working at once.
3. Put it into a string of the form `.env.example` shows for `CACHE_DB_CONNECTION_STRING`, with
   the project's direct host from the **Connect** dialog, and hand it to each holder privately,
   never in email or a shared chat. Each follows
   [`apps/worker/README.md`](../../apps/worker/README.md) § The categorization cache. Until they
   do, their `live` worker and the lab cannot reach the cache.

## Postmark's `auth` SMTP token

Supabase Auth sends sign-in codes with it, so it lives only in Supabase's SMTP settings and
nothing redeploys.

1. [Postmark](https://account.postmarkapp.com) → the production server → the `auth` stream →
   Settings → Generate an SMTP token. The secret key is shown only once.
2. [Supabase](https://supabase.com/dashboard/projects) → the production project → Authentication
   → SMTP Settings: the access key is the username, the secret key the password. Save.
3. Sign in to the app with a fresh code. When it arrives, delete the old token in Postmark.
