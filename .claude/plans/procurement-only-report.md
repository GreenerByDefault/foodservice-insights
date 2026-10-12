# Procurement-only report

## Context

The product makes one kind of report: procurement data in kilos, with emissions. `analyze()`
calls `build_food_report(mode="procurement", region="us")` and nothing else in the product can
reach another mode. The report core still carries the notebooks' second mode, `serving` —
servings per entree, no emissions — and it threads through every layer:

- `report/schema.py`: `ReportMode`, `VALID_REPORT_MODES`, `REQUIRED_COLUMNS_BY_MODE`,
  `metric_for_mode`, `required_columns_for_mode`, and two helpers that derive display text from
  the metric column's *name* — `metric_display_label` strips `_total`/` total` suffixes and
  `per_diner_metric_name` parses them back apart.
- `report/food_report.py`: `FoodReport.mode`, the `metric_total` property, `_validate_rows(mode)`,
  two `if mode == "procurement"` blocks, two `serving=(mode == "serving")` flags, and
  `summary_stats` — a `dict[str, str]` of display strings whose "Data type" is the mode.
- `report/aggregation.py`: `run_aggregation_pipeline(mode=...)`, and `Aggregation.procurement`,
  `None` exactly when the report is a serving report.
- `report/checks.py`: `_unit_label` compares the column name against `"servings total"`;
  `check_per_product_weight_bounds` picks its YAML group and its nouns the same way;
  `run_all_diagnostics(serving=...)` has a fallback that swaps the metric column.
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
- **Every leaf function already takes a metric.** `aggregate_data`, the drivers, the plant
  shares, every check, every panel and figure take a column name. What is procurement-specific
  is derived from that name by the three string helpers above; the orchestration layer is where
  the `mode` branches and optional fields live.
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
- **A `Metric` value replaces the string-derived labels.** `report/metric.py` defines a frozen
  `Metric(column, label, unit, per_head_stem, line_noun)` with `per_head(diner_or_meal)`, and the
  product's one instance, `KILOS = Metric("kilos_total", "Kilos", "kg", "kilos", "weight")`.
  Leaf functions take a `Metric` where they took a column name, and read `.label`, `.unit` and
  `.per_head(...)` where they called `metric_display_label`, `_unit_label` and
  `per_diner_metric_name`. Every string those helpers produce today comes out identical, so the
  PDF, workbook and golden fixture do not change. *Rejected: hard-coding `kilos_total` in the
  leaves.* The lab would then fork aggregation, checks and charts — about 1,500 lines — to keep
  its serving report. A column name and four labels is the whole difference between the two
  reports, and one small value carries it.
- **The lab owns the serving report**, in `food_report/serving.py`, composed from the product's
  leaves with `SERVINGS = Metric("servings total", "Servings", "servings", "servings", "serving count")`
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
  from the metric; `run_all_diagnostics` reads `per_product_weight_bounds` and passes them. It is
  the one check with a serving-specific threshold, and this keeps the lab's bounds in the lab.

## PR 1 — `Metric` replaces the string-derived labels

