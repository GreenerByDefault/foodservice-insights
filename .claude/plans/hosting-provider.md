# Hosting on DigitalOcean App Platform

## Context

The team chose DigitalOcean App Platform
([analysis](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/hosting-provider.md)),
and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Hosting records the choice. This plan connects
the existing deploy pipeline to it.

The pipeline itself is already built. [`deploy.yml`](../../.github/workflows/deploy.yml) builds
both images on every push to `main` and pushes them to GHCR as public packages. It migrates the
database, and [`actions/deploy-service`](../../.github/actions/deploy-service/action.yml) resolves
the commit to an image digest. That action's last step is a stub that only prints a warning. What
is missing is everything on DigitalOcean's side, and that one step.

Other plans own these pieces:

- **Our own domain and Cloudflare**: [`cloudflare-and-domain.md`](cloudflare-and-domain.md). Until
  it lands, the web app is served from its App Platform starter domain.
- **The specs' `alerts:`, alert destinations, and `liveness_health_check`**:
  [`alerts.md`](alerts.md). **`log_destinations:`**: [`logs.md`](logs.md). Both add to the spec
  files PR 1 creates, and both pass their tokens the same way as every other secret (§ Secrets).
- **Postmark's credentials**: [`email-provider.md`](email-provider.md) adds them the same way.
- **The site password** is separate work already in progress. **The web app must not be on a
  public URL before the password lands.** Production runs `PUBLIC_AUTH_MODE=placeholder`, so the
  password is the only thing in front of the placeholder admin. The rehearsal below waits for it
  for the same reason.

DigitalOcean facts, read from its docs and the `doctl` source on 2026-10-14:

- **An update replaces the whole app spec.** `PUT /v2/apps` and `doctl apps update --spec` both
  submit one. The next deploy removes anything the spec leaves out, whether an env var, an alert,
  or a log destination. A setting changed in the dashboard lasts only until that deploy.
- **`doctl apps update <id> --spec <file> --wait` exits nonzero when the deployment fails**, and
  gives up after 30 minutes. It does not substitute variables. `--spec -` reads the spec from stdin.
- **`health_check` is a readiness check.** When it fails, traffic stops going to the instance, and
  a deploy whose new instance never passes it fails and rolls back. **`liveness_health_check`
  restarts the container.** Workers can only have the liveness check, and only if they listen on a
  port. Ours does not.
- **A worker's `termination.grace_period_seconds` defaults to 120 and can be at most 600.** One FAQ
  gives the default as 30. Either is far short of our drain. The docs don't say whether the old
  worker keeps running until the new one starts, and it doesn't matter here: attempts just wait in
  the queue, or are shared between whichever workers are running.
- **Rollback** can restore any of the last 10 successful deployments, including that deployment's
  spec and env vars. A rollback through the API also *pins* the app: new deployments are refused
  until the rollback is committed or reverted. The docs don't say whether a dashboard rollback does
  the same.
- **There is no outbound IPv6**, so the Supabase IPv4 add-on is required (`ARCHITECTURE.md`
  § Supabase).
- **App Platform keeps no runtime logs** unless they are forwarded somewhere, which is `logs.md`.
- **App Platform sets `PORT` to match `http_port`**, and adapter-node listens on `PORT`.
- **The `apps-s-1vcpu-0.5gb` and `-1gb-fixed` sizes can't run more than one instance.**
- **API tokens can have custom scopes.** CI needs only `app:update` and the read scopes it depends
  on, with no `app:create` or `app:delete`.

## Decisions

### Two apps, one spec file each

`.do/web.yaml` and `.do/worker.yaml`. DigitalOcean documents no way to deploy only one component of
an app, and every update submits the whole spec. In a single app, every push to `main` could
restart the worker and fail its in-flight attempts as `shut_down`, which defeats `ARCHITECTURE.md`
§ Worker deploys only on demand. Billing is per component, so two apps cost the same as one.

### The spec in git is canonical

