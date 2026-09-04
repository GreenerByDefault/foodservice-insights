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

`pnpm dev` runs it under `node --watch --watch-path=src`, restarting only on changes to this
package's own `src/`. Without `--watch-path`, `node --watch` also restarts on every write to a
`@gbd/*` dependency's `dist/` — pnpm symlinks those in real, not under `node_modules` by path, so
Node's usual `node_modules` exclusion doesn't apply — which mid-processes an attempt every time
another package's `tsc --watch` recompiles. A dependency change still needs a manual restart to
take effect.

**In a container, `start` must run as `exec node dist/main.js` (the Dockerfile `CMD`), never as
`pnpm --filter @gbd/worker start`.** Under pnpm, pnpm is PID 1 and SIGTERM never reaches Node,
which makes the drain design in [`worker.ts`](src/worker.ts) inert and presents as a worker bug
rather than a process-tree one. `ARCHITECTURE.md` already assumes "the parent is PID 1 in its
container."

Beyond the vars every package reads from `.env`, it needs:

| Var | |
| --- | --- |
| `WORKER_RUN_ROOT` | Where each attempt gets its own run directory |
| `PYTHON_BIN` | The Python interpreter that runs the analysis child — the repo venv, not the bare system interpreter |
| `WORKER_MODE` | Which `analyze` the child runs — see below |
| `WORKER_ID` | Optional. Defaults to a value derived from the host and process |
| `WORKER_MAX_CONCURRENT_ATTEMPTS` | Optional. Overrides `maxConcurrentAttempts` |

`createWorkerConfig` in [`src/config.ts`](src/config.ts) is the only way to obtain a checked
`WorkerConfig` — every tunable, and the relations enforced between them, is documented there
rather than here.

### `WORKER_MODE`

[`src/modes.ts`](src/modes.ts) resolves `WORKER_MODE` into which child to spawn and, since a
fast local loop needs different timings than production, which config profile to run it under.

| `WORKER_MODE` | Runs |
| --- | --- |
| `stubbed` | `python -m worker_child.testing` — a fake analysis, steered by the report name. See [`worker_child/testing.py`](../../python/worker_child/worker_child/testing.py) for the scenario catalogue (`!slow`, `!hang`, `!fail:<reason>`, …). |
| `mock-llm` | Not available yet — fails at startup naming why. The slot the analysis library's port fills. |
| `live` | The real `python -m worker_child`. Raises `NotImplementedError` until the port lands. |
| `off` | `pnpm dev` starts no worker. |

## Layout

| File | Role |
| --- | --- |
| [`worker.ts`](src/worker.ts) | The process itself — claiming, directing in-flight attempts, the sweeps, and draining. Its real-time scheduling lives in [`ticker.ts`](src/ticker.ts). |
| [`modes.ts`](src/modes.ts) | Resolves `WORKER_MODE` into a child command and config overrides. |
| [`attempt/directive.ts`](src/attempt/directive.ts) | Decides what a live attempt needs each tick. |
| [`attempt/verdict.ts`](src/attempt/verdict.ts) | Decides what a dead child means. |
| [`attempt/lifecycle.ts`](src/attempt/lifecycle.ts), [`attempt/queue.ts`](src/attempt/queue.ts) | Start and claim attempts. |
| [`sweeps/converge.ts`](src/sweeps/converge.ts), [`sweeps/notifications.ts`](src/sweeps/notifications.ts) | Converge rows nobody else will. |
| [`child/spawn.ts`](src/child/spawn.ts), [`child/run-directory.ts`](src/child/run-directory.ts) | The OS-level half of the parent ↔ child contract in [`contract/`](../../contract/). |
| [`db.ts`](src/db.ts) | Owns the worker's own database handle. |
| [`clock.ts`](src/clock.ts) | The only source of "now" the worker reads — the seam that lets a test move time without a real sleep. |
| [`failures.ts`](src/failures.ts) | The six named rules every failure path here obeys — read it before touching any error handling. [`retry.ts`](src/retry.ts) is the one-retry-layer rule's implementation. |

## Testing

[`worker.test.ts`](src/worker.test.ts) runs the whole thing end to end against a real spawned
child (faked via [`src/testing/fake-child.ts`](src/testing/fake-child.ts)) and real breakable
database/blob-store proxies. `directive.test.ts`, `verdict.test.ts`, `config.test.ts`, and
`modes.test.ts` cover their own modules' decision tables with no database, no child, and no
clock, which is what lets `worker.test.ts` skip re-testing any of them.
