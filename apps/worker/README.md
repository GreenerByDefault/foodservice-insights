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

| File | Role |
| --- | --- |
| [`worker.ts`](src/worker.ts) | The process itself — claiming, directing in-flight attempts, the sweeps, and draining. |
| [`attempt/directive.ts`](src/attempt/directive.ts) | Decides what a live attempt needs each tick. |
| [`attempt/verdict.ts`](src/attempt/verdict.ts) | Decides what a dead child means. |
| [`attempt/lifecycle.ts`](src/attempt/lifecycle.ts), [`attempt/queue.ts`](src/attempt/queue.ts) | Start and claim attempts. |
| [`sweeps/reaper.ts`](src/sweeps/reaper.ts), [`sweeps/notifications.ts`](src/sweeps/notifications.ts) | Converge rows nobody else will. |
| [`child/spawn.ts`](src/child/spawn.ts), [`child/run-directory.ts`](src/child/run-directory.ts) | The OS-level half of the parent ↔ child contract in [`contract/`](../../contract/). |
| [`db.ts`](src/db.ts) | Owns the worker's own database handle. |
| [`failures.ts`](src/failures.ts) | The six named rules every failure path here obeys — read it before touching any error handling. |

## Testing

[`worker.test.ts`](src/worker.test.ts) runs the whole thing end to end against a real spawned
child (faked via [`src/testing/fake-child.ts`](src/testing/fake-child.ts)) and real breakable
database/blob-store proxies. `directive.test.ts` and `config.test.ts` cover their own modules'
decision tables with no database, no child, and no clock, which is what lets `worker.test.ts` skip
re-testing either.
