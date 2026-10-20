# Dashboards

## Context

`REQUIREMENTS.md` § Metrics asks for users, reports, attempt timing, AI cost and failed attempts
over time. User country waits on [`user-country.md`](user-country.md).
The pipe has landed:
- the `metrics` schema and its three base views, read only by `metrics_reader`, with tombstones
  so hard-deleted rows stay counted (`packages/db/migrations/009_metrics.ts` and
  `011_metrics_tombstones.ts`);
- the views over the attempt telemetry (`013_metrics_telemetry.ts`), described below;
- a synthetic history to draw, telemetry included, a local Grafana to draw it in, a check in
  `pnpm test` that runs every panel's query, and the push to Grafana Cloud
  ([`apps/grafana`](../../apps/grafana/README.md)).

`product` and `cost` are done. What is left is the `operations` and `impact` dashboards, which read
the telemetry views. The data alerts and the views they need are [`alerts.md`](alerts.md).

The plan ends when every § Metrics item and the attempt telemetry have panels. A metric after that
follows `apps/grafana/README.md`'s recipe, with no plan.

### The telemetry views

Each reads its telemetry table first, so deleted work stays in every week it ran, and buckets by
`recorded_at`. The comments in `013_metrics_telemetry.ts` and on each view say what each column
means; what a panel has to respect:

- **`metrics.attempt_telemetry`** is the telemetry row, plus the attempt's `status`,
  `failure_reason` and `worker_git_sha` from `metrics.attempt` (null only for an attempt deleted
  before tombstones existed), plus four derived columns:
  - `quality_status`, a `metrics.quality_status` enum (`pass`, `warning`, `invalid`), derived as
    `quality_status_from_findings` does. Null when the report group is, so a run that never
    reached its report is not a `pass`. It is also the denominator of a check's firing rate.
  - `cache_hit_rate`, `categorized_products_share` and `categorized_kilograms_share`, each null when
    its group is or the input was empty. A cache hit includes "No Matches Found" products, so the
    hit rate is not a categorization rate.
- **`metrics.attempt_llm_usage`** is each usage row, with the telemetry's `report_id`,
  `organization_id` and `recorded_at` and the attempt's outcome, and `cost_usd` as
  `numeric(10, 6)` in place of micro-USD. A report's cost is the sum over its attempts.
  `rate_limited_requests` is the 429 count.
- **`metrics.attempt_quality_check`** is each check's warning and error findings, with the
  telemetry's ids and `recorded_at`. Its `status` is the finding's, so it carries no attempt
  outcome; join `metrics.attempt_telemetry` for that.

What still holds from the telemetry tables themselves:
- **The telemetry row fills in by stage.** The input, categorization and report groups are each
  all null or all set, and each requires the one before; the stage times are a prefix. So null
  means "never got there", not zero, and a stage-time percentile should say which attempts it
  covers.
- **`categorized_kilograms` can exceed `input_kilograms` in the last bit**, so a panel clamps the
  kilogram share with `least(1, …)`, as `cost`'s do.
- **`co2e_kg_per_diner_or_meal` means nothing without `counts_basis`**, which is null when the
  uploader gave no counts. A panel that aggregates it across reports groups by `counts_basis`,
  since a per-diner and a per-meal figure do not average.
- **Grafana's pool serves about six panel queries at once** (`METRICS_POOL` in
  `apps/grafana/src/data-source.ts`). A bigger dashboard still loads, in waves.

### The synthetic history

`insertSyntheticHistory` writes telemetry for every claimed attempt, from
[`history/telemetry.ts`](../../packages/db/src/testing/history/telemetry.ts), on a random stream
of its own so it can change without moving any time in the history. Every operations and impact
column already has a shape to draw: stage times that fit inside each run, failures that stop at a
stage their reason implies (`unusable_data` with under 20% categorized), bursts of 429s, peak
memory that grows with an upload's rows, quality findings with occasional errors, `counts_basis`
of `people`, `meals` and null, and a plant share that drifts up per organization. A panel that
needs something it lacks adds it there; `plan.test.ts` and `insert.test.ts` cover what it plans
and writes.

## Decisions

### A dashboard per reader

| Dashboard | Reader | Starting panels |
| --- | --- | --- |
| `product` | GBD | done |
| `cost` | GBD and us | done |
| `operations` | us | stage time p50 and p95; 429s per week; which checks warn most; peak memory; database connections (`alerts.md`) |
| `impact` | GBD | CO2e analyzed and plant share per month |

A dashboard answers one reader's questions, and stays near what Grafana's pool serves at once.
The panels are a starting set, settled in the local loop against the synthetic history, as
`cost`'s were: it shipped AI cost per week by attempt outcome rather than a bare total, and the
share of products by how they were categorized rather than a hit rate alone.
*Rejected: one product dashboard for everything.* It would hold about fifteen panels, with GBD's
numbers among ours.

### Weeks, not days

A panel buckets by week, Monday to Sunday in UTC, and says so in its description. The synthetic
history, like production for now, has about one and a half attempts a day, so a daily p95 is the
slowest of one or two attempts and draws noise. A stage-time percentile on `operations` follows the
same rule. `impact`'s months are the exception the table names: emissions are reported monthly.

### Looking like one product

`product` set what the other dashboards follow, and `cost` follows it:
- a fixed color per series, never the classic palette's next one, so a failure reason, a stage or
  an outcome keeps its color across panels and two series never share a hue (`cost` colors
  succeeded green and failed red, as `product`'s reasons are);
- a p95 as the dashed twin of its p50, in the same color;
- whole-number axes (`decimals: 0`) on a count, and no legend on a single-series panel, whose
  title already names it;
- headline numbers in one stat panel with one query, and no more than about six panels.

## PR 1 — the operations dashboard

- `operations`, with its starting panels. If `alerts.md` PR 2 landed first, the dashboard
  already exists, holding its database-connections panel.

## PR 2 — the impact dashboard

Independent of PR 1.

- `impact`, with its starting panels.

The last of these PRs to land deletes this plan.

## Verification

Each PR runs `pnpm lint && pnpm check && pnpm test`, which sends every panel's query through
Grafana. Then by hand:

- In `pnpm grafana`, every new panel draws a shape from `pnpm seed:history`.
- With a small real file on `live`, the attempt shows its cost on `cost`, and the day's total is
  close to what OpenAI's dashboard shows for the project.
- Once Grafana Cloud has the dashboards, a production attempt shows on each.
