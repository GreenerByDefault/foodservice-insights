# Procurement-only report

## Context

The product makes one kind of report: procurement data in kilos, with emissions. `analyze()`
calls `build_food_report(mode="procurement", region="us")` and nothing else in the product can
reach another mode. The report core still carries the notebooks' second mode, `serving` —
servings per entree, no emissions — and it threads through every layer:

- `report/schema.py`: `ReportMode`, `VALID_REPORT_MODES`.
- `report/metric.py`: a frozen `Metric(column, label, unit_singular, unit_plural, per_head_stem,
  line_noun)` with `per_head(diner_or_meal)`, the two instances `KILOS` and `SERVINGS`, and
  `METRIC_BY_MODE`.
- `report/food_report.py`: `FoodReport.mode`, the `metric` property (`METRIC_BY_MODE[mode]`),
  two `if mode == "procurement"` blocks, a `serving=(mode == "serving")` flag, and
  `summary_stats` — a `dict[str, str]` of display strings whose "Data type" is the mode.
  `validate_rows(rows, metric)` is public.
- `report/aggregation.py`: `run_aggregation_pipeline(mode=...)`, and `Aggregation.procurement`,
  `None` exactly when the report is a serving report.
- `report/checks.py`: `run_all_diagnostics(df, diner_meal_mapping, diner_or_meal, metric)` picks
  the bounds YAML group with `metric == SERVINGS` and passes `low` and `high` to
  `check_per_product_weight_bounds`.
- `report/plots/report.py`: `serving` flag, `emissions_summary: DataFrame | None`, a check for the
  emissions column.
- `report/pdf.py`: the title page's subtitle is `report.mode.title()`, `create_key_value_summary_page`
  (serving's substitute for the narrative), `_executive_narrative` returning `None`, and
  `if procurement is not None` around three table pages.
- `report/excel.py`: `procurement_sheets(None)`, an optional "Emissions Summary" sheet.
- `data_files/diagnostic_thresholds.yaml`: `per_product_serving_bounds`.
- `FoodReport.emissions_summary: DataFrame | None` and the optional fields above make every
  procurement reader check for a `None` that the product never produces.

Only the lab exercises it: `gbd_foodservice_insights_lab.food_report.pipeline.run_food_report`,
from `runscripts/2. Produce Food Report.py --procurement-serving serving`, whose workbooks feed
`3. Compare baseline procurement vs serving.py` and the pilot analysis. `caches-to-supabase.md`
keeps the lab's entree classification (serving data's step 1) alive, so serving reports are a
live lab workflow and cannot simply be deleted.

Facts that shape the design:

- **The product's serving branch is half-maintained.** A serving PDF's "How to Read This Report"
  and "About This Report" pages talk about carbon footprint and procurement data, because those
  pages are written once for procurement. The data scientists' report has been getting
  procurement prose on serving data; owning the serving report would let them fix that.
- **Every leaf function already takes a metric**, so the `mode` branches and optional fields
  live only in the orchestration layer. The leaves that print a label or unit take a `Metric`:
  `detect_unusual_sales`, `detect_month_over_month_total_volatility`,
  `check_per_product_weight_bounds`, `generate_all_report_plots` and every figure and panel that
  titles an axis. The leaves that only read the column take `metric.column`: `aggregate_data`,
  `create_template_data`, `identify_overall_drivers`, `identify_category_drivers`, the two plant
  shares, `check_diner_meal_reasonableness`, and the lab's QA diagnostics.
- **`summary_stats` has two readers**: the key-value page (serving only) and the lab's manifest,
  metadata and run result. `_executive_narrative` reads its `"Date range"` entry back out.
- **The narrative never has to fall back.** No category in `GBD_categories.yaml` has a zero
  emission factor, and `build_food_report` rejects rows whose weights are all zero, so a
  procurement report's total CO₂e is always positive.
- **The lab's QA workbook, manifest and metadata already take frames and dicts**, not a
  `FoodReport` (`build_qa_excel_report`, `write_run_manifest`, `build_run_result`), so a lab
  serving report with the same attribute names slots in behind them.
- **The plant shares are typed.** `aggregation.PlantAnimalSplit` (never `None`) and
  `PlantProteinShare | None` are what the lab's serving report carries too.
