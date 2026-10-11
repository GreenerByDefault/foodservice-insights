# Lab boundary

## Context

`.claude/rules/python.md` § The lab boundary: code goes to the lab when it is exploratory and
into `gbd_foodservice_insights` when the worker needs it. The product has one caller,
`analyze()`, whose inputs are fixed (procurement, US factors, "YYYY-MM" counts the web validated,
`top_n_drivers=5`); the lab calls the same modules with notebook inputs. Mapping every product
symbol to its callers shows what is still in the product only for the lab, or only to tolerate
inputs the product never sends:

- `categorization/reviews.py` and `CategorizedProducts.ai_review_df`: read only by the lab's
  `categorization/spreadsheet.py`, which writes the human-review CSV. `analyze()` discards it,
  and `categorization-cache.md` PR 5 builds the harvested rows from `unique_products_df`, not
  from it.
- `MergeCounts.to_summary` and `n_rows_non_entree`: only the lab's `spreadsheet.py` and
  `entrees.filter_to_entrees` (the entree filter moved to the lab in #354 and #376).
- `aggregation.category_highest_vs_lowest_months` → `aggregation["highest_lowest"]`: computed on
  every product run, shown nowhere in the PDF or client workbook; only the lab's QA workbook reads it.
- `report/utils.py` (`normalize_diner_meal_mapping`, `_to_month_period`, `compute_month_alignment`,
  `divide_by_diner_meals`, the string branch of `ensure_month_year_column`) and
  `schema.validate_region`: parse and re-validate month keys, counts and region strings at every
  layer — `build_food_report`, `aggregate_data` (twice, once per grain), and each per-diner chart
  panel — because the notebooks passed strings. `analyze()` already holds typed values; #462 and
  #464 made the rows typed, the counts and region are the remainder.
- `aggregation._normalize_categories_to_canonical_labels` and every `.str.lower()` /
  `lowercase=True` comparison in `aggregation.py`, `emissions.py`, `plots/panels.py` and
  `checks.py`: tolerate hand-edited category names. On the product path every category is a
  canonical GBD name (cache validated, LLM answers snapped, #469 and #475), and the per-row
  `map(lambda)` ran 278,953 times in the cap profile for nothing.

## Decisions

- **Typed inputs, as #462 did for the rows.** `build_food_report` takes
  `diner_meal_mapping: Mapping[pd.Period, float]` and `region: Region`; `analyze()` converts
  its "YYYY-MM" keys with `pd.Period(month, freq="M")`. The one check that every month in the
  data has a count above zero happens once, at the top of `build_food_report`, raising
  `ValueError`; the product cannot hit it (the web sends a count ≥ 1 for exactly the file's
  months), the lab can.
- **Categories are compared exactly.** #501 rejects a non-GBD category at the boundary
  (`_validate_rows`), so nothing below it needs case folding. *Rejected: keeping it for the lab's
  hand-edited CSVs* — the lab now fails at `build_food_report` with the offending names, which
  is the rule ("fail loudly on bad data"), and it already did for emission factors (#492).
- **What the lab alone reads moves to the lab**, with its tests: the review table, the merge
  summary, the highest-vs-lowest table, the mapping and region parsers. The product's
  `CategorizedProducts` keeps `cleaned_df`, `unique_products_df` and `match_type_counts`;
  `MergeCounts` keeps its counts (the seam docstring in `analysis.py` names it as where result
  metadata would come from).
- Serving mode stays.
- The lab-only taxonomy getters in `categories.py` (`get_meat_categories`,
  `clean_GBD_category_name`, `get_dairy_categories`, …) move in `library-types.md` PR 1, where
  they become one-liners; not here.

## PR 1 — Move the review table and the merge summary to the lab

- `categorization/reviews.py` → `gbd_foodservice_insights_lab/categorization/reviews.py`;
  `tests/categorization/test_reviews.py` → `lab/tests/categorization/`. `CategorizedProducts`
  drops `ai_review_df`; `categorize_unique_products` no longer builds it. The lab's
  `categorize_spreadsheet_to_csvs` calls `build_ai_review_table(categorized.cleaned_df,
  categorized.unique_products_df)` itself.
- `MergeCounts` drops `to_summary` and `n_rows_non_entree`. The lab's `spreadsheet.py` gets a
  `merge_summary(counts, *, n_rows_non_entree=None)` returning the same dict;
  `filter_to_entrees` returns the non-entree row count alongside the counts instead of
  `dataclasses.replace`-ing it in.
- `tests/categorization/test_pipeline.py`, `test_steps.py` and the lab's `test_spreadsheet.py`,
  `test_entrees.py` follow. `categorization/pipeline.py`'s module docstring drops `reviews.py`.

## PR 2 — Move the highest-vs-lowest month table to the lab

- `category_highest_vs_lowest_months` → `gbd_foodservice_insights_lab/food_report/diagnostics.py`,
  with its two tests. `run_aggregation_pipeline` drops `highest_lowest`; the lab's
  `_write_qa_workbook` computes it from `report.aggregation["monthly_category_data"]` with
  `per_diner_metric_name(report.metric_total)`.
- Golden fixture: unchanged (the table was never in a deliverable).

## PR 3 — `build_food_report` takes typed counts

- Signature: `diner_meal_mapping: Mapping[pd.Period, float]`. `analyze()` builds it:
  `{pd.Period(month, freq="M"): float(count) for month, count in request.monthly_counts.items()}`.
  `build_food_report` checks once that every `month_year` in the rows has a count > 0 and raises
  `ValueError` listing the months otherwise; `FoodReport.diner_meal_mapping` stays a plain dict.
- `aggregate_data` loses `diner_meal_mapping` and `per_diner_meal`; `run_aggregation_pipeline`
  adds the per-head column by `agg[metric] / agg["month_year"].map(mapping)` for both grains.
  `plots/panels.py` divides a monthly series the same way instead of `divide_by_diner_meals`.
- `report/utils.py` keeps `monthly_totals` and a datetime-only `month_year` helper (or
  `build_food_report` inlines `rows["date"].dt.to_period("M")`); `normalize_diner_meal_mapping`
  and `_to_month_period` move to the lab's `food_report/utils.py` (its JSON loader is the only
  caller); `compute_month_alignment`, `divide_by_diner_meals` and the string branch of
  `ensure_month_year_column` are deleted.
- `tests/report/test_quality_contract.py` is mostly these helpers' tests: move what survives
  into `test_food_report.py` / `test_aggregation.py` and delete the file. `test_analysis.py`'s
  `test_hands_the_report_the_forms_answers` asserts the Period-keyed mapping.
- Touches `analyze()`; `categorization-cache.md` PR 5 touches its cache lines, not these.

## PR 4 — Compare categories exactly

- Delete `_normalize_categories_to_canonical_labels`; `create_template_data`,
  `summarize_animal_emissions_intensity`, `calculate_animal_emissions_concentration`,
  `calculate_category_swap_scenarios`, `calculate_plant_animal_split`,
  `calculate_plant_protein_share` and `filter_monthly_categories_by_type` use the names as
  given, with `isin` against `get_*_categories()`. `_RUMINANT_SWAP_SOURCE_CATEGORIES` and
  `_MILK_SWAP_SOURCE_CATEGORIES` become the canonical names.
- `emissions.get_emission_factor` and `calculate_emissions` look factors up by exact name and
  take `region: Region`; `schema.validate_region` moves to the lab's `run_food_report`, its only
  remaining caller (it validates a string from `client_metadata.json`).
- Tests that asserted case tolerance (`test_create_template_data_preserves_values_when_category_case_differs`,
  `test_calculate_plant_animal_split_is_case_insensitive_and_keeps_one_sided_months`,
  `test_summarize_animal_emissions_intensity_normalizes_case_variants`, the lowercase cases in
  `test_emissions.py`) become exact-name tests or go.
- Golden fixture: unchanged (the baseline CSV already uses canonical names).

## Verification

`just lint && just check && just test && just test-lab` per PR, golden fixture regenerated and
diffed. After PR 4, `grep -rn "lower()" python/insights/gbd_foodservice_insights/report
python/insights/gbd_foodservice_insights/emissions.py` finds no category comparison, and
`scripts/profile_report.py` (#499) no longer lists
`_normalize_categories_to_canonical_labels`. `python/insights/README.md` and the lab README's
description of what the wrapper adds stay accurate; update the sentence on the review CSV.
