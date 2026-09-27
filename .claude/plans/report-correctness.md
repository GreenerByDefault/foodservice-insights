# Report correctness

## Context

An audit of the ported report code in September 2026 ran `run_food_report` with `analyze()`'s
exact arguments (procurement, `us`, both count bases) on inputs `apps/web` accepts,
rendered every PDF page, and read back every workbook sheet. The deliverable crashes on ordinary
data, carries wrong numbers, and says things the data does not support. This plan fixes what it
computes. `tests/test_analysis.py::test_analyze_golden_deliverables` pins today's output: every
fix here regenerates the golden with `UPDATE_GOLDEN=1`, and the fixture diff is the review.

Verified facts, each reproduced through `analyze()` or `run_food_report` with product arguments:

**Aborts that reach the user as "not your file, retry", where the retry fails identically**

- One line with weight 0 in a category with no other weight crashes `_safe_percentage` and
  `summarize_animal_emissions_intensity` (`aggregation.py`): the locked pandas is 3.0.6 and the
  code was written on 2, where `replace({0: pd.NA})` kept a float dtype; now it makes an object
  Series and `astype(float)` raises. `read_input_csv` accepts `weight >= 0`.
- `detect_exact_duplicate_rows` (`diagnostics.py`) returns an `error` when duplicate
  `(date, product, category, weight)` lines exceed 2% of rows (`diagnostic_thresholds.yaml`);
  three identical lines in a 36-row file abort the run. Two cases of one item on one invoice is
  ordinary procurement data, and `apps/web` does not dedupe.
- `check_diner_meal_reasonableness` returns an `error` when two or more months' counts fall
  outside 0.5× to 2× the median. Two low summer months abort the run over numbers the user typed.
- All three classify as `unknown` (`worker_child/failures.py`): `raise_on_error_findings` raises
  a bare `ValueError`, and REQUIREMENTS.md § Errors says an unknown failure tells the user it was
  not their file and offers a retry.

**Wrong numbers**

- The per-diner headline, the narrative's per-diner sentence and the Emissions Summary sheet
  divide by the sum of every month in `monthly_counts`; the monthly charts divide month by month.
  A month with a count but no surviving rows (every product in it uncategorized, so
  `merge_categorizations` dropped them) lowers the headline and yields only an `info` finding.
- `Unspecified non dairy milk` has `emission_factor_us: null` in `GBD_categories.yaml`, is in the
  list the model chooses from, and produces `NaN` emissions that the run files as a `warning`:
  its kilos count toward weights and the plant share and vanish from every CO2e figure.
- "Carbon Emissions Over Time" autoscales both y-axes from the data minimum (the kilos page one
  page earlier is zero-based), and `_millions_formatter` rounds ticks to whole thousands, so a
  1,067 to 1,192 kg range prints `1k 1k 1k 1k 1k 1k` and a ±14% swing fills the chart.
- The executive summary rounds to whole tonnes: 2,501 kg is "3 tonnes".
- `calculate_emissions_per_diner_meal` rounds to four decimals, so minor categories at a large
  site show `0.0` in the workbook.
- "How to Read" says the top-product charts show "the largest impact on your overall carbon
  figures"; they rank by kilos. On a realistic run whole milk is first at 34% of kilos and 5% of
  emissions.

**Wrong status and wording**

- `quality_status_from_findings` (`schema.py`) grades `info` as `warning`, and
  `gbd_categories_absent` fires whenever any of the 27 categories is unbought, so every report
  says "Some data-quality notes apply" and its quality page prints the finding verbatim:
  `GBD categories absent from data: ['Almond/Coconut Milk', …]`. A count month with no rows is
  reported twice (`pipeline.py` and `ensure_date_alignment`).
- Meal mode still says "normalising against the number of diners served" and "how many people
  were served", and the workbook columns are `kilos per diner-meal` and `kg_co2e_per_diner_meal`.
- On plant-only data the narrative says "animal products 0%. Animal products carry far higher
  emissions per kilogram, so a small number of categories drive most of the footprint."; a
  single month prints as "Jan 2025 – Jan 2025".
