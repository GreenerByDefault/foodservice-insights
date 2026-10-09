# Report typed data

## Context

The report core (`report/food_report.py`, `checks.py`, `aggregation.py`, `quality.py`) still
handles values as text or as `Any`, mostly because the lab hands it raw CSVs. Each item below
leaves that seam.

**Two product functions parse text, and the lab relies on both.**
`categorize_unique_products` runs `parse_and_validate_date_column` and `clean_weight_column`
on whatever it is handed. `categorization-pipeline.md` PR 2 makes it take typed input.
`build_food_report`'s `date_normalization` stage runs `parse_and_validate_date_column(allow_missing=True,
return_diagnostics=True)`, and the lab's `run_food_report` hands it `pd.read_csv` output with
text dates. On the product path `read_input_csv` has already parsed the dates, so only the
`datetime64` pass runs. Even so, `max_future_days=30` against the container's local date can
reject a date the web accepted against UTC (`report-correctness.md`), and either function can
trigger it.

**The date stage files nothing on a run that succeeds.** An ambiguous, invalid or out-of-range
date raises, and the stage files `date_parse_failure` as an `error`. A missing-token date (`n/a`)
gets a `date_parse_status` warning, and its `NaT` then fails `post_normalization`'s non-null
check. A blank cell already fails `ingestion`'s. The golden has no `date_normalization` finding,
and `allow_missing` and `return_diagnostics` (with its three overloads) exist only for this
call. Progress is a heartbeat (`ReportProgress`), so dropping a stage changes no count.

**The metric is never coerced at the boundary.** On the product path it is float. The lab gets
whatever `pd.read_csv` infers. Several checks call `pd.to_numeric(..., errors="coerce")` on it
themselves. `detect_numeric_coercion_loss` reports the text tokens that coercion would drop:
on the product path it always files `success`, which the golden pins, and the lab's
`Numeric_Coercion_Loss` sheet appears only when it is non-empty. `parsing.py` imports
`MISSING_TEXT_TOKENS` from `checks.py` only because this check shares it.

**Driver percentages round-trip through text.** `aggregation.identify_overall_drivers` and
`identify_category_drivers` format `percentage` as `"12.3%"` via `format_percentage_column`.
Their only readers are the two driver charts (`plots/figures.py`, `plots/panels.py`), which
parse it back with `convert_percentage_to_float` and draw from the float. No workbook carries
these tables.

**`pd.api.types.is_period_dtype`** raises `Pandas4Warning` on pandas 3 and is gone in 4. It is
called four times in three lab modules: `plotting_extras.py`, `pilot/plots.py` and
`pilot/analysis.py`.

## Decisions

- **The product keeps what `analyze()` reaches.** Code that only the lab imports moves to the
  lab. Code that nothing imports is deleted with its tests, since git keeps it.
- **"No caller in the repo" does not prove code is dead.** Data scientists keep gitignored
  notebooks in `client_work/` that grep can't see. GBD's lead data scientist has accepted
  breaking changes, so the test is usefulness: delete what is superseded or is a one-liner over
  something that stays. The notebooks can restore from git if needed.
- **`build_food_report` takes typed rows**: a `datetime64` `date` and a numeric metric. It raises
  `TypeError` otherwise, because that is a caller bug and `read_input_csv` guarantees both.
  Parsing text belongs to the lab: `run_food_report` runs `parse_and_validate_date_column`
  (`allow_missing` left `False`, so an `n/a` date fails at the parse with examples) and
  `clean_weight_column` on the metric before calling. A bad date in the lab raises the parser's
  `ValueError`, and the failed manifest records it as `error_message`.
  *Rejected: rebuilding the `date_parse_failure` finding in the lab* — it would be a second copy
  of the finding plumbing for an error whose message already lists the bad values.
- **`report/parsing.py` moves whole to the lab** once no product function calls it. Its
  `min_date` and `max_date` stay, since a data scientist may want a range. `allow_missing` and
  `return_diagnostics` go with their only caller.
- **The export tables stay in `checks.py`.** *Rejected: moving them to the lab with the QA
  workbook* — each check samples its finding from the frame it returns
  (`flagged_rows.head(sample_limit)`), so splitting them out would compute each frame twice.
- **Percentages stay numbers until drawn.**
- **One kind of change per PR.** A deletion, a move, a type change or a boundary change each
  lands alone, so each golden or fixture diff shows one change.

PR order: 1, 4 and 5 can land any time. 2 lands after 1. 3 lands after 1, 2 and
`categorization-pipeline.md` PR 2.

## PR 1 — `build_food_report` takes typed rows

- `food_report.py`: the `date_normalization` stage and its `_STAGE_MESSAGES` entry go. After the
  ingestion checks, `TypeError` unless `date` is `datetime64` and the metric is numeric. The
  `parsing` import goes.
- `parsing.py`: `allow_missing`, `return_diagnostics` and the three overloads go.
- The lab's `run_food_report` parses the date and cleans `metric_for_mode(mode)` after
  `pd.read_csv`, inside the `try`, so a failure still writes the failed manifest.
- Tests: the row builders in `test_food_report.py`, `test_pdf.py` and `test_outputs.py` switch to
  `datetime64` dates. `test_ambiguous_dates_abort_whatever_the_region` goes, since ambiguity is
  `test_parsing.py`'s job. New tests: a text date and a text metric each raise `TypeError`.
  - Lab: `test_quality_contract.py`'s abort test expects the parser's `ValueError` naming
    `bad date`, and a failed manifest whose `error_message` carries it and whose
    `quality_status` is null.
  - New lab test: a serving CSV whose `servings total` reads `"1,234"` reaches the report as
    1234.
- Worth it: it removes `build_food_report`'s half of `report-correctness.md`'s UTC date
  rejection. `categorization-pipeline.md` PR 2 removes the other half. The golden does not move.

## PR 2 — delete `detect_numeric_coercion_loss`

With PR 1, the metric is numeric on every path, so the check can never find anything.

- `checks.py`: the check and its `run_all_diagnostics` call go. `MISSING_TEXT_TOKENS` moves to
  `parsing.py`, its only remaining user, so `parsing.py` stops importing `checks.py`.
- `diagnostic_thresholds.yaml`: `numeric_coercion_loss` goes.
- The lab: the `Numeric_Coercion_Loss` export sheet goes.
- Tests: its two tests and its threshold case go, and the aggregate `run_all_diagnostics` test
  loses its row. Regenerate the golden with `UPDATE_GOLDEN=1`. Its diff should be exactly the one
  `success` finding; anything more is a bug.

## PR 3 — parsing moves to the lab

After `categorization-pipeline.md` PR 2, `parsing.py`'s only callers are the lab's
`categorize_spreadsheet_to_csvs` and `run_food_report`.

- `git mv` `report/parsing.py` to `gbd_foodservice_insights_lab/parsing.py`, and
  `tests/report/test_parsing.py` to `lab/tests/test_parsing.py`, so history follows. Change only
  import paths, and point `test_utils.py`'s docstring at the new place.
- After this, the product has no text parsing outside `read_input_csv`.

## PR 4 — driver percentages stay numeric

- `aggregation.py`: both driver functions leave `percentage` as a float rounded to one decimal.
  `format_percentage_column` and `convert_percentage_to_float` go, and
  `create_horizontal_percentage_barplot` reads `percentage_col` directly instead of its `_float`
  copy.
- Tests: the two helper tests in `test_plotting_utils.py` go. Driver tests that assert `"12.3%"`
  assert `12.3` instead.
- No workbook or golden change. The driver pages must render identically (see Verification).

## PR 5 — `isinstance(dtype, pd.PeriodDtype)`

The four `is_period_dtype` calls in the lab become `isinstance(<series>.dtype, pd.PeriodDtype)`.

## Verification

- Every PR: `just lint && just check && just test && just test-lab`. The golden stays unchanged
  except in PR 2.
- PR 3: `uv sync --package worker-child --no-dev --no-editable` into a fresh venv
  (`UV_PROJECT_ENVIRONMENT=<scratch>/venv`), where the lab is not importable. In that venv,
  `python -m worker_child.mock_llm <runDirectory>` must still exit 0 with a PDF and a workbook,
  which shows that nothing product-side imports a moved symbol. Build the run directory the way
  `worker_child/tests/conftest.py`'s `run_directory` fixture does, with `sample_input_csv()` as
  the input.
- PRs 1 and 3 (no CI job runs the lab against data, so do this by hand):
  1. Categorize `python/lab/test_data/step_2_output/validated_data.csv` (rename its
     `weight_lbs` to `weight`) through `categorize_spreadsheet_to_csvs`, with `KeywordLlmClient`
     and the cache path pointed at a missing file.
  2. Add `kilos_total`, then run `2. Produce Food Report.py` on the result in a scratch client
     folder.
  3. Repeat on `main`, using a detached `git worktree` on `PYTHONPATH`.
  4. Diff the client and QA workbooks sheet by sheet. Expect them to be identical.
- PR 4: render the PDF with `mock_llm` on the branch and on `main`, and compare the driver pages
  pixel for pixel.
- PR 5: the `just test-lab` output has no `Pandas4Warning`.

## Risks

- Lab regressions are silent, and the hand-run check above is the only guard.
- PR 1 changes how the lab reports a bad date: the parser's `ValueError` replaces the
  `date_parse_failure` finding. Tell the data scientists.
- PR 1 and `report-correctness.md` PR 2 both edit `build_food_report`'s stages, so whichever
  lands second rebases.