Because an update replaces the whole spec, everything about an app lives in its file: size,
instance count, region, grace, health check, env, and later its alerts and log destinations. Each
file's header says that a change made in the dashboard is undone by the next deploy.
[`budget.ts`](../../packages/db/src/budget.ts) currently says instance counts are "set in the
host's dashboard". They move into these files, where a test can hold them to the connection budget.

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
out as valid YAML. DigitalOcean encrypts each `SECRET` when it receives it.

- A non-secret value that the migrate step also reads (`DB_SSL_CA`, the `S3_*` variables) comes from
  the Environment's variables the same way, so it has only one home.
- A value only the app reads (`PUBLIC_AUTH_MODE`, `WORKER_MODE`, the grace) is written in the spec.
- The image digest is filled in the same way, from `${IMAGE_DIGEST}`.

To rotate a secret, change it in the Environment and redeploy. For the worker, that means
dispatching a worker deploy.

*Rejected: committing DigitalOcean's encrypted `EV[…]` values.* DigitalOcean says they are safe to
store in a repo, but this repo is public, and runtime secrets would have a second home beside the
Environment.

### `doctl`, not DigitalOcean's GitHub Action

*Rejected: `digitalocean/app_action/deploy@v2`.* It finds the app by the spec's `name` and creates
a new app when none matches, so renaming an app would quietly start a second one beside the first.
It also expands every `$` in the spec, replaces an unset variable with an empty string, and waits
with no timeout. `doctl apps update` takes an app ID, so it can only ever update that app. The two
IDs are Environment variables.

### The worker drains for ten minutes

The worker spec sets `grace_period_seconds: 600`, the maximum, with `PLATFORM_SHUTDOWN_GRACE_MS:
"600000"` beside it. [`config.ts`](../../apps/worker/src/config.ts) derives the drain from that
variable. A test reads `.do/worker.yaml` and fails if the two values disagree. This replaces
`ARCHITECTURE.md`'s warning that nothing in the repo can check this relation. Attempts that a deploy
still cuts off are recorded `shut_down`, and the user retries them. Dispatching worker deploys at a
quiet hour avoids most of them.

### `/health` is the readiness check only

The web app's `health_check` points at `/health`, which checks the database and the bucket. That
is right for readiness: a deploy whose instance cannot reach Supabase fails and rolls back instead
of going live. As a liveness check, `/health` would restart every web container whenever Supabase
blipped, so `alerts.md` owns the liveness check and points it at a route with no dependencies.

### Sizes, counts, and region

- **Web:** one `apps-s-1vcpu-0.5gb`.
- **Worker:** two `apps-s-1vcpu-2gb`, which matches `budget.ts`.
- **Explicit sizes:** set `instance_size_slug` in both specs, because the spec's default is a legacy
  size.
- **Region:** the App Platform region nearest the Supabase project, because every claim, lease
  renewal, and poll is a round trip to the database. `doctl apps list-regions` lists the choices.

[`monthly_costs.py`](../../scripts/monthly_costs.py) has the reasoning for each size and what it
costs. **Open:** drop the worker to `apps-s-1vcpu-1gb` once production shows that the parent plus
three children stay well under 1 GB.

## Before PR 1: the account

Dashboard work, with no code:

1. **A team for the nonprofit.** Make its developers Owners, and require secure sign-in (2FA or
   SSO).
2. **A spend alert** at the expected monthly bill. It emails owners and billers, and is a warning,
   not a cap.
3. **A custom-scope token for CI:** `app:read`, `app:update`, `regions:read`, `sizes:read`,
   `actions:read`. Give it an expiry, and set a calendar reminder to rotate it. A token belongs to
   one user and stops working if that user leaves the team. Store it as
   `DIGITALOCEAN_ACCESS_TOKEN` in the `production` Environment, along with the app secrets the
   Environment does not hold yet, such as `OPENAI_API_KEY`.
4. **Confirm that the Supabase project has the IPv4 add-on.**

