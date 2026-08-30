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
today it's a plain-props stub (a raw ISO timestamp, a bare list of file links) rather than the real
screen.

- **The succeeded screen is three plain props, nothing else.** `polling/view.svelte` renders it as
  `<ResultView finishedAt={...} files={...} inputFile={...} />` — a `Date`, a `ResultFiles`, and
  `{ href, originalFilename, byteSize }`. This component does not know a poll exists, does not
  take `data`, and never will: once a report has succeeded nothing on this screen changes again
  without a page reload, so there is nothing here for a poll to drive.
- **`ResultFiles.pdf` and `.xlsx` are always present.** `analysis_attempt_succeeded_has_pdf` /
  `_has_xlsx` (DB triggers) guarantee it, and `_loadReport`'s `loadResultFiles`
  ([`+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.server.ts))
  already asserts it via `requireConstraint`, throwing (500) rather than rendering around a missing
  file. There is no "missing file" case left for this view to handle.
- **Charts do not exist in this schema or contract right now, on purpose.** `result_file_kind` was
  `'pdf' | 'xlsx' | 'chart'`; the `chart` variant, `chart_key`, and every piece of plumbing built on
  it (the worker's chart file naming, the contract's `charts` array, this page's `ChartLink`) were
  removed rather than shipped half-specified: nothing has ever produced a real chart (`analyze()`
  is still a stub), and the title/order/description a chart needs were never settled. Re-adding
  charts is a fresh, additive change once GBD says whether this page shows them at all.
- **The file links need no signing logic here.** `/file/input/[id]` and `/file/result/[id]` are
  public, permanent, and 302 to a 60-second signed URL
  ([`files.ts`](apps/web/src/lib/server/files.ts)). A PDF or XLSX downloads as
  `{report name}.{ext}`. No link on this page expires.
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

## Manual verification needs a report to look at

The upload form ([`report-upload-form.md`](report-upload-form.md)) is the only thing that creates
a report from a browser, and it hasn't landed. Until it does, use a throwaway script or `psql`
against the test stack, and `UPDATE analysis_attempt` to flip a row to `succeeded` with some
`result_file` rows attached — see `insertAnalysisAttempt` / `insertResultFile` in
[`fixtures.ts`](packages/db/src/testing/fixtures.ts) for the shape a test would use, and drive the
same inserts by hand. Do **not** extend [`seed.ts`](packages/db/src/seed.ts) — it is scoped to the
placeholder identity and marked for deletion when auth lands.

## How this gets tested

**Components, real Chromium (`*.svelte.test.ts`).** `result-view.svelte.test.ts` mounts the view on
its own props: the three hrefs (PDF, XLSX, original file), and `page.viewport(375, 667)` asserting
no horizontal scroll.

Not tested here: the poll, the switch, and the discriminated union — those already have their own
tests (`polling/view.svelte.test.ts`, `poll-report.test.ts`, `load-report.test.ts`) and this PR
touches none of them.

## PR 1 — The success view

**`result/view.svelte`** — replace the stub: "Finished 4 minutes ago" (via `formatElapsed`/
`formatTimestamp`), then the PDF and Excel buttons, then the original file as a secondary link with
its filename and `displaySize(byteSize)`.

**Tests** — `result-view.svelte.test.ts` (see above).

## Follow-ups this work identifies but does not do

- **Charts.** Removed from the schema and contract entirely in a prior change — see the Context
  note above. Whether this page ever shows a chart gallery, and what a chart needs (title, order,
  description) is a question for GBD, not something to design speculatively here.
- **Nothing deletes a report from the UI.** `DELETE .../reports/[reportId]` is a real, tested
  endpoint, but delete wants a heavier confirmation than cancel's or retry's, and a home on every
  screen rather than only one. A small self-contained PR once the screens exist.
- **Result metadata** — processing time, model, tokens, cost — has a home on this page and no
  design yet.
- **The organization's reports list is still a stub**, so nothing links *to* a report page yet.
  It will want the same status labels this page uses, promoted out of this route folder on that
  second consumer rather than in anticipation of it.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. Run `svelte-autofixer` (Svelte MCP) over every new `.svelte` file until it reports nothing.
2. From the repo root: `pnpm lint && pnpm check && pnpm test`.
3. `pnpm dev`, then flip a report to `succeeded` with a PDF and an XLSX attached (see
   *Manual verification* above): both download links work.
4. Keyboard-only through the success view.
5. At 375px, no horizontal scroll.
6. Report which steps passed, and say plainly if any were skipped.
