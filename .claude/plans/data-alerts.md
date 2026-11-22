# Data alerts

## Context

`docs/architecture.md` § Alerts has three layers. Host (DigitalOcean) and Outside (Better Stack's
`/health/ready` monitor and `error`-line alert) are live. The Data row is **Open**, and
§ Failure modes still promises these alerts:

- workers cannot keep up: attempts waiting too long to be claimed;
- workers fail unexpectedly: failures over a threshold, and attempts not cleaned up in time;
- email is broken: the *gave up* and *stuck* queries under the table;
- the database runs out of connections, which has no alert today.

The Data layer was going to be Grafana Cloud alert rules. Here is what changed that (2026-11-22):

- **The free Grafana Cloud stack sleeps.** After some days without a visitor, every API path
  answers `503 {"code":"Loading","message":"Click on the checkbox to continue loading your instance"}`,
  and only a person opening the stack and ticking the checkbox wakes it. API calls do not:
  `deploy-web` hit it 17 times in a row on 2026-11-22 and stayed red. Grafana documents none of
  this.
- **Grafana-managed rules are evaluated by the Grafana server**, which is not running while that
  page answers. So the alerts would most likely be silent exactly when no one is looking.
  Grafana's documents never say either way. Its MSA excludes free services from any uptime
  commitment.
- **Better Stack already delivers the rest of our alerts, for free.** Its plan gives 10 monitors
  checked every 3 minutes (`scripts/monthly_costs.py`). One is used. A monitor emails when a URL
  stops answering 2xx and again when it recovers, and keeps each incident's history.
- **The web app connects as `postgres`**, which owns the `metrics` views. It can read them with
  no new grant.

## Decisions

### The web app evaluates; Better Stack polls

Each check is a route, `/health/data/<check>`, that counts rows in a `metrics` view. It answers
200 when the count is within the check's threshold. It answers 503 when the count is over the
threshold, or when the query fails, so a check broken by a migration, or a database the web
cannot reach, alerts rather than going quiet. One Better Stack monitor polls each route, so the
alert email names the check, and each check opens and resolves its own incident.