## PR 1 — the app specs

- **`.do/web.yaml` and `.do/worker.yaml`**, as described in § Decisions.
  - **Image:** `registry_type: GHCR`, `registry: greenerbydefault`, the
    `foodservice-insights/<service>` repository, and `digest: ${IMAGE_DIGEST}`. No registry
    credentials, since the packages are public.
  - **Env:** every variable the process needs at startup. The lists are `assertConfigured` in
    [`config.ts`](../../apps/web/src/lib/server/config.ts) for the web app and
    [`modes.ts`](../../apps/worker/src/modes.ts) for the worker. `.env.example` says what each
    variable is for.
  - **Email:** `EMAIL_TRANSPORT=provider` until Postmark is wired up, so a send fails with an
    `EmailError` instead of silently going nowhere.
- **Tests.** The worker's grace against `PLATFORM_SHUTDOWN_GRACE_MS` goes in `config.test.ts`,
  beside the relation it guards. Both apps' instance counts against `budget.ts` go in
  `budget.test.ts`. Both tests need a YAML parser; the `yaml` package has no dependencies of its
  own.
- **`budget.ts`:** the comment about instance counts points at the specs.
- **`ARCHITECTURE.md` § Worker deploys only on demand:** the trap paragraph names
  `.do/worker.yaml` and the test, instead of saying nothing in the repo can check the relation.

Nothing deploys yet; the stub still only warns.

## Rehearsal, by hand

Do this after PR 1 merges and the site password has landed.

Create both apps from the committed specs with `doctl apps create --spec -`, behind the same `yq`
substitution, using `main`'s current image digests. Run the worker with `WORKER_MODE=mock-llm`
until the first CI dispatch, so it spends nothing on OpenAI. Record each app's ID as an Environment
variable (`DO_WEB_APP_ID`, `DO_WORKER_APP_ID`). Then check the things the docs leave open:

- App Platform pulls the nested GHCR repository `foodservice-insights/web` by digest.
- `DB_SSL_CA` arrives intact: the web app's `/health` answers 200.
- An update with a deliberately wrong secret fails, `doctl` exits nonzero, and the previous
  deployment keeps serving.
- An attempt that is running when the worker is redeployed either finishes or ends `shut_down`.
  Ending `abandoned` would mean App Platform did not honor the grace.
- How long a worker deploy takes to reach `ACTIVE`, to size `deploy-worker`'s `timeout-minutes`.
- Whether a dashboard rollback pins the app, so that the next `doctl apps update` is refused until
  the rollback is committed or reverted.

## PR 2 — deploy from CI

- **`actions/deploy-service`:** replace the stub step with the `yq` and `doctl apps update --wait`
  pipeline above. Install `doctl` with `digitalocean/action-doctl`, pinned by commit SHA like every
  other action on the deploy path. Map each service to its spec file and its app-ID variable.
- **`deploy.yml`:** pass the Environment's secrets and variables to both deploy jobs. Raise
  `deploy-worker`'s `timeout-minutes` above the time the rehearsal measured.
- **`ARCHITECTURE.md` § Secrets management:** the `production` Environment is the one home of every
  production secret, and each deploy writes them into the specs, so rotating a secret is a
  redeploy.
- **`ARCHITECTURE.md` § Bad deploys are fixed forward:** whether a rollback pins the app, from the
  rehearsal. Also note that a rollback restores the old deployment's env, including any secret
  rotated since.
- Delete this plan.

## Verification

Run `pnpm lint && pnpm check && pnpm test` for both PRs. After PR 2 merges:

- The next push to `main` deploys the web app. The run is green, `deploy/web` moves, and the digest
  DigitalOcean is running matches the one in the run's log.
- Dispatching `deploy.yml` deploys the worker at `deploy/web`'s commit, and the web app does not
  redeploy.
- A worker dispatch while an attempt is running ends that attempt `succeeded` or `shut_down`.
- With a secret deleted from the Environment, the deploy fails before anything is submitted.