- The title page title-cases the client name (`McDonald's` becomes `Mcdonald'S`) and does not
  wrap it; the executive summary uses the raw name. "Kg CO2e Kg" is a column header
  (`test_outputs.py` pins it); two of four methodology headings are not bold.

**Layout**

- The Category Template table gives every column the same width, so six months clip category
  names to "Beef and Buffalo" and twelve to "Beef and".
- Each figure's size becomes its page's size, so one PDF has a dozen paper sizes, and label
  wrapping grows the page: a 200-character product name made a 10 × 18.5 in page.
- One near-empty page per category, alphabetical, up to 27 on real data.

**Silent failures**

- A plant/animal split or plant-protein share failure is logged and the page and narrative
  sentence are dropped; a chart failure prints the Python exception on a placeholder page and
  files a `warning`. Neither can fail a run.
- `build_food_report` catches an exception from emissions, the emissions summary or diagnostics,
  files it as an `error` finding and keeps going; the final checkpoint then raises
  `QualityCheckError` with only the message string, so the traceback is lost, and later stages
  run on the broken frame: an emissions crash also files a misleading
  `aggregation_failed: 'emissions_kg_co2e'`. These blocks existed so `warn_continue` could keep
  going; that policy is gone, and date, month, mapping and aggregation failures already raise
  `from exc` on the spot.
- `compare_missing_snapshots` (`quality.py`) counts a column that did not exist before the stage
  as "newly introduced missing values", so the emissions stage files two findings per null factor.

**Noise and cost** (30k rows, 2k products; proportions, not seconds)

- `find_close_product_pairs` is O(n²) in unique products, runs twice per report, and compares raw
  strings, so `Tomato 1kg` and `Tomato 2kg` are a pair: 1 s at 2k products, ~26 s at 10k, for a
  finding that is `info` on tabular data. `score_cutoff` plus a length prefilter measured 3.5×.
- `ensure_month_year_column` (`report/utils.py`) re-parses every row through `pd.Period(str(v))`
  when the column is already `period[M]`, and three checks call it: ~0.75 s of the 1.2 s the
  diagnostics take.
- Thirteen seaborn palette warnings per run from `create_horizontal_percentage_barplot`.
- `.claude/rules/python.md` says datasets rarely exceed thousands of rows; `apps/web`'s
  `MAX_DATA_ROWS` is 500,000. Measure at the cap before dismissing any of the above.

## Decisions

- **Behavioural changes to ported code are each their own PR**, so a fixture diff reviews one
  thing.
- **No data-driven check may abort a product run.** An `error` finding is for our bugs (a
  missing column, row drift, a stage raising), which correctly land as `unknown` with a
  traceback. The two escalations become warnings in `diagnostic_thresholds.yaml`, for the lab
  too. *Rejected: a product-only threshold profile* — two vocabularies for one check.
  *Rejected: mapping the `ValueError` to `UnusableDataError`* — duplicates and unusual headcounts
  are not unusable data, and "contact GBD" would be the wrong advice.
- **Per-diner denominators sum only months present in the data**, computed once. A count for a
  month with no rows stays an `info` finding.
- **A null emission factor never ships as NaN.** Interim: categorization's category list excludes
  categories without a factor for the region, and a categorized row that still meets one is an
  `error` finding. **Open:** GBD decides whether `Unspecified non dairy milk` gets a factor or
  leaves the YAML; the match prompt already routes unnamed non-dairy milks to oat milk.
- **`info` never changes a report's status or wording, and the customer PDF lists warnings and
  errors only.** `info` findings stay for the QA workbook. *Rejected: deleting `info` findings* —
  the lab reads them.
- **Drivers stay ranked by kilos; the prose says so.** The Decision KPIs page is where carbon
  ranking lives. **Open:** GBD may want procurement drivers ranked by CO2e instead; that is a
  product decision. Also for GBD: the Animal Emissions Intensity table lists animal categories by
  CO2e per kg with poultry and fish at the bottom, which reads as the beef-to-chicken nudge
  REQUIREMENTS.md § Processing forbids.