- 36 product lines and about 50 product-test lines mention serving or the mode.

## Decisions

- **The product's report core is procurement-only.** `build_food_report`, `Aggregation`,
  `generate_all_report_plots`, `write_report_pdf` and `write_client_workbook` know one metric and
  always compute emissions. `FoodReport.emissions_summary` and the three procurement tables stop
  being optional (`ProcurementAggregation` folds into `Aggregation`), `ExecutiveNarrative` is
  always written and `co2e_kg_per_diner_or_meal` is a `float`, and `create_key_value_summary_page`
  leaves with serving. *Rejected: keeping `mode`.* The leaves' metric parameter is cheap; the
  orchestration branches and the `| None` fields they force on every reader are the cost.
- **A `Metric` value carries the labels, not the column's name.** Display text comes from
  `.label`, `.unit_singular`, `.unit_plural`, `.line_noun` and `.per_head(...)`, never from
  parsing `kilos_total` or stripping an "s". The product's one instance is `KILOS`.
  *Rejected: hard-coding `kilos_total` in the leaves.* The lab would then fork aggregation,
  checks and charts — about 1,500 lines — to keep its serving report. A column name and four
  labels is the whole difference between the two reports, and one small value carries it.
- **The lab owns the serving report**, in `food_report/serving.py`, composed from the product's
  leaves with its own `SERVINGS` (the one `report/metric.py` holds until PR 2 deletes it)
  and the bounds `(1.0, 1000.0)` that `per_product_serving_bounds` holds today. Its PDF does not
  reuse the product's two prose pages, which are written about procurement; what a serving
  report should say about itself is the data scientists' call, and until they write it the
  serving PDF has no prose pages. `run_food_report` dispatches on mode to the product's
  procurement trio or the lab's serving trio; everything after (QA workbook, metadata, manifest)
  reads frames and findings both report types expose under the same names.
- **`summary_stats` leaves `FoodReport`.** The lab computes its own, from the typed fields it
  already has, in `food_report/summary.py`. The narrative takes its period from a public
  `date_range_label(rows)` in `food_report.py`, the one line of `_summary_stats` the product reads.
- **The title page names only the report type.** `create_title_page(pdf, client, subtitle)`
  takes the subtitle as display text, so the product passes "Procurement" and the lab's serving
  PDF passes "Serving". GBD's pilot-program phase (`baseline`/`pilot`) is not on any cover: it
  was noise to a web-app customer, and the lab still records it in `client_metadata.json` and
  the run manifest. Nothing in the remaining PRs changes customer-visible output.
- **`check_per_product_weight_bounds` takes `low` and `high`** rather than choosing a YAML group
  from the metric. It is the one check with a serving-specific threshold, so once
  `run_all_diagnostics` reads only `per_product_weight_bounds`, the lab's bounds live in the lab.

## PR 1 — The lab's serving report

After this PR nothing in the lab calls `build_food_report(mode="serving")`, so PR 2 can delete it.

