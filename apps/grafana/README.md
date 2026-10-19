# @gbd/grafana

This package holds the product dashboards, stored as files in [`resources/`](resources/), and runs
a local Grafana for working on them. Every panel queries the views in the database's `metrics`
schema as the read-only `metrics_reader` role. [`packages/db/README.md`](../../packages/db/README.md)
covers those views.

## Prerequisites

You need [gcx](https://github.com/grafana/gcx), Grafana's CLI. Only this package uses it:

```sh
brew install gcx
```

## Working on a dashboard

Start the dev database, then run:

```sh
pnpm seed:history   # rows for the panels to draw, ending today
pnpm grafana
```

Open <http://localhost:55331>, not Grafana's own port. `gcx dev serve` serves the dashboards from
`resources/` through a proxy in front of a Grafana running in Docker, so Grafana itself has no
dashboards. Queries run against the dev database.

Ctrl-C stops the proxy, and `pnpm grafana:stop` stops Grafana. A change to
[`compose.yaml`](compose.yaml) takes effect only after you stop Grafana.

The files and the browser stay in sync in both directions:

- **When you edit a file**, the open tab reloads.
- **When you save in the UI**, the save is written back to the file, and the diff contains only
  what you changed.

So you can build a panel in the UI and commit the diff, or have an agent edit the file and watch
the panel redraw. Each file holds every default spelled out, in the form a UI save writes. Keep
it that way, or the next save will rewrite the whole file.

To add a dashboard, copy an existing file, then change its `metadata.name` and its title.

**Keep dashboards at `dashboard.grafana.app/v2beta1`.** Behind `gcx dev serve`, Grafana's frontend
requests `v2beta1`, and the proxy cannot convert a file stored at any other version, so the
dashboard renders nothing. Grafana itself accepts `v2beta1` and converts it.

## Adding a metric

1. Add a view in a new migration, following the conventions for `metrics` views in
   [`packages/db/README.md`](../../packages/db/README.md#conventions). Test it in
   [`packages/db/tests/metrics.test.ts`](../../packages/db/tests/metrics.test.ts).
2. Add the rows the view reads to the synthetic history in
   [`plan.ts`](../../packages/db/src/testing/history/plan.ts), then run `pnpm seed:history`.
3. Add a panel that uses `metrics` as its data source.

`pnpm test` then runs every panel's query through a test Grafana, on port 65330, against a
database of its own holding the synthetic history. A panel fails if its query errors or returns
no rows.
