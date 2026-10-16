# Optional diner and meal counts

## Context

GBD asked for a "no diner counts" option on the upload form:

> We might have a client who doesn't need per person metrics. There should be a warning saying
> that no meal counts were provided; thus the numbers can't be directly compared to other sites
> due to differences in size.

Today counts are required at every layer, and each layer enforces it separately:

- **The form** puts `required` on an input for every month the file covers
  ([`upload-form.svelte`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/upload-form.svelte),
  [`monthly-counts.svelte`](../../apps/web/src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/monthly-counts.svelte)).
- **The server** checks for a count in every month that has rows: `ReportMetadataSchema` in
  [`metadata.ts`](../../apps/web/src/lib/reports/metadata.ts), and `monthsWithoutCounts` in
  [`submission.ts`](../../apps/web/src/lib/reports/submission.ts).
- **The database:** `report.counts_basis` and `report.monthly_counts` are both `NOT NULL`, and
  so is `analysis_attempt_telemetry.counts_basis`.
- **Telemetry's all-or-none CHECK:** `analysis_attempt_telemetry_report_all_or_none` requires
  `co2e_kg_per_diner_or_meal` whenever `total_co2e_kg` is set.
- **The worker ↔ child contract** requires a non-empty `monthlyCounts` on the way in and
  `co2eKgPerDinerOrMeal` on the way out, in both
  [`messages.ts`](../../apps/worker/src/contract/messages.ts) and
  [`messages.py`](../../python/worker_child/worker_child/contract/messages.py).
- **The analysis library:** `build_food_report` raises "No positive diner count for …" for any
  month without one ([`food_report.py`](../../python/insights/gbd_foodservice_insights/report/food_report.py)).

Per-diner figures appear only in the PDF and the Excel file. The web report page lists the counts
that were entered (`upload-details.svelte`), but shows no metric.

What depends on counts today:

- **PDF:**
  - The last sentence of the executive summary's first paragraph ("roughly X kg of CO₂e per
    diner").
  - Two lines on the How to Read page.
  - One line on the About page.
  - The "Number of Diners by Month" chart.
  - The bottom panel of both "Kilos Over Time" and "Carbon Emissions Over Time".
  - The `diner_meal_count_reasonableness` check, when it warns.
- **Excel:**
  - The "Diners"/"Meals" sheet.
  - The `kilos per …` column in both monthly sheets.
  - The `kg_co2e_per_…` column in Emissions Summary.

Everything else is computed without counts and is unchanged: totals, categories, plant share,
intensity, the KPIs and the scenarios.

