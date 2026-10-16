# Hosting on DigitalOcean App Platform

## Context

The team chose DigitalOcean App Platform
([analysis](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/hosting-provider.md)),
and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Hosting records the choice. This plan connects
the existing deploy pipeline to it.

The pipeline itself is already built. [`deploy.yml`](../../.github/workflows/deploy.yml) builds
both images on every push to `main` and pushes them to GHCR as public packages. It migrates the
database, and [`actions/deploy-service`](../../.github/actions/deploy-service/action.yml) resolves
the commit to an image digest. That action's last step is a stub that only prints a warning.

Each service is its own App Platform app, described in full by its spec:
[`.do/web.yaml`](../../.do/web.yaml) and [`.do/worker.yaml`](../../.do/worker.yaml). Two apps,
because DigitalOcean documents no way to deploy one component of an app, so in one app every push to
`main` would restart the worker. What is missing is the apps themselves and the deploy step that
submits those specs.

Other plans own these pieces:

- **Our own domain and Cloudflare**: [`cloudflare-and-domain.md`](cloudflare-and-domain.md). Until
  it lands, the web app is served from its App Platform starter domain.
- **The specs' `alerts:` and alert destinations**: [`alerts.md`](alerts.md). **`log_destinations:`**:
  [`logs.md`](logs.md). Both add to the specs, and both pass their tokens the same way as every
  other secret (§ Secrets).
- **Postmark's credentials**: [`email-provider.md`](email-provider.md) adds them the same way.

DigitalOcean facts, read from its docs and the `doctl` source on 2026-10-14:

- **An update replaces the whole app spec.** `PUT /v2/apps` and `doctl apps update --spec` both
  submit one. The next deploy removes anything the spec leaves out, whether an env var, an alert,
  or a log destination. A setting changed in the dashboard lasts only until that deploy.
- **`doctl apps update <id> --spec <file> --wait` exits nonzero when the deployment fails**, and
  gives up after 30 minutes. It does not substitute variables. `--spec -` reads the spec from stdin.
- **A deploy whose new web instance never passes `health_check` fails and rolls back.**
- **Rollback** can restore any of the last 10 successful deployments, including that deployment's
  spec and env vars. A rollback through the API also *pins* the app: new deployments are refused
  until the rollback is committed or reverted. The docs don't say whether a dashboard rollback does
  the same.
- **There is no outbound IPv6**, so the Supabase IPv4 add-on is required (`ARCHITECTURE.md`
  § Supabase).
- **App Platform keeps no runtime logs** unless they are forwarded somewhere, which is `logs.md`.
- **API tokens can have custom scopes.** CI needs only `app:update` and the read scopes it depends
  on, with no `app:create` or `app:delete`.

## Decisions

### No rehearsal: the first CI deploy is the test

The apps are created bare, and the first deploy from CI is the first time either spec runs. What
the docs leave open (App Platform pulling a nested GHCR repository by digest, a multi-line
`DB_SSL_CA` arriving intact, how long a worker deploy takes, whether a dashboard rollback pins the
app) is found out there and fixed forward, like any other bad deploy. Nobody is using production
yet, so a failed first deploy costs nothing but a follow-up PR.

*Rejected: rehearsing by hand with `doctl apps create` before wiring up CI.* It would check the
same things a second way, with the secrets copied onto someone's machine to do it.

### Secrets: the `production` Environment, filled in at deploy

Every production secret lives where the migrate step's secrets already live: the `production`
GitHub Environment, never repo secrets (`ARCHITECTURE.md` § Secrets management). A spec refers to
a secret with a `${NAME}` placeholder and `type: SECRET`. The deploy step fills the placeholders in
with `yq`, which comes preinstalled on GitHub's Ubuntu runners:

```sh
yq '(.. | select(tag == "!!str")) |= envsubst(nu, ne, ff)' .do/web.yaml \
  | doctl apps update "$APP_ID" --spec - --wait
```

`nu, ne` fail the deploy when a variable is unset or empty, instead of submitting an empty secret.
yq edits the parsed document, so a value containing newlines (`DB_SSL_CA`) or a `$` still comes
out as valid YAML. DigitalOcean encrypts each `SECRET` when it receives it. Because yq consumes
every `${…}`, App Platform's own bindable variables such as `${APP_URL}` can't appear in a spec.

- The image digest is filled in the same way, from `${IMAGE_DIGEST}`.
- A non-secret value comes from the Environment's variables when the migrate step also reads it
  (`DB_SSL_CA`, the `S3_*` variables), so it has one home, or when it isn't known until the apps
  exist (`SITE_URL`, the starter domain) or names the Supabase project (`PUBLIC_SUPABASE_URL`,
  `PUBLIC_SUPABASE_PUBLISHABLE_KEY`).
