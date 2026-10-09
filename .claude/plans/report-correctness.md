# Report correctness

## Context

The product's report is `analyze()` → `build_food_report` → `build_report_charts` →
`write_report_pdf` and `write_client_workbook` (`report/`); the lab's `run_food_report` wraps
the same core. An audit in September 2026 ran that path with `analyze()`'s arguments on inputs
`apps/web` accepts and read every PDF page and workbook sheet; every fact below was reproduced
again on 27 September against `main`, through `analyze()` with `KeywordLlmClient` on inline
frames. The deliverable aborts on ordinary data, carries wrong numbers, and says things the data
does not support. `tests/test_analysis.py::test_analyze_golden_deliverables` pins today's
output: most PRs here regenerate it with `UPDATE_GOLDEN=1`, and the fixture diff is the review.

Other plans own neighbouring problems and are referenced where the sequencing matters:
`categorization-cache.md` PR 5 (what reaches the report from the cache),
`categorization-pipeline.md` (what the model may answer), `report-typed-data.md` (typed inputs
at the report boundary, the `Finding` type).

**Aborts.** Each reaches the user as "not your file, retry", and the retry fails identically,
because `raise_on_error_findings` raises `QualityCheckError`, a bare `ValueError`, which
`worker_child/failures.py` classifies `unknown`.

- `detect_exact_duplicate_rows` (`checks.py`) files an `error` when rows identical on
  `(date, product, category, weight)` exceed 2% of the file (`diagnostic_thresholds.yaml`
  `error_share_threshold`); three identical lines in a 38-row file abort the run. Two cases of
  one item on one invoice is ordinary procurement data, and `apps/web` does not dedupe.
- `check_diner_meal_reasonableness` files an `error` when two or more months' counts fall
  outside 0.5× to 2× the median (`error_if_flagged_months: 2`). Two summer months at 30% of
  term time abort a twelve-month upload over numbers the user typed and the web validated.

**Wrong numbers.**

- The cache holds a handful of typo categories (`Plant-Based Butter`, `Mlik`, `Stone Fruit`)
  that have no factor, so their rows yield `NaN` emissions filed as `warning` findings: the
  kilos count toward weights and the plant share and vanish from every CO2e figure.
  `categorization-cache.md` PR 5 drops them before they reach the report.

**Silent failures.**

- A plant/animal split or plant-protein share failure is logged and the page and narrative
  sentence are dropped; a chart failure prints the Python exception on a placeholder page and
  files a `warning` (`_safe_plot`, `report/plots/report.py`). Neither can fail a run.
