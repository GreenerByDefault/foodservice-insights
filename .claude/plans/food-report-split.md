# Food report split

## Context

`run_food_report` (`report/pipeline.py`) was written for a data scientist running one client at
a time. It reads a CSV, finds `client_metadata.json` beside it, names its outputs after the
file's stem, and writes a seven-part bundle: the PDF, the client workbook, a QA workbook, a
300-dpi PNG of every chart, a manifest, a run log, and a write-back into the metadata.
`analyze()` needs two of those files. To get them it writes its DataFrame to CSV, fakes the
metadata, and throws the rest away in `work_directory`.

The split: the product keeps an in-memory core that turns categorized rows into a report and
writes the two deliverables, and the lab owns the file-reading wrapper and the rest of the
bundle. It is the boundary `entree-detection-to-lab.md` draws for `categorize_file`, so once
both land the product exposes `categorize_products` and `build_food_report`, and the lab owns
every file wrapper.

Nothing outside tests reads the graphs, QA workbook, manifest, log or metadata write-back; the
step 2 runscript only prints their paths. They are for people, and the people are in the lab.

Measured on synthetic procurement data, one run per size on a loaded laptop, so read the
proportions rather than the seconds:

| | 5k rows, 400 products | 30k rows, 2k products |
| --- | --- | --- |
| Whole report | 6.1 s | 18.5 s |
| QA workbook | 1.1 s | 10.6 s |
| PNG export | 2.2 s | 2.2 s |
| QA diagnostic sheets | 0.1 s | 1.1 s |

The web app needs none of the last three. The QA workbook is the one that grows: it writes every
raw row through openpyxl, and the upload cap allows a few hundred thousand. End to end, an
uncached run is still dominated by LLM calls, which is `categorization-pipeline.md`'s concurrency
PR, not this one.

## Decisions

