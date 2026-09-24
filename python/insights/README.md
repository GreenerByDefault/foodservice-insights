# gbd_foodservice_insights

The analysis library the worker ships: it categorizes a foodservice procurement CSV into GBD's
food categories (a historical cache first, then an LLM), computes emissions, and renders the
report — a PDF and a client workbook. [`analysis.py`](gbd_foodservice_insights/analysis.py) is
the one entry point the worker calls; the lab calls the same modules directly.

## Where a report change goes

`report/pipeline.py`'s `run_food_report()` orchestrates the report. To change:

| What | Where |
| --- | --- |
| PDF text, section wording, page order, quality-summary wording | `report/pdf.py` — `build_pdf_report()` and its `create_*_page()` helpers |
| Which tables the PDF includes | `report/pipeline.py`, the `tables` passed to `build_pdf_report()` |
| How those tables are computed | `report/aggregation.py` |
| Chart content and captions | `report/plots.py` — `generate_all_report_plots()`, then the `plot_*` function |
| Warnings and diagnostics on the quality pages | `report/diagnostics.py` — `run_all_diagnostics()` |
| Client or QA workbook tabs | `report/excel.py` |
| Manifest fields, output filenames, returned artifact paths | `report/artifacts.py` |
| The per-run log file | `report/run_logging.py` |

`report/pdf.py` is PDF-only. Never edit a generated PDF; change the code and regenerate.
