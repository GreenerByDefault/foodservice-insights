# Notebook-era leftovers

## Context

`gbd_foodservice_insights` was ported from `catering_analysis`, where data scientists called
each function from a notebook on whatever frame they had. Two rounds of moves and fixes since
(#378, #380, #452, #466, #484, #501, #502, #509, #510 among them), then emissions and
aggregation reading the rows' fixed columns, then the report checks dropping their guards for
validated rows, have taken most of that era out of the product.

What remains is in the charts and the writers: **parameters nothing varies**, and a few guards
beside them. `emissions_col` on the emissions chart panels,
`create_horizontal_percentage_barplot(palette=None)`,
`plot_food_and_drink_comparison_page(diner_meal_mapping=None)` followed by a raise, the caption
in `ReportCharts.figures: list[tuple[str, Figure]]` that is always `""`, and
`_remove_duplicate_xlabels`, a cleanup step that no product chart triggers.

## Decisions

- **Fail loudly, do not default.** A guard whose condition validation excludes is deleted, not
  converted; where the lab could still reach the path with an unexpected frame, pandas' own
  `KeyError` is the right failure. Validation here means `apps/web`'s upload checks,
  `read_input_csv`, `validate_rows` (columns present, no nulls, `datetime64` dates, numeric
  non-negative metric, exact GBD categories) and `build_food_report`'s rejection of all-zero
  weights and of any data month without a positive count. *Rejected: keeping the guards as
  cheap insurance.* They are what turns a bug into a report with a silently missing check or
  table.
- **Lab-only code moves with its tests; import paths break.** The lab's gitignored notebooks are
  invisible callers and a breaking change there is accepted; the lab's checked-in callers are
  updated in the same PR.
- **Kept, deliberately.** `Finding.metadata`, `column` and `count` — the lab's QA sheet shows
  them and the lab's own diagnostics tests pin them. The `(findings, export_df)` tuples the
  checks return — the lab's QA workbook. `categorize_unique_products`'s dtype checks — the lab
  hands it frames read from arbitrary files. `check_diner_meal_reasonableness`'s "no month has
  both a count and food" finding — reachable when enough months' lines all weigh zero.
  *Rejected: dissolving `schema.py` and moving `emissions.py` under `report/`.* Cosmetic once
  the above lands.

## PR 1 — Chart and writer signatures

- `plots/report.py`: delete the `filter_monthly_categories_by_type(...)` call whose result is
  discarded; delete `_remove_duplicate_xlabels` and `_normalize_axis_text` with their test —
  `test_generate_all_report_plots_orders_every_page` lists every page, and none labels its x
  axis with its own title. `generate_all_report_plots` returns `list[Figure]`;
  `ReportCharts.figures: list[Figure]`; `write_report_pdf` iterates figures;
  `test_write_report_pdf_does_not_render_plot_captions` goes. In the lab, `export_report_plots`
  takes `list[Figure]` (its caption fallback already reads each figure's title), and
  `food_report/serving.py`'s `serving_charts` and `write_serving_pdf` stop wrapping and
  unpacking `("", figure)`.
- `plots/figures.py` and `plots/panels.py`: `diner_meal_mapping` required
  (`test_food_and_drink_comparison_page_requires_diner_meals` goes), `diner_or_meal: DinerOrMeal`
  where it is `str`, `plot_diner_meal_numbers` takes a `Mapping` (not `| pd.Series`),
  `plot_emissions_by_category` drops its `"pct_of_total" in data.columns` guard,
  `filter_monthly_categories_by_type` drops its `"category"` guard, and `GBD_COLORS[0]` is read
  without the truthiness guard. `draw_total_emissions`, `draw_emissions_per_diner` and the
  figure that calls them drop `emissions_col` and read `emissions_kg_co2e`.
  `prepare_monthly_trend_data` stays as it is: the lab's pilot plots use it.
- `plotting_utils.create_horizontal_percentage_barplot` drops `palette`.
- `excel.write_excel_workbook(path: Path, sheets) -> None`; `write_client_workbook` passes its
  `Path`; the lab's `build_qa_excel_report` wraps its string once and logs the path it was given.

This is the last PR: it deletes this plan.

## Verification

`just lint && just check && just test && just test-lab`. The golden fixture does not change.
Render the golden run's PDF before and after on the same day with `SOURCE_DATE_EPOCH` fixed and
compare the bytes — `pytest --basetemp=<dir> -k golden` on `tests/test_analysis.py` leaves it at
`<dir>/test_analyze_golden_deliverabl0/output/report.pdf`.
