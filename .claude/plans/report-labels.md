# Report labels

## Context

Three sets of names the customer sees in the deliverables are wrong or inconsistent, all pinned
by `tests/data/analysis_golden.json`:

- **Per-head columns ignore the counts basis.** `schema.per_diner_metric_name` hardcodes
  `"… per diner-meal"`, so the client workbook's "Monthly by Product" and "Monthly by Category"
  sheets carry `kilos per diner-meal`, and "Emissions Summary" carries `kg_co2e_per_diner_meal`,
  for a report whose text pages say "meals" (#404 fixed the PDF text only). The web's form offers
  people or meals; the workbook should say which.
- **The milk→oat scenario sits under ruminant column names.** `calculate_category_swap_scenarios`
  names its columns `baseline_ruminant_weight_kg`, `baseline_ruminant_emissions_kg_co2e`,
  `remaining_ruminant_weight_kg` for both swaps, and the "Substitution_Scenarios" sheet shows them
  verbatim (the PDF renames the columns it keeps). Sheet names also mix "Monthly by Product" with
  `Decision_KPIs` and `Substitution_Scenarios`.
- **CO2e vs CO₂e.** `create_executive_summary_page` writes "CO2e" under a comment saying
  Montserrat and Lato lack the subscript-two glyph. They do not: all four packaged files have
  U+2082 (checked with `FT2Font.get_char_index`), and rendering "CO₂e" in each produces no
  missing-glyph warning. Meanwhile the methodology page and `draw_total_emissions`'s y-axis use
  "CO₂e", and the next panel on the same page says "kg CO2e per Diner".

## Decisions

- **Column names follow the basis**: `kilos per diner` / `kilos per meal`,
  `kg_co2e_per_diner` / `kg_co2e_per_meal`. `per_diner_metric_name` takes `diner_or_meal`;
  `run_aggregation_pipeline` and `calculate_emissions_per_diner_meal` receive it from
  `build_food_report`.
- **Scenario columns are source-neutral**: `baseline_source_weight_kg`,
  `baseline_source_emissions_kg_co2e`, `remaining_source_weight_kg`. The `source_categories`
  column already says what the source was.
- **Sheet names use spaces**: "Decision KPIs", "Substitution Scenarios".
- **CO₂e everywhere the PDF renders prose or a label**; workbook column names stay ASCII because
  they are identifiers. The stale font comment goes. *Rejected: CO2e everywhere* — the glyph is
  the standard notation and the fonts carry it.

## PR 1 — Name per-head columns by the counts basis

- `schema.per_diner_metric_name(total_metric, diner_or_meal)`; callers in `aggregation.py`
  (`aggregate_data` / `run_aggregation_pipeline`), `plots/panels.py` and
  `emissions.calculate_emissions_per_diner_meal` pass the report's `diner_or_meal`.
- Tests: `test_aggregation.py` and `test_emissions.py` assert both spellings; golden fixture
  regenerated (its "Diners" run shows `kilos per diner`); `test_analysis.py`'s meals case asserts
  the `kilos per meal` column.
- Lab: `excel.build_qa_excel_report` and `pilot/` read the column by name through
  `per_diner_metric_name`; pass `diner_or_meal` there too.

## PR 2 — Source-neutral scenario columns, spaced sheet names, CO₂e

- `aggregation.calculate_category_swap_scenarios` column renames; `pdf._format_substitution_scenarios_for_pdf`
  keeps its own display names.
- `excel.write_client_workbook` sheet names "Decision KPIs", "Substitution Scenarios"
  (`test_analyze_writes_a_real_report_end_to_end` lists the sheets).
- `pdf.py`: "CO₂e" in the executive summary headline, narrative and methodology; delete the
  font comment. `plots/panels.py` and `plots/figures.py`: "kg CO₂e" in every axis label and
  title that says CO2e. `tests/report/test_pdf.py` narrative assertions follow.
- Golden fixture regenerated; diff is the review.

## Verification

`just lint && just check && just test && just test-lab`; open the regenerated golden diff and
check only the intended names changed. Run an upload on `WORKER_MODE=mock-llm` with the meals
basis and confirm the workbook's per-head column says `meal` and the PDF's emissions page uses
one spelling of CO₂e.
