# Notebook-era leftovers

## Context

`gbd_foodservice_insights` was ported from `catering_analysis`, where data scientists called
each function from a notebook on whatever frame they had. Two rounds of moves and fixes since
(#378, #380, #452, #466, #484, #501, #502, #509, #510 among them) have taken most of that era out
of the product. What remains is small and scattered, in three kinds:

1. **Lab conveniences still living in the product.** `quality.findings_to_frame`,
   `missingness_summary_frame` and `summarize_findings` (QA-workbook sheets, no product reader),
   `utils.rel_path` (log formatting, two lab readers), `schema.STATUS_SEVERITY` (no reader at
   all), `schema.VALID_REGIONS` (the lab's `validate_region`), `MergeCounts` and
   `CategorizedProducts.match_type_counts` (the categorization runscript's summary; `analyze()`
   discards both), and six of the twelve groups in `data_files/diagnostic_thresholds.yaml`, read
   only by the lab's own diagnostics: `near_duplicate_product_names`,
   `missing_weeks_within_month`, `category_discontinuity`, `single_product_dominance`,
   `category_concentration`, `meat_quantity_reasonableness`. A seventh, `missing_internal_months`,
   is empty and read by nobody.
2. **Guards for conditions validation already excludes**, each answering with a quiet default
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
3. **Parameters nothing varies.** `weight_col`, `category_col`, `emissions_col` and
   `product_col` on the emissions and aggregation functions, `aggregate_data`'s
   `metrics: list[str] | str`, `create_horizontal_percentage_barplot(palette=None)`,
   `plot_food_and_drink_comparison_page(diner_meal_mapping=None)` followed by a raise, the
   caption in `ReportCharts.figures: list[tuple[str, Figure]]` that is always `""`, and
   `_remove_duplicate_xlabels`, a cleanup step that no product chart triggers.

Two dead lines in the categorization steps belong to the same era: `clean_product_names`
ends with a `fillna` for names that cannot be missing, `merge_categorizations` drops three
columns that are never present, and `categorize_with_llm` guards a `match_type` column that
only an isolation test omits. The `previously_categorized` column equals `category.notna()` at
every step and no lab code reads it. And two correctness nits in the PDF's narrative:
`_executive_narrative` names the three largest categories by CO₂e with `nlargest`, so a
category bought only at zero weight can appear as "and Pork (0%)" when fewer than three
categories carry emissions; and `_narrative_paragraphs` reads the plant and animal shares
after rounding, so food that is 0.04% animal is called "all plant-based" and food that is 0.4%
animal reads "100% … and animal products 0%".

`caches-to-supabase.md` PR 5 adds `new_categorizations` to `CategorizedProducts`. Nothing below
touches that, and the PRs here land in either order relative to it — whichever lands second
rebases.

## Decisions

- **Fail loudly, do not default.** A guard whose condition validation excludes is deleted, not
  converted; where the lab could still reach the path with an unexpected frame, pandas' own
  `KeyError` is the right failure. *Rejected: keeping the guards as cheap insurance.* They are
  what turns a bug into a report with a silently missing check or table.
- **Lab-only code moves with its tests; import paths break.** The lab's gitignored notebooks are
  invisible callers and a breaking change there is accepted; the lab's checked-in callers are
  updated in the same PR.
- **The lab gets its own thresholds file**, `gbd_foodservice_insights_lab/data_files/diagnostic_thresholds.yaml`,
  and its own twenty-line `thresholds.py` against the lab's `PACKAGE_DIR`. *Rejected: one YAML the
  lab reads through the product's loader.* The product would keep carrying numbers it never reads.
- **`MergeCounts` becomes a lab type built from the frames.** `merge_categorizations` returns the
  merged frame; the lab's `merge_summary` derives the counts from the before and after frames
  (the merge drops only `No Matches Found` rows, so rows lost are rows uncategorized), and
  `filter_to_entrees` keeps adjusting the lab's type.
- **Kept, deliberately.** `Finding.metadata`, `column` and `count` — the lab's QA sheet shows
  them and the lab's own diagnostics tests pin them. The `(findings, export_df)` tuples the
  checks return — the lab's QA workbook. `categorize_unique_products`'s dtype checks — the lab
  hands it frames read from arbitrary files. `check_diner_meal_reasonableness`'s "no month has
  both a count and food" finding — reachable when enough months' lines all weigh zero. *Rejected: dissolving `schema.py` and moving
  `emissions.py` under `report/`.* Cosmetic once the above lands.

## PR 1 — The narrative names only categories with emissions

One of the plan's two behavior changes, with PR 7. `_executive_narrative` filters `co2e_by_cat` to
`total_kg_co2e > 0` before `nlargest(3, ...)`. A test in `test_pdf.py` builds a report with two
emitting categories and one zero-weight category and asserts the narrative names two. The golden
fixture does not change: its three top categories all emit.

## PR 2 — Lab-only helpers and thresholds leave the product

- `findings_to_frame`, `missingness_summary_frame`, `summarize_findings` → a new
  `gbd_foodservice_insights_lab/food_report/quality.py`; `summarize_findings` counts statuses
  with its own `Counter` rather than importing `summarize_status_counts`.
- `rel_path` → `gbd_foodservice_insights_lab/notebook_utils.py`, with its two tests from
  `test_utils.py`.
- `STATUS_SEVERITY` deleted. `VALID_REGIONS` deleted; `validate_region` uses `get_args(Region)`.
- The six lab-only threshold groups move to the lab's YAML; `missing_internal_months: {}` is
  deleted; the lab's `food_report/diagnostics.py` reads its own loader. The product YAML keeps
  `outlier_line_items`, `per_product_weight_bounds`, `month_over_month_total_volatility`,
  `diner_meal_count_reasonableness` and `date_distribution`.

## PR 3 — Categorization returns what the product reads

- `merge_categorizations(original_df, categorized_products_df) -> pd.DataFrame`; the 20% check
  computes its two counts inline; the `fillna("No Matches Found")` after the left merge becomes a
  raise when a product has no categorization, since the frames come from one
  `categorize_unique_products` call and a gap is a bug; the never-present `columns_to_drop` go.
  `analysis.py` drops `_counts`.
- `MergeCounts` → the lab, built by `MergeCounts.between(before, after)`; `spreadsheet.py`,
  `entrees.py` and their tests import it from there.
- `CategorizedProducts` loses `match_type_counts`; `categorize_unique_products` logs the
  breakdown as it does now; `spreadsheet.py` computes
  `unique_products_df["match_type"].value_counts()` for its summary.
- The `previously_categorized` column goes: `clean_product_names` masks on `category.notna()`,
  `categorize_using_cleaned_name_history` and `categorize_using_historical_classifications`
  stop writing it. `clean_product_names`'s trailing `fillna` goes. `categorize_with_llm` writes
  `match_type` unconditionally, and `test_categorize_with_llm_tolerates_a_missing_match_type_column`
  goes with the guard.
- Tests: `test_steps.py` and `test_pipeline.py` re-pin the frames without the column;
  `test_categorize_unique_products_characterization` is the one to read closely.

## PR 4 — Emissions and aggregation read the rows' fixed columns

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

## PR 5 — Checks without guards for validated rows

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

## PR 6 — Chart and writer signatures

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

## PR 7 — The narrative's plant sentence reads unrounded shares

The other behavior change. `ExecutiveNarrative` gains `any_animal: bool`, set from
`PlantAnimalSplit.animal_total > 0`, and the "All of the categorised food was plant-based"
sentence branches on it instead of `animal_pct == 0`. A `_share_text` helper in `pdf.py` prints
a nonzero share that `:.0f` would show as 0% or 100% as "under 1%" or "over 99%". Tests in
`test_pdf.py`: 0.04% animal gets the two-share sentence with "under 1%", not the all-plant one;
0.4% animal reads "over 99%" and "under 1%". The golden fixture's narrative gains
`any_animal: true`; its rendered sentence does not change.

## Verification

Each PR: `just lint && just check && just test && just test-lab`. The golden fixture does not
change in any PR but PR 7's one added field. For PRs 2–6, render the golden run's PDF before and after on the same day with
`SOURCE_DATE_EPOCH` fixed and compare the bytes. After PR 2,
`git grep -n 'findings_to_frame\|missingness_summary_frame\|summarize_findings\|rel_path\|STATUS_SEVERITY\|VALID_REGIONS' python/insights`
returns nothing; after PR 3, the same for `MergeCounts\|match_type_counts\|previously_categorized`.
