# Optional diner and meal counts

## Context

GBD asked for a "no diner counts" option on the upload form:

> We might have a client who doesn't need per person metrics. There should be a warning saying
> that no meal counts were provided; thus the numbers can't be directly compared to other sites
> due to differences in size.

Everything behind the form already handles a report without counts. The database stores it as
NULL in both `report.counts_basis` and `report.monthly_counts` (`report_counts_all_or_none`
ties them), the worker hands the child `counts: null` in `run.json`, the analysis library
builds a totals-only report, telemetry records a NULL basis and no per-diner figure, and the
report page's Upload details read "Not provided". What still requires counts is the front door,
and each layer enforces it on its own:

- **The form** puts `required` on an input for every month the file covers
  ([`upload-form.svelte`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/upload-form.svelte),
  [`monthly-counts.svelte`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/monthly-counts.svelte)).
- **The server** checks for a count in every month that has rows: `ReportMetadataSchema` in
  [`metadata.ts`](../../apps/web/src/lib/reports/metadata.ts), and `monthsWithoutCounts` in
  [`submission.ts`](../../apps/web/src/lib/reports/submission.ts).

The worker deploys only on dispatch, so it is always the side running behind the web app
([`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker-deploys-only-on-demand)). A deployed worker
that predates the `counts` manifest shape would fail a report without counts at manifest parse,
so **the worker that accepts `counts: null` must be live before the form below merges.**

## Decisions

### "No counts" is NULL in the database, and one optional value above it

The two report columns are NULL together, never one without the other. Every layer above SQL
parses them into a single optional value — the manifest's `counts: { basis, monthly } | null`,
Python's `MonthlyCounts | None`, the report page's `counts: ReportCounts | null` — so "a basis
without counts" is unrepresentable outside SQL. The form's submission follows suit: the server
writes NULL to both columns or neither.

*Rejected: a `'none'` value on the `counts_basis` enum.* An `ADD VALUE` can't be used in the same
transaction that adds it, and every pending migration runs in one
([`packages/db/README.md`](../../packages/db/README.md#writing-a-migration)). It also reads wrong:
"no counts" is not a kind of count.

**In the form,** the `counts-basis` field takes `'people' | 'meals' | 'none'`. The `'none'` token
lives only there; the server stores NULLs. Partial counts, with some months missing, stay an
error: `None` is the explicit, typed absence of counts, not a licence for a bad mapping.

### The form: a third "Count by" choice

```
Diners or meals served
  Enter how many diners or meals you served each month. …   (existing copy)

  Count by   ( ) Diners  ( ) Meals  ( ) No counts

  [with "No counts" chosen, the month inputs give way to:]
  ⓘ Your report will show totals only. Totals grow with the number of people a site
    serves, so they can't be compared directly with other sites.
```

- **The default stays Diners,** so skipping counts is a deliberate choice rather than the path of
  least resistance.
- **Typed counts survive a round trip.** The draft stays in component state, so choosing "No
  counts" and then switching back restores what was typed.
- **Submit isn't blocked.** The month inputs unmount, so their `required` no longer applies.
- **On submit,** `counts-basis=none` is sent and `monthly-counts` is left out.

The note is a `Field.Description` added to the radio group's `aria-describedby` while it shows.
*Rejected: an `Alert`.* Its `role="alert"` would interrupt a screen reader on every change of
radio.

*Rejected: a separate "I don't have counts" checkbox.* It is a second control for what is really
a third answer to "count by what?", and it would leave the Diners/Meals radio meaningful only
some of the time.

### The warning lives with the numbers: in the PDF

GBD's warning is about comparing figures, and the figures are in the PDF, so that is where the
warning goes. The library already does this. The executive summary says the figures are totals
and can't be compared directly with other sites, How to Read says the same, About drops its
per-diner line, the diner chart is left out, and the two trend pages keep only their total panel.
The counts check is skipped rather than reported. *Rejected: reporting "no counts" as a quality
finding.* It is the client's choice, not a data problem, and a warning finding would flip
`quality_status` and count as a fired check in telemetry.

**The web report page** reads "Not provided" under "Diners or meals served" in place of the
month table. It shows no figures, so a comparability warning there would have nothing to
qualify.

The Excel workbook drops the counts sheet and the per-head columns, and carries no warning.

## PR 1 — the form offers "No counts"

Merge only once a worker deploy carrying the `counts` manifest shape is live.

- **`metadata.ts`:** `ReportMetadataSchema` becomes a `v.variant` on `countsBasis`.
  - `'none'` requires `monthly-counts` to be absent.
  - The other two bases keep today's rules.
- **`submission.ts`:** run `monthsWithoutCounts` only when there are counts.
- **`+server.ts`:** `insertReport` writes NULL to both `countsBasis` and `monthlyCounts`.
- **`upload-form.svelte`:** the third radio, the note, and leaving `monthly-counts` out on
  submit.
- **`REQUIREMENTS.md` § File upload:** "a map of each month to the number of diners or meals,
  or none".
- Delete this plan.

Tests:
- **`metadata` / `submission`:**
  - `none` without counts is accepted.
  - `none` with counts is rejected.
  - `people` without counts is still rejected.
- **`create-report.test.ts`:** stores NULLs.
- **`upload-form.svelte.test.ts`:**
  - Choosing "No counts" hides the months and shows the note.
  - Submit sends `counts-basis=none` with no `monthly-counts`.
  - Switching back restores the typed values.
- **`new-report.e2e.ts`:** a no-counts upload lands on a report whose Upload details say "Not
  provided".
- **`new-report.screenshot.ts`:** a baseline for the "No counts" state, regenerated through
  turbo.
- **Optional:** point `tests/e2e/specs/report-lifecycle.e2e.ts` at "No counts", so the full stack
  runs that path once. Nothing has run a no-counts report through the real web → worker → child
  path yet; until now the shared `contract/fixtures/valid/run.no-counts.json` is the only
  cross-stack evidence.

## Verification

- With `/run`, upload with "No counts" at phone and desktop widths, toggle between bases, and
  check that typed counts come back. Then let the report finish and open its PDF.
- **Gates:** `just lint && just check && just test` for Python, and
  `pnpm lint && pnpm check && pnpm test` for TypeScript.
