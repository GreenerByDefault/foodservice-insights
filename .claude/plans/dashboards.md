# Dashboards

## Context

`REQUIREMENTS.md` § Metrics asks for users, reports, attempt timing, AI cost and failed attempts
over time. User country waits on [`user-country.md`](user-country.md).
[`metrics-pipeline.md`](metrics-pipeline.md) builds the pipe:
- the `metrics` schema and its three base views, read only by `metrics_reader`;
- tombstones, so hard-deleted rows stay counted;
- a synthetic history and a local Grafana to draw it in;
- a check in `pnpm test` that runs every panel's query;
- the push to Grafana Cloud.

It ships one dashboard, `product`, with one panel. This plan decides what goes through the pipe:
which dashboards exist and who reads each, the views beyond the base ones, and the panels. The
data alerts and the views they need are [`alerts.md`](alerts.md).

The plan ends when every § Metrics item and the attempt telemetry have panels. A metric after that
follows `apps/grafana/README.md`'s recipe, with no plan.

Facts from the tree (2026-10-15, `main` at `d0335043`) that shape the design:

- **Four of § Metrics' five database items need only the base views.** Users, reports, attempt
  timing and failures are `GROUP BY`s over `metrics.app_user`, `metrics.report` and
  `metrics.attempt`, which keep hard-deleted rows once the pipeline's tombstones land. "Users over
  time" counts by `email_confirmed_at`, because a code request alone makes an `auth.users` row
  (`metrics-pipeline.md` § Context).
- **AI cost comes from the attempt telemetry, which every ending records.** `003_attempt_telemetry`
  created `analysis_attempt_telemetry`, `analysis_attempt_llm_usage` and
  `analysis_attempt_quality_check`. The parent writes all three after the verdict, in one
  transaction, however the child ended ([`telemetry.ts`](../../apps/worker/src/attempt/telemetry.ts)).
  `public-schema.sql` is the shape, and its column comments say what each count includes. What a
  view has to respect:
  - **They outlive what they describe.** They carry `analysis_attempt_id`, `report_id` and
    `organization_id` raw, with no FK, and nothing deletes from them. So they need no tombstone,
    and a deleted organization's spend stays counted.
  - **They hold no status.** A fenced or lost parent does not know an attempt's final one.
  - **One usage row per attempt × operation × requested model**, with `cost_micro_usd` in integer
    micro-USD at list price. A report's cost is the sum over its attempts, since a retry spends
    again.
  - **The telemetry row fills in by stage.** The input, categorization and report groups are each
    all null or all set, and each requires the one before; the stage times are a prefix. So null
    means "never got there", not zero.
  - **`quality_status` is not stored.** The library derives it from the findings in
    `quality_status_from_findings`, and the quality rows hold those findings counted per check and
    status.
  - **`categorized_kilograms` can exceed `input_kilograms` in the last bit.** Both are float sums,
    over different rows, so a kilogram share can exceed 1.
  - **`co2e_kg_per_diner_or_meal` means nothing without `counts_basis`**, which the telemetry row
    keeps because `report`'s copy goes with the organization.
  - **A cache hit is not a categorization.** `cache_raw_name_products` and
    `cache_cleaned_name_products` include products whose cached category is "No Matches Found".
  - `requested_model` and `served_model` are text, each under a pattern CHECK.
  - The test stack prints floats with `extra_float_digits = 0`, so a `double precision` read back
    through Kysely is rounded to 15 digits. A `toEqual` needs values that survive that, such as
    the fixtures' `2500.5`.
- **Nothing local produces realistic usage.** `mock-llm` records everything but usage, and
  `stubbed` reports the same `STUB_TELEMETRY` every time. Only the synthetic history can give a
  cost panel a shape.
- **With no FK, deleting an organization leaves its telemetry behind.** `withCommittedFixture`'s
  teardown already deletes its organizations' telemetry by `organization_id` for that reason.
- **Grafana's pool serves about six panel queries at once** (`metrics-pipeline.md` § Access). A
  bigger dashboard still loads, in waves.

## Decisions

### A dashboard per reader