The worker deploys only on dispatch, so it is always the side running behind the schema and the web
app ([`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker-deploys-only-on-demand)). A deployed worker
that cannot handle a report without counts would fail it at manifest parse. That constraint
decides the PR order.

## Decisions

### "No counts" is NULL in both report columns, tied by a CHECK

`report.counts_basis` and `report.monthly_counts` become nullable, with a new constraint
`report_counts_all_or_none`: `(counts_basis IS NULL) = (monthly_counts IS NULL)`. The existing
`report_monthly_counts_is_object` passes on NULL and stays as it is. The column comments say that
NULL means the uploader chose not to give counts.

*Rejected: a `'none'` value on the `counts_basis` enum.* An `ADD VALUE` can't be used in the same
transaction that adds it, and every pending migration runs in one
([`packages/db/README.md`](../../packages/db/README.md#writing-a-migration)). The CHECK pairing it
with a NULL `monthly_counts` would have to dodge that with a `::text` cast. It also reads wrong:
"no counts" is not a kind of count.

The migration only relaxes constraints, so it is pure expand. An old worker never meets a NULL
until the form offers the option.

### Telemetry: no basis means no per-diner figure

`analysis_attempt_telemetry.counts_basis` becomes nullable. `…_report_all_or_none` is replaced by
two constraints:

- `num_nulls(total_co2e_kg, plant_pct_by_weight) IN (0, 2)`
- `(co2e_kg_per_diner_or_meal IS NULL) = (total_co2e_kg IS NULL OR counts_basis IS NULL)`

So the per-diner figure is present exactly when there was a report and there were counts. That
keeps telemetry able to tell "no counts" apart from "the report never got that far".

### Above the database, counts are one optional value, never two nullables

The DB row carries two nullable columns, but every layer above parses them into a single optional
value. That makes "a basis without counts" unrepresentable outside SQL.

**The worker ↔ child manifest** replaces `countsBasis` and `monthlyCounts` with
`counts: { basis, monthly } | null`. The parent and the child ship in one image, so this contract
can change shape freely; only the database → parent seam has to tolerate an old worker. Going the
other way, `co2eKgPerDinerOrMeal` becomes `v.nullable(quantity)` on the TS side, the way
`plantProteinPctByWeight` already is. The Python side validates it only when it is not `None`,
copying the pattern `_report_payload` already uses for that field.

**Python:**
- `AnalysisRequest.counts` becomes `MonthlyCounts | None`, where `MonthlyCounts` holds the basis
  and the month mapping.
- `FoodReport`'s three fields `diner_or_meal`, `diner_meal_mapping` and `diner_meals_in_data`
  collapse into `headcounts: Headcounts | None`.
- `ReportSummary.co2e_kg_per_diner_or_meal` becomes `float | None`.
- Partial counts, with some months missing, stay an error. Python's "fail loudly on bad data"
  rule applies to a bad mapping; `None` is the explicit, typed absence of one.

**Web:**
- The report page loader returns `counts: { basis, monthly: MonthlyCount[] } | null`.
- The form's `counts-basis` field takes `'people' | 'meals' | 'none'`. The `'none'` token lives
  only in the form; the server stores NULLs.

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
warning goes:

- **Executive summary:** the per-diner sentence becomes "No diner or meal counts were provided, so
  these figures are totals. Sites differ in size, so they can't be compared directly with other
  sites." It sits in the same spot a reader would otherwise find the per-diner figure.
- **How to Read:** the two per-diner lines become "Every figure in this report is a total. Totals
  rise and fall with how many people you serve, so compare months with that in mind."
- **About This Report:** the "Per-diner figures account for this by normalising…" line is
  dropped.
- **Charts:**
  - "Number of Diners by Month" is omitted.
  - "Kilos Over Time" and "Carbon Emissions Over Time" become single-panel figures, keeping the
    total panel only.
- **Quality checks:** `run_all_diagnostics` skips the counts reasonableness check.

*Rejected: `_draw_unavailable` placeholders for the per-diner panels.* They would say three more
times what the summary already says once.

*Rejected: reporting "no counts" as a quality finding.* It is the client's choice, not a data
problem. A warning finding would flip `quality_status` to "Some data-quality notes apply", and it
would count as a fired check in telemetry.

**The web report page** reads "Not provided" in place of the month table. It shows no figures, so
a comparability warning there would have nothing to qualify.

**The Excel workbook** drops the counts sheet and the per-head columns, and carries no warning.
It is raw data for analysts, and the missing columns say it.

## PR 1 — the analysis library builds a report without counts

Only `python/insights` and the lab callers change. There is no contract change, so nothing can
send `None` yet.

- Introduce `Headcounts | None` on `FoodReport` and `MonthlyCounts | None` on `AnalysisRequest`.
  - If the diff gets large, split off a behavior-preserving prefactor that only regroups the
    three fields into `Headcounts`.
- When there are no counts:
  - `aggregation.monthly()` omits the per-head column.
  - `calculate_emissions_per_diner_meal` isn't called.
  - `run_all_diagnostics` skips the counts check.
  - `summarize_report` gives `None`.
- PDF: `ExecutiveNarrative`, `_narrative_paragraphs`, `_how_to_read_lines` and
  `_methodology_lines` take the optional headcounts and produce the wording above.
- Plots: `plots/report.py` drops the diner chart, and `figures.py` builds 1×1 trend figures.
- Excel: the counts sheet is `None`.
- Update the lab callers: `food_report/{pipeline,summary,serving}.py`,
  `procurement_serving_comparison.py` and `pilot/analysis.py`.

Tests:
- **`test_food_report`:** with no counts, there is no per-head column, no counts finding, and the
  summary's per-diner value is `None`.
- **`test_pdf`:**
  - The exact no-counts narrative sentence, next to the existing `"meal"` case.
  - A no-counts case added to the parametrized How to Read and About test.
  - Page titles.
- **Plots:** the figure titles without the diner chart, and single-panel trend figures.
- **`test_outputs`:** the sheet list and the columns.
- **`test_analysis`:** an end-to-end `analyze()` with `counts=None`, asserting sheets and chart
  titles.
  - No second golden: `analysis_golden.json` must stay unchanged, which proves the with-counts
    path didn't move.

## PR 2 — the database and the worker accept a report without counts

- **Schema:**
  - `packages/db/migrations/004_optional_counts.ts`, with the constraints above.
  - Regenerate `public-schema.sql` and `src/generated/`.
  - `fixtures.ts` accepts null counts.
- **Contract:**
  - The manifest `counts` shape and nullable `co2eKgPerDinerOrMeal`, in both `messages.ts` and
    `messages.py` (plus `fields.py`, `run.py` and `testing.py`).
  - `contract.json`.
  - Move the existing invalid-count fixtures under `counts`.
- **Worker:** `attempt/queue.ts` builds `counts` from the two columns, and `attempt/telemetry.ts`
  writes a NULL basis.
- **Web:** the report page loader and `upload-details.svelte` handle `counts: null`, showing "Not
  provided". The generated types force this now; the form still can't produce one.

Tests:
- **DB (`withRollback`):**
  - `report` accepts both counts columns NULL and rejects exactly one NULL.
  - Telemetry accepts a NULL per-diner value with a NULL basis.
  - Telemetry rejects a NULL per-diner value with a basis set, and a per-diner value with no
    basis.
- **Contract fixtures:**
  - Valid: `run` with `counts: null`, and `telemetry` with a null per-diner value.
  - Invalid: `counts: {}`, a basis with no monthly counts, and an unknown basis.
- **Web:** `load-report.test.ts` returns `counts: null`, and `upload-details.svelte.test.ts` shows
  "Not provided".
- **`pnpm test:system`** locally, because this changes the web ↔ worker ↔ child seam.

**After merging, dispatch a worker deploy.** PR 3 must not merge until it is live.

## PR 3 — the form offers "No counts"

- **`metadata.ts`:** `ReportMetadataSchema` becomes a `v.variant` on `countsBasis`.
  - `'none'` requires `monthly-counts` to be absent.
  - The other two bases keep today's rules.
- **`submission.ts`:** run `monthsWithoutCounts` only when there are counts.
- **`+server.ts`:** `insertReport` writes NULLs.
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
  runs that path once.

## Verification

- **PR 1:** render a no-counts PDF from a test helper and read it, checking the executive
  summary, How to Read, both trend pages, and the absence of the diner chart. Open the workbook
  too.
- **PR 2:** before dispatching, confirm the deployed worker's manifest parse accepts
  `counts: null`: the system test covers this.
- **PR 3:** with `/run`, upload with "No counts" at phone and desktop widths, toggle between bases,
  and check that typed counts come back. Then let the report finish and open its PDF.
- **Gates:** `just lint && just check && just test` and `just test-lab` for Python, and
  `pnpm lint && pnpm check && pnpm test` for TypeScript.
