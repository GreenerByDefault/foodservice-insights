# Whole-system end-to-end tests

`pnpm test:system`, from the repo root. It gives the run its own database, blob-store bucket, app
server and worker, so it is safe to run alongside anything else.

The one tier that exercises more than one component at a time:

```
browser -> web app -> Postgres -> worker parent -> Python child -> blob store -> email
```

Everything else stops short of that. `apps/web/e2e` writes report rows straight into the database
and never starts a worker; `apps/worker/src/worker.test.ts` drives `fake-child.ts`, a TypeScript
stand-in, so the child's real writers never meet the parent's real readers. So the tests here are
about the *wiring* between components — a component's own behaviour belongs to its own tier.

The worker runs in `WORKER_MODE=stubbed`, where the report's name selects the scenario the child
plays out (see [`apps/worker/README.md`](../../apps/worker/README.md#worker_mode)).

**Deliberately not covered:** the other failure reasons, and the parent-torture cases — a child
that ignores SIGTERM, exits with no verdict, or leaks a grandchild. `apps/worker/src/worker.test.ts`
owns those against `fake-child.ts`, and `apps/web/e2e` owns each failure screen's copy against
seeded rows. Keep this suite small; every test here costs a real worker and a real child.

## When the analysis library is ported

**Open:** only the happy path moves to `WORKER_MODE=mock-llm`. What changes there is its *content*
and its cadence — a 15-byte stub PDF becomes a real report, `resultMetadata` becomes real, and a
realistic progress cadence is the only thing that ever exercises `killAfterNoProgressMs` against a
real workload. What survives unchanged is the chain itself and the contract round trip between the
parent's readers and the child's real writers.

The failure test stays on `stubbed`, permanently: `!fail:unusable-data` fires exactly that failure,
instantly, every time, where reaching it under `mock-llm` would mean constructing input that
genuinely provokes the library's judgement — which is the library's tier, not this one.

Two modes means two workers, and two workers cannot share one queue (`claimNextAttempt` is
`FOR UPDATE SKIP LOCKED`, so either could claim either report). So the happy path moves to a second
Playwright project with its own run database, bucket, and worker.