- Any other value only the app reads (`PUBLIC_AUTH_MODE`, `WORKER_MODE`, the grace) is written in
  the spec.

The specs' placeholders are the list of what the Environment must hold. To rotate a secret, change
it in the Environment and redeploy. For the worker, that means dispatching a worker deploy.

*Rejected: committing DigitalOcean's encrypted `EV[…]` values.* DigitalOcean says they are safe to
store in a repo, but this repo is public, and runtime secrets would have a second home beside the
Environment.

### `doctl`, not DigitalOcean's GitHub Action

*Rejected: `digitalocean/app_action/deploy@v2`.* It finds the app by the spec's `name` and creates
a new app when none matches, so renaming an app would quietly start a second one beside the first.
It also expands every `$` in the spec, replaces an unset variable with an empty string, and waits
with no timeout. `doctl apps update` takes an app ID, so it can only ever update that app. The two
IDs are Environment variables.

## Before PR 1: the account and the apps

Dashboard work, with no code:

1. **A team for the nonprofit.** Make its developers Owners, and require secure sign-in (2FA or
   SSO).
2. **A spend alert** at the expected monthly bill. It emails owners and billers, and is a warning,
   not a cap.
3. **A custom-scope token for CI:** `app:read`, `app:update`, `regions:read`, `sizes:read`,
   `actions:read`. Give it an expiry, and set a calendar reminder to rotate it. A token belongs to
   one user and stops working if that user leaves the team. Store it as
   `DIGITALOCEAN_ACCESS_TOKEN` in the `production` Environment.
4. **Confirm that the Supabase project has the IPv4 add-on.**
5. **Create both apps** in the dashboard, each from its GHCR image, with the name and region its
   spec gives. The region is Richmond (`ric`), the nearest to the project's `us-east-1`. The
   OpenAPI spec's region enum doesn't list `ric` yet, though the availability matrix does; if the
   dashboard or the first deploy refuses it, fall back to `nyc`. Nothing else about the apps
   matters, since the first deploy replaces the whole spec; until then the worker crash-loops
   without its env. Record each app's ID in the Environment as `DO_WEB_APP_ID` and
   `DO_WORKER_APP_ID`.
6. **Fill in the Environment** with every `${NAME}` the specs use but `IMAGE_DIGEST`: secrets for
   the `SECRET`s, variables for the rest. `SITE_URL` is the web app's starter domain, from step 5.
   `SITE_PASSWORD` is a long, random value: production runs `PUBLIC_AUTH_MODE=placeholder`, so it
   is the only thing in front of the placeholder admin.

## PR 1 — deploy from CI

- **`actions/deploy-service`:** replace the stub step with the `yq` and `doctl apps update --wait`
  pipeline above. Install `doctl` with `digitalocean/action-doctl`, pinned by commit SHA like every
  other action on the deploy path. Map each service to its spec file and its app-ID variable. A
  composite action can't read secrets itself, so the job passes them in as env.
- **`deploy.yml`:** pass each spec's placeholders from the Environment's secrets and variables to
  its deploy job. Raise both deploy jobs' `timeout-minutes` above `doctl`'s own 30-minute wait, so
  a stuck deploy fails with `doctl`'s message rather than the runner's. A worker deploy can take
  the old worker's full ten-minute grace before it even starts the new one.
- **`.do/README.md`:** drop the status line. Add that rotating a secret is changing it in the
  Environment and redeploying (for the worker, dispatching one), and how to roll back: a rollback
  restores the old deployment's env, including any secret rotated since, and if the next deploy is
  refused because the rollback pinned the app, commit or revert the rollback in the dashboard.
- **`ARCHITECTURE.md` § Secrets management:** at most a clause, that the `production` Environment
  is also where the running apps' secrets live. The mechanism stays in `.do/README.md`; the root
  docs stay high level.
- Delete this plan.

## Verification

Run `pnpm lint && pnpm check && pnpm test`. After PR 1 merges, the first deploys are where anything
the docs left open turns up; fix forward:

- The next push to `main` deploys the web app. The run is green, `deploy/web` moves, the digest
  DigitalOcean is running matches the one in the run's log, and `/health/ready` on the starter
  domain answers 200, which shows the database CA arrived intact.
- Dispatching `deploy.yml` deploys the worker at `deploy/web`'s commit, and the web app does not
  redeploy. The next attempt it claims has that commit as its `worker_git_sha`.
- A worker dispatch while an attempt is running ends that attempt `succeeded` or `shut_down`.
  Ending `abandoned` would mean App Platform did not honor the grace.
- With a secret deleted from the Environment, the deploy fails before anything is submitted.
