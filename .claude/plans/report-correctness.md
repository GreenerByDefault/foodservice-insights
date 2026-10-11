# Report correctness

## Context

The product's report is `analyze()` → `build_food_report` → `build_report_charts` →
`write_report_pdf` and `write_client_workbook` (`report/`); the lab's `run_food_report` wraps
the same core. An audit in September 2026 ran that path with `analyze()`'s arguments on inputs
`apps/web` accepts and read every PDF page and workbook sheet; every fact below was reproduced
again on 27 September against `main`, through `analyze()` with `KeywordLlmClient` on inline
frames. The deliverable carries wrong numbers and hides its own failures. `tests/test_analysis.py::test_analyze_golden_deliverables` pins today's
output: most PRs here regenerate it with `UPDATE_GOLDEN=1`, and the fixture diff is the review.
The remaining PRs were re-checked against `main` on 11 October, after the week's moves to the
lab; every fact below still reproduces unless it says otherwise.

**Wrong numbers.**

- A category whose every line weighs 0 gets a `NaN` driver share (`_safe_percentage`,
  `report/aggregation.py`), so its driver panel prints "nan%", the whole drivers section is
  stamped "[DATA WARNING]", and the customer's quality page lists `plot_input_missing_values`.

**Silent failures.**

- A plant/animal split or plant-protein share failure is logged and the page and narrative
  sentence are dropped; a chart failure prints the Python exception on a placeholder page and
  files a `warning` (`_safe_plot`, `report/plots/report.py`). Neither can fail a run.

## Decisions

- **Behavioural changes to ported code are each their own PR**, so a fixture diff reviews one
  thing. Each PR below says why it is worth landing on its own.
- **No data-driven check may abort a product run.** An `error` finding is for our bugs (a
  missing column, row drift, a stage raising), which correctly land as `unknown` with a
  traceback, since `raise_on_error_findings` raises `QualityCheckError`, a bare `ValueError`.
  Every `error` a diagnostic can file is unreachable from customer data on the product path:
  `check_diner_meal_reasonableness`, the last that was reachable, files a `warning` however many
  months fall outside 0.5× to 2× the median, in the lab too. *Rejected: a product-only
  threshold profile* — two vocabularies for one check. *Rejected: mapping the `ValueError` to
  `UnusableDataError`* — unusual headcounts are not unusable data, and "contact GBD" would be
  the wrong advice.
- **Identical lines are data, and nothing checks for them.** The exact-duplicate-rows check is
  gone, not demoted. It was written for the lab, where several client exports are stitched
  together and can overlap; the lab's `detect_component_duplicate_risk` checks that where the
  files are combined. A product report holds one file of `product, date, weight`, so two cases
  of one item on one day are identical lines, and a warning at 0.5% would have told nearly every
  customer their correct totals might be overstated. *Rejected: a warning at the upload form* —
  the form has no warning state, and the user cannot tell us which of their repeats are real.
- **A zero-weight line is data; a file that weighs nothing is not.** A single 0 is ordinary
  (short-shipped or not-yet-weighed lines) and gets a `per_product_weight_bounds` warning. A file
  whose every weight is 0 is refused at upload (`normalize.ts`, `all-weights-zero`), and
  `build_food_report` raises `UnusableDataError` when every row it receives is 0, which also
  catches an upload whose only weight was on uncategorized products. That is the one data-driven
  abort, and it is an `UnusableDataError`, not an `error` finding: there is no report to write.
- **`info` never changes a report's status or wording, and the customer PDF lists warnings and
  errors only.** `quality_status_from_findings` ignores `info`, and with
  `show_quality_successes` off (`analyze()`) the quality page neither lists nor counts notes, so
  demoting a finding to `info` is how a later PR takes it off the customer's page. `info`
  findings stay for the lab's QA workbook and its PDF, which shows everything. *Rejected: deleting `info`
  findings* — the lab reads them. **Open:** which warnings a customer should see at all (month
  volatility, partial first or last month, outlier line items) is GBD's call; this
  plan only stops `info` leaking.
