# The report page

## Context

[`reports/[reportId]/+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.svelte)
is the page a user lands on after an upload is accepted, and the page every notification email
links to. Everything on it is built and tested except one leaf component: the **succeeded**
screen's content. The waiting, canceled and failed screens, the live poll that swaps between all
of them, and the discriminated union the server hands down are done —
[`polling/view.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/polling/view.svelte)
owns the switch, the live region, and the poll loop, and none of that is this PR's concern. What
remains is
[`result/view.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/result/view.svelte):
today it's a plain-props stub (a raw ISO timestamp, a bare list of file links, chart keys as their
raw snake_case strings) rather than the real screen.

- **The succeeded screen is three plain props, nothing else.** `polling/view.svelte` renders it as
  `<ResultView finishedAt={...} files={...} inputFile={...} />` — a `Date`, a `ResultFiles`, and
  `{ href, originalFilename, byteSize }`. This component does not know a poll exists, does not
  take `data`, and never will: once a report has succeeded nothing on this screen changes again
  without a page reload, so there is nothing here for a poll to drive.
- **`ResultFiles.pdf` and `.xlsx` are always present.** `analysis_attempt_succeeded_has_pdf` /
  `_has_xlsx` (DB triggers) guarantee it, and `_loadReport`'s `loadResultFiles`
  ([`+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.server.ts))
  already asserts it via `requireConstraint`, throwing (500) rather than rendering around a missing
  file. `ResultFiles.charts` is `ChartLink[]` (`{ href, chartKey }`), ordered by `chartKey` in the
  query — there is no "missing file" and no reordering left for this view to handle.
- **The file links need no signing logic here.** `/file/input/[id]` and `/file/result/[id]` are
  public, permanent, and 302 to a 60-second signed URL
  ([`files.ts`](apps/web/src/lib/server/files.ts)). A chart gets no `content-disposition` so it
  renders inline; a PDF or XLSX downloads as `{report name}.{ext}`. No link on this page expires.
- **`@gbd/core`'s [`time.ts`](packages/core/src/time.ts) owns both renderings of a moment.**
  `formatElapsed(now, at)` gives the relative string ("3 minutes ago"), stopping at days rather than
  using `Intl.RelativeTimeFormat`'s approximate weeks/months; `formatTimestamp(at)` is the exact UTC
  moment for a tooltip. Render as
  `<time datetime={iso} title={formatTimestamp(at)}>{formatElapsed(now, at)}</time>` — but see
  *Rejected* below, this view only ever renders one such line, not a timeline.
- **`displaySize(byteSize)`** ([`file-drop-zone/index.ts`](apps/web/src/lib/components/ui/file-drop-zone/index.ts))
  is the existing human-readable byte formatter — reuse it for the original file's secondary link
  rather than writing a second one.

*Rejected: a timeline on the success screen.* Once a report is ready, how long it queued is
metadata, out of scope. One line — "Finished 4 minutes ago" — carries everything a timeline would
have.

## Decisions

### Charts render generically, from the key alone

Chart keys are open-ended snake_case strings — `CHART_KEY_PATTERN` is
`/^[a-z0-9]+(_[a-z0-9]+)*$/` in [`layout.ts`](apps/worker/src/contract/layout.ts) — so nothing on
this page may enumerate them. Every `result_file` row of kind `chart` becomes a figure, ordered by
`chart_key` (already sorted by the load), captioned with `humanizeChartKey(key)` (`total_spend` →
"Total spend"). When the chart set is settled, only that one function and the ordering change.

**One column, `max-w-3xl`.** A chart PNG has its axis labels baked in at whatever size the library
drew them, so a two-up grid at 500px each is a wall of unreadable text, and 375px is worse. Single
column, `max-width: 100%; height: auto`, `loading="lazy"`, and each figure's image wrapped in a
link to its own `/file/result/{id}` so a phone user can open it full size.

**Accessibility is genuinely limited here, and the plan should not pretend otherwise.** A PNG with
no description is not accessible, and the library gives us nothing to describe it with. The least
dishonest arrangement available:

- `<figcaption>` carries the humanized title, so it is visible and in the accessibility tree.
- `<img alt="">`, because the caption already names the figure and there is no description to put
  in `alt` — a duplicate of the caption is noise, and a made-up description is worse than silence.
- One sentence above the section pointing at the real alternative: the Excel file has the same
  figures as text.

The actual fix is a title and a short description per chart in the child's `result.json`, which is
a contract change (§ Follow-ups). This is worth raising before an accessibility review, not after.

