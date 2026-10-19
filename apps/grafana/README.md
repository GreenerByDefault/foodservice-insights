# @gbd/grafana

The product dashboards, as files in [`resources/`](resources/), and a local Grafana to work on
them in. Every panel queries the views in the database's `metrics` schema, as the read-only
`metrics_reader` role; [`packages/db/README.md`](../../packages/db/README.md) covers the views.

## Prerequisites

[gcx](https://github.com/grafana/gcx), Grafana's CLI. Only this package needs it:

```sh
brew install gcx
```

## Working on a dashboard

With the dev database running:

```sh
pnpm seed:history   # rows for the panels to draw, ending today
pnpm grafana
```

Open <http://localhost:55331>, not Grafana's own port: the dashboards are served from
`resources/` by `gcx dev serve`, a proxy in front of a Grafana in Docker, and Grafana itself has
none. Queries run against the dev database. Ctrl-C stops the proxy; `pnpm grafana:stop` stops
Grafana.

The files and the browser stay in step both ways:

- **Edit a file**, and the open tab reloads.
- **Save in the UI**, and the save is written back to the file, as a diff of only what you changed.

So build a panel in the UI and commit the diff, or have an agent edit the file and watch it redraw.
Either way, the files are in the form a UI save writes, every default spelled out; keep them that
way, or the next save rewrites the whole file. To add a dashboard, copy one, and change its
`metadata.name` and title.

**Keep dashboards at `dashboard.grafana.app/v2beta1`.** Behind `gcx dev serve`, Grafana's
frontend asks for `v2beta1`, and the proxy cannot convert a file at any other version, so it
renders nothing. Grafana itself accepts `v2beta1` and converts it.

## Adding a metric

1. A view in a new migration, following
   [`packages/db/README.md`](../../packages/db/README.md#conventions)'s conventions for `metrics`
   views, with its test in
   [`packages/db/tests/metrics.test.ts`](../../packages/db/tests/metrics.test.ts).
2. The rows it reads, in the synthetic history,
   [`plan.ts`](../../packages/db/src/testing/history/plan.ts). Then `pnpm seed:history`.
3. A panel, with `metrics` as its data source.
