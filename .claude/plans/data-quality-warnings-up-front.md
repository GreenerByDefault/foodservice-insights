# Data quality warnings up front

## Context

The nonprofit tried the app and wrote:

> On the report landing tab/page, maybe have the data quality warnings there? This might require
> further iteration, but I want reports with large data quality flags to be displayed there early
> so users can take the findings with a grain of salt. Right now, having the data quality pieces
> at the end might cause users to miss that piece

We asked whether they meant the web page or only the PDF. This plan assumes the web page, and
reorders the PDF either way. The PDF is what gets forwarded, and the people who receive it are the
ones most likely to take its numbers at face value.

Today:

- **The checks** are in `checks.run_all_diagnostics`
  ([`checks.py`](../../python/insights/gbd_foodservice_insights/report/checks.py)). Each returns
  `Finding`s whose `message` and `sample_values` are plain-language f-strings written for the PDF.
  Several of them name the customer's products.
- **No check emits `error`.** Every finding the customer sees is a `warning`, so `quality_status`
  is only ever `pass` or `warning`.
- **The customer PDF** lists the `warning` and `error` findings on "Data Completeness & Quality",
  its last page. The list is capped at 20 findings and 5 examples each, by `quality_lines` with
  `show_successes=False` in
  [`pdf.py`](../../python/insights/gbd_foodservice_insights/report/pdf.py). The executive summary
  only says the notes are "listed in plain language at the back of this report"
  (`_narrative_paragraphs`).
- **The web report page** shows the downloads and the upload details, and no findings.
- **`result.json`** carries only `analysisAttemptId`. The findings reach the database only as
  telemetry: counts per check and status, in `analysis_attempt_quality_check`.

## Decisions

### The page shows the PDF's own wording, stored with the attempt

The child adds the customer's findings to `result.json`. The worker stores them in a new
`analysis_attempt_finding` table, in the same transaction that `markAttemptSucceeded`
([`queue.ts`](../../apps/worker/src/attempt/queue.ts)) uses to insert `result_file`. The page loads
them alongside the result files.

- **One source of wording.** The page and the PDF print the same Python strings, so they cannot
  disagree.
- **Written atomically with the success verdict.** A succeeded attempt always has its findings, so
  no rows means no warnings.
- **`ON DELETE CASCADE` from `analysis_attempt`.** The messages name products, which are customer
  data. Deleting a report is only a soft delete, but deleting an organization hard-deletes its
  reports and attempts, and the findings have to go with them.

*Rejected: reading `analysis_attempt_quality_check`.*
- It holds counts, not wording.
- It is written after the verdict on a best-effort basis: a bounded retry, then the rows are logged
  and dropped ([`ARCHITECTURE.md`](../../ARCHITECTURE.md)). A succeeded report can show up before its
  telemetry arrives, or without it ever arriving. The page would then show no warnings without
  any sign that something was missing, which is the worst failure this feature can have.
- The missing foreign key is not itself the obstacle, since a join on `analysis_attempt_id` works.
  The reason behind it is: telemetry outlives the organization, so it is defined to hold no
  customer text (the header of
  [`003_attempt_telemetry.ts`](../../packages/db/migrations/003_attempt_telemetry.ts)). The wording
  cannot go there.

*Rejected: per-check wording in TypeScript keyed on the `quality_check` enum, the way
[`failure-copy.ts`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/[reportId=uuid]/failure/failure-copy.ts)
handles failures.*
- It loses the specifics, such as which month or which product, that make a warning actionable.
- Its wording drifts from the PDF's.
- It still needs a source more reliable than telemetry, so it saves little.

The counts are stored twice, here and in telemetry. That is deliberate, because the two are kept
for different lengths of time.

### What is stored is exactly what the customer PDF lists

`quality_lines` decides which findings the customer sees. That selection moves into a
`customer_findings(findings)` function, which both the PDF and `result_payload` call, so there is
one definition of what the customer sees.

`analysis_attempt_finding`:

- `analysis_attempt_id`: references `analysis_attempt`, with `ON DELETE CASCADE`.
- `position`: the PDF's order. The primary key is `(analysis_attempt_id, position)`.
- `quality_check` and `status`: reuse the enums from `003`. A CHECK limits `status` to `warning`
  and `error`.
- `message`: non-empty text.
- `sample_values`: a `text[]` of at most 5.

The contract bounds the length of `message` and of each sample. Base the bound on
`categorization.maxProductBytes`, since a product name is the longest thing a message embeds.

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

### The PDF: the quality page follows the executive summary

The page order becomes: title, executive summary, Data Completeness & Quality, How to Read, then
the charts and the rest. The page stays there when every check passed. In that case it is a short
page saying so.

