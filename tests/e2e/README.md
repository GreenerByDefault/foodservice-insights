# Whole-system end-to-end tests

`pnpm test:system`, from the repo root. It gives the run its own database, blob-store bucket, app
server and worker, so it is safe to run alongside anything else.

**Both services run as their real Docker images** — see
[`scripts/containers.ts`](scripts/containers.ts) for why, and for the networking that makes a
container reachable from a host browser. That networking needs a one-time `/etc/hosts` line (see
the repo root [`README.md`](../../README.md)), which the run checks for before it does anything
slow.

The one tier that exercises more than one component at a time:

- Browser uploads through the web app, which writes a report row to Postgres.
- The worker parent polls Postgres for that row, fetches the input file from the blob store,
  and spawns the Python child.
- While the child runs, the parent repeatedly reads its progress and renews its lease in
  Postgres.
- On exit, the parent uploads the child's result files back to the blob store, then writes
  the verdict to Postgres.
- A separate notification sweep polls Postgres for finished/failed attempts and sends email,
  on its own schedule.

Every package's other test suite stops short of that: `apps/web/e2e` seeds rows straight into the database with no
worker involved, and `apps/worker/src/worker.test.ts` drives the TypeScript `fake-child.ts` instead
of a real child. This tier is only the wiring between components — a component's own behaviour
belongs to its own tier.

The worker runs in `WORKER_MODE=stubbed`, where the report's name selects the scenario the child
plays out (see [`apps/worker/README.md`](../../apps/worker/README.md#worker_mode)).

**`@gbd/worker` is a devDependency here even though nothing imports it**, and the `test:system`
task in [`turbo.json`](../../turbo.json) names the Dockerfiles and `python/**` in its `inputs`.
Both exist for one reason: to put what the images are built from into Turbo's hash. Without them a
worker or Python change replays a cached pass and never rebuilds an image, which is the one failure
mode that would make this whole tier quietly stop testing anything. Neither is dead weight to
remove.

**Deliberately not covered:** the other failure reasons, and the parent-torture cases — a child
that ignores SIGTERM, exits with no verdict, or leaks a grandchild. `apps/worker/src/worker.test.ts`
owns those against `fake-child.ts`, and `apps/web/e2e` owns each failure screen's copy against
seeded rows. Keep this suite small; every test here costs a real worker and a real child.

## When the analysis library is ported

**Open:** only the happy path moves to `WORKER_MODE=mock-llm` — real content and a real progress
cadence, so `killAfterNoProgressMs` finally runs against a real workload. The wiring itself doesn't
change. `!fail:unusable-data` stays on `stubbed` permanently — provoking that failure for real is
the library's tier, not this one.

Two modes need two workers, since one queue can't serve both (`claimNextAttempt`'s row lock lets
either claim either report). So the happy path gets its own Playwright project: its own database,
bucket, and worker.
