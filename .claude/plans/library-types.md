# Library types

## Context

The recent typed-rows and `Finding` TypedDict work (#459, #462, #464) paid for itself in bugs
found (#465). Three stringly-typed shapes remain, each read by key or by name in several places:

- **`categories.py`** (212 lines): eleven `get_*_categories(lowercase=False)` getters over the
  raw YAML `dict[str, Any]`; `get_egg_categories` and `get_protein_categories` decide membership
  by `"egg" in name`; `emissions.load_emission_factors` rebuilds a second dict from the same
  YAML. Five getters have no product caller (`get_meat_categories`, `clean_GBD_category_name`,
  `get_dairy_categories`, `get_egg_categories`, `get_plant_based_dairy_categories`); the lab's
  `pilot/` and `diagnostics.py` use three of them.
- **`run_aggregation_pipeline` → `dict[str, Any]`**, read by string key in `food_report.py`,
  `excel.py`, `pdf.py`, `plots/report.py` and the lab's `pipeline.py`;
  `FoodReport.procurement_table(name)` re-derives "is this one present" from the dict.
  `calculate_animal_emissions_concentration` returns a one-row DataFrame whose columns are prose
  ("Top product emissions (kg CO2e)") so the workbook can print it, and `pdf.py` renames those
  columns in `_format_decision_kpis_for_pdf` only for `create_decision_kpis_page` to read them
  back by the new names and write one sentence.
- **`pdf.build_pdf_report`** takes `title_info: dict[str, str]`, `narrative: dict[str, Any]`
  with nine documented keys, and `tables: dict[str, DataFrame]` that `create_table_page`
  dispatches on title strings ("Decision KPIs", "Substitution Scenarios", "Category Template").
  `write_report_pdf` is its only product caller; the golden test records its kwargs.
- Plotting leftovers: `plot_category_totals` styles through pyplot state (`plt.title`,
  `plt.yticks`) while every other figure uses its `ax`; `format_month_labels` handles Periods,
  datetimes and three string formats for callers that only ever pass Periods;
  `plotting_utils`'s header names `aggregate.py` and `results.py`, which no longer exist;
  `GBD_colors` and `get_GBD_categories` are the last non-PEP 8 names.

## Decisions

- **One `Category` record per YAML entry**, loaded once: `name` (the `cool_food_pledge_name`
  the report shows), `short_name`, `emission_factor_us`, `emission_factor_europe`,
  `is_animal_product`, `product_category`, `kind: Literal["food", "drink"]`, `meat`,
  `protein`. `protein: true` is added to the YAML for the six meats, two eggs, four plant
  proteins and plant-based egg, replacing the "egg in name" rule with data. Every getter is a
  comprehension over `categories()`; the lab-only ones move to a lab `categories.py` as the
  same one-liners. *Rejected: deriving `protein` from `product_category`* — "Animal Based
  Proteins" includes dairy-adjacent eggs and excludes plant egg; the flag says what it means.
- **An `Aggregation` frozen dataclass** with the procurement-only tables typed `| None`, and
  `AnimalEmissionsConcentration(top_products, top_products_kg_co2e, total_animal_kg_co2e,
  share_pct)` in place of the prose-column DataFrame; `excel.py` builds its one-row sheet from
  it and `pdf.py` its sentence.
- **`write_report_pdf` is the PDF builder.** `build_pdf_report`'s dict parameters become an
  `ExecutiveNarrative` dataclass and explicit per-table page functions chosen in
  `write_report_pdf`; the title-string dispatch in `create_table_page` goes. The golden test
  records the typed inputs (`report` fields, the narrative, chart titles) instead of
  `build_pdf_report`'s kwargs.
- Order after `lab-boundary` PR 4 (exact category matching), so the `lowercase` flags are
  already unused when they are removed.

## PR 1 — `Category` records and a `protein` flag

- `data_files/GBD_categories.yaml`: `protein: true|false` on every entry (13 true).
- `categories.py`: `Category` frozen dataclass, `@cache def categories() -> tuple[Category, ...]`
  validating the YAML's shape once, `category_names()` (renamed from `get_GBD_categories`),
  `animal_product_categories()`, `plant_based_categories()`, `plant_protein_categories()`,
  `protein_categories()`, `food_categories()`, `drink_categories()`. Drop the `lowercase` flags
  and `get_gbd_categories_metadata`.
- `emissions.load_emission_factors` becomes `{c.name: c.emission_factor_us | …_europe}` from
  `categories()`; `test_every_category_has_an_emission_factor` becomes a type (`float`, not
  `float | None`).
- Lab: `gbd_foodservice_insights_lab/categories.py` with `meat_categories()`,
  `dairy_categories()`, `egg_categories()`, `plant_based_dairy_categories()`,
  `short_name(category)` (was `clean_GBD_category_name`); `pilot/`, `plotting_extras.py`,
  `food_report/diagnostics.py` import from there.
- `tests/test_categories.py` (298 lines) rewritten around `categories()`: the YAML parses to
  the expected count, every name is unique, `protein` matches meat ∪ eggs ∪ plant proteins ∪
  plant egg, the lowercase cases go.

## PR 2 — `Aggregation` and `AnimalEmissionsConcentration`

- `aggregation.py`: `Aggregation(monthly_product, monthly_category, template, overall_drivers,
  category_drivers, animal_emissions_intensity: DataFrame | None, animal_emissions_concentration:
  AnimalEmissionsConcentration | None, substitution_scenarios: DataFrame | None)`;
  `run_aggregation_pipeline` returns it with the three `None` for serving.
- `FoodReport.aggregation: Aggregation`; `procurement_table()` goes. `food_report.py`,
  `excel.py` (which renders the concentration as its one-row sheet), `pdf.py`, `plots/report.py`
  and the lab's `pipeline.py` / `excel.py` read attributes.
- Tests: `test_aggregation.py`, `test_food_report.py`, `test_outputs.py`, lab `test_pipeline.py`.

## PR 3 — Typed PDF assembly

- `pdf.py`: `ExecutiveNarrative` dataclass built by `_executive_narrative`; `write_report_pdf`
  assembles the pages itself — title, executive summary (narrative, or the key-value page for a
  serving report), how-to-read, charts, `create_category_template_pages`,
  `create_animal_intensity_page`, `create_decision_kpis_page(concentration)`,
  `create_substitution_scenarios_page`, about, quality. `build_pdf_report`, `create_table_page`'s
  title dispatch, `_format_decision_kpis_for_pdf` and `title_info` go; `_draw_table_page` stays
  the shared renderer with explicit `font_size`/`row_scale`/`col_widths` arguments.
- `tests/report/test_pdf.py` (911 lines): the `build_pdf_report` tests call `write_report_pdf`
  with the small `FoodReport` fixtures the `write_report_pdf` tests already use; the golden
  harness in `test_analysis.py` records `report.findings`, `report.summary_stats`, the
  narrative, the formatted tables and chart titles from `write_report_pdf`'s arguments.
- Golden fixture regenerated (its structure changes; values should not).

## PR 4 — Plotting leftovers

- `plot_category_totals` styles its `ax`; `format_month_labels(months: Iterable[pd.Period])`;
  `GBD_colors` → `GBD_COLORS` (lab callers too); `plotting_utils` header rewritten; `rel_path`
  dropped from the product's two log lines (log the path); `set_ylim_with_padding` inlined into
  `plot_diner_meal_numbers`, its only caller.
- `tests/test_plotting_utils.py`, `tests/report/plots/` follow.

## Verification

`just lint && just check && just test && just test-lab` per PR; golden fixture regenerated and
diffed, with values unchanged in PRs 1–2 and only the recording's shape changed in PR 3.
`uv run ty check python` reports no new `Any` in `report/`. The chart screenshot baselines
(`chart-screenshots.md`) are unaffected: no figure's content changes.
