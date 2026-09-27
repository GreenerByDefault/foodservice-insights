# gbd_foodservice_insights

The analysis library the worker ships: it categorizes a foodservice procurement CSV into GBD's
food categories (a historical cache first, then an LLM), computes emissions, and renders the
report — a PDF and a client workbook. [`analysis.py`](gbd_foodservice_insights/analysis.py) is
the one entry point the worker calls; the lab calls the same modules directly.

## Where a report change goes

`report/food_report.py`'s `build_food_report()` computes the report in memory, and
`report/pdf.write_report_pdf()` / `report/excel.write_client_workbook()` write the client-facing
PDF and workbook. The lab's `gbd_foodservice_insights_lab.food_report.pipeline.run_food_report()`
wraps those with file handling and the rest of the bundle (chart PNGs, the QA workbook, the run
manifest, the run log) — see its README. To change:

| What | Where |
| --- | --- |
| PDF text, section wording, page order, quality-summary wording | `report/pdf.py` — `build_pdf_report()` and its `create_*_page()` helpers |
| Which tables the PDF includes | `report/pdf.py` — `write_report_pdf()` |
| How those tables are computed | `report/aggregation.py` |
| Which charts, in what order | `report/plots/report.py` — `generate_all_report_plots()` |
| How a page or panel is drawn | `report/plots/figures.py` (`plot_*`), then `report/plots/panels.py` (`draw_*`) |
| Warnings and diagnostics on the quality pages | `report/diagnostics.py` — `run_all_diagnostics()` |
| Client workbook tabs | `report/excel.py` — `write_client_workbook()` |

`report/pdf.py` is PDF-only. Never edit a generated PDF; change the code and regenerate.
