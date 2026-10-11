# Report diagnostics

## Context

The product runs one report shape: `analyze()` calls `build_food_report(mode="procurement",
region="us")` on rows `read_input_csv` has already checked against the web app's promises
(`contract/contract.json` § inputCsv). The PDF's "Data Completeness & Quality" page lists the
customer only `warning` and `error` findings (`show_quality_successes=False`, #392), though it
still prints how many `success` findings passed, so deleting one lowers that count. No `error` is
reachable from customer data.

`build_food_report` now checks its rows once, up front (`_validate_rows` in
`report/food_report.py`): the required columns are present and non-null, `date` is
`datetime64` and the metric numeric (`TypeError` otherwise), the metric is non-negative and every
`category` is an exact GBD name (`ValueError`). Every stage after that raises its own exception;
nothing collects error findings any more, and `FoodReport.findings` is the one list of findings,
which the lab extends with its own. So a check in `report/checks.py` may assume all of that rather
than re-check it.

`run_all_diagnostics` files ten findings. Six reach a customer and stay: month-over-month
volatility, missing internal months, headcount reasonableness, unusual line items, weight bounds,
partial first/last month. Four cannot, or mislead when they do:

| Finding | Why it leaves the product |
| --- | --- |
| `single_product_dominance`, `category_concentration`, `missing_weeks_within_month` | `info` only |
| `category_discontinuity` | in one validated export, a category absent for a month between two it was bought in is purchasing, not "a missing month of data"; `missing_internal_months` already covers a wholly missing month |

`scripts/profile_report.py` builds a report from a synthetic upload at the row cap under
`cProfile` and prints each stage's time and the PDF's page count; use it before claiming any
change here is faster.

`report/thresholds.py` merges an override YAML over the packaged one, keyed on both files' mtimes
through an `lru_cache`; no caller sets `DIAGNOSTIC_THRESHOLDS_PATH` except tests, and the
per-call `override` parameters on every check are used only by tests.

## Decisions

- **The four checks move to the lab** as real capability for its multi-file world. Same shape as
  #452 and #484: the lab's `run_food_report` appends their findings after `build_food_report`.
  *Rejected: keeping category discontinuity as a customer warning* — the message tells the
  customer their data is probably missing, which in a single validated export is usually false
  and never actionable (#491's reasoning).
- **Thresholds stay in the packaged YAML** so the data scientists tune them in one place, loaded
  once with `functools.cache`. The override-file path and the per-call overrides go;
  `resolve_diagnostic_threshold` moves to the lab, its only remaining caller. *Rejected: constants
  in `checks.py`* — the YAML is the lab's knob, and the precedent since #484 is that lab-only
  thresholds (`near_duplicate_product_names`, `meat_quantity_reasonableness`) live there too.
- Serving mode and its thresholds (`per_product_serving_bounds`) are untouched.

## PR 1 — Move the lab-only checks to the lab

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
- Golden fixture diff: three findings disappear (missing weeks does not fire on it).

## PR 2 — Load thresholds once

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
fixture per PR and review its diff. After PR 1, `run_all_diagnostics` files exactly six findings
and `checks.py` is about 900 lines.
