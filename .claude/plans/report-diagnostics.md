# Report diagnostics

## Context

The product runs one report shape: `analyze()` calls `build_food_report(mode="procurement",
region="us")` on rows `read_input_csv` has already checked against the web app's promises
(`contract/contract.json` § inputCsv). The PDF's "Data Completeness & Quality" page lists the
customer only `warning` and `error` findings (`show_quality_successes=False`, #392), though it
still prints how many `success` findings passed. No `error` is reachable from customer data.

`build_food_report` checks its rows once, up front (`_validate_rows` in
`report/food_report.py`): the required columns are present and non-null, `date` is
`datetime64` and the metric numeric (`TypeError` otherwise), the metric is non-negative and every
`category` is an exact GBD name (`ValueError`). Every stage after that raises its own exception;
nothing collects error findings, and `FoodReport.findings` is the one list of findings, which the
lab extends with its own. So a check in `report/checks.py` may assume all of that rather than
re-check it.

`run_all_diagnostics` files the six findings that reach a customer: month-over-month volatility,
missing internal months, headcount reasonableness, unusual line items, weight bounds, partial
first/last month. The lab's `run_food_report` appends its own after `build_food_report`: near-
duplicate names, meat quantities, category discontinuity, single-product dominance, category
concentration and missing weeks within a month, all in
`gbd_foodservice_insights_lab/food_report/diagnostics.py`. Those last four used to run in the
product too, but three were only ever `info` and the fourth told a customer a month of data was
probably missing when, in one validated export, it is purchasing. The lab's end-to-end test
(`test_integration_food_report.py`) pins the full list of findings the bundle files, so a lab
check that goes silent fails there rather than nowhere.

`report/thresholds.py` merges an override YAML over the packaged one, keyed on both files' mtimes
through an `lru_cache`; no caller sets `DIAGNOSTIC_THRESHOLDS_PATH` except tests. The product
checks take per-call override parameters (`detect_unusual_sales`'s five thresholds,
`check_per_product_weight_bounds`' `low`/`high`, `check_diner_meal_reasonableness`' ratios) that
only tests pass; the lab's checks take them too (`threshold_pct`, `max_gap_days`,
`max_levenshtein_distance`), and every one resolves through `resolve_diagnostic_threshold`.

`scripts/profile_report.py` builds a report from a synthetic upload at the row cap under
`cProfile` and prints each stage's time and the PDF's page count; use it before claiming any
change here is faster.

## Decisions

- **Lab-only checks live in the lab** and are appended by `run_food_report`, the pattern since
  #452 and #484; no golden fixture for the lab, because its QA workbook would repeat the product
  golden's tables and churn with every product change. *Rejected: keeping category
  discontinuity as a customer warning* — in a single validated export the message is usually
  false and never actionable (#491's reasoning).
- **Thresholds stay in the packaged YAML** so the data scientists tune them in one place, loaded
  once with `functools.cache`. The override-file path and the product's per-call overrides go;
  `resolve_diagnostic_threshold` moves to the lab, whose checks keep their overrides because a
  notebook may want them. *Rejected: constants in `checks.py`* — the YAML is the lab's knob, and
  lab-only thresholds already live there.
- Serving mode and its thresholds (`per_product_serving_bounds`) are untouched.

## PR 1 — Load thresholds once

- `report/thresholds.py` becomes a `functools.cache`d read of the packaged YAML and
  `get_diagnostic_threshold(diagnostic, name) -> float`; `DIAGNOSTIC_THRESHOLDS_PATH`,
  `_threshold_cache_key`, `_merge_threshold_mappings` and the mtime-keyed `lru_cache` go.
- The product checks drop their override parameters and call `get_diagnostic_threshold`
  directly; `test_checks.py`'s parametrized `test_checks_read_their_thresholds_from_yaml` (three
  cases now) and the serving-bounds tests monkeypatch `get_diagnostic_threshold` or use the YAML
  values. Delete `test_load_diagnostic_thresholds_refreshes_when_the_path_changes`.
- `resolve_diagnostic_threshold` moves to the lab's `diagnostics.py`. The lab's three tests that
  point `DIAGNOSTIC_THRESHOLDS_PATH` at a temporary YAML (meat quantity, near-duplicate names,
  and its own parametrized `test_checks_read_their_thresholds_from_yaml`) monkeypatch
  `get_diagnostic_threshold` instead.

## Verification

`just lint && just check && just test && just test-lab`; regenerate the golden fixture with
`UPDATE_GOLDEN=1` and confirm it does not change, since no threshold value moves.
