# Foodservice Insights

Greener by Default's foodservice emissions analysis tool. Customers upload procurement
data and get back a report on the climate impact of their food purchasing, with
recommendations.

## Run the app locally

The app needs both of the repo's stacks. The web app and the worker are TypeScript, and the
worker runs each analysis in Python.

### Prerequisites

- **Node 24**. Run `nvm use` if you use nvm.
- **pnpm**: `corepack enable`
- **[uv](https://docs.astral.sh/uv/)** and **[just](https://just.systems)**: `brew install uv just`
- **Docker**, running. Docker Desktop, Rancher Desktop, and OrbStack all work.
- **The Supabase CLI**: `brew install supabase/tap/supabase`

### First time

```sh
pnpm install
just sync
cp .env.example .env
scripts/supabase start
pnpm migrate
pnpm seed:identity
```

`pnpm seed:identity` creates the placeholder user that you sign in as, with `.env`'s
`SITE_PASSWORD`, in the default `PUBLIC_AUTH_MODE=placeholder`. The app cannot sign anyone in
without it. `.env.example` ships a working `SITE_PASSWORD`; if you change it, keep it at or above the
minimum length in [`site-password.ts`](apps/web/src/lib/server/auth/site-password.ts), or sign-in
errors.

### Start it

If the databases have stopped, for example after a computer restart, start them first:

```sh
scripts/supabase start
```

Then use two terminal tabs, in either order, so the web app's logs and the worker's logs stay
separate:

```sh
# Tab 1: the web app
pnpm dev:web

# Tab 2: the worker
pnpm dev:worker
```

Alternatively, `pnpm dev` runs both in one terminal, with their logs interleaved.

Open <http://localhost:5173> and upload a CSV. Enter the `SITE_PASSWORD` from `.env`, which defaults to `local-password`.
You can use [`apps/web/sample-reports/valid.csv`](apps/web/sample-reports/valid.csv) for an example CSV. The report page
updates on its own once the analysis finishes. Emails the app sends arrive in the local mailbox,
<http://localhost:55324>. When you're done, run `scripts/supabase stop` to free the memory the
databases use.

### Analysis modes

`WORKER_MODE` in `.env` chooses which analysis runs when a report is uploaded. Restart both
tabs after you change it, because the web app reads it too, to decide how often the report
page checks for a result.

| `WORKER_MODE` | What you get | Use it for |
| --- | --- | --- |
| `mock-llm` (default) | The real analysis, with a real PDF and workbook. A keyword list categorizes products instead of OpenAI, so products it does not recognize are left uncategorized. No API key needed. | Demos with the sample data, and most development |
| `live` | The real analysis, categorized by OpenAI. Needs `OPENAI_API_KEY` in `.env`, and every report is billed to that key. Your local cache starts empty, so every product goes to OpenAI; optionally, set `CACHE_DB_CONNECTION_STRING` to [reuse production's verified answers](apps/worker/README.md#the-categorization-cache). | Real procurement data |
| `stubbed` | A fake analysis that finishes in seconds. Its PDF and workbook are placeholders that will not open. The report name drives failure scenarios such as `!slow` and `!fail:<reason>`; see [`testing.py`](python/worker_child/worker_child/testing.py) for the full list. | Working on the report lifecycle and its error states |
| `off` | No worker, so reports stay queued. | UI work that doesn't need a result |

### Signing in for real

By default, sign-in is the site password, and makes you the placeholder user. To use Supabase Auth
instead, set `PUBLIC_AUTH_MODE=supabase` in `.env` and restart the web app. Sign in with any
address; the code arrives in the local mailbox, and an address that is new creates an account.
To make yourself a superadmin, set `app_user.is_superadmin` in Supabase Studio's SQL editor
(<http://localhost:55323>), as the runbook
[Write to the database by hand](docs/runbooks/write-to-the-database-by-hand.md) describes.

## Developing

Two stacks live here, and they share no toolchain. Pick yours:

| Working on | Start here |
| --- | --- |
| **TypeScript** — the web app, the worker parent, `packages/*` | [`docs/typescript.md`](docs/typescript.md) |
| **Python** — the analysis library, the worker child, the lab | [`python/README.md`](python/README.md) |

[`AGENTS.md`](AGENTS.md) covers how code is written here and how a change is verified, for both.

### The two databases

Two independent Supabase stacks run locally: one for development, and one that the TypeScript and
Python tests share. Start only the one you need. Running both at once works, but they compete for
the same memory and CPU, especially across concurrent sessions.

| Stack | For | Ports | Yours to modify? |
| --- | --- | --- | --- |
| [`supabase-dev/`](supabase-dev/) | Local development | `553xx` | Yes — seed it, hand-edit rows, break it |
| [`supabase-test/`](supabase-test/) | Automated tests | `653xx` | No. The test suites own it, and migrate it whenever they run |

`TEST_DB=1` is the single switch that picks the test stack — for the CLI, for the database
scripts, and for the tests. Always go through the [`scripts/supabase`](scripts/supabase)
wrapper, never a bare `supabase`, or the CLI will not find either stack. As with the dev stack,
stop the test stack once you're done with it, to free the memory:

```sh
TEST_DB=1 scripts/supabase start
TEST_DB=1 scripts/supabase stop
```

### Working with Claude Code

The repo configures Claude Code for you; there is nothing to set up.

- **What it reads on its own:** [`AGENTS.md`](AGENTS.md) in every session, a stack's rules in
  [`.claude/rules/`](.claude/rules/) once it touches that stack's files, and the Svelte MCP server
  from [`.mcp.json`](.mcp.json) (approve it when asked).
- **Skills you type:** `/plan-adopt` to bring a plan mode plan into
  [`.claude/plans/`](.claude/plans/), `/plan-advance` to fold a finished PR back into its plan,
  and `/prune-comments` and `/test-rigor` before opening a PR. Claude loads the other skills in
  [`.claude/skills/`](.claude/skills/) itself when they apply.
- **A refusal means stop and ask a person.** When the database, a hook or a permission rule
  refuses something, the answer is never to find another way round it.
- **`.claude/settings.local.json` is yours**, and gitignored; the shared settings are in
  [`.claude/settings.json`](.claude/settings.json).
- **After changing the rules or skills,** run `/doctor prompt-audit` (Claude Code 2.1.283 or
  later) to catch stale or conflicting instructions.


## Where to find things

**Understand it**

| Doc | What it covers |
| --- | --- |
| [`docs/requirements.md`](docs/requirements.md) | What the product must do |
| [`docs/architecture.md`](docs/architecture.md) | How the system fits together, and why |

**Work on it**

| Doc | What it covers |
| --- | --- |
| [`docs/typescript.md`](docs/typescript.md) | Commands, tests, and database tasks for the TypeScript stack |
| [`python/README.md`](python/README.md) | Running and testing the Python stack |
| [`AGENTS.md`](AGENTS.md) | How we write code here, and where each stack's rules live |

**Each component**

| Doc | What it covers |
| --- | --- |
| [`apps/web/README.md`](apps/web/README.md) | The web app's design |
| [`apps/web/e2e/README.md`](apps/web/e2e/README.md) | The web app's e2e and screenshot suites |
| [`apps/web/sample-reports/README.md`](apps/web/sample-reports/README.md) | CSVs to upload by hand |
| [`apps/web/src/lib/reports/csv/README.md`](apps/web/src/lib/reports/csv/README.md) | How an uploaded CSV is validated |
| [`apps/worker/README.md`](apps/worker/README.md) | Running the worker parent, and where its pieces live |
| [`packages/browser-testing/README.md`](packages/browser-testing/README.md) | Playwright helpers both e2e suites share |
| [`packages/core/README.md`](packages/core/README.md) | Values and helpers the web app and worker share |
| [`packages/db/README.md`](packages/db/README.md) | The database model, and where to read the schema |
| [`packages/storage/README.md`](packages/storage/README.md) | The blob store, and its key layout |
| [`packages/email/README.md`](packages/email/README.md) | The emails we send, and reading them locally |
| [`tests/e2e/README.md`](tests/e2e/README.md) | Whole-system e2e, against both services' real images |
| [`contract/README.md`](contract/README.md) | The worker parent ↔ child contract |
| [`python/insights/README.md`](python/insights/README.md) | The analysis library, and where a report change goes |
| [`python/lab/README.md`](python/lab/README.md) | Data-science experiments; ships nothing |

**Run it in production**

| Doc | What it covers |
| --- | --- |
| [`docs/runbooks/`](docs/runbooks/README.md) | What we have at each vendor, and the procedures done by hand |
| [`.do/README.md`](.do/README.md) | Hosting, deploys, and secrets |
| [`apps/grafana/README.md`](apps/grafana/README.md) | The product dashboards, and adding a metric |

## What CI runs

A pull request runs only the jobs its changes can affect, per
[`.github/filters.yml`](.github/filters.yml).

PRs merge through a merge queue, which runs everything on the exact commit that will land on
`main`, so a PR can be green alone and still be ejected for clashing with one ahead of it.
