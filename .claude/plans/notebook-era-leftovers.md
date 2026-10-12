# Notebook-era leftovers

## Context

`gbd_foodservice_insights` was ported from `catering_analysis`, where data scientists called
each function from a notebook on whatever frame they had. Two rounds of moves and fixes since
(#378, #380, #452, #466, #484, #501, #502, #509, #510 among them) have taken most of that era out
of the product. What remains is small and scattered, in two kinds:

1. **Guards for conditions validation already excludes**, each answering with a quiet default
   instead of a failure. `apps/web` rejects a file whose product is blank or a placeholder, whose
   date is not a date, whose weight is not a plain non-negative number, or whose weights are all
   zero; `read_input_csv` re-checks the promises the contract makes; `validate_rows` (today
   `_validate_rows`) requires the four columns, no nulls, a `datetime64` date, a numeric
   non-negative metric and exact GBD categories; `build_food_report` rejects all-zero weights
   and any data month without a positive count. Past those, a missing column is a bug, yet
   `checks.py` files an `info` finding for one in two places and raises `KeyError` in a third,
   `aggregation.py` returns an empty frame or `None` for one in three, `emissions.py` raises
   `ValueError` for one in both of its frame functions, `report/utils.monthly_totals` in two
   more, and `check_date_distribution` and `run_all_diagnostics` silently skip checks whose
   columns are "missing". The two line-level checks also run
   `pd.to_numeric(..., errors="coerce")` over a column that is already numeric.
2. **Parameters nothing varies.** `weight_col`, `category_col`, `emissions_col` and
   `product_col` on the emissions and aggregation functions, `aggregate_data`'s
   `metrics: list[str] | str`, `create_horizontal_percentage_barplot(palette=None)`,
   `plot_food_and_drink_comparison_page(diner_meal_mapping=None)` followed by a raise, the
   caption in `ReportCharts.figures: list[tuple[str, Figure]]` that is always `""`, and
   `_remove_duplicate_xlabels`, a cleanup step that no product chart triggers.

## Decisions

- **Fail loudly, do not default.** A guard whose condition validation excludes is deleted, not
  converted; where the lab could still reach the path with an unexpected frame, pandas' own
  `KeyError` is the right failure. *Rejected: keeping the guards as cheap insurance.* They are
  what turns a bug into a report with a silently missing check or table.
- **Lab-only code moves with its tests; import paths break.** The lab's gitignored notebooks are
  invisible callers and a breaking change there is accepted; the lab's checked-in callers are
  updated in the same PR.
- **Kept, deliberately.** `Finding.metadata`, `column` and `count` — the lab's QA sheet shows
  them and the lab's own diagnostics tests pin them. The `(findings, export_df)` tuples the
  checks return — the lab's QA workbook. `categorize_unique_products`'s dtype checks — the lab
  hands it frames read from arbitrary files. `check_diner_meal_reasonableness`'s "no month has
  both a count and food" finding — reachable when enough months' lines all weigh zero. *Rejected: dissolving `schema.py` and moving
  `emissions.py` under `report/`.* Cosmetic once the above lands.

## PR 1 — Emissions and aggregation read the rows' fixed columns

- `emissions.py`: `calculate_emissions(df, region)` and `calculate_emissions_summary(df)` on
  `kilos_total`, `category` and `emissions_kg_co2e`, without column checks and without the
  `total == 0` branch (no zero factors, no all-zero rows). `calculate_emissions_per_diner_meal`
  takes a `float` and raises unless it is positive. `get_emission_factor` raises `KeyError`
  for a category outside the YAML — its callers pass the YAML's own names and validated
  categories — and `calculate_category_swap_scenarios` drops its `None` check and the
  `missing_categories` scan.
- `aggregation.py`: `aggregate_data(df, group_by, metric)` with one metric and no validation;
  `create_template_data`, `identify_category_drivers`, `identify_overall_drivers` drop their
  column checks; `summarize_animal_emissions_intensity(df)`,
  `calculate_animal_emissions_concentration(df, *, top_n)` and the swap functions drop the
  `*_col` parameters and the "missing columns → empty" returns, keeping the "no animal rows",
  "no ruminant rows" and "nothing to replace" returns, which are data. `monthly_totals` moves
  here from `report/utils.py` without its two guards, and that module goes.
- Tests: the `pytest.raises(ValueError, match="not found")` family and the missing-column
  cases in `test_emissions.py` and `test_aggregation.py` go; everything else keeps passing.

## PR 2 — Checks without guards for validated rows

- `detect_unusual_sales`: the `missing_columns` raise, the `df.empty` and `valid_rows.empty`
  returns (rows are never empty, and at least one weighs more than zero), and `pd.to_numeric`.
- `check_per_product_weight_bounds`: the missing-columns `info` finding, the `df.empty` return,
  `pd.to_numeric`.
- `detect_month_over_month_total_volatility`: the missing-metric `info` finding and the
  unreachable `comparison_df.empty` branch after the `< 2` months return.
- `check_date_distribution`: the `"month_year" not in df.columns` return, and the
  `median_count == 0` return — it counts lines, and every month it sees has at least one.
  `run_all_diagnostics`: the column guards around the two checks it conditionally ran.
- `_format_month_label(month: pd.Period)` formats the `Period` it is always given.
  `quality_status_from_findings` and `summarize_status_counts` read `item["status"]`; the
  `TypedDict` guarantees it.
- Tests: the tests of the deleted branches go; the messages, statuses and export frames the
  remaining tests pin do not change.

## PR 3 — Chart and writer signatures

- `plots/report.py`: delete the `filter_monthly_categories_by_type(...)` call whose result is
  discarded; delete `_remove_duplicate_xlabels` and `_normalize_axis_text` with their test —
  `test_generate_all_report_plots_orders_every_page` lists every page, and none labels its x
  axis with its own title. `generate_all_report_plots` returns `list[Figure]`;
  `ReportCharts.figures: list[Figure]`; `write_report_pdf` iterates figures;
  `test_write_report_pdf_does_not_render_plot_captions` goes. The lab's `export_report_plots`
  takes `list[Figure]`; its caption fallback already reads each figure's title.
- `plots/figures.py` and `plots/panels.py`: `diner_meal_mapping` required
  (`test_food_and_drink_comparison_page_requires_diner_meals` goes), `diner_or_meal: DinerOrMeal`
  where it is `str`, `plot_diner_meal_numbers` takes a `Mapping` (not `| pd.Series`),
  `plot_emissions_by_category` drops its `"pct_of_total" in data.columns` guard,
  `filter_monthly_categories_by_type` drops its `"category"` guard, and `GBD_COLORS[0]` is read
  without the truthiness guard. `prepare_monthly_trend_data` stays as it is: the lab's pilot plots
  use it.
- `plotting_utils.create_horizontal_percentage_barplot` drops `palette`.
- `excel.write_excel_workbook(path: Path, sheets) -> None`; `write_client_workbook` passes its
  `Path`; the lab's `build_qa_excel_report` wraps its string once and logs the path it was given.

## Verification

Each PR: `just lint && just check && just test && just test-lab`. The golden fixture does not
change in any PR. For every PR, render the golden run's PDF before and after on the same day with
`SOURCE_DATE_EPOCH` fixed and compare the bytes.