- `gbd_foodservice_insights_lab/food_report/serving.py`: `SERVINGS`, `SERVING_LINE_BOUNDS`, a
  frozen `ServingReport` (rows, metric, diner_or_meal, diner_meal_mapping, diner_meals_in_data,
  monthly_product, monthly_category, template, overall_drivers, category_drivers,
  plant_animal_split, plant_protein_share, findings, summary_stats), and:
  - `build_serving_report(rows, *, diner_meal_mapping, diner_or_meal, top_n_drivers)` —
    `validate_rows(rows, SERVINGS)`, the month column and positive-count check as
    `build_food_report` does them, `aggregate_data`/`create_template_data`/`identify_*` and the
    two plant shares with `SERVINGS.column`, and the six checks called directly — each with
    `SERVINGS` or `SERVINGS.column` as its signature takes, and the bounds check with the serving
    bounds (not `run_all_diagnostics`, which still reads the product YAML until PR 2).
  - `serving_charts(report)` — a context manager over `plot_diner_meal_numbers`,
    `plot_food_and_drink_comparison_page`, `plot_category_totals`,
    `plot_plant_breakdown_overview`, `plot_overall_drivers` and `plot_category_drivers_pages`,
    closed on exit like `build_report_charts`.
  - `write_serving_pdf(report, figures, path, *, client_name, show_quality_successes)`
    — `create_title_page` with `"Serving"`, the key-value summary page (moved
    here from `pdf.py`, with its test), the charts, `create_category_template_pages`, and the
    quality page through a public `quality_lines` (today's `_quality_to_lines`).
  - `write_serving_workbook(report, path)` — `write_excel_workbook` with the four sheets a serving
    workbook has today.
- `food_report/pipeline.py`: `run_food_report` builds one or the other by mode; `_normalize_report_mode`
  returns the lab's own `Literal["procurement", "serving"]`.
- Tests: `tests/food_report/test_serving_report.py`, carrying over what the product's serving
  tests pin — "servings per meal" columns, no emissions anywhere, the four workbook tabs, the
  key-value page in place of the narrative, bounds and volatility messages in servings. The
  existing serving cases in `tests/food_report/test_outputs.py` and `test_quality_contract.py`
  keep passing through `run_food_report`.

## PR 2 — Serving leaves the product

- `schema.py`: delete `ReportMode`, `VALID_REPORT_MODES`. `metric.py`: delete `SERVINGS` and
  `METRIC_BY_MODE`.
- `food_report.py`: `build_food_report(rows, *, diner_meal_mapping, region, diner_or_meal,
  top_n_drivers, report_progress)`; `FoodReport` loses `mode`, `metric` and `summary_stats`;
  `emissions_summary: pd.DataFrame`; `_summary_stats` goes and `date_range_label(rows)` stays
  public; `validate_rows(rows, metric)` keeps its metric, since the lab's serving report calls it
  with `SERVINGS`.
- `aggregation.py`: `run_aggregation_pipeline(df, mapping, top_n, *, region, diner_or_meal)`;
  `Aggregation` gains `animal_emissions_intensity`, `animal_emissions_concentration` and
  `substitution_scenarios` directly; `ProcurementAggregation` goes.
- `checks.py`: `run_all_diagnostics(df, diner_meal_mapping, diner_or_meal)` passes `KILOS` and
  the `per_product_weight_bounds` thresholds; the `SERVINGS` comparison goes. `diagnostic_thresholds.yaml` loses
  `per_product_serving_bounds`.
- `plots/report.py`: `generate_all_report_plots(aggregation, diner_meal_mapping, emissions_summary,
  plant_animal_split, plant_protein_share, diner_or_meal)` loses `metric` and `serving` and always
  draws the two emissions pages.
- `pdf.py`: `write_report_pdf` passes `"Procurement"` to `create_title_page`, and always
  writes the narrative and the three table pages their data supports; `_executive_narrative` returns
  `ExecutiveNarrative`, whose period is `date_range_label(report.rows)` and whose
  `co2e_kg_per_diner_or_meal` is a `float`.
- `excel.py`: `procurement_sheets(aggregation)`; the "Emissions Summary" sheet is always written.
- Lab: `food_report/pipeline.py` reads `report.metric` today; with `FoodReport.metric` gone it
  takes the metric from the mode (`KILOS` or the lab's `SERVINGS`). `food_report/summary.py` computes the summary stats `run_food_report` writes into the
  manifest, metadata and run result, from a `FoodReport` or a `ServingReport`.
- Tests: the serving cases in `test_food_report.py`, `test_outputs.py`, `test_pdf.py`,
  `test_checks.py`, `test_aggregation.py`, `test_report.py` and `test_panels.py` go;
  `test_procurement_report_holds_its_normalized_inputs_and_tables` pins the typed fields it
  pinned through `summary_stats`. The golden fixture loses its `summary_stats` entry and nothing
  else (`UPDATE_GOLDEN=1`, and the diff is the review).

## Verification

Each PR: `just lint && just check && just test && just test-lab`. For PR 2, render the golden
run's PDF (`analyze()` on `testing.sample_input_csv()` with `KeywordLlmClient`) before and after
on the same day with `SOURCE_DATE_EPOCH` fixed and compare the bytes; the title page's date is
the only thing that could differ, and it does not within a day. The workbook differs only in
openpyxl's creation time, so compare its unzipped sheets instead. After PR 2, `git grep -n 'serving\|ReportMode\|summary_stats' python/insights`
returns nothing, and the step-2 runscript still produces a serving bundle from
`python/lab/test_data/`.