**Trap for later: a CSP will need `img-src` for the storage origin.** There is no CSP yet, and
`REQUIREMENTS.md` § Security wants one. Charts are `<img>`s that 302 to Supabase, so whoever adds
the CSP has to allow that host or every chart breaks.

**Cost, accepted:** each chart image is one request to our server, which is a database read plus an
`objectExists` call plus a signing call. Eight charts is eight of those on a page view.
`loading="lazy"` spreads them out. Not worth optimising until it is measured.

## Manual verification needs a report to look at

The upload form ([`report-upload-form.md`](report-upload-form.md)) is the only thing that creates
a report from a browser, and it hasn't landed. Until it does, use a throwaway script or `psql`
against the test stack, and `UPDATE analysis_attempt` to flip a row to `succeeded` with some
`result_file` rows attached — see `insertAnalysisAttempt` / `insertResultFile` in
[`fixtures.ts`](packages/db/src/testing/fixtures.ts) for the shape a test would use, and drive the
same inserts by hand. Do **not** extend [`seed.ts`](packages/db/src/seed.ts) — it is scoped to the
placeholder identity and marked for deletion when auth lands.

## How this gets tested

**Pure functions, node.** `chart-title.test.ts` — snake_case, one word, digits, and the hyphenated
form the DB fixture still uses (see § Follow-ups).

**Components, real Chromium (`*.svelte.test.ts`).** `result-view.svelte.test.ts` mounts the view on
its own props: the three hrefs (PDF, XLSX, original file), one figure per chart with the humanized
caption, and `page.viewport(375, 667)` asserting no horizontal scroll.

Not tested here: the poll, the switch, and the discriminated union — those already have their own
tests (`polling/view.svelte.test.ts`, `poll-report.test.ts`, `load-report.test.ts`) and this PR
touches none of them.

## PR 1 — The success view

**`result/view.svelte`** — replace the stub: "Finished 4 minutes ago" (via `formatElapsed`/
`formatTimestamp`), then the PDF and Excel buttons, the original file as a secondary link with its
filename and `displaySize(byteSize)`, then the charts.

**`charts.svelte`** and **`chart-title.ts`** — `humanizeChartKey`, the single-column figure list,
lazy images, the full-size link, and the one sentence pointing at the Excel file.

**Tests** — `chart-title.test.ts`, `result-view.svelte.test.ts` (see above).

## Follow-ups this work identifies but does not do

- **Charts have no order and no description.** Both want the same contract change: `result.json`'s
  `charts` array carrying a title, a short description and an explicit order, rather than bare
  keys. Until then the page orders by key and captions with a humanized key.
- **`insertResultFile`'s default `chartKey` is `'total-spend'`**
  ([`fixtures.ts`](packages/db/src/testing/fixtures.ts)), which `CHART_KEY_PATTERN` would reject.
  A one-character fix, but it is not this change's.
- **Nothing deletes a report from the UI.** `DELETE .../reports/[reportId]` is a real, tested
  endpoint, but delete wants a heavier confirmation than cancel's or retry's, and a home on every
  screen rather than only one. A small self-contained PR once the screens exist.
- **A CSP will need `img-src` for the storage origin.**
- **Result metadata** — processing time, model, tokens, cost — has a home on this page and no
  design yet.
- **Making charts `<img>`s breaks `reports-succeeded.png`** (`e2e/reports/reports.screenshot.ts`),
  for two independent reasons: `redirectToSignedUrl` 404s a key with nothing behind it, so the
  fixture needs real bytes via `putObject`; and the signed URL points at `S3_ENDPOINT`
  (`127.0.0.1` in `.env.test`), which resolves to the screenshot browser's own container rather
  than the host. Fixing the second means signing against `host.docker.internal` or intercepting
  with `page.route()` — worth knowing before this PR is estimated.
- **The organization's reports list is still a stub**, so nothing links *to* a report page yet.
  It will want the same status labels this page uses, promoted out of this route folder on that
  second consumer rather than in anticipation of it.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. Run `svelte-autofixer` (Svelte MCP) over every new `.svelte` file until it reports nothing.
2. From the repo root: `pnpm lint && pnpm check && pnpm test`.
3. `pnpm dev`, then flip a report to `succeeded` with a PDF, an XLSX and three charts attached (see
   *Manual verification* above): all three download links work, the charts render inline rather
   than downloading, and each opens full size.
4. Keyboard-only through the success view.
5. At 375px, no horizontal scroll.
6. Report which steps passed, and say plainly if any were skipped.
