# Food report split

## Context

`run_food_report` (`report/pipeline.py`) was written for a data scientist running one client at
a time. It reads a CSV, finds `client_metadata.json` beside it, names its outputs after the
file's stem, and writes a seven-part bundle: the PDF, the client workbook, a QA workbook, a
300-dpi PNG of every chart, a manifest, a run log, and a write-back into the metadata.

The in-memory core now exists. `report/food_report.py` holds `build_food_report`, which runs
every stage from ingestion through diagnostics with no files and no log handlers, and
`build_report_charts`. `pdf.write_report_pdf` and `excel.write_client_workbook` write the two
deliverables. `analyze()` calls those four directly on its categorized DataFrame and writes
`report.pdf` and `report.xlsx` straight into `output_directory`, so `work_directory` goes unused
(it stays on the seam because the run-directory layout is contract). `run_food_report` composes
the same four, then writes the rest of the bundle itself; nothing in the product calls it any
more, only its own tests and the lab's step 2 runscript.

`tests/test_analysis.py::test_analyze_golden_deliverables` goes through `analyze()`, the one path
that survives every PR here. It records what `pdf.build_pdf_report` is handed (title info,
summary stats, narrative, tables, findings, chart titles) and every client-workbook sheet, and
compares them with `tests/data/analysis_golden.json`; `UPDATE_GOLDEN=1` rewrites the fixture. It
must pass unchanged through both remaining PRs.

The split: the product keeps an in-memory core that turns categorized rows into a report and
writes the two deliverables, and the lab owns the file-reading wrapper and the rest of the
bundle. It is the boundary `entree-detection-to-lab.md` draws for `categorize_file`, so once
both land the product exposes `categorize_products` and `build_food_report`, and the lab owns
every file wrapper.

Nothing outside tests reads the graphs, QA workbook, manifest, log or metadata write-back; the
step 2 runscript only prints their paths. They are for people, and the people are in the lab.

What moving `analyze()` off the bundle bought, on synthetic procurement data (30k rows, 2k
products, offline LLM): the report stage went from about 10.3 s to 3.7 s, mostly the PNG export
and the QA workbook, which writes every raw row through openpyxl and so grows with the upload.
Those slow runs now happen only in `run_food_report`'s own tests, so moving them to the lab
makes `just test` faster.

## Decisions

