# Procurement-only report

## Context

The product makes one kind of report: procurement data in kilos, with emissions. `analyze()`
calls `build_food_report(mode="procurement", region="us")` and nothing else in the product can
reach another mode. The lab builds its serving reports itself, in
`gbd_foodservice_insights_lab/food_report/serving.py`, and `run_food_report` dispatches to it by
mode, so nothing calls `build_food_report(mode="serving")` any more. The report core still
carries that second mode — servings per entree, no emissions — through every layer:

- `report/schema.py`: `ReportMode`, `VALID_REPORT_MODES`.
- `report/metric.py`: the frozen `Metric` with its two instances `KILOS` and `SERVINGS`, and
  `METRIC_BY_MODE`.
- `report/food_report.py`: `FoodReport.mode`, the `metric` property (`METRIC_BY_MODE[mode]`),
  two `if mode == "procurement"` blocks, a `serving=(mode == "serving")` flag, and
  `summary_stats` — a `dict[str, str]` of display strings whose "Data type" is the mode.
- `report/aggregation.py`: `run_aggregation_pipeline(mode=...)`, and `Aggregation.procurement`,
  `None` exactly when the report is a serving report.
- `report/checks.py`: `run_all_diagnostics(df, diner_meal_mapping, diner_or_meal, metric)` picks
  the bounds YAML group with `metric == SERVINGS`.
- `report/plots/report.py`: `serving` flag, `emissions_summary: DataFrame | None`, a check for the
  emissions column.
- `report/pdf.py`: the title page's subtitle is `report.mode.title()`, `create_key_value_summary_page`
  (serving's substitute for the narrative, which the lab's serving PDF imports from here),
  `_executive_narrative` returning `None`, and `if procurement is not None` around three table
  pages.
- `report/excel.py`: `procurement_sheets(None)`, an optional "Emissions Summary" sheet.
- `data_files/diagnostic_thresholds.yaml`: `per_product_serving_bounds`.
- `FoodReport.emissions_summary: DataFrame | None` and the optional fields above make every
  procurement reader check for a `None` that the product never produces.

Facts that shape the design:

- **The lab's serving report is built from the product's leaves.** Every leaf that prints a
  label or unit takes a `Metric`; every leaf that only reads the column takes `metric.column`.
  `serving.py` passes its own `SERVINGS` and its own `SERVING_LINE_BOUNDS` to them, and calls
  `validate_rows`, `quality_lines`, `diner_meals_frame`, `create_title_page`,
  `create_category_template_pages`, `create_text_page` and `create_key_value_summary_page`
  from the product. Those stay public; the rest of the product can forget serving.
- **`summary_stats` has three readers**: the key-value page (serving only), `_executive_narrative`,
  which reads its `"Date range"` back out, and the lab's run result. A `ServingReport` already
  computes its own.
- **The narrative never has to fall back.** No category in `GBD_categories.yaml` has a zero
  emission factor, and `build_food_report` rejects rows whose weights are all zero, so a
  procurement report's total CO₂e is always positive.
- **The lab's pipeline reads both report types through the same names** — `rows`, `metric`,
  `diner_meal_mapping`, `diner_or_meal`, `findings`, `summary_stats` — and branches on
  `isinstance(report, ServingReport)` only to pick the charts, PDF and workbook writers and the
  QA workbook's tables. Its QA workbook (`build_qa_excel_report`) takes frames and a
  `ProcurementAggregation | None`, not a report.

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
- **The lab owns the serving report**, with its own `SERVINGS` and serving bounds. Serving
  reports are a live lab workflow — `caches-to-supabase.md` keeps the entree classification
  that feeds them — so they move rather than go. Its PDF does
  not reuse the product's two prose pages, which are written about procurement; what a serving
  report should say about itself is the data scientists' call, and until they write it the
  serving PDF has no prose pages. Its summary has no emissions-factor region.
- **`summary_stats` leaves `FoodReport`.** The lab computes the procurement summary itself, from
  the typed fields, in `food_report/summary.py`. The narrative takes its period from a public
  `date_range_label(rows)` in `food_report.py`, the one line of `_summary_stats` the product reads.
- **The title page names only the report type.** `create_title_page(pdf, client, subtitle)`
  takes the subtitle as display text, so the product passes "Procurement" and the lab's serving
  PDF passes "Serving". GBD's pilot-program phase (`baseline`/`pilot`) is not on any cover: it
  was noise to a web-app customer, and the lab still records it in `client_metadata.json` and
  the run manifest. Nothing in the remaining PR changes customer-visible output.
- **`check_per_product_weight_bounds` takes `low` and `high`** rather than choosing a YAML group
  from the metric. It is the one check with a serving-specific threshold, so once
  `run_all_diagnostics` reads only `per_product_weight_bounds`, the lab's bounds live in the lab.

## PR 1 — Serving leaves the product

- `schema.py`: delete `ReportMode`, `VALID_REPORT_MODES`. `metric.py`: delete `SERVINGS` and
  `METRIC_BY_MODE`.
- `food_report.py`: `build_food_report(rows, *, diner_meal_mapping, region, diner_or_meal,
  top_n_drivers, report_progress)`; `FoodReport` loses `mode`, `metric` and `summary_stats`;
  `emissions_summary: pd.DataFrame`; `_summary_stats` goes and `date_range_label(rows)` is
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
  `co2e_kg_per_diner_or_meal` is a `float`. `create_key_value_summary_page` moves to the lab's
  `serving.py`, with its test; it shares the "Executive Summary" header with the narrative page
  through `_new_summary_figure`, which the lab copies or the product makes public.
- `excel.py`: `procurement_sheets(aggregation)`; the "Emissions Summary" sheet is always written.
- Lab: `food_report/pipeline.py` reads `report.metric` for its own checks and the QA workbook;
  with `FoodReport.metric` gone it reads `_METRIC_BY_MODE[mode]`, and `_build_report` stops
  passing `mode="procurement"`. `food_report/summary.py` computes the procurement summary stats
  `run_food_report` writes into the run result. `build_qa_excel_report` takes the `Aggregation`
  (or `None` for a serving report) where it took a `ProcurementAggregation`.
- Tests: the serving cases in `test_food_report.py`, `test_outputs.py`, `test_pdf.py`,
  `test_checks.py`, `test_aggregation.py`, `test_report.py` and `test_panels.py` go;
  `test_procurement_report_holds_its_normalized_inputs_and_tables` pins the typed fields it
  pinned through `summary_stats`. The lab's `_ExcelPayload` in `tests/food_report/test_outputs.py`
  builds an `Aggregation`. The golden fixture loses its `summary_stats` entry and nothing else
  (`UPDATE_GOLDEN=1`, and the diff is the review).

## Verification

`just lint && just check && just test && just test-lab`. Render the golden run's PDF
(`analyze()` on `testing.sample_input_csv()` with `KeywordLlmClient`) before and after on the
same day with `SOURCE_DATE_EPOCH` fixed and compare the bytes; the title page's date is the only
thing that could differ, and it does not within a day. The workbook differs only in openpyxl's
creation time, so compare its unzipped sheets instead. Afterwards,
`git grep -n 'serving\|ReportMode\|summary_stats' python/insights` returns nothing, and the lab's
`test_serving_report.py` and `test_run_food_report_writes_a_serving_bundle_without_emissions`
still pass unchanged.
