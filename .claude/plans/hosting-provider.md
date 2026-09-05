# Hosting provider recommendation

> **Status:** a proposal for the decision [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Choosing a
> host leaves **Open**. A human makes the call; this file exists so they do not have to re-derive
> it. Once decided, § Hosting records the choice,
> [`actions/deploy-service`](../../.github/actions/deploy-service/action.yml) gets the real deploy
> call, and this file is deleted.
>
> Provider facts were read from each provider's current docs on 2026-09-05 and move; where one
> contradicted our earlier notes, the newer reading won. Cost figures come from
> [`scripts/hosting_costs.py`](../../scripts/hosting_costs.py), kept so the estimate can be re-run
> as the assumptions change.

## What we ask of a host

The deploy pipeline is built, and it narrows the ask.
[`deploy.yml`](../../.github/workflows/deploy.yml) builds both images in CI, pushes them to GHCR
tagged by commit, and resolves the tag to a digest; migrations run from the workflow. So the
provider builds nothing and needs no git integration. What is left:

1. **Run a public GHCR image, pinned by digest, on a call from CI that returns a real exit code.**
   Web and worker deploy separately; a rollback is the same call at an older commit.
2. **A shutdown grace measured in minutes.** An attempt averages ~5 minutes (range 2–15). The
   worker drains on SIGTERM and needs the platform to wait;
   [`deploy-skew-hardening.md`](deploy-skew-hardening.md) makes that relation checkable once the
   platform's number is known.
3. **Manual scaling, restarts, alerts on CPU/memory/disk, and logs** — § Choosing a host and
   § Failure modes.
4. **Price, and simplicity over time**, for a two-person nonprofit team. No autoscaling.
5. A staging copy later ([`staging-environment.md`](staging-environment.md)).

Candidates: Railway, Render, and DigitalOcean App Platform. *Rejected: a DigitalOcean Droplet.*
$12–18/month runs both containers, but OS patching, Docker, TLS, restarts, log shipping, and a
deploy script become ours to maintain — the opposite of simplicity over time. *Rejected: Cloud
Run, Fargate, Heroku.* Each caps or fixes the shutdown grace at 10–120 seconds. *Rejected:
Cloudflare Workers + Containers.* Containers wake on requests and sleep when idle, so an always-on
worker needs a controller Worker, Durable Object, and Cron Trigger that we would write and operate;
they also cannot pull from GHCR or pin a digest, and there are no alerts below Enterprise.

## 1. How each one bills

| | Railway | Render | DigitalOcean App Platform |
| --- | --- | --- | --- |
| Model | Metered: $/vCPU-second and $/GB-second on what a container *actually uses* | Fixed instance tiers, prorated per second | Fixed instance tiers, prorated per second |
| Plan fee | Pro $20/mo per workspace, unlimited seats; comes back as a $20 usage credit | Hobby free (one seat) or Pro $25/mo per workspace, unlimited seats | None; teams are free |
| Compute | ≈$20 per vCPU-month + ≈$10 per GB-month, metered | $7 (0.5 CPU / 512MB), $25 (1 CPU / 2GB), $85 (2 / 4GB)… nothing between $7 and $25 | $5 (1 shared vCPU / 512MB, single instance), $12 (1GB), $25 (2GB), $50 (2 / 4GB) |
| Egress | $0.05/GB, nothing included | 5GB (Hobby) / 25GB (Pro) included, then $0.15/GB | 50–250GB per instance, pooled, then $0.02/GB |
| Nonprofit | None found | None found | $2,500 one-time credit, valid one year. **Open:** the program dates from 2023 and its application page is gone; confirm it still exists |
| Bill surprises | Metering has no ceiling until you set Replica Limits, so a leak runs up the bill. A duplicated environment is a second billed copy | Preview environments never expire by default; dedicated IPs $100/mo | Dedicated egress IP $25/app/mo; the $5 and $10 tiers cannot scale past one instance |

Railway is priced at Pro, not Hobby, because CPU/memory alerts ("Monitors") and 30-day logs are
Pro-only. Render is priced at Pro because Hobby is one seat and a shared login is out.

## 2. What it would cost us

Output of `scripts/hosting_costs.py` on 2026-09-05. The usage figures are guesses until
production exists; the script says which ones.

| Scenario | Railway | Render | DigitalOcean |
| --- | ---: | ---: | ---: |
| Launch: 1 web, 1 worker, ~100 reports/mo | $20 | $57 | $30 |
| Planned: 1 web, 2 workers, ~500 reports/mo | $20 | $82 | $55 |
| Planned + staging | $20 | $114 | $85 |
| Growth: 2 web, 3 workers, ~2,000 reports/mo, + staging | $21 | $149 | $129 |

What the table is really saying:

- **Railway's metering is what makes it cheap here.** The pipeline is IO-bound and we assume an
  idle worker is ~150MB, so real usage sits under the $20 credit in every scenario, and staging
  is nearly free. The flip side is that the bill follows consumption: a memory leak or a runaway
  child costs money instead of hitting a tier ceiling.
- **Render and DigitalOcean charge for the 2GB the worker must be *able* to use**, not the
  ~200MB it averages. Two workers is $50/mo on both. If the parent plus three children measure
  under 1GB in production, DigitalOcean drops to $12 per worker; Render has no 1GB tier.
- **Render's extra ~$25 is its plan fee**; its per-instance prices match DigitalOcean's.
- Egress rounds to zero everywhere. Supabase, Cloudflare, email, and AI spend are the same on
  all three and are left out.

## 3. Deploying from our pipeline

This is where the three differ most, and it decides how much of `actions/deploy-service` is a
documented call versus our own code.

| | Railway | Render | DigitalOcean |
| --- | --- | --- | --- |
| Public GHCR image | Yes, any plan | Yes | Yes (`registry_type: GHCR`) |
| Pin by digest | **Not documented**; tags only | Yes, documented | Yes, and DO's docs recommend digests over tags |
| The call from CI | No CLI path — `railway redeploy` only re-pulls the current tag. Either the GraphQL API (update the service's image source, deploy, poll `deployment.status`; the input shape is confirmed only by a 2024 staff forum post), or the new IaC: template the image into `.railway/railway.ts` and `railway config apply` | `render deploys create <service> --image <url@digest> --wait --confirm`, documented to exit nonzero on a failed deploy | `doctl apps update <id> --spec app.yaml --wait` (nonzero on failure, 30-minute ceiling), or the official `digitalocean/app_action/deploy@v2`, which substitutes `IMAGE_DIGEST_<component>` into the spec and waits for `ACTIVE` |
| Config as code | `.railway/railway.ts` (TypeScript). The legacy `railway.toml`/`.json` stop being read 2026-12-01 | `render.yaml` blueprint | `.do/app.yaml` spec. `PUT /v2/apps` replaces the whole spec, so the file in git must be canonical |
| Auto-redeploy when a tag moves | Off by design here | Image-backed services never do | Not supported for GHCR at all |

## 4. Draining the worker

| | Railway | Render | DigitalOcean |
| --- | --- | --- | --- |
| Default | **0s** — SIGKILL at once | 30s | 120s |
| Maximum | **Undocumented** | 300s; more only by asking support | **600s** (`grace_period_seconds`), workers included |
| Old and new overlap | `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, default 0 | New instance up, 60s, then SIGTERM the old | Old runs until the new is healthy. **Open:** not documented for workers specifically |

Ten minutes covers the average attempt twice over and most of the 2–15 minute range; five covers
about the average. None covers the 15-minute tail, and none needs to: the worker deploys only when
someone dispatches it, so it can go out at a quiet hour, and an attempt cut off at the grace is
recorded `shut_down` and retried by the user. `drainGraceMs` is then sized to the platform's number
minus `killGraceMs` and one terminal write — the `PLATFORM_SHUTDOWN_GRACE_MS` check in
[`deploy-skew-hardening.md`](deploy-skew-hardening.md).

## 5. Running it: scaling, logs, alerts

| | Railway | Render | DigitalOcean |
| --- | --- | --- | --- |
| Manual scaling | Up to 42 replicas (Pro); vertical is automatic up to a cap you set | Up to 100 instances; changing tier redeploys | 1–250 instances on the scalable tiers; changing tier redeploys |
| Restart on crash | `ON_FAILURE` (10 retries) or `ALWAYS` | Restarts (worker policy undocumented); suspends after 24h of failing to start | Liveness probes restart; a full disk replaces the container |
| Logs | 30 days (Pro), searchable. **No log drain**; ship from inside the container if wanted elsewhere | 14 days (Pro), searchable; log streams to Datadog, Better Stack, Papertrail… on all plans | Build logs 90 days. **Runtime logs are not retained at all** unless forwarded to Better Stack, Datadog, Papertrail, or OpenSearch |
| CPU/memory alerts | Yes — Pro Monitors: CPU, RAM, disk, egress | **None native.** Event notifications only (deploy failed, unhealthy), plus an OpenTelemetry metrics stream (Pro) to an external tool | Yes — CPU, RAM, restart count, deploy events; email or Slack, free |
| Ephemeral disk | 100GB (paid plans) | Unpublished; ~2GB per an old forum thread | 4GiB (one support page says 2) |

## 6. Staging, and reaching Supabase

- **Staging.** Railway: a duplicated environment in the same project, billed as a second copy
  (cheap under metering). Render: Projects → Environments; Pro lifts Hobby's limit of two.
  DigitalOcean: a second app, cloneable, tagged Staging within a Project. All three fit
  [`staging-environment.md`](staging-environment.md); the pipeline diff is the same.
- **Supabase.** Render and DigitalOcean have **no outbound IPv6**; Railway has a per-service
  toggle. Supabase's direct connection is IPv6-only, so on all three the practical path is the
  Supavisor session pooler over IPv4 — how `cfa-web-app` already connects. Not a differentiator.

## 7. Reliability in 2026

From status pages and postmortems, so uneven, but the patterns differ. Railway had the year's
worst: a May 19 GCP account suspension took every region down for ~8 hours, a February anti-fraud
system SIGTERMed ~3% of workloads, and August alone had ten incidents. Render's runtime incidents
were minutes long; its deploy pipeline degrades often. DigitalOcean App Platform had an August
24–25 control-panel and API outage (deploys, not running apps) and a few short deployment
degradations. A hosting outage here costs in-flight attempts, which users retry; it loses no data.

## Recommendation

**DigitalOcean App Platform.** It is the only one where all three things this architecture
depends on are documented, first-party, and free: deploying a digest-pinned GHCR image from CI
with a real exit code (an official GitHub Action, even), a ten-minute shutdown grace, and
CPU/memory alerts. At the planned scale it is about $55/month with no seat fee, and the nonprofit
credit, if it still exists, covers the first year outright.

What we accept with it: runtime logs vanish unless forwarded, so wiring Better Stack or Papertrail
is a day-one task rather than an option; shared vCPUs on the cheap tiers; and the $5 web tier
cannot scale, so a second web instance means moving to the $12 tier.

**Runner-up: Render.** Its deploy story is as clean as DigitalOcean's, and it keeps and searches
logs itself. Pick it if the team weighs that above $25–30/month, and is willing to ask support to
lift the 300-second grace and to stream metrics elsewhere for alerts.

**Railway** is the cheapest on paper by ~$35/month, the one the team already runs `cfa-web-app`
on, and Pro has the best built-in logs and alerts. It loses on the two things the pipeline was
built around: no documented digest deploy or CLI/API image update (the IaC route is new and
untested for this), and a 0-second default grace with no documented maximum. Its 2026 outage
record is also the worst of the three. Choose it only if familiarity dominates, and only after an
empirical test that `drainingSeconds=600` is honored and that `railway config apply` fails the
workflow when a deploy crashes.

What would change this: the DigitalOcean credit is gone *and* the worker measures well under 1GB
(Railway's price gap widens to real money); or DigitalOcean turns out to run zero old/new worker
overlap on deploy (then Render's documented 60 seconds matters).

## After the decision

Four things, whichever provider wins:

1. Replace the stub step in `actions/deploy-service` with the provider's deploy-by-digest call,
   waiting for a terminal status.
2. Commit the provider's config-as-code file: both services, the shutdown grace at its maximum,
   and `PLATFORM_SHUTDOWN_GRACE_MS` set beside it — [`deploy-skew-hardening.md`](deploy-skew-hardening.md) § a.
3. Set the production secrets in the provider, and `DB_CONNECTION_STRING` in GitHub Actions
   ([`deploy-migrations.md`](deploy-migrations.md)), both pointing at the Supavisor session pooler.
4. Set the spend and resource alerts, and on DigitalOcean, log forwarding.

The deployed commit needs no provider-injected variable: every image carries
`org.opencontainers.image.revision`, and the deploy run logs the digest.
