# @gbd/worker

The worker parent process: claims analysis attempts off the queue, spawns Python children to run
them, and writes results back to the database and blob store. For how it fits the wider system —
the queue contract, the parent ↔ child run directory, deployments and draining — see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker).

## Running it

[`src/main.ts`](src/main.ts) is the entrypoint:

```sh
pnpm --filter @gbd/worker build && pnpm --filter @gbd/worker start
```

Beyond the vars every package reads from `.env`, it needs:

| Var | |
| --- | --- |
| `WORKER_RUN_ROOT` | Where each attempt gets its own run directory |
| `PYTHON_BIN` | The Python interpreter that runs the analysis child |
| `WORKER_ID` | Optional. Defaults to a value derived from the host and process |
| `WORKER_MAX_CONCURRENT_ATTEMPTS` | Optional. Overrides `maxConcurrentAttempts` |

`createWorkerConfig` in [`src/config.ts`](src/config.ts) is the only way to obtain a checked
`WorkerConfig` — every tunable, and the relations enforced between them, is documented there
rather than here.

## Layout

- [`worker.ts`](src/worker.ts) is the process itself — claiming, directing in-flight attempts, the
  sweeps, and draining. Read it, not this file, for how those actually work.
- [`attempt/directive.ts`](src/attempt/directive.ts) decides what a live attempt needs each tick;
  [`attempt/verdict.ts`](src/attempt/verdict.ts) decides what a dead child means;
  [`attempt/lifecycle.ts`](src/attempt/lifecycle.ts) and [`attempt/queue.ts`](src/attempt/queue.ts)
  start and claim attempts.
- [`sweeps/reaper.ts`](src/sweeps/reaper.ts) and
  [`sweeps/notifications.ts`](src/sweeps/notifications.ts) converge rows nobody else will.
- [`child/spawn.ts`](src/child/spawn.ts) and [`child/run-directory.ts`](src/child/run-directory.ts)
  are the OS-level half of the parent ↔ child contract in [`contract/`](../../contract/).
- [`db.ts`](src/db.ts) owns the worker's own database handle, tuned separately from
  `@gbd/db/env`'s.
- [`failures.ts`](src/failures.ts) is the reasoning behind "an error is not a verdict" — read it
  before touching any error handling here.

## Testing

[`worker.test.ts`](src/worker.test.ts) runs the whole thing end to end against a real spawned
child (faked via [`src/testing/fake-child.ts`](src/testing/fake-child.ts)) and real breakable
database/blob-store proxies. `directive.test.ts` and `config.test.ts` cover their own modules'
decision tables with no database, no child, and no clock, which is what lets `worker.test.ts` skip
re-testing either.
