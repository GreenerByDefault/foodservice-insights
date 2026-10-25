# @gbd/worker

The worker parent process: claims analysis attempts off the queue, spawns Python children to run
them, and writes results back to the database and blob store. Its design is [below](#design); for
the seams it shares with the rest of the system — the queue, reaping, canceling and deploys — see
[`docs/architecture.md`](../../docs/architecture.md#worker).

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

Beyond the vars every package reads from `.env`, it needs:

| Var | |
| --- | --- |
| `WORKER_RUN_ROOT` | Where each attempt gets its own run directory |
| `PYTHON_BIN` | The Python interpreter that runs the analysis child — the repo venv, not the bare system interpreter |
| `WORKER_MODE` | Which `analyze` the child runs — see below |
| `WORKER_ID` | Optional. Defaults to a value derived from the host and process |
| `WORKER_MAX_CONCURRENT_ATTEMPTS` | Optional. Overrides `maxConcurrentAttempts` |
| `PLATFORM_SHUTDOWN_GRACE_MS` | The host's shutdown grace, which `drainGraceMs` is derived from. Required by `WORKER_MODE=live`; optional otherwise |
| `WORKER_DRAIN_GRACE_MS` | Optional. Overrides the derived `drainGraceMs` |
| `CACHE_DB_CONNECTION_STRING` | Optional. Points the categorization cache's reads and suggestions at another database than `DB_CONNECTION_STRING`'s — see [below](#the-categorization-cache). Production leaves it unset |

`createWorkerConfig` in [`src/config.ts`](src/config.ts) is the only way to obtain a checked
`WorkerConfig` — every tunable, and the relations enforced between them, is documented there
rather than here.

### The categorization cache

The worker looks each product up in a cache of categorizations that a person has verified, and
sends only the rest to the LLM. Yours is in your local database, and starts empty. With
`WORKER_MODE=live`, point it at production's instead, so your runs start from Greener by
Default's answers:

1. Ask Greener by Default for the `cache_client` connection string, and treat it like
   `OPENAI_API_KEY`. It can only read the cache and suggest rows to it.
2. Put it in `.env` as `CACHE_DB_CONNECTION_STRING`, beside `WORKER_MODE=live`, in the form
   `.env.example` shows: its `sslrootcert` is the absolute path to the repo's `supabase-ca.crt`.
3. Restart the worker. Its `Worker started` line names the cache database as
   `cache_client@db.<project-ref>.supabase.co:5432/postgres`, not `worker`.

Each product your runs send to the LLM then lands in production's cache as a suggestion, which a
person verifies in Supabase Studio before any run uses it.

- **Comment the line out while changing the categorization prompt or model.** Otherwise the
  experiment's answers become the first suggestion for every product it sees, and block the real
  model's.
- **Never put this string in `DB_CONNECTION_STRING`.** Your worker would claim production's
  reports.
- `WORKER_MODE=mock-llm` and `stubbed` ignore it with a warning, so their keyword and fake
  answers never reach the shared cache, and use your local one.
- The lab reads the same variable; see [`python/lab/README.md`](../../python/lab/README.md#working-on-a-client).

Without the string, you can load a CSV copy of the cache into your local database with the
[temporary go-live import](../../packages/db/scripts/temporary-go-live-cache-import/README.md).

### `WORKER_MODE`

[`src/modes.ts`](src/modes.ts) resolves `WORKER_MODE` into which child to spawn and, since a
fast local loop needs different timings than production, which config profile to run it under.
For what each mode gives you and when to pick it, see the root
[`README.md`](../../README.md#analysis-modes).

| `WORKER_MODE` | Analysis | Runs | Timings |
| --- | --- | --- | --- |
| `mock-llm` | Real, with a keyword list instead of OpenAI | `python -m worker_child.mock_llm` | Production |
| `live` | Real, categorized by OpenAI; what production runs | `python -m worker_child` | Production |
| `stubbed` | Fake, finishing in seconds | `python -m worker_child.testing` | Fast, so `!hang` is killed while you watch |
| `off` | None | Nothing | — |

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

## Design

Catching a hung or crashed analysis means answering two different questions — is the *child*
still making progress, and does the *parent* still get to act on it — and each has to keep
working when the other's machinery is down. They are **two independent axes**, and mixing them
forfeits what each is for:

| | Axis A — child liveness | Axis B — supervisor authority |
| --- | --- | --- |
| Medium | the filesystem | Postgres |
| Signal | `progress.json` `sequence` → parent's `lastProgressAt` | the guarded `UPDATE` |
| Clock | the parent's, only ever as a difference | the database's, on both write and read |
| Answers | should I kill this child? | may I still write this attempt's verdict, and is anyone still watching it? |
| Survives a DB outage | **yes, by design** | no |
| Survives losing the container | no | **yes, that is its whole job** |

Because Axis B reads and writes the *database's* `now()`, cross-worker liveness never depends on
worker clocks agreeing. Because Axis A only ever subtracts the *parent's* clock, it keeps working
through a total database outage.

One rule resolves the two axes into one design:

> **A worker renews the lease on an attempt if and only if it has just checked that attempt's
> child and will still reach a verdict for it.**

Child progress is an *input* to the renewal decision, never the value written. "Has someone taken
this attempt?" is the renewal's *answer*. "Tell other parents I am alive" is its *effect*.
[`failures.ts`](src/failures.ts) holds what follows from it when a check or a write fails.

Four layered defenses, because a hung analysis has to be caught even if the process that should
notice it is itself hung:

1. **The child reports progress** to a file between API calls, and the parent kills it as hung
   after `killAfterNoProgressMs` without any ([`config.ts`](src/config.ts)).
2. **The parent hard-kills** a child after `killAfterTotalRuntimeMs`, however healthy it looks
   ([`config.ts`](src/config.ts)).
3. **A claim held past `claimedCeilingMs` is reaped**, whatever its lease says. This catches a
   parent that renews forever but never finishes, which the first two cannot, since both watch
   the child ([`sweeps/converge.ts`](src/sweeps/converge.ts)).
4. **Other workers reap an expired lease**, for a container that died with its attempts claimed
   ([`sweeps/converge.ts`](src/sweeps/converge.ts)). The parent is PID 1, so its children die
   with it; the reaper exists for the row, not the processes.

*Rejected: writing the child's progress timestamp into the database.* It collapses the two axes
onto one medium: a parent whose database is down stops being able to answer "should I kill this
child?", and a parent whose clock is skewed poisons every other worker's liveness judgement.

## Testing

[`worker.test.ts`](src/worker.test.ts) runs the whole thing end to end against a real spawned
child (faked via [`src/testing/fake-child.ts`](src/testing/fake-child.ts)) and real breakable
database/blob-store proxies. `directive.test.ts`, `verdict.test.ts`, `config.test.ts`, and
`modes.test.ts` cover their own modules' decision tables with no database, no child, and no
clock, which is what lets `worker.test.ts` skip re-testing any of them.