The executive summary's sentence changes from "at the back of this report" to "on the next page".

*Rejected: moving the page only when a warning fired.* A page whose position depends on the data is
harder for a reader to find and harder to test.

### Reports from before the change show no notice

Attempts that finished before PR 3's worker was deployed have no rows, so they look clean. We
accept that. The app is in trial, and a backfill would mean rerunning the checks.

### Not in this plan: headline numbers

The nonprofit said earlier that the page does not need headline numbers. The notice meets their
need without any. If they ask for numbers later, the same path carries them: `result.json`, then
stored with the attempt. They should not come from telemetry, which has the reliability problem
described above. Also note that the optional-counts plan makes the per-diner figure nullable.

### How often warnings fire

Before PR 4 merges, query production's `analysis_attempt_quality_check` for each check's firing
rate. The success rows are kept, so the rate has a denominator. If most reports get a warning, the
notice becomes noise. The fix then belongs in the thresholds (`diagnostic_thresholds.yaml`) or in a
severity split, not in hiding the notice.

The sample is still small, so this informs the decision but does not block it.

### Overlap with in-flight plans

- **`optional-diner-and-meal-counts`:**
  - Its PR 1 skips the counts check when there are no counts. That needs no change here.
  - It deliberately does not report "no counts" as a finding, so no-counts reports will not show
    this notice.
  - It also claims migration `004`. Whichever lands second renumbers.

## PR 1 — the PDF puts the quality page up front

Python only, and independent of the rest, so it can merge first.

- **`write_report_pdf`:** move the "Data Completeness & Quality" page to directly after
  `create_executive_summary_page`.
- **`_narrative_paragraphs`:** change "at the back of this report" to "on the next page".
- **Extract `customer_findings`:** pull out the warning/error filter and the 20 and 5 caps, and
  have `quality_lines` call it. This is a prefactor for PR 3.

Tests (`test_pdf.py`):

- The page-title order in the existing `write_report_pdf` test.
- The narrative sentence.
- The existing `quality_lines` tests stay green unchanged, which shows the extraction preserved
  behavior.

## PR 2 — the `analysis_attempt_finding` table

- **The migration:** add `packages/db/migrations/004_attempt_findings.ts` (or the next free
  number), with the columns and constraints above and comments on the table and on `position`.
- **Regenerate:** `public-schema.sql` and `src/generated/`.
- **Docs:** add one line on the table to the model section of `packages/db/README.md`.

This is a pure expand: nothing reads or writes the table yet. The migration runs when
`deploy.yml` deploys web.

Tests (`withRollback`):

- A `warning` row is accepted.
- The table rejects:
  - a `success` or `info` status;
  - an empty message;
  - more than 5 samples;
  - a duplicate position.
- Deleting the report's organization deletes the rows.

## PR 3 — the child reports its findings and the worker stores them

Merge only once PR 2 has deployed. The parent and the child ship in one image, so the contract can
change shape in a single PR.

- **Contract:**
  - `result.json` gains a required `findings` array, which may be empty, of
    `{ qualityCheck, status, message, sampleValues }`.
  - The finding enums already live under `telemetryEnums` in `contract.json`. Reuse them, and
    rename that group if `result.json` sharing it reads wrong.
- **Python:**
  - `AnalysisOutcome` gains `findings`, built from `customer_findings(report.findings)` in
    `analysis.py`.
  - `result_payload` validates and writes them.
  - `run.py` passes them through.
- **TypeScript:**
  - `ChildResultSchema` in `messages.ts` gains the array.
  - `markAttemptSucceeded` inserts the rows after `result_file`, with `position` set from each
    finding's index.

Tests:

- **Contract fixtures:**
  - The valid `result.json` gains findings.
  - Invalid fixtures: a `success` status, an unknown check, an empty message, 6 samples, a message
    over the bound, and an unknown field.
- **`queue.test.ts`:** `markAttemptSucceeded` writes the findings in order. It writes none when it
  loses the race.
- **Python:** `test_analysis` covers the outcome's findings, and the child's `run` test covers the
  payload.
- **`pnpm test:system`** locally, because this changes the seam between the worker and the child.

**After merging, dispatch a worker deploy.**

## PR 4 — the report page shows the warnings

This can merge any time after PR 2. It shows nothing until PR 3's worker is live.

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

- Run each stack's gate for every PR.
- Run the whole flow locally. Upload a file with a missing internal month, which trips
  `missing_internal_months`. Then check that:
  - the notice shows on the page once the report finishes;
  - the warning in the PDF is on page 3;
  - deleting the organization removes its `analysis_attempt_finding` rows.