- **Four product functions replace `run_food_report`**, in `gbd_foodservice_insights.report`:
  - `build_food_report(rows, *, diner_meal_mapping, mode, region, diner_or_meal, top_n_drivers,
    pdf_extracted=False, missing_data_policy="hard_fail", report_progress) -> FoodReport` runs
    every stage from ingestion through diagnostics, in memory: no files, no log handlers.
    `FoodReport` is a frozen dataclass of the normalized rows, the aggregation tables, the
    emissions summary, the plant splits, the findings and the summary stats. Its parameters are
    `Literal`s; turning folder text like `"sales-serving data"` into a mode is the lab's job.
  - `build_report_charts(report) -> ReportCharts`: the figures, plus the findings `_safe_plot`
    adds.
  - `write_report_pdf(report, charts, path, *, client_name, baseline_pilot,
    show_quality_successes)`. The PDF-table formatters and the executive-narrative payload move
    from `pipeline.py` into `pdf.py` with it. It still closes every figure, error or not
    (#331), so `ReportCharts` is single-use and the lab exports its PNGs first, as it does today.
  - `write_client_workbook(report, path)`.
- **Charts are their own step, not part of `FoodReport`**, so a notebook, a unit test or a future
  result-metadata field that only wants numbers never renders thirty-odd figures. The cost is
  that plot findings arrive late: the quality status and summary, the "Data Quality Status"
  stat and the narrative's status are computed from `report.findings + charts.findings` where
  they are used. *Rejected: figures inside `FoodReport`, because every numbers-only caller would
  render them, and the report would outlive the figures the PDF closes.*
- **The product keeps what `analyze()` reaches, and the rest of the bundle moves to the lab**:
  `artifacts.py`, `run_logging.py`, `build_qa_excel_report`, `_collect_diagnostic_export_sheets`
  and the helpers only they reach (`findings_to_frame`, `missingness_summary_frame`,
  `diagnostics.summarise_numeric_columns`), `export_report_plots`,
  `load_diner_meal_mapping_from_json`, and the cwd `report_input_file` fallback. If charts
  return to the result page (REQUIREMENTS.md § Result page), exporting them is a new product
  function at web resolution, not this one.
- **`missing_data_policy` stays, `warn_continue` included**, with its empty-aggregation and
  placeholder-chart paths: data scientists may run it to get a bundle out of broken data. The
  product always passes `hard_fail`.
- **The lab keeps the name.** `gbd_foodservice_insights_lab.food_report.run_food_report` keeps
  today's keyword arguments and result dict, and writes the same bundle by composing the four
  functions. Only the import path changes; a shim is impossible, since the product may not
  import the lab.
- **The step 2 runscript's `--input` and `--diner-meals` are an interface.** Every client
  folder's copy of `1.5. Clean Units Runscript.py` launches the template's step 2 with them
  (`get_customer_template_dir()`), and those copies live in gitignored `client_work/`, out of
  our reach.

## PR 1: split `run_food_report` (prefactor, product only)

- Extract the four functions. `run_food_report` becomes their composition plus the bundle
  extras, with the same signature, the same files and the same result dict.
- Delete the two compatibility wrappers at the bottom of `pipeline.py`; nothing calls them.
- Check before relying on it: plot findings join the list after the diagnostics and before the
  quality summary and the "Data Quality Status" stat are computed. Keep that order, because the
  PDF shows the first 20 non-success findings in the order they were collected.

**Testing:**

- **First commit, before touching any code: a golden test through `analyze()`**, the one path
  that survives every PR in this plan.
  - Input: `insights/tests/data/aggregated_baseline.csv` reshaped to `product,date,weight` with
    `testing.input_csv_text`, and its categories written to the `cache_path` fixture so
    `KeywordLlmClient` sees no calls.
  - Wrap `pdf.build_pdf_report` to record what it is handed — title info, summary stats,
    narrative, tables, findings and chart titles — and read back every client-workbook sheet.
    Compare both against a committed JSON fixture, which `UPDATE_GOLDEN=1` rewrites. Not the
    PDF's bytes or text: the title page is dated and the fonts vary by machine.
  - It has to pass unchanged through PRs 1–3.
- The `run_food_report` tests in `test_outputs.py`, `test_quality_contract.py` and
  `test_integration_food_report.py` pass unchanged: the second characterization.
- New unit tests of `build_food_report` on inline frames, asserting `FoodReport` fields with
  `assert_frame_equal` and writing no files: the `hard_fail` raise, the row-count-drift finding
  in the emissions stage, the month-alignment findings, `warn_continue`'s empty aggregation, and
  serving mode.

## PR 2: `analyze()` uses the core directly

- `analyze()` calls `build_food_report` on `df_final` (with `weight` renamed to `kilos_total`)
  and writes `report.pdf` and `report.xlsx` straight into `output_directory`: no CSV round trip,
  no `client_metadata.json`, no `_move`. `work_directory` goes unused and stays on the seam,
  since the run-directory layout is contract.
- The behaviour changes, all intended:
  - No graphs, QA workbook, manifest or log are written.
  - Progress stages drop from 15 to 11.
  - A product named `NA`, `null` or `None` no longer turns into NaN on the `read_csv` round
    trip and hard-fails the run.
  - `run_logging`'s bump of the package logger to INFO no longer sends INFO lines to the
    child's stderr.
- Check before relying on it: `parse_and_validate_date_column` now sees `datetime64` rather than
  ISO strings. Its docstring says it handles native datetimes; the golden test proves it.
- Put the `hard_fail` rationale on the `build_food_report` call in `analyze()`, since the port
  plan that held it is gone: past `read_input_csv` and `apps/web`'s month-coverage check, an error
  finding can only be our bug, so it lands as `unknown` rather than shipping a report with sheets
  silently missing. *Rejected: `warn_continue`* — a rejected `monthly_counts` shipped a report
  with no per-diner figures and no error. (`report-correctness.md` is what makes that sentence
  true: today two data-driven checks can still raise under `hard_fail`.)

**Testing:**

- The golden test passes unchanged: the same deliverable, from a different path.
- `FakeReport` becomes a fake `build_food_report` that records the DataFrame and kwargs, so
  `test_analysis.py` asserts the frame with `assert_frame_equal` instead of reading a CSV. The
  `client_metadata.json` assertions go, and the title moves to what `write_report_pdf` is
  handed.
- `test_analyze_writes_a_real_report_end_to_end`: `+ 15` becomes `+ 11`.
- A regression test for a product named `NA`.
- The PR body carries before and after timings on a 30k-row synthetic input.

## PR 3: move the bundle to the lab

- Move `run_food_report` and the bundle-only code into `gbd_foodservice_insights_lab/food_report/`.
- Point `2. Produce Food Report.py` and `notebook_runscript_setup.py` (it calls
  `default_report_output_dir`) at it. Delete the runscript's own copy of the
  `report_input_file` fallback; the wrapper already has one.
- Docs: the `artifacts.py` and `run_logging.py` rows of `insights/README.md`, and the step 2 row
  of the lab README.

**Testing:**

- These move to `python/lab/tests/` with their assertions unchanged: the `run_food_report` tests
  in `test_outputs.py` and `test_quality_contract.py`, `test_integration_food_report.py`,
  `test_run_logging.py`, the QA-workbook test and the `summarise_numeric_columns` tests. An
  unchanged assertion is how the move shows it changed no behaviour. `just test` loses its
  slowest report runs.
- New: a runscript test on `test_runscript.py`'s importlib pattern, pinning `--input X
  --diner-meals Y` to `run_food_report(input_file=X, diner_meal_file=Y)`, since existing client
  folders depend on it.

## PR 4: step 1.5 calls the report in-process (lab only)

- The last cell of `1.5. Clean Units Runscript.py` calls
  `run_food_report(input_file=output_file, diner_meal_mapping=diners_map)` and prints the
  result. The temp `_diner_meals_from_notebook.json` and the subprocess go. Existing client
  copies keep launching the CLI, which still works.
- Lab README: after editing lab code, restart the kernel or use `%autoreload`, since the kernel
  holds whatever it imported.

## Verification

- Every PR: `just lint && just check && just test`, plus `just test-lab` for PRs 1, 3 and 4.
- PRs 1 and 2 change what `analyze()` runs: also `pnpm test:system`, which runs a real report
  through both images on `mock-llm`.
- PR 2: one real run through `pnpm dev`, with its PDF and workbook compared side by side against
  a run of the same upload from `main`.
- PRs 3 and 4: run steps 1.5 → 2 on `lab/test_data` in a scratch client folder, and diff the
  client workbook against a run from `main`.

## Risks

- **The golden test pins today's numbers, bugs included.** The `monthly_emissions` merge in
  `pipeline.py` copies each month's total onto every category row, inflating "Carbon Emissions
  Over Time" and the workbook's Monthly by Category emissions by the number of categories. Its
  fix regenerates the golden, and the fixture diff is the review.
- **Near-duplicate product names are O(n²) in unique products.** The check runs twice today and
  once after PR 2, and for web runs it only ever yields `info`. Measure it at large product
  counts before skipping it, which would be a behaviour change.
- **Conflicts.** `categorization-cache.md` PR 5 and `entree-detection-to-lab.md` PR 1 also edit
  `analyze()`; whichever lands second rebases.