- **Fixed page sizes.** Every page is US Letter, portrait for text and tables and landscape for
  wide charts, and wrapped labels shrink the font or truncate rather than grow the page. Category
  pages are ordered by emissions and grouped several to a page. **Open:** GBD says how many
  category pages it wants at all.
- **Every sentence the narrative prints is conditional on the data it describes**: no animal
  sentence at 0% animal, one month prints once, tonnes carry one decimal below 10 t.
- **A split, share, chart or stage failure fails the run, with its own traceback.** `_safe_plot`'s
  placeholder page goes, and the emissions, emissions-summary and diagnostics `except` blocks go
  rather than filing a finding.

## PRs

Roughly in order of user impact. Each is small.

1. **Zero-weight categories.** `_safe_percentage` and the intensity table mask a zero denominator
   to NaN. Tests: a zero-total category among normal rows and an all-zero file, both through
   `run_food_report`, both succeed.
2. **Thresholds.** The two escalations become warnings. Tests: 15% duplicate
   lines and two outlier months succeed with a `warning` finding; a missing column still raises.
3. **Per-diner denominator.** One helper for the total; `kg_co2e_per_diner_meal` unrounded, rounded
   only where displayed. Tests: an extra count month leaves the headline, the narrative and the
   sheet unchanged.
4. **Null emission factor**, per the decision. Tests: the category is absent from the list the
   model sees; a cache row in it is an error finding.
5. **Status and the quality page.** `quality_status_from_findings` ignores `info`; the caveat and
   the findings list are warning-and-error only; the pipeline's duplicate month-alignment finding
   goes; `compare_missing_snapshots` ignores new columns. Tests: a clean run and an `info`-only
   run hand the PDF status `pass` and no caveat; a warning run gets both.
6. **Emissions-over-time axes.** Zero-based `y_max`; the formatter prints a decimal below its
   unit. Tests assert the bottom limit and that tick labels are distinct.
7. **Wording.** Meal-mode strings and column names (`per_diner_metric_name` takes the basis),
   tonnes formatting, conditional narrative sentences, the single-month period, the column
   header, bold headings, the title page (no `.title()`, wrapped), the driver sentence. Split
   into more PRs if the golden diff gets noisy. Tests read what `build_pdf_report` is handed and
   the sheet column names, in both count bases.
8. **Pages.** Fixed sizes, capped label wrapping, a measured label column and rotated or paged
   month headers in the Category Template, category pages grouped and ordered by emissions.
9. **Fail loudly.** Split, share and chart failures raise, and so do emissions, emissions-summary
   and diagnostics crashes, uncaught. The lab's failure manifest then records no findings for a
   crash (only `QualityCheckError` carries them); its log keeps the traceback. Tests: each stage
   monkeypatched to raise surfaces that exception, not `QualityCheckError`.
10. **Diagnostics cost.** `find_close_product_pairs` with `score_cutoff`, a length prefilter and
    digit-insensitive comparison; `ensure_month_year_column` returns early on `PeriodDtype`; the
    palette warning. Timings at 30k rows / 2k products and at `MAX_DATA_ROWS` in the PR body, and
    the `python.md` sentence about dataset size corrected to name `MAX_DATA_ROWS`.

Testing, generally: new tests use the product arguments and assert what `build_pdf_report` is
handed and what the sheets contain, not that files exist.

## Verification

- Every PR: `just lint && just check && just test`, and `pnpm test:system` since each changes
  what `analyze()` produces.
- PRs 6 to 8: render the PDF from `python/lab/test_data` through `2. Produce Food Report.py`
  before and after, and compare pages side by side.

## Risks

- The golden test pins numbers, so every PR here regenerates it; review the fixture diff rather
  than accept it.
- Threshold and `info` changes alter the lab's QA output; tell the data scientists.
- Until PR 2 lands, the lab has no way past a duplicate-lines or diner-count-outlier false
  positive: `--missing-data-policy warn_continue` was removed first. Land PR 2 soon.
- The GBD questions block PR 4 and parts of PRs 7 and 8 only.