- **Every category in `GBD_categories.yaml` has a factor in every region**, pinned by
  `test_emissions.py::test_every_category_has_an_emission_factor`, and the product path assigns
  only GBD categories: the cache admits nothing else (#455, #475), and the model's answers are
  snapped to one or to "No Matches Found" (#469), which `merge_categorizations` drops.
  `Unspecified non dairy milk` carries the mean of the four named plant milks, the method GBD
  used from its first commit until the November 2025 move to per-region factors dropped it to
  `null`. A row without a factor can therefore only mean our bug or a typo in a lab's
  hand-edited categorized CSV, and `calculate_emissions` raises `ValueError` naming every such
  category, so `build_food_report` never sees a `NaN` emission. *Rejected: an `error` finding*
  — a finding exists to be listed in a report, and this one could only abort. *Rejected: deleting the
  category* — it removes something GBD built on purpose, where restoring the factor undoes an
  accidental regression and needs no one's sign-off. *Rejected: excluding factorless categories
  from the model's list* — a second notion of "valid category". The match prompt's rule sending
  unnamed non-dairy milk to Oat Milk has contradicted the category since April 2025, and no
  cache row uses it; which one GBD wants is their call, and either way the number is sane.
- **Drivers stay ranked by kilos; the prose says so.** The Decision KPIs page is where carbon
  ranking lives. **Open:** GBD may want procurement drivers ranked by CO2e instead. Also for
  GBD: the Animal Emissions Intensity table lists animal categories with poultry and fish at the
  bottom by CO2e per kg, which reads as the beef-to-chicken nudge REQUIREMENTS.md § Processing
  forbids.
- **A split, share or chart failure fails the run, with its own traceback,** as a stage failure
  in `build_food_report` already does: a stage that raises surfaces its own exception, and
  `raise_on_error_findings` follows each stage's drift and missingness checks, so no later stage
  runs on a broken frame. `_safe_plot` goes, placeholder page and input checks alike, and
  `ReportCharts` then carries no findings.
- **Fixed page sizes.** Every page is US Letter: `LETTER_PORTRAIT` for text and
  `LETTER_LANDSCAPE` for charts and tables (the Category Template needs the width), both in
  `plotting_utils.py`, and `test_analysis.py` reads every page's size out of an `analyze()` PDF
  with a 200-character product name, so a new page in another size fails there. Labels never grow
  the page: `wrap_labels` ends in an ellipsis past three lines, since the workbook keeps every
  full product name. `create_horizontal_percentage_barplot` keys its bars on the full label and
  shortens only the tick text, because seaborn averages rows that share a label into one bar;
  any new drivers drawer must keep that. A two-panel trend page stacks its panels, which share
  the month axis, rather than setting them side by side as tall, narrow charts that steepen every
  swing. The Category Template already fits by measurement: `create_table_page` sizes each column to its widest
  rendered text and splits months across pages ("Category Template (1 of 2)") against
  `_table_width_in(fig_size)`, which derives the table's width from the page size and the
  `figure.subplot` rcParams. A change to the page size carries through; a change to where table
  axes sit on the page must go through `_table_width_in` too, or the template clips again.
- **Every category keeps its drivers, four to a page.** `plot_category_drivers_pages`
  (`report/plots/figures.py`) lays `draw_category_drivers` panels (`report/plots/panels.py`) in
  a 2 × 2 grid on a landscape page, alphabetically, so 26 categories take 7 pages, not 26.
  *Rejected: only the top categories* — a customer looking for one category's drivers would
  find nothing. **Open:** ordering the panels by emissions, highest first, to match the emissions
  page. Alphabetical is easier to look a category up in, and nothing yet says a reader wants the
  other; if we do, it is its own PR, and a serving report, which has no emissions, needs an
  order of its own.

## PR 1 — a zero-weight category's driver share is 0%, not NaN

- `_safe_percentage` (`report/aggregation.py`) returns 0.0 for a zero denominator, as
  `identify_overall_drivers` already does for the whole file. A category bought only at weight
  0 keeps its driver panel, with every bar at 0%.
- Tests: `build_food_report` with a category whose lines all weigh 0 gives that category's
  drivers a `percentage` of 0.0, and `build_report_charts` files no finding.
- Worth it: found 11 October; a zero-weight line is ordinary data (see Decisions), and today
  this stamps a "[DATA WARNING]" on every driver page. Lands before PR 2, which deletes the
  input check that is today the only sign of it.

## PR 2 — a chart or split failure fails the run

- `_safe_plot`, `_placeholder_figure`, the input checks and the category-driver `try` in
  `report/plots/report.py` go, and so do the split and share `try` blocks in
  `build_food_report`. `generate_all_report_plots` loses `quality_findings`, `ReportCharts`
  loses `findings`, and `write_report_pdf` and the lab's `run_food_report` stop merging chart
  findings. `FoodReport.findings` is then the whole list.
- This adds aborts. Probed 11 October on one row, one month, plant milks only, a gap
  month, a 200-character product and every category over twelve months: no chart fell back
  except PR 1's case. The split and share return `None` for every no-data case, so they raise
  only on our bug.
- Tests: the `_safe_plot` and placeholder tests in `plots/test_report.py` go; a chart
  monkeypatched to raise surfaces from `build_report_charts`. The lab's failure manifest
  records no findings for a crash, as today; its log keeps the traceback.
- Worth it: today a chart crash ships the customer a page of Python.

Testing, generally: new tests use the product arguments and assert what `build_pdf_report` is
handed and what the sheets contain, not that files exist.

## Verification

- Every PR: `just lint && just check && just test`; `just test-lab`, since all change what the
  lab's QA workbook and manifest say; `pnpm test:system` for any PR that changes what
  `analyze()` writes.

## Risks

- The golden test pins numbers, so most PRs here regenerate it; review the fixture diff rather
  than accept it.
- Threshold, status and `info` changes alter the lab's QA output; tell the data scientists.
- PR 2 turns any chart bug the probe missed into a failed run. That is the intent, but watch
  `unknown` failures after it deploys.
- No PR here waits on GBD.