- **Four product functions replace `run_food_report`**, each in the module under
  `gbd_foodservice_insights.report` that owns its concern. Nothing is re-exported from the
  package `__init__`, because that would load pyplot for anyone importing `report.schema`.
  - `food_report.build_food_report(rows, *, diner_meal_mapping, mode, region, diner_or_meal,
    top_n_drivers, pdf_extracted=None, missing_data_policy="hard_fail", report_progress) ->
    FoodReport`. `diner_meal_mapping` is the raw month → count `Mapping`, normalized inside, so a
    bad mapping is a finding at the same stage as before. `mode`, `region` and `diner_or_meal`
    are the `ReportMode`, `Region` and `DinerOrMeal` `Literal`s from `schema.py`; turning folder
    text like `"sales-serving data"` into a mode is the lab's job. `pdf_extracted` stays
    `bool | None`, because diagnostics record it in finding metadata and `False` would change
    the golden. `FoodReport` is frozen. It holds the normalized rows, the aggregation dict, the
    emissions summary, the plant splits, `diagnostics`, `findings` and `summary_stats`, which
    leaves out "Data Quality Status". It also has `metric_total`, `total_diner_meals` and
    `procurement_table(name)`, which returns the procurement-only tables or `None`.
  - `food_report.build_report_charts(report) -> ReportCharts`: the figures, plus the findings
    `_safe_plot` adds.
  - `pdf.write_report_pdf(report, charts, path, *, client_name, baseline_pilot,
    show_quality_successes) -> None`. The PDF-table formatters and the executive narrative live
    in `pdf.py` beside it. It still closes every figure, error or not (#331), so `ReportCharts`
    is single-use and the lab exports its PNGs first.
  - `excel.write_client_workbook(report, path) -> None`.
- **Under `hard_fail`, an error finding raises `quality.QualityPolicyError`**, a `ValueError`
  whose `findings` is everything collected before the abort. That is how the lab's failure
  manifest still gets a quality summary, since `build_food_report` returns nothing when it
  raises.
- **Progress is split between the stages.** `build_food_report` reports its 8 stages. The
  caller reports charts, the PDF and the workbook, since those calls are separate: `analyze()`
  reports one before each, for 11, and `run_food_report` reports its bundle stages on top, for
  15.
- **Charts are their own step, not part of `FoodReport`**, so a notebook, a unit test or a future
  result-metadata field that only wants numbers never renders thirty-odd figures. The cost is
  that plot findings arrive late: the quality status and summary, the "Data Quality Status"
  stat and the narrative's status are computed from `report.findings + charts.findings` where
  they are used. *Rejected: figures inside `FoodReport`, because every numbers-only caller would
  render them, and the report would outlive the figures the PDF closes.*
- **The product keeps what `analyze()` reaches, and the rest of the bundle moves to the lab**:
  all of `pipeline.py` (`run_food_report`, `_write_qa_workbook`,
  `_collect_diagnostic_export_sheets`, and `_resolve_input_file`, the cwd `report_input_file`
  fallback), `artifacts.py`, `run_logging.py`, `excel.build_qa_excel_report`, the helpers only
  they reach (`quality.findings_to_frame`, `quality.missingness_summary_frame`,
  `diagnostics.summarise_numeric_columns`), `plots.export_report_plots`, and
  `utils.load_diner_meal_mapping_from_json`. If charts
  return to the result page (REQUIREMENTS.md § Result page), exporting them is a new product
  function at web resolution, not this one.
- **`missing_data_policy` stays, `warn_continue` included**, with its empty-aggregation and
  placeholder-chart paths: data scientists may run it to get a bundle out of broken data. The
  product always passes `hard_fail`.
- **The lab keeps the name.** `gbd_foodservice_insights_lab.food_report.run_food_report` keeps
  today's keyword arguments and result dict, and writes the same bundle. Only the import path
  changes; a shim is impossible, since the product may not import the lab. It loads
  `diner_meal_file` before calling the core, so a missing or unreadable file raises under either
  policy rather than becoming a `warn_continue` finding.
- **The step 2 runscript's `--input` and `--diner-meals` are an interface.** Every client
  folder's copy of `1.5. Clean Units Runscript.py` launches the template's step 2 with them
  (`get_customer_template_dir()`), and those copies live in gitignored `client_work/`, out of
  our reach.

## PR 1: move the bundle to the lab

- Move `pipeline.py` and the rest of the bundle-only code listed in Decisions into
  `gbd_foodservice_insights_lab/food_report/`.
- Point `2. Produce Food Report.py` and `notebook_runscript_setup.py` (it calls
  `default_report_output_dir`) at it. Delete the runscript's own copy of the
  `report_input_file` fallback; the wrapper already has one.
- Docs: the `artifacts.py` and `run_logging.py` rows of `insights/README.md`, and the step 2 row
  of the lab README.

**Testing:**

- These move to `python/lab/tests/` with their assertions unchanged: the `run_food_report` tests
  in `test_outputs.py` and `test_quality_contract.py`, `test_integration_food_report.py`,
  `test_run_logging.py`, the QA-workbook test and the `summarise_numeric_columns` tests.
  `test_food_report.py` stays: it tests the core. An
  unchanged assertion is how the move shows it changed no behaviour. `just test` loses its
  slowest report runs.
- New: a runscript test on `test_runscript.py`'s importlib pattern, pinning `--input X
  --diner-meals Y` to `run_food_report(input_file=X, diner_meal_file=Y)`, since existing client
  folders depend on it.

## PR 2: step 1.5 calls the report in-process (lab only)

- The last cell of `1.5. Clean Units Runscript.py` calls
  `run_food_report(input_file=output_file, diner_meal_mapping=diners_map)` and prints the
  result. The temp `_diner_meals_from_notebook.json` and the subprocess go. Existing client
  copies keep launching the CLI, which still works.
- Lab README: after editing lab code, restart the kernel or use `%autoreload`, since the kernel
  holds whatever it imported.

## Verification

- Every PR: `just lint && just check && just test && just test-lab`.
- Every PR: run steps 1.5 → 2 on `lab/test_data` in a scratch client folder, and diff the
  client workbook against a run from `main`.

## Risks

- **The golden test pins today's numbers, bugs included.** A fix to a number regenerates it with
  `UPDATE_GOLDEN=1`, and the fixture diff is the review.
- **Near-duplicate product names are O(n²) in unique products.** It runs once per web run (in
  diagnostics) and twice per `run_food_report` run (again for the QA workbook), and for web runs
  it only ever yields `info`. Measure it at large product counts before skipping it, which would
  be a behaviour change.
