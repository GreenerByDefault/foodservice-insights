# Product surface trim

## Context

The product package still carries code that only the lab, only tests, or nobody calls.
The report bundle and entree detection have already moved to the lab. This plan is what is left,
mapped in the September 2026 audit by grepping callers across `python/` with tests excluded and
following the call graphs.

What the map found:

- `report/diagnostics.py` (3,411 lines) is the product's largest module. The product reaches
  about 2,700 lines today and about 2,300 after the split, in four pieces: threshold loading; the
  quality checks and `run_all_diagnostics` (about 2,500 lines, the product core); messy-input
  parsing that the product never enters because `read_input_csv` has already parsed
  (`parse_and_validate_date_column`'s string, numeric and ambiguous passes, `clean_weight_column`'s
  string path, `clean_column_names`); and the export tables (the DataFrame half of every
  `(findings, DataFrame)` return, `summarise_numeric_columns`) that only the QA workbook reads.
  Dead outright: `validate_date_column`, `baseline_pre_flight_checks` (tests only),
  `identify_potentially_abnormal_weight_meat_items` and the meat block of `run_all_diagnostics`
  (they need a `quantity` column the product never has), `detect_numeric_coercion_loss` on the
  product path (the metric is already float), and `MISSING_TEXT_TOKENS` defined twice.
- `categories.py`: `GBD_categories_check`, `clean_GBD_category_names` and `order_GBD_categories`
  (three `print` calls between them, and they mutate their input) and
  `get_plant_based_dairy_categories` have no callers; `get_dairy_categories` and
  `clean_GBD_category_name` are lab-only. `utils.py`: `remove_file` has no callers;
  `get_default_output_file` is lab-only, called by the lab's `categorize_spreadsheet_to_csvs`; `rel_path`
  shortens two log lines.
- `report/schema.py`: `validate_report_mode` has no callers; `REQUIRED_NON_NULL_COLUMNS_BY_MODE`
  equals `REQUIRED_COLUMNS_BY_MODE`; `normalize_report_mode`'s `"serv" in text`
  heuristic is folder-name parsing the split plan gives to the lab.
  `emissions.get_available_regions` has no callers. `aggregation.py`: `aggregate_data`'s
  `timescale="period"` branch has no callers; `category_highest_vs_lowest_months` feeds only the
  QA workbook.
- `report/plots.py`: the `plot_*` functions `generate_all_report_plots` never reaches have no
  other product caller (`plot_metric_over_time` is used by the lab's `pilot/plots.py`; the rest
  by nobody).
  `plotting_utils.py` is shared with four lab modules; `plot_time_series_with_periods` and
  `rotate_x_labels` are lab-only. `aggregation.py` formats percentages as strings that `plots.py`
  parses back. `plotting_utils.py` sets the backend, the seaborn palette and the fonts at import.
- `report/pdf.py`: the Decision KPIs branch inside `create_table_page` is unreachable (the function
  returns for that title earlier). The quality page's error handling is all dead: any `error`
  finding aborts the run before a PDF exists (the report always hard-fails), so
  `_QUALITY_STATUS_SENTENCES["error"]` (never selected anyway: the vocabulary is `invalid`),
  `_STATUS_LABELS["error"]`, the `n_err` "issues" count in `_quality_to_lines` and the
  `Data check result: invalid.` fallback cannot render. `invalid` itself stays: the lab's failure
  manifest records it. `report/pipeline.py`: `summary_stats` is built for a summary page
  the product never renders, since the narrative replaces it; only "Date range" survives, and
  `test_outputs.py` asserts on the rest.
- Tests follow the code. About a quarter of `test_diagnostics.py` targets lab-only paths;
  the `*_reads_*_from_yaml` tests are one template, and the loader's own test already shows
  their `cache_clear()` calls unnecessary; the `test_run_all_diagnostics_includes_*` tests
  re-assert what each check's unit test asserts, with an empty mapping the product never passes.
  `test_aggregate.py` is a legacy grab-bag of aggregation, diagnostics and about twenty plot
  tests, several asserting only `isinstance(fig, plt.Figure)`; `test_plotting_utils.py` is mostly
  "runs without error"; `conftest.py`'s `temp_dir` wraps `tmp_path`.
- Mechanical: `from __future__ import annotations` in 18 modules on Python 3.14; docstrings that
  restate the signature (`Parameters`/`Returns`, `Args`/`Returns`) on about 35 functions across
  `categorization/`, `categories.py` and `utils.py`; `Any` in 167 places where `dict[str, str]`
  or a `Literal` is easy; two hand-rolled module caches (`categories.py`, `emissions.py`) that
  `functools.cache` expresses; `pd.api.types.is_period_dtype` in `plotting_utils.py`, deprecated
  in pandas 3 and gone in 4.

## Decisions

- **The product keeps what `analyze()` reaches.** Code the lab alone imports moves to the lab;
  code nobody imports is deleted with its tests, since git has it.
- **"No caller in the repo" is not proof of dead.** Data scientists keep gitignored notebooks in
  `client_work/` that grep cannot see. GBD's lead data scientist has accepted breaking changes, so
  the test is usefulness: delete what is superseded or a one-liner over something that stays, and
  restore from git if she needs it back.