A prefactor with no behavior change; serving still exists, as `SERVINGS` in `metric.py`, so the
serving tests keep passing and prove the labels come out the same. (The PR after this one is
the lab's serving report, so the one branch `run_all_diagnostics` keeps here is short-lived.)

- `report/metric.py`: `Metric`, `KILOS`, `SERVINGS`.
- `schema.py`: delete `metric_display_label`, `per_diner_metric_name`, `metric_for_mode`,
  `required_columns_for_mode`, `REQUIRED_COLUMNS_BY_MODE`. `build_food_report` maps the mode to a
  `Metric`; `FoodReport.metric: Metric` replaces the `metric_total` property; `_validate_rows`
  becomes public `validate_rows(rows, metric)` with required columns
  `("date", "product", "category", metric.column)`, since PR 2's lab report validates the same way.
- `aggregation.py`, `checks.py` (`_unit_label` goes; `_format_quantity` takes `metric.unit`; the
  bounds check takes `metric`, `low`, `high`; `run_all_diagnostics` reads the YAML group for the
  mode — the one branch PR 3 deletes), `plots/report.py`, `plots/figures.py`, `plots/panels.py`
  (`metric_label: str` parameters become `metric: Metric`), `food_report.py`
  (`metric_value_unit` is `metric.unit`).
- Lab: `food_report/pipeline.py` reads `report.metric.column` and `report.metric.per_head(...)`;
  `pilot/plots.py` takes a `Metric` where it took a column name and called
  `metric_display_label`.
- Tests: the helpers' tests become `Metric` tests; everything else re-points. The golden fixture
  does not change.

## PR 2 — The lab's serving report

After this PR nothing in the lab calls `build_food_report(mode="serving")`, so PR 3 can delete it.

- `gbd_foodservice_insights_lab/food_report/serving.py`: `SERVINGS`, `SERVING_LINE_BOUNDS`, a
  frozen `ServingReport` (rows, diner_or_meal, diner_meal_mapping, diner_meals_in_data,
  monthly_product, monthly_category, template, overall_drivers, category_drivers,
  plant_animal_split, plant_protein_share, findings, summary_stats), and:
  - `build_serving_report(rows, *, diner_meal_mapping, diner_or_meal, top_n_drivers)` —
    `validate_rows(rows, SERVINGS)`, the month column and positive-count check as
    `build_food_report` does them, `aggregate_data`/`create_template_data`/`identify_*` with
    `SERVINGS`, the two plant shares, and the six checks called directly with `SERVINGS` and the
    serving bounds (not `run_all_diagnostics`, which still reads the product YAML until PR 3).
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

## PR 3 — Serving leaves the product

- `schema.py`: delete `ReportMode`, `VALID_REPORT_MODES`. `metric.py`: delete `SERVINGS`.
- `food_report.py`: `build_food_report(rows, *, diner_meal_mapping, region, diner_or_meal,
  top_n_drivers, report_progress)`; `FoodReport` loses `mode`, `metric` and `summary_stats`;
  `emissions_summary: pd.DataFrame`; `_summary_stats` goes and `date_range_label(rows)` stays
  public; `validate_rows(rows)` validates for `KILOS`.
- `aggregation.py`: `run_aggregation_pipeline(df, mapping, top_n, *, region, diner_or_meal)`;
  `Aggregation` gains `animal_emissions_intensity`, `animal_emissions_concentration` and
  `substitution_scenarios` directly; `ProcurementAggregation` goes.
- `checks.py`: `run_all_diagnostics(df, diner_meal_mapping, diner_or_meal)` passes `KILOS` and
  the `per_product_weight_bounds` thresholds. `diagnostic_thresholds.yaml` loses
  `per_product_serving_bounds`.
- `plots/report.py`: `generate_all_report_plots(aggregation, diner_meal_mapping, emissions_summary,
  plant_animal_split, plant_protein_share, diner_or_meal)` always draws the two emissions pages.
- `pdf.py`: `write_report_pdf` passes `"Procurement"` to `create_title_page`, and always
  writes the narrative and the three table pages their data supports; `_executive_narrative` returns
  `ExecutiveNarrative`, whose period is `date_range_label(report.rows)` and whose
  `co2e_kg_per_diner_or_meal` is a `float`.
- `excel.py`: `procurement_sheets(aggregation)`; the "Emissions Summary" sheet is always written.
- Lab: `food_report/summary.py` computes the summary stats `run_food_report` writes into the
  manifest, metadata and run result, from a `FoodReport` or a `ServingReport`.
- Tests: the serving cases in `test_food_report.py`, `test_outputs.py`, `test_pdf.py`,
  `test_checks.py`, `test_aggregation.py`, `test_report.py` and `test_panels.py` go;
  `test_procurement_report_holds_its_normalized_inputs_and_tables` pins the typed fields it
  pinned through `summary_stats`. The golden fixture loses its `summary_stats` entry and nothing
  else (`UPDATE_GOLDEN=1`, and the diff is the review).

## Verification

Each PR: `just lint && just check && just test && just test-lab`. For PRs 1 and 3,
render the golden run's PDF before and after on the same day with `SOURCE_DATE_EPOCH` fixed and
compare the bytes; the title page's date is the only thing that could differ, and it does not
within a day. After PR 3, `git grep -n 'serving\|ReportMode\|metric_total\|summary_stats' python/insights`
returns nothing, and the step-2 runscript still produces a serving bundle from
`python/lab/test_data/`.
