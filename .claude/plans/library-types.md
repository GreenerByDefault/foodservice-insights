# Library types

## Context

The recent typed-rows and `Finding` TypedDict work (#459, #462, #464) paid for itself in bugs
found (#465), `categories.py` now loads `GBD_categories.yaml` once into frozen `Category`
records, and `run_aggregation_pipeline` returns a frozen `Aggregation` (in
`report/aggregation.py`) instead of a string-keyed dict. One stringly-typed shape remains:

- **`pdf.build_pdf_report`** takes `title_info: dict[str, str]`, `narrative: dict[str, Any]`
  with nine documented keys, and `tables: dict[str, DataFrame]` that `create_table_page`
  dispatches on title strings ("Decision KPIs", "Substitution Scenarios", "Category Template").
  `write_report_pdf` is its only product caller; the golden test records its kwargs.
- The decision-KPI page still round-trips through a DataFrame: `write_report_pdf` passes
  `ProcurementAggregation.animal_emissions_concentration` (an `AnimalEmissionsConcentration`) to
  `_format_decision_kpis_for_pdf`, which builds a one-row frame with display column names
  ("Share of Animal Emissions (%)", "Top Animal Products" joined by `" | "`) only for
  `create_decision_kpis_page` to read them back and split the product list to write one
  sentence. That frame exists solely to keep `build_pdf_report`'s recorded `tables` — and so the
  golden fixture — unchanged until this PR.

## Decisions

- **`Aggregation.procurement` is a `ProcurementAggregation`, or `None` exactly for a serving
  report.** Within it, each table is `None` only when the data has nothing to show (no animal
  rows, no ruminant or cow's-milk rows), so the two absences never share one `None`. A page or
  sheet is included exactly when its field is not `None`; nothing downstream checks `mode` or
  `.empty`. *Rejected: flat `None`-able fields on `Aggregation`, which conflated a serving report
  with an empty table; a `ServingAggregation | ProcurementAggregation` union, which would repeat
  the five shared tables or need inheritance.*
- **`AnimalEmissionsConcentration` holds unrounded floats** — `top_products` (largest emitter
  first), `top_products_kg_co2e`, `total_animal_kg_co2e` — with `share_pct` a property, so it
  cannot disagree with its parts. Each renderer rounds for itself: the workbook's three
  procurement sheets, including the one-row "Decision KPIs", come from `excel.procurement_sheets`
  (public, since the lab's QA workbook splices them in too); the PDF rounds kg CO₂e to whole numbers and the share to
  one decimal.
- **`write_report_pdf` is the PDF builder.** `build_pdf_report`'s dict parameters become an
  `ExecutiveNarrative` dataclass and explicit per-table page functions chosen in
  `write_report_pdf`; the title-string dispatch in `create_table_page` goes. The golden test
  records the typed inputs (`report` fields, the narrative, chart titles) instead of
  `build_pdf_report`'s kwargs.

## PR 1 — Typed PDF assembly

- `pdf.py`: `ExecutiveNarrative` dataclass built by `_executive_narrative`; `write_report_pdf`
  assembles the pages itself — title, executive summary (narrative, or the key-value page for a
  serving report), how-to-read, charts, `create_category_template_pages`,
  `create_animal_intensity_page`, `create_decision_kpis_page(concentration)` (reading
  `top_products` as a tuple, not splitting a joined string), `create_substitution_scenarios_page`,
  about, quality. `build_pdf_report`, `create_table_page`'s title dispatch,
  `_format_decision_kpis_for_pdf` and `title_info` go; `_draw_table_page` stays the shared
  renderer with explicit `font_size`/`row_scale`/`col_widths` arguments.
- `tests/report/test_pdf.py`: the `build_pdf_report` tests call `write_report_pdf` with the
  small `FoodReport` fixtures the `write_report_pdf` tests already use; the golden harness in
  `test_analysis.py` records `report.findings`, `report.summary_stats`, the narrative, the
  formatted tables and chart titles from `write_report_pdf`'s arguments.
- Golden fixture regenerated (its structure changes; values should not).

## Verification

`just lint && just check && just test && just test-lab`; golden fixture regenerated and diffed,
with only the recording's shape changed. `uv run ty check python` reports no new `Any` in
`report/`. The chart screenshot baselines (`chart-screenshots.md`) are unaffected: no figure's
content changes.