- **`diagnostics.py` splits along the seams above**: `report/thresholds.py`, `report/checks.py`
  (the checks and `run_all_diagnostics`), and the lab gets the messy-input parsing. Findings stay
  `dict[str, Any]`; a `Finding` type belongs beside `report.food_report.FoodReport`.
  **Open:** whether the export tables move with the QA workbook or stay because most checks
  compute them on the way to their findings. Measure per check before deciding.
- **Typed inputs at the boundary.** `categorize_unique_products` takes `datetime64` dates and float
  weights (`categorization-pipeline.md` PR 3) and the report takes `Literal` modes and regions
  (`build_food_report`). Parsing text is the lab's.
- **Tests move with the code, assertions unchanged.** A trivial assertion is deleted rather than
  moved unless it is the only test of a lab function. Templated tests collapse to one
  parametrized test.
- **The mechanical sweep is one PR per kind**, never folded into a behaviour PR.

## PR 1 — delete the dead

Everything with no callers: the four `categories.py` functions and `remove_file`,
`schema.validate_report_mode`, `REQUIRED_NON_NULL_COLUMNS_BY_MODE`,
`emissions.get_available_regions`, the `timescale="period"` branch, the unreachable `plot_*`
functions (each superseded by a combined page the report renders, or a one-line pandas
profile), the unreachable Decision KPIs branch and the never-selected `"error"` status sentence
in `pdf.py`, `validate_date_column`, `baseline_pre_flight_checks`, the second token set, and both
`temp_dir` fixtures. Tests go with them. No product behaviour changes: the golden test passes
unchanged.

Dropped from this PR after review:

- **The meat check is lab code, not dead.** The lab hands its full CSV to `build_food_report`,
  and serving data carries the `quantity` column the check needs. It moves in PR 3.
- **`summary_stats` is rendered.** `_executive_narrative` returns `None` when total CO2e is
  missing or zero (missing emissions are only a warning), and the PDF falls back to the
  key-value page. The golden file pins every key.
- **The quality page's per-finding `error` label and count stay**: `build_pdf_report` is public,
  and only the status sentence is unreachable by construction.
- **`highest_lowest` feeds the lab's QA workbook**, not the client workbook; the lab uses it.

## PR 2 — lab-only code to the lab

`plot_metric_over_time` to `pilot/plots.py`, `plot_time_series_with_periods` to
`plotting_extras.py`, `clean_column_names` to `extraction/tabular_io.py`, and
`normalize_report_mode` private to `food_report/pipeline.py`; `rotate_x_labels` and
`get_default_output_file` inline into their one caller. Lab imports repointed; lab tests move,
assertions unchanged.

`get_dairy_categories` and `clean_GBD_category_name` stay in `categories.py` despite being
lab-only: that module is the one access layer over `GBD_categories.yaml`, and splitting its
getters across packages would leave half the taxonomy in each. Stacks on PR 1, which deletes the product callers of
`clean_GBD_category_name`, `plot_time_series_with_periods`, `rotate_x_labels` and
`normalize_report_mode`.

- `normalize_report_mode` is still reached by `run_all_diagnostics` → `check_required_columns`,
  which only ever passes the two literals, so the product builds the `ReportMode` itself.
- `plot_metric_over_time` calls `_prepare_monthly_trend_data`, which the report also uses.
- `detect_numeric_coercion_loss` stays: `run_all_diagnostics` calls it and the golden file pins
  its finding, so dropping it from the product path is a behaviour change.

## PR 3 — split `diagnostics.py`

Thresholds, checks, and parsing (lab), per the decision. `parse_and_validate_date_column` keeps
only its `datetime64` pass in the product if any product caller remains after
`categorization-pipeline.md` PR 3; otherwise it moves whole.

## PR 4 — test consolidation

The YAML template tests become one parametrized test; the `run_all_diagnostics_includes` tests
become one test that the aggregate returns every check's findings in order, given the
Period-keyed mapping the product passes; `test_aggregate.py` splits into `test_plots.py` (keeping
the `generate_all_report_plots` tests, the strongest in the suite) and its other tests merge into
their modules' files; `test_plotting_utils.py` keeps font registration and the wrapping helpers.

## PR 5 — mechanical

`from __future__` gone; signature-restating docstrings pruned (the `prune-comments` skill);
`Any` to real types where trivial; `functools.cache` for the two YAML caches;
`isinstance(dtype, pd.PeriodDtype)`. **Open:** keep percentages numeric in `aggregation.py` and
format them at draw time; it changes the workbook's percentage cells from text to numbers, so it
is a behaviour change for GBD to want.

## Verification

- Every PR: `just lint && just check && just test && just test-lab`; the golden test unchanged
  through PR 4.
- PRs 2 and 3: `uv sync --package worker-child --no-dev` into a fresh venv still runs
  `WORKER_MODE=mock-llm`, proving nothing product-side imports a moved symbol.
- PRs 2 and 3: run `1. Categorize Runscript.py` and `2. Produce Food Report.py` on
  `python/lab/test_data` in a scratch client folder, since no CI job runs the lab against data.

## Risks

- Lab regressions are silent; the runscript check above is the only guard.
