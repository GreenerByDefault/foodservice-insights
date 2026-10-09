# Report typed data

## Context

The report core (`report/food_report.py`, `checks.py`, `aggregation.py`, `quality.py`) still
handles values as text or as `Any`, mostly because the lab hands it raw CSVs. Each item below
leaves that seam.

**`build_food_report` takes typed rows.** It raises `TypeError` unless `date` is `datetime64`
and the metric is numeric, since `read_input_csv` guarantees both on the product path. The lab's
`run_food_report` runs `parse_and_validate_date_column` and `clean_weight_column` on its
`pd.read_csv` output before calling it, so a bad date in the lab raises the parser's
`ValueError`, which the failed manifest records as `error_message`.

**`categorize_unique_products` takes typed rows too**, so `parsing.py`'s only callers are the
lab's `categorize_spreadsheet_to_csvs` and `run_food_report`.

**A check can no longer find anything.** Several checks call `pd.to_numeric(..., errors="coerce")`
on the metric themselves, and `detect_numeric_coercion_loss` reports the text tokens that
coercion would drop. With the metric numeric on every path, it always files `success`, which the
golden pins, and the lab's `Numeric_Coercion_Loss` sheet never appears. `parsing.py` imports
`MISSING_TEXT_TOKENS` from `checks.py` only because this check shares it.

**Driver percentages round-trip through text.** `aggregation.identify_overall_drivers` and
`identify_category_drivers` format `percentage` as `"12.3%"` via `format_percentage_column`.
Their only readers are the two driver charts (`plots/figures.py`, `plots/panels.py`), which
parse it back with `convert_percentage_to_float` and draw from the float. No workbook carries
these tables.

## Decisions

- **The product keeps what `analyze()` reaches.** Code that only the lab imports moves to the
  lab. Code that nothing imports is deleted with its tests, since git keeps it.
- **"No caller in the repo" does not prove code is dead.** Data scientists keep gitignored
  notebooks in `client_work/` that grep can't see. GBD's lead data scientist has accepted
  breaking changes, so the test is usefulness: delete what is superseded or is a one-liner over
  something that stays. The notebooks can restore from git if needed.
- **Parsing text belongs to the lab.** *Rejected: rebuilding the `date_parse_failure` finding in
  the lab* — it would be a second copy of the finding plumbing for an error whose message
  already lists the bad values.
- **`report/parsing.py` moves whole to the lab** once no product function calls it. Its
  `min_date` and `max_date` stay, since a data scientist may want a range.
- **The export tables stay in `checks.py`.** *Rejected: moving them to the lab with the QA
  workbook* — each check samples its finding from the frame it returns
  (`flagged_rows.head(sample_limit)`), so splitting them out would compute each frame twice.
- **Percentages stay numbers until drawn.**
- **One kind of change per PR.** A deletion, a move, a type change or a boundary change each
  lands alone, so each golden or fixture diff shows one change.

PR order: 1 and 3 can land any time. 2 lands after 1.

## PR 1 — delete `detect_numeric_coercion_loss`

- `checks.py`: the check and its `run_all_diagnostics` call go. `MISSING_TEXT_TOKENS` moves to
  `parsing.py`, its only remaining user, so `parsing.py` stops importing `checks.py`.
- `diagnostic_thresholds.yaml`: `numeric_coercion_loss` goes.
- The lab: the `Numeric_Coercion_Loss` export sheet goes.
- Tests: its two tests and its threshold case go, and the aggregate `run_all_diagnostics` test
  loses its row. Regenerate the golden with `UPDATE_GOLDEN=1`. Its diff should be exactly the one
  `success` finding; anything more is a bug.

## PR 2 — parsing moves to the lab

- `git mv` `report/parsing.py` to `gbd_foodservice_insights_lab/parsing.py`, and
  `tests/report/test_parsing.py` to `lab/tests/test_parsing.py`, so history follows. Change only
  import paths, and point `test_utils.py`'s docstring at the new place.
- After this, the product has no text parsing outside `read_input_csv`.

## PR 3 — driver percentages stay numeric

- `aggregation.py`: both driver functions leave `percentage` as a float rounded to one decimal.
  `format_percentage_column` and `convert_percentage_to_float` go, and
  `create_horizontal_percentage_barplot` reads `percentage_col` directly instead of its `_float`
  copy.
- Tests: the two helper tests in `test_plotting_utils.py` go. Driver tests that assert `"12.3%"`
  assert `12.3` instead.
- No workbook or golden change. The driver pages must render identically (see Verification).

## Verification

- Every PR: `just lint && just check && just test && just test-lab`. The golden stays unchanged
  except in PR 1.
- PR 2: `uv sync --package worker-child --no-dev --no-editable` into a fresh venv
  (`UV_PROJECT_ENVIRONMENT=<scratch>/venv`), where the lab is not importable. In that venv,
  `python -m worker_child.mock_llm <runDirectory>` must still exit 0 with a PDF and a workbook,
  which shows that nothing product-side imports a moved symbol. Build the run directory the way
  `worker_child/tests/conftest.py`'s `run_directory` fixture does, with `sample_input_csv()` as
  the input.
- PR 2 (no CI job runs the lab against data, so do this by hand):
  1. Categorize `python/lab/test_data/step_2_output/validated_data.csv` (rename its
     `weight_lbs` to `weight`) through `categorize_spreadsheet_to_csvs`, with `KeywordLlmClient`
     and the cache path pointed at a missing file.
  2. Add `kilos_total`, then run `2. Produce Food Report.py` on the result in a scratch client
     folder.
  3. Repeat on `main`, using a detached `git worktree` on `PYTHONPATH`.
  4. Diff the client and QA workbooks sheet by sheet. Expect them to be identical.
- PR 3: render the PDF with `mock_llm` on the branch and on `main`, and compare the driver pages
  pixel for pixel.

## Risks

- Lab regressions are silent, and the hand-run check above is the only guard.