| Dashboard | Reader | Starting panels |
| --- | --- | --- |
| `product` | GBD | users over time; reports per week; organizations active per week; p50 and p95 queue, run and total time per day; failed attempts per week, by reason |
| `cost` | GBD and us | AI cost per week; cost per succeeded report; cache hit rate; categorized share by kilograms |
| `operations` | us | stage time p50 and p95; 429s per week; which checks warn most; peak memory; database connections (`alerts.md`) |
| `impact` | GBD | CO2e analyzed and plant share per month |

A dashboard answers one reader's questions, and stays near what Grafana's pool serves at once.
The panels are a starting set. Each is settled in the local loop, looking at the synthetic
history, and its PR is where it changes. The views are what this plan fixes, because each is a
migration and its columns are pinned.
*Rejected: one product dashboard for everything.* It would hold about fifteen panels, with GBD's
numbers among ours.

### Views over the telemetry

- **Each reads its telemetry table first, `LEFT JOIN`s `metrics.attempt`** for status, failure
  reason and `worker_git_sha`, and buckets by `recorded_at`. So deleted work stays in every week it
  ran, and with the tombstones a deleted attempt's outcome survives too.
  *Rejected: copying the verdict onto the telemetry row.* After a fenced or lost ending, the
  parent does not know the final status, and the tombstone already keeps it.
- `metrics.attempt_llm_usage`: each usage row, with `cost_usd` as a numeric.
- `metrics.attempt_telemetry`: the telemetry columns, plus:
  - `quality_status`, derived as `quality_status_from_findings` does. Null when the report group
    is null, so a run that never reached the report is not a `pass`;
  - `cache_hit_rate`;
  - `categorized_kilograms_share`, which a panel clamps rather than the view hiding the row;
  - `categorized_products_share`.
- `metrics.attempt_quality_check`.
- A panel that aggregates `co2e_kg_per_diner_or_meal` across reports groups by `counts_basis`,
  since a per-diner and a per-meal figure do not average.

### The synthetic history grows with each view

A PR that adds a view adds the rows it reads to `insertSyntheticHistory`, since the panel check
fails a panel that returns nothing. For the telemetry, the generator:
- writes telemetry and usage for every settled attempt that was claimed;
- writes quality rows and the report group for every succeeded one;
- gives some failed attempts a categorization group under 20%;
- takes `counts_basis` from the synthetic report, so both values occur.

`seed:history`'s replace deletes the marked organizations' telemetry by `organization_id`, beside
their tombstones, in the same transaction. The cascade from the telemetry row takes the usage and
quality rows. Without that, a second run would double every telemetry panel.

## PR 1 — the product dashboard

Needs `metrics-pipeline.md` PR 4, so the panel check covers these panels from the start.

- `product` gains its starting panels beside the pipeline's reports per week. No migration: the
  base views and the synthetic history already cover them.

## PR 2 — the telemetry views, and the cost dashboard

Needs `metrics-pipeline.md` PR 4. Independent of PR 1.

- The views from Decisions, in the next migration. Each gets its tests. The conventions test
  allowlists `requested_model` and `served_model` in `IDENTIFIER_TEXT_COLUMNS`, with their reasons.
- The generator and the replace from Decisions. The plan's pure test gains that both
  `counts_basis` values occur, and the replace test gains the telemetry case.
- `cost`, with its starting panels.

## PR 3 — the operations dashboard

Needs PR 2's views.

- `operations`, with its starting panels. If `alerts.md` PR 2 landed first, the dashboard
  already exists, holding its database-connections panel.

## PR 4 — the impact dashboard

Needs PR 2's views. Independent of PR 3.

- `impact`, with its starting panels.

The last of these PRs to land deletes this plan.

## Verification

Each PR runs `pnpm lint && pnpm check && pnpm test`, which sends every panel's query through
Grafana. Then by hand:

- In `pnpm grafana`, every new panel draws a shape from `pnpm seed:history`.
- After PR 2, with a small real file on `live`, the attempt shows its cost on `cost`, and the
  day's total is close to what OpenAI's dashboard shows for the project.
- Once Grafana Cloud has the dashboards, a production attempt shows on each.
