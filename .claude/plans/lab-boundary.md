# Lab boundary

## Context

`.claude/rules/python.md` § The lab boundary: code goes to the lab when it is exploratory and
into `gbd_foodservice_insights` when the worker needs it. The product has one caller,
`analyze()`, whose inputs are fixed (procurement, US factors, "YYYY-MM" counts the web validated,
`top_n_drivers=5`); the lab calls the same modules with notebook inputs. Mapping every product
symbol to its callers shows what is still in the product only for the lab, or only to tolerate
inputs the product never sends:

- `schema.validate_region`, called by `emissions.get_emission_factor` and
  `calculate_emissions` on every lookup, because the notebooks passed region strings.
  `analyze()` already holds a typed `Region`; #462 and #464 made the rows typed, and the counts
  became a `Mapping[pd.Period, float]` checked once in `build_food_report`, so the region is the
  remainder.
- `aggregation._normalize_categories_to_canonical_labels` and every `.str.lower()` /
  `{c.lower() for c in …_categories()}` comparison in `aggregation.py`, `emissions.py`, `plots/panels.py` and
  `checks.py`: tolerate hand-edited category names. On the product path every category is a
  canonical GBD name (cache validated, LLM answers snapped, #469 and #475), and the per-row
  `map(lambda)` ran 278,953 times in the cap profile for nothing.

## Decisions

- **Typed inputs, checked once at the boundary.** `build_food_report` takes
  `diner_meal_mapping: Mapping[pd.Period, float]` and `region: Region`, and is the one place
  that refuses a data month without a positive count; the chart panels and
  `run_aggregation_pipeline` divide by the mapping without re-checking it. `analyze()` builds
  the keys with `pd.PeriodIndex`, since pandas' stubs type a lone `pd.Period(...)` as possibly
  `NaT`. The lab parses its own strings at its entry points — `run_food_report` and the pilot
  `plot_metric_over_time` call `food_report/utils.normalize_diner_meal_mapping` — and the region
  follows the same pattern.
- **Categories are compared exactly.** #501 rejects a non-GBD category at the boundary
  (`_validate_rows`), so nothing below it needs case folding. *Rejected: keeping it for the lab's
  hand-edited CSVs* — the lab now fails at `build_food_report` with the offending names, which
  is the rule ("fail loudly on bad data"), and it already did for emission factors (#492).
- **What the lab alone reads moves to the lab**, with its tests: the region parser. (The
  counts parser already did. So did the merge summary: `spreadsheet.merge_summary`, fed by
  `filter_to_entrees`' non-entree count. So did the highest-vs-lowest month table, now
  `food_report/diagnostics.category_highest_vs_lowest_months`, computed in `_write_qa_workbook`.) `MergeCounts` keeps its counts (the seam
  docstring in `analysis.py` names it as where result metadata would come from).
- Serving mode stays.

## PR 1 — Compare categories exactly

- Delete `_normalize_categories_to_canonical_labels`; `create_template_data`,
  `summarize_animal_emissions_intensity`, `calculate_animal_emissions_concentration`,
  `calculate_category_swap_scenarios`, `calculate_plant_animal_split`,
  `calculate_plant_protein_share` and `filter_monthly_categories_by_type` use the names as
  given, with `isin` against the `categories.py` getters (`animal_product_categories()`, …). `_RUMINANT_SWAP_SOURCE_CATEGORIES` and
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

`just lint && just check && just test && just test-lab`, golden fixture regenerated and
diffed. Afterwards, `grep -rn "lower()" python/insights/gbd_foodservice_insights/report
python/insights/gbd_foodservice_insights/emissions.py` finds no category comparison, and
`scripts/profile_report.py` (#499) no longer lists
`_normalize_categories_to_canonical_labels`. `python/insights/README.md` and the lab README's
description of what the wrapper adds stay accurate.
