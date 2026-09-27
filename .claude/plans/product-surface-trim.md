# Product surface trim

## Context

The product package still carries code that only the lab or only tests reach. The report bundle,
entree detection and the lab-only helpers have already moved to the lab, and the code nothing
called is gone. This plan is what is left, mapped in the September 2026 audit by grepping callers
across `python/` with tests excluded and following the call graphs.

What the map found:

- `report/diagnostics.py` (3,281 lines) is the product's largest module. The product reaches
  about 2,700 lines today and about 2,300 after the split, in four pieces: threshold loading; the
  quality checks and `run_all_diagnostics` (about 2,500 lines, the product core); messy-input
  parsing that the product never enters because `read_input_csv` has already parsed
  (`parse_and_validate_date_column`'s string, numeric and ambiguous passes, `clean_weight_column`'s
  string path); and the export tables (the DataFrame half of every `(findings, DataFrame)` return,
  `summarise_numeric_columns`) that only the QA workbook reads. Two checks look misfiled and are
  not: `identify_potentially_abnormal_weight_meat_items` and the meat block of
  `run_all_diagnostics` are lab code, since they need a `quantity` column that only the lab's
  serving CSVs carry (the lab hands the whole CSV to `build_food_report`); and
  `detect_numeric_coercion_loss` looks redundant on the product path, where the metric is already
  float, but the golden file pins its finding.
- `report/plots/`: `generate_all_report_plots` reaches every `plot_*` function left.
  `prepare_monthly_trend_data` is public because the lab's `pilot/plots.py` builds
  `plot_metric_over_time` on it, so the lab's trend numbers are the report's. `plotting_utils.py`
  is shared with five lab modules and sets the backend, the seaborn palette and the fonts at
  import. `aggregation.py` formats percentages as strings that `figures.py` parses back. The
  multi-panel pages are layout over the public `draw_*` drawers in `panels.py`; nothing outside
  `report/plots/` calls them, and that is not a reason to trim them, since they exist so a
  notebook draws one panel exactly as the client sees it.
- Tests follow the code. About a quarter of `test_diagnostics.py` targets lab-only paths: the
  `TestParseAndValidateDateColumn` string, numeric and ambiguous cases, and the meat check's two
  tests, in the outliers and thresholds sections. Threshold overrides go through one
  parametrized test, `test_checks_read_their_thresholds_from_yaml`, whose inputs each land on the
  opposite side of the checked-in default from the override, so a case fails if its check ignores
  the YAML; its `_override_thresholds` helper monkeypatches
  `report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH`. `run_all_diagnostics` has one aggregate test of
  its ordered findings on product-shaped input, beside the tests of its own inline logic.
- Two things in `diagnostics.py` are left with no caller now that the tests stopped reaching for
  them: the `_ThresholdLoader` Protocol that bolts `cache_clear` and `cache_info` onto
  `load_diagnostic_thresholds` (the cache keys on path and mtime, so no test clears it), and
  `detect_unusual_sales`'s legacy list-returning path, since `run_all_diagnostics` and the lab's
  `food_report/pipeline.py` both pass `return_details=True`. The legacy path is also what prints
  "Checking for products..." to stdout.
- Mechanical: `Any` in
  about 145 places where `dict[str, str]` or a `Literal` is easy;
  `pd.api.types.is_period_dtype`, deprecated in pandas 3 and gone in 4, which now lives only in the
  lab (`plotting_extras.py`, `pilot/plots.py`, `pilot/analysis.py`).

## Decisions

- **The product keeps what `analyze()` reaches.** Code the lab alone imports moves to the lab;
  code nobody imports is deleted with its tests, since git has it.
- **`categories.py` stays whole.** It is the one access layer over `GBD_categories.yaml`, so its
  getters stay together even where only the lab calls them (`get_dairy_categories`,
  `clean_GBD_category_name`) or nothing does (`get_plant_based_dairy_categories`, whose
  replacement is an exact product-category string that returns `[]` when mistyped). Splitting the
  getters across packages would leave half the taxonomy in each.
- **"No caller in the repo" is not proof of dead.** Data scientists keep gitignored notebooks in
  `client_work/` that grep cannot see. GBD's lead data scientist has accepted breaking changes, so
  the test is usefulness: delete what is superseded or a one-liner over something that stays, and
  restore from git if she needs it back.
- **`diagnostics.py` splits along the seams above**: `report/thresholds.py`, `report/checks.py`
  (the checks and `run_all_diagnostics`), and the lab gets the messy-input parsing and the meat
  check. The lab then runs the meat check itself, or its QA workbook loses the finding.
  `detect_numeric_coercion_loss` stays in `checks.py`, since dropping it would change the golden.
  Findings stay `dict[str, Any]`; a `Finding` type belongs beside `report.food_report.FoodReport`.
  **Open:** whether the export tables move with the QA workbook or stay because most checks
  compute them on the way to their findings. Measure per check before deciding.
- **Typed inputs at the boundary.** `categorize_unique_products` takes `datetime64` dates and float
  weights (`categorization-pipeline.md` PR 6) and the report takes `Literal` modes and regions
  (`build_food_report`). Parsing text is the lab's: free-text modes resolve only in the lab's
  `food_report/pipeline.py`, and `run_all_diagnostics` builds its `ReportMode` from its `serving`
  flag.
- **Tests move with the code, assertions unchanged.** A trivial assertion is deleted rather than
  moved unless it is the only test of a lab function.
- **The mechanical sweep is one PR per kind**, never folded into a behaviour PR. It follows code
  that has moved to the lab.

## PR 1 — split `diagnostics.py`

Thresholds and checks stay in the product; the messy-input parsing and the meat check go to the
lab, per the decision, and the meat check's two tests leave `test_diagnostics.py` with it.
`parse_and_validate_date_column` keeps only its `datetime64` pass in the product if any product
caller remains after `categorization-pipeline.md` PR 6; otherwise it moves whole.

`thresholds.py` takes the loader without the `_ThresholdLoader` shim, and `_override_thresholds`
patches the path where it now lives. `checks.py` takes `detect_unusual_sales` without its legacy
path, and that path's two tests and its threshold case go with it.

## PR 2 — mechanical

`Any` to real types where trivial;
`isinstance(dtype, pd.PeriodDtype)` in the three lab modules. **Open:** keep percentages
numeric in `aggregation.py` and format them at draw time; it changes the workbook's percentage cells
from text to numbers, so it is a behaviour change for GBD to want.

## Verification

- Every PR: `just lint && just check && just test && just test-lab`; the golden test unchanged
  through PR 1.
- PR 1: `uv sync --package worker-child --no-dev --no-editable` into a fresh venv, where the lab
  is not importable, and `python -m worker_child.mock_llm` still writes a PDF and workbook,
  proving nothing product-side imports a moved symbol.
- PR 1: run `1. Categorize Runscript.py` and `2. Produce Food Report.py` on
  `python/lab/test_data` in a scratch client folder, since no CI job runs the lab against data.

## Risks

- Lab regressions are silent; the runscript check above is the only guard.
