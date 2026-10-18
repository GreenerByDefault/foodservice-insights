# Data quality warnings up front

## Context

The nonprofit tried the app and wrote:

> On the report landing tab/page, maybe have the data quality warnings there? This might require
> further iteration, but I want reports with large data quality flags to be displayed there early
> so users can take the findings with a grain of salt. Right now, having the data quality pieces
> at the end might cause users to miss that piece

We asked whether they meant the web page or only the PDF. This plan assumes the web page. The PDF
now has its "Data Completeness & Quality" page directly after the executive summary, which was our
idea, not theirs: the PDF is what gets forwarded, and the people who receive it are the ones most
likely to take its numbers at face value. The page keeps that position when every check passed, as
a short page saying so, because a page whose position depends on the data is harder to find and
to test. The web notice, by contrast, appears only when there are findings.

Today:

- **The checks** are in `checks.run_all_diagnostics`
  ([`checks.py`](../../python/insights/gbd_foodservice_insights/report/checks.py)). Each returns
  `Finding`s whose `message` and `sample_values` are plain-language f-strings written for the PDF.
  Several of them name the customer's products.
- **No check emits `error`.** Every finding the customer sees is a `warning`, so `quality_status`
  is only ever `pass` or `warning`.
- **What the customer PDF lists is `listed_findings(findings, show_successes=False)`** in
  [`quality.py`](../../python/insights/gbd_foodservice_insights/report/quality.py): the warnings
  and errors, at most 20, with at most 5 examples each, as `ListedFinding`s. `quality_lines` in
  [`pdf.py`](../../python/insights/gbd_foodservice_insights/report/pdf.py) renders that list, and
  `analyze()` hands the same list back as `AnalysisOutcome.findings`.
- **The child writes them to `result.json`** as a required `findings` array of
  `{ qualityCheck, status, message, sampleValues }`, and **the worker stores them in
  `analysis_attempt_finding`** in the same transaction as the success verdict
  (`markAttemptSucceeded` in [`queue.ts`](../../apps/worker/src/attempt/queue.ts)). The contract
  bounds each message and sample at 8,000 bytes of UTF-8 and the samples at 5, under `findings` in
  [`contract.json`](../../contract/contract.json).
- **The stubbed child** (`WORKER_MODE=stubbed`, `python/worker_child/worker_child/testing.py`)
  reports one `missing_internal_months` warning on its happy path, so a report made under
  `pnpm dev` has a finding to show.
- **The web report page** shows the downloads and the upload details, and no findings. The rows
  only appear once a worker that writes them has been deployed.

## Decisions

### The page shows the PDF's own wording, stored with the attempt

The page reads `analysis_attempt_finding`, ordered by `position`, which is the PDF's order. The
page and the PDF print the same Python strings, so they cannot disagree. Because the rows are
written atomically with the success verdict, a succeeded attempt always has its findings, and no
rows means no warnings. They hang off `analysis_attempt` with `ON DELETE CASCADE`, since the
messages name products and deleting an organization hard-deletes its attempts.

*Rejected: reading `analysis_attempt_quality_check`.*
- It holds counts, not wording.
- It is written after the verdict on a best-effort basis: a bounded retry, then the rows are logged
  and dropped ([`ARCHITECTURE.md`](../../ARCHITECTURE.md)). A succeeded report can show up before its
  telemetry arrives, or without it ever arriving. The page would then show no warnings without
  any sign that something was missing, which is the worst failure this feature can have.
- Telemetry outlives the organization, so it is defined to hold no customer text (the header of
  [`003_attempt_telemetry.ts`](../../packages/db/migrations/003_attempt_telemetry.ts)). The wording
  cannot go there.

*Rejected: per-check wording in TypeScript keyed on the `quality_check` enum, the way
[`failure-copy.ts`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/failure/failure-copy.ts)
handles failures.* It loses the specifics, such as which month or which product, that make a
warning actionable, and its wording drifts from the PDF's.

### The page: a notice above the downloads

The notice goes in `result-view.svelte`, between the status line and the buttons, and appears
only when there are findings:

```
⚠ This report has 2 data quality warnings
  Read them before you share the results.

  • Found 3 months where the total kilos changed by more than 50% from the month before. …
    ▸ Examples (3)
  • Mar 2024, the last month in the file, has 12 lines against about 340 …
```

- **The messages are visible from the start.** They are the point of the notice. Each finding's
  examples go in a collapsed native `<details>`.
- **The heading is the only new wording in TypeScript.** It shows the count, singular or plural.
- **It uses the `Alert` component without its `role="alert"`.** The notice appears when a poll
  swaps in the result view, and the page's live headline already announces that. The same
  interruption is why the optional-counts plan rejected `Alert` on the form.
- **Nothing appears when every check passed.** The PDF already says so.

Adjust the layout once the nonprofit has seen it.

### Reports from before the change show no notice

Attempts that finished before the findings-storing worker was deployed have no rows, so they look
clean. We accept that. The app is in trial, and a backfill would mean rerunning the checks.

### Not in this plan: headline numbers

The nonprofit said earlier that the page does not need headline numbers. The notice meets their
need without any. If they ask for numbers later, the same path carries them: `result.json`, then
stored with the attempt. They should not come from telemetry, which has the reliability problem
described above. Also note that the optional-counts plan makes the per-diner figure nullable.

### How often warnings fire

Before PR 1 merges, query production's `analysis_attempt_quality_check` for each check's firing
rate. The success rows are kept, so the rate has a denominator. If most reports get a warning, the
notice becomes noise. The fix then belongs in the thresholds (`diagnostic_thresholds.yaml`) or in a
severity split, not in hiding the notice.

The sample is still small, so this informs the decision but does not block it.

### Reports without counts

The upload form offers "No counts". The library skips the counts check for those reports, and
deliberately does not report "no counts" as a finding, so they will not show this notice. That
needs no change here.

## PR 1 — the report page shows the warnings

It shows nothing in production until the worker that stores findings is deployed.

- **`+page.server.ts`:**
  - The `succeeded` attempt gains `findings`, loaded by position next to `loadResultFiles`.
  - `poll/+server.ts` reuses `_loadReport`, so the polling path gets the findings too.
- **The component:** a new `data-quality-notice.svelte`, rendered by `result-view.svelte`.

Tests:

- **`load-report.test.ts`:** findings come back in order, and as `[]` when there are none.
- **The component test:**
  - nothing renders with no findings;
  - the heading is singular or plural;
  - the messages are visible and the examples sit inside `<details>`.
- **`apps/web/e2e/reports/reports.screenshot.ts`:** a succeeded report with warnings.

## Verification

- Run the TypeScript gate.
- Run the whole flow locally. Upload a file with a missing internal month, which trips
  `missing_internal_months`, or any file under `WORKER_MODE=stubbed`. Then check that:
  - the notice shows on the page once the report finishes;
  - deleting the organization removes its `analysis_attempt_finding` rows.