- `build_food_report` catches an exception from emissions, the emissions summary or diagnostics,
  files it as an `error` finding and keeps going; the final `raise_on_error_findings` then raises
  without the cause, so the traceback is lost, and later stages run on the broken frame: an
  emissions crash also files a misleading `aggregation_failed: 'emissions_kg_co2e'`. These blocks
  existed so `warn_continue` could keep going; that policy is gone (#352), and date, month,
  mapping and aggregation failures already raise `from exc` on the spot.

**Noise and cost** (measured 27 September; proportions, not seconds).

- `find_close_product_pairs` is O(n²) in unique products: 0.5 s at 2k products, 3 s at 5k, so
  roughly 50 s at the 20k a 500,000-row upload could carry. On the product path its finding is
  `info` on tabular data, which no customer sees; the lab runs it a second time for
  the QA workbook.
- `ensure_month_year_column` (`report/utils.py`) re-parses every row through `pd.Period(str(v))`
  when the column is already `period[M]`, and three checks call it on a copy of the whole frame:
  about a third of what the diagnostics cost.
- Thirteen seaborn palette warnings per run from `create_horizontal_percentage_barplot`, and
  nine "More than 20 figures have been opened" warnings while the PDF's text pages are drawn.
- `.claude/rules/python.md` says datasets rarely exceed thousands of rows; `apps/web`'s
  `MAX_DATA_ROWS` is 500,000.

## Decisions

- **Behavioural changes to ported code are each their own PR**, so a fixture diff reviews one
  thing. Each PR below says why it is worth landing on its own.
- **No data-driven check may abort a product run.** An `error` finding is for our bugs (a
  missing column, row drift, a stage raising, a category we failed to give a factor), which
  correctly land as `unknown` with a traceback. The two escalations become warnings in
  `diagnostic_thresholds.yaml`, for the lab too; after that, every `error` a diagnostic can file
  is unreachable from customer data on the product path. *Rejected: a product-only threshold
  profile* — two vocabularies for one check. *Rejected: mapping the `ValueError` to
  `UnusableDataError`* — duplicates and unusual headcounts are not unusable data, and "contact
  GBD" would be the wrong advice.
- **A zero-weight line is data; a file that weighs nothing is not.** A single 0 is ordinary
  (short-shipped or not-yet-weighed lines) and gets a `per_product_weight_bounds` warning. A file
  whose every weight is 0 is refused at upload (`normalize.ts`, `all-weights-zero`), and
  `build_food_report` raises `UnusableDataError` when every row it receives is 0, which also
  catches an upload whose only weight was on uncategorized products. That is the one data-driven
  abort, and it is an `UnusableDataError`, not an `error` finding: there is no report to write.
- **`info` never changes a report's status or wording, and the customer PDF lists warnings and
  errors only.** `quality_status_from_findings` ignores `info`, and with
  `show_quality_successes` off (`analyze()`) the quality page neither lists nor counts notes, so
  demoting a finding to `info` is how a later PR takes it off the customer's page. `info`
  findings stay for the lab's QA workbook and its PDF, which shows everything. *Rejected: deleting `info`
  findings* — the lab reads them. **Open:** which warnings a customer should see at all (month
  volatility, partial first or last month, outlier line items, duplicates) is GBD's call; this
  plan only stops `info` leaking.
- **Every category in `GBD_categories.yaml` has a factor in every region**, pinned by
  `test_emissions.py::test_every_category_has_an_emission_factor`. `Unspecified non dairy milk`
  carries the mean of the four named plant milks, the method GBD used from its first commit
  until the November 2025 move to per-region factors dropped it to `null`. Once
  `categorization-cache.md` PR 5 also filters the cache, a row without a factor can only mean
  our bug, and `unmatched_emission_factors` becomes an `error`. *Rejected: deleting the
  category* — it removes something GBD built on purpose, where restoring the factor undoes an
  accidental regression and needs no one's sign-off. *Rejected: excluding factorless categories
  from the model's list* — a second notion of "valid category". The match prompt's rule sending
  unnamed non-dairy milk to Oat Milk has contradicted the category since April 2025, and no
  cache row uses it; which one GBD wants is their call, and either way the number is sane.
- **Drivers stay ranked by kilos; the prose says so.** The Decision KPIs page is where carbon
  ranking lives. **Open:** GBD may want procurement drivers ranked by CO2e instead. Also for
  GBD: the Animal Emissions Intensity table lists animal categories with poultry and fish at the
  bottom by CO2e per kg, which reads as the beef-to-chicken nudge REQUIREMENTS.md § Processing
  forbids.
- **A split, share, chart or stage failure fails the run, with its own traceback.** `_safe_plot`
  goes, placeholder page and input checks alike, and so do the emissions, emissions-summary and
  diagnostics `except` blocks. `ReportCharts` then carries no findings.
- **Fixed page sizes.** Every page is US Letter: `LETTER_PORTRAIT` for text and
  `LETTER_LANDSCAPE` for charts and tables (the Category Template needs the width), both in
  `plotting_utils.py`, and `test_analysis.py` reads every page's size out of an `analyze()` PDF
  with a 200-character product name, so a new page in another size fails there. Labels never grow
  the page: `wrap_labels` ends in an ellipsis past three lines, since the workbook keeps every
  full product name. `create_horizontal_percentage_barplot` keys its bars on the full label and
  shortens only the tick text, because seaborn averages rows that share a label into one bar;
  any new drivers drawer must keep that. A two-panel trend page stacks its panels, which share
  the month axis, rather than setting them side by side as tall, narrow charts that steepen every
  swing. The Category Template already fits by measurement: `create_table_page` sizes each column to its widest
  rendered text and splits months across pages ("Category Template (1 of 2)") against
  `_table_width_in(fig_size)`, which derives the table's width from the page size and the
  `figure.subplot` rcParams. A change to the page size carries through; a change to where table
  axes sit on the page must go through `_table_width_in` too, or the template clips again.
- **Every category keeps its drivers, four to a page.** `plot_category_drivers_pages`
  (`report/plots/figures.py`) lays `draw_category_drivers` panels (`report/plots/panels.py`) in
  a 2 × 2 grid on a landscape page, alphabetically, so 26 categories take 7 pages, not 26.
  *Rejected: only the top categories* — a customer looking for one category's drivers would
  find nothing. **Open:** ordering the panels by emissions, highest first, to match the emissions
  page. Alphabetical is easier to look a category up in, and nothing yet says a reader wants the
  other; if we do, it is its own PR, and a serving report, which has no emissions, needs an
  order of its own.

## PR 1 — the two escalations become warnings

- `diagnostic_thresholds.yaml`: `exact_duplicate_rows.error_share_threshold` and
  `diner_meal_count_reasonableness.error_if_flagged_months` go; `_duplicate_row_status` and
  `check_diner_meal_reasonableness` lose their `error` branch. The `test_checks.py` tests
  that assert `error` or read those two keys flip.
- Tests: 8% duplicate lines and two outlier months succeed through `analyze()` with a `warning`
  finding each; a missing required column still raises.
- Worth it: the only aborts a real upload is likely to hit, and the lab has no override since
  `warn_continue` went.

## PR 2 — fail loudly

- The emissions, emissions-summary and diagnostics `except` blocks in `build_food_report` go,
  with `raise_on_error_findings` after each stage's checks so row drift still aborts there;
  the split and share `try` blocks go; `_safe_plot` and the category-driver `try` go, and
  `ReportCharts.findings` with them. `unmatched_emission_factors` becomes an `error`, which
  makes the `emissions_missing_*` and `monthly_emissions_missing` findings and their tests dead.
- Tests: each stage monkeypatched to raise surfaces that exception, not `QualityCheckError`; a
  category without a factor aborts at the emissions stage. The lab's failure manifest records
  no findings for a crash, as today; its log keeps the traceback.
- Lands after `categorization-cache.md` PR 5, or a cache typo aborts real runs.
- Worth it: today a stage crash loses its traceback and a chart crash ships a page of Python.

## PR 3 — noise and cost

- `find_close_product_pairs` skips pairs whose lengths differ by more than the cutoff and passes
  `score_cutoff` to `distance`; `ensure_month_year_column` returns early on a monthly
  `PeriodDtype`; the barplot palette matches its hue count; `python.md`'s sentence about dataset
  size names `MAX_DATA_ROWS`.
- Tests: pair results unchanged on a fixture with near pairs; timings at 30k rows / 2k products
  and at the cap in the PR body.
- Worth it only if the timings at the cap say so; otherwise land the warning fix alone.

Testing, generally: new tests use the product arguments and assert what `build_pdf_report` is
handed and what the sheets contain, not that files exist.

## Verification

- Every PR: `just lint && just check && just test`; `just test-lab` for PRs 1, 2 and 3, which change what the lab's QA
  workbook and manifest say; `pnpm test:system` for any PR that changes what `analyze()` writes.

## Risks

- The golden test pins numbers, so most PRs here regenerate it; review the fixture diff rather
  than accept it.
- Threshold, status and `info` changes alter the lab's QA output; tell the data scientists.
- Until PR 1 lands, the lab has no way past a duplicate-lines or diner-count-outlier false
  positive. Land it first.
- No PR here waits on GBD; the null-emission-factor restoration is decided in this plan.
