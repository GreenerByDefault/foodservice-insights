# Report diagnostics

## Context

The product runs one report shape: `analyze()` calls `build_food_report(mode="procurement",
region="us")` on rows `read_input_csv` has already checked against the web app's promises
(`contract/contract.json` § inputCsv: trimmed non-empty products, ISO dates, weights ≥ 0, and a
count ≥ 1 for exactly the file's months — `apps/web/src/lib/reports/csv/rules/`,
`monthly-coverage.ts`, `metadata.ts`). The PDF's "Data Completeness & Quality" page shows the
customer only `warning` and `error` findings (`show_quality_successes=False`, #392), and since
#494 no `error` is reachable from customer data.

Against that, `report/checks.py` (1,872 lines) and `build_food_report` still carry the notebook
era's checks. Of the 15 findings `run_all_diagnostics` files:

| Finding | Reaches a customer? | Why not |
| --- | --- | --- |
| `single_product_dominance`, `category_concentration`, `missing_weeks_within_month`, `missing_category_month_combos`, `gbd_categories_absent` | no | `info`/`success` only |
| `required_columns`, `negative_values`, `gbd_categories` | no | typed rows (#462), web + `read_input_csv` reject negatives, cache and LLM only yield GBD names (#469, #475) and `calculate_emissions` raises (#492) |
| `date_alignment` | no | "in data, not in counts" aborts earlier in `aggregate_data`; "in counts, not in data" is `info` and the web sends counts for exactly the file's months |
| `aggregation_reconciliation` | only on our own bug | a groupby summing to a different total than its input is a unit test, not a data diagnostic |
| `zero_category_month_combos` | yes, misleadingly | a zero-weight line is ordinary data (#397, #495); the message is jargon |
| `category_discontinuity` | yes, misleadingly | in one validated export a category absent for a month between two it was bought in is purchasing, not "a missing month of data"; `missing_internal_months` already covers a wholly missing month |
| `month_over_month_total_volatility`, `missing_internal_months`, `diner_meal_count_reasonableness`, `outlier_line_items`, `per_product_weight_bounds`, `date_distribution` | yes | keep |

`build_food_report` wraps `ensure_month_year_column` and `calculate_emissions` in required-column,
non-null, missingness-snapshot and row-count-drift findings that cannot fire on typed rows, and
three stages still catch `Exception` to file an `error` finding and raise a bare
`QualityCheckError` — the pattern #490 removed from the other three because it loses the cause.

Two of the surviving checks misfire, verified by running them: a 0 kg line trips
`per_product_weight_bounds` as "0.0000 kg, which is below the 0.001 kg lower bound", a unit-mistake
warning for data the report treats as ordinary; and `outlier_line_items` puts every flagged
product into one "Affected products: …" sample line, so at the upload cap (500k rows; 22,558
flagged in the synthetic profile) the customer PDF ran to 173 pages, about 150 of them that
list, and writing it took 15 s. The messages the customer does see read as internals: "the total
kilos total changed", "First month (2025-01) has 12 rows, only 30% of median (40)", "Found 1 rows
with per-product weights … at row 0" (a dataframe index that `analyze()` renumbers after dropping
uncategorized rows, so it maps to nothing in their file).

`report/thresholds.py` merges an override YAML over the packaged one, keyed on both files' mtimes
through an `lru_cache`; no caller sets `DIAGNOSTIC_THRESHOLDS_PATH` except one lab test, and the
per-call `override` parameters on every check are used only by tests.

## Decisions

- **Six checks stay in the product**: month-over-month volatility, missing internal months,
  headcount reasonableness, unusual line items, weight bounds, partial first/last month. Each can
  file a warning the customer can act on.
- **Four move to the lab** as real capability for its multi-file world: product dominance,
  category concentration, missing weeks within a month, category discontinuity (with its
  `Category_Discontinuity` QA sheet). Same shape as #452 and #484: the lab's `run_food_report`
  appends their findings after `build_food_report`. *Rejected: keeping category discontinuity as
  a customer warning* — the message tells the customer their data is probably missing, which in
  a single validated export is usually false and never actionable (#491's reasoning).
- **Six are deleted**, not moved: required columns, negative values, GBD categories (both),
  date alignment, aggregation reconciliation, zero category-month combos. Each is a one-liner
  over a guarantee `build_food_report` now enforces up front, for the lab too. The reconciliation
  becomes a unit test on `run_aggregation_pipeline`.
- **`build_food_report` validates its inputs once and raises `ValueError`** — required columns,
  no nulls, `date` is `datetime64`, the metric is numeric and non-negative, every `category` is a
  GBD name — instead of collecting error findings. The lab's `parsing.clean_weight_column` can
  still hand it a NaN; it now gets the column named in the exception rather than a
  `QualityCheckError` with the cause lost. With that, `QualityCheckError`,
  `raise_on_error_findings` and the `quality.py` check helpers go, and `FoodReport.diagnostics`
  and `.findings` collapse into one `findings` (they were equal once nothing else contributed).
- **A zero-weight line is in range.** The lower bound applies to positive weights only.
- **Samples are bounded.** The "Affected products" line goes; the `sample_limit` row samples
  that follow it are the examples.
- **Messages name the customer's things**: months as "Jan 2025", units as "kg" or "servings",
  "lines" not "rows", the product and value rather than a row index.
- **Thresholds stay in the packaged YAML** so the data scientists tune them in one place, loaded
  once with `functools.cache`. The override-file path and the per-call overrides go;
  `resolve_diagnostic_threshold` moves to the lab, its only remaining caller. *Rejected: constants
  in `checks.py`* — the YAML is the lab's knob, and the precedent since #484 is that lab-only
  thresholds (`near_duplicate_product_names`, `meat_quantity_reasonableness`) live there too.
- Serving mode and its thresholds (`per_product_serving_bounds`) are untouched.

## PR 1 — Bound and reword the surviving checks' findings

Customer-visible, and the one performance fix worth making. `report/checks.py` and
`tests/report/test_checks.py`; the golden fixture (`UPDATE_GOLDEN=1`) diff is the review.

- `check_per_product_weight_bounds`: flag `0 < value < low` and `value > high`; message and
  samples name the product, the value with its unit, and the bound — no `row N`.
- `detect_unusual_sales`: drop the "Affected products: …" entry from `sample_values`; keep the
  `sample_limit` row samples and add the unit to them and to the message.
- `detect_month_over_month_total_volatility`: "the total kilos changed" via
  `metric_display_label(metric_total).lower()`; samples carry the unit.
- `check_date_distribution`: "Jan 2025, the first month in the file, has 12 lines against about
  40 in a typical month, so it may be a partial month." via `_format_month_label`.
- Add `scripts/profile_report.py`: builds the synthetic cap-sized frame, runs
  `build_food_report` → charts → `write_report_pdf` → `write_client_workbook` under `cProfile`,
  prints stage timings and the PDF's page count. `just check` already typechecks `scripts/`.
  Record in the PR body the before/after at the cap (before: 173 pages, 14.7 s PDF write).
- Tests: a 0 kg line files `success`; a 0.0005 kg line files the warning; the outlier finding's
  `sample_values` has at most `sample_limit` entries; each reworded message.

## PR 2 — Delete the findings that cannot fire, and validate the rows up front

- `report/food_report.py`: `_validate_rows(rows, mode)` at the top of `build_food_report`, raising
  `ValueError` for a missing or null required column, a non-`datetime64` date, a non-numeric or
  negative metric, or a category outside `get_GBD_categories()`. Delete the ingestion and
  post-normalization finding blocks, the missingness/drift checks around emissions, and the three
  `except Exception` wrappers (month normalization, diner-meal mapping, aggregation): the stage's
  own exception propagates, as #490 did for the others. `FoodReport` keeps one `findings` tuple.
- `report/quality.py` loses `check_required_columns`, `check_required_non_null`,
  `missing_snapshot`, `compare_missing_snapshots`, `check_row_count_drift`, `QualityCheckError`,
  `raise_on_error_findings`. Keeps `Finding`, `make_finding`, `summarize_findings`,
  `findings_to_frame`, `missingness_summary_frame` (the last two for the lab).
- `report/checks.py`: delete `check_required_columns`, `ensure_date_alignment`,
  `check_negative_values`, `check_aggregation_reconciliation`, `check_zero_category_month_combos`,
  `_format_category_month_missing_sample`, and the required-columns, date-alignment and
  GBD-category blocks in `run_all_diagnostics`. Drop the `sample_rows` metadata from the
  remaining findings: only the lab's QA findings sheet showed it, as a stringified dict, and the
  lab's export sheets carry the same rows.
- `data_files/diagnostic_thresholds.yaml`: drop `aggregation_reconciliation`.
- `tests/report/test_aggregation.py`: `run_aggregation_pipeline`'s monthly tables each sum to
  the input total (the reconciliation finding as a test).
- Tests to rewrite as `pytest.raises(ValueError)`: `test_an_error_finding_raises_with_every_finding_so_far`,
  `test_missing_date_column_aborts_at_ingestion`, `test_unusable_diner_meal_mapping_aborts_immediately`,
  `test_emissions_that_drop_a_row_abort_before_any_later_stage_runs`,
  `test_aggregation_failure_raises_from_the_original_exception`; delete
  `test_a_mapping_month_absent_from_the_data_is_one_info_finding`,
  `test_run_all_diagnostics_excludes_no_matches_from_missing_categories`, the quality-helper tests
  in `test_quality_contract.py`, and the reconciliation and zero-combo tests in `test_checks.py`.
  Add: a category outside the GBD list, a negative metric and a null product each raise naming
  the problem.
- Lab: `food_report/pipeline.py` drops the `QualityCheckError` branch and the `diagnostics=`
  half of its `dataclasses.replace`; `_collect_diagnostic_export_sheets` drops
  `Aggregation_Reconciliation`; `lab/tests/food_report/test_quality_contract.py` and
  `test_outputs.py` follow. `python/insights/README.md`'s table row for checks is still right.

## PR 3 — Move the lab-only checks to the lab

- `check_single_product_dominance`, `check_category_concentration`
  (`_check_top_share_concentration`), `check_missing_weeks_within_month`
  (`_dates_appear_month_bucketed`, `_dates_support_within_month_gap_detection`) and
  `detect_category_discontinuity` move from `report/checks.py` to
  `gbd_foodservice_insights_lab/food_report/diagnostics.py`, with their `test_checks.py` tests
  to `lab/tests/food_report/test_diagnostics.py`. The lab reimplements `_format_month_label`
  (one line) rather than importing a private name.
- `run_all_diagnostics` loses the four calls; `run_food_report` appends their findings beside
  the near-duplicate and meat checks (#484's pattern) and keeps the `Category_Discontinuity` QA
  sheet from the lab copy.
- Thresholds stay where they are in the YAML (lab-only thresholds already live there).
- Golden fixture diff: four findings disappear.

## PR 4 — Load thresholds once

- `report/thresholds.py` becomes a `functools.cache`d read of the packaged YAML and
  `get_diagnostic_threshold(diagnostic, name) -> float`; `DIAGNOSTIC_THRESHOLDS_PATH`,
  `_threshold_cache_key`, `_merge_threshold_mappings` and the mtime-keyed `lru_cache` go.
- The six product checks drop their `override` parameters and call `get_diagnostic_threshold`
  directly; tests that passed overrides use the YAML values or monkeypatch
  `get_diagnostic_threshold`. Delete `test_load_diagnostic_thresholds_refreshes_when_the_path_changes`
  and the lab's override-path test.
- `resolve_diagnostic_threshold` moves to the lab's `diagnostics.py`.

## Verification

`just lint && just check && just test && just test-lab` after each PR; regenerate the golden
fixture per PR and review its diff. After PR 1, `uv run python scripts/profile_report.py` shows
the cap-sized PDF at roughly 25 pages and a PDF write under 3 s. After PR 3,
`run_all_diagnostics` files exactly six findings and `checks.py` is under 900 lines. An upload on
`WORKER_MODE=mock-llm` with one 0-weight line shows no weight-bounds warning on the quality page.