The database still evaluates each check, through the same view the dashboards read, so each
metric keeps one tested definition (`009_metrics.ts`'s header). The web app only relays the
answer.

- *Rejected: Grafana Cloud alert rules on the free plan,* because they likely stop while the stack
  sleeps, per Context.
- *Rejected: Grafana Pro, about $20 a month,* because it would buy alerting that Better Stack
  already does free, plus dashboards that never sleep, which no one needs.
- *Rejected: the worker evaluating,* because queue wait exists to catch a wedged worker, which
  cannot report itself.
- *Rejected: one monitor on one route for every check,* because a second check failing during the
  first one's incident would send no email.

### The response is the page to read

The body is JSON: the check, the count and the threshold. Better Stack's incident links to the
URL, so whoever gets the email clicks through to what fired. A failed query answers with
`status: "error"` only, and its reason goes to the log at `error`, which Better Stack's log
alert also catches.

### Public, with counts only, and cached

The routes are unauthenticated, like `/health/ready`. A count says no more than "three analyses
failed recently", and nothing in a response identifies a user. That is the rule that keeps them
public: if a page ever needs attempt ids, it goes behind sign-in instead.

The real exposure is load, since anyone can call them. Each result is cached in the process for
60 seconds, so any number of requests costs one query per check per minute against the web's
pool of five. `WEB_INSTANCES` is 1, so a per-process cache is the whole cache.

- *Considered, not done: a shared-secret header.* Better Stack can send one. Add it if the counts
  are ever judged sensitive.
- The routes join `UNATTENDED_ROUTES` in `hooks.server.ts`, so polls log at `debug`. They are
  never the host's readiness probe, which must not fail a deploy because a queue is long.

### The checks

A check counts a state that clears by itself: one that holds now, or an event inside a window.
Without that, a single old row would hold its incident open forever. Each check's threshold and
what firing means sit on the check, never in a doc. Where each starts:

- **Queue wait:** a `pending` attempt created more than 30 minutes ago. At three slots and
  2–15-minute attempts, that means demand beyond capacity, or no worker claiming (the case
  `.do/worker.yaml` gives for having no probe).
- **Failures:** an attempt failed in the last hour for a reason that is ours: anything but
  `unusable_data`. At ~17 attempts a day, each one is worth a look.
- **Not cleaned up:** an attempt `processing` past `claimedCeilingMs` plus `reapIntervalMs`, so no
  reaper is running. The web cannot import the worker's
  [`config.ts`](../../apps/worker/src/config.ts), so the check states its own value and names that
  file.
- **Notifications gave up:** terminal, not `canceled`, unsent, `notification_attempts` at
  `maxNotificationAttempts`, and finished inside a window longer than the sweep's whole backoff
  schedule ([`notifications.ts`](../../apps/worker/src/sweeps/notifications.ts)), so every
  give-up is seen once and then clears.
- **Notifications stuck:** the same rows below the attempts cap, finished over an hour ago, with
  `has_requester`, as in the sweep's due predicate. Otherwise an attempt whose requester was
  deleted would fire forever.
- **Connections:** the sum of `metrics.database_connection`'s `connections` above 80% of
  `max_connections`. The view can read a connection or two high (its comment says why), which the
  headroom absorbs. When the database is truly out, the check's own query fails, and that also
  answers 503.

*Considered, not done: a child's peak memory.* A child killed for memory already fails its
attempt, so the failures check covers it. Add it if those failures show up.

### Every check is tested as it fires

Each check's function takes `db` (`.claude/rules/web.md`). Its test inserts the rows that should
and should not fire it, with `withRollback`, and asserts the count and the status. That is
stronger than the Grafana design, which could only check by hand that a rule fired.

### Grafana's sleep is a warning, not a failure

Most deploys change no dashboard, so a sleeping stack should not turn `deploy-web` red. When the
first call answers `503` with `code: "Loading"`, `deploy.ts` skips the push and prints a GitHub
`::warning::`. The warning says the dashboards were not updated, and how to fix that: open the
stack, tick the box, and re-run the latest Deploy run. Any other failure still fails the run.
The README tells whoever changes a dashboard to wake the stack before merging.

## PR 1 — Deploy past a sleeping Grafana

- `apps/grafana/src/`: a pure function that recognizes the sleeping response, with a unit test
  against the body above and against an ordinary 503.
- `apps/grafana/scripts/deploy.ts`: on that response, print the warning and exit 0.
- `apps/grafana/README.md` § Deploying: say that the free stack sleeps and only a person wakes it,
  that a deploy then skips the push with a warning, and that someone merging a dashboard change
  should open the stack first.
- `.github/workflows/deploy.yml`: the dashboard step's comment says a sleeping stack is skipped.

## PR 2 — The checks and their monitors

- `apps/web/src/routes/health/data/[check]/`: the route, the checks (§ The checks), the cache, and
  a test per check. An unknown check is a 404. Add the route to `UNATTENDED_ROUTES`.
- After deploy, by hand: one Better Stack monitor per check, emailing the team like the existing
  monitor.
- `docs/architecture.md`:
  - § Alerts: the Data row is evaluated by the web's `/health/data` routes and polled by Better
    Stack, with its rules in the route's checks file. The two notification queries under
    § Failure modes move into that file, and the doc points there.
  - § Failure modes: the queue, failures, email and connections rows name their checks in place of
    their **Open**.
- Delete this plan.

## Verification

- PR 1: `pnpm lint && pnpm check && pnpm test`. After it lands, while the stack sleeps, the next
  `deploy-web` is green with the warning. After waking the stack, a re-run pushes.
- PR 2: the same gate. Locally, under `pnpm dev`, a `pending` attempt backdated past 30 minutes
  turns its route to 503, and claiming it turns it back. After deploy:
  - every route answers 200;
  - a temporary monitor on `/health/data/nope` emails everyone, and so proves delivery without
    touching production's rows. Delete it after.
- **Open:** whether free Better Stack alerts reach every team member or only the account owner.
  If only the owner, the monitors email a shared address the team reads. This holds for the
  existing monitor too.
