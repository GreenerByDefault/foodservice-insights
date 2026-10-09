# Driver percentages stay numeric

## Context

`aggregation.identify_overall_drivers` and `identify_category_drivers` format `percentage` as
`"12.3%"` via `plotting_utils.format_percentage_column`. Their only product readers are the two
driver charts (`plots/figures.py`, `plots/panels.py`), which parse it back with
`convert_percentage_to_float` and draw from the float. No workbook carries these tables. The lab's
pilot notebook calls `identify_overall_drivers` too, but only to hand the result to
`plot_overall_drivers`, so it follows the charts.

## Decisions

- **Percentages stay numbers until drawn.** The chart's bar labels are the only place the `%`
  belongs.

## PR 1 — driver percentages stay numeric

- `aggregation.py`: both driver functions leave `percentage` as a float rounded to one decimal.
- `plotting_utils.py`: `format_percentage_column` and `convert_percentage_to_float` go, and
  `create_horizontal_percentage_barplot` reads `percentage_col` directly instead of its `_float`
  copy. The two chart callers drop their conversion.
- Tests: the two helper tests in `test_plotting_utils.py` go, and the barplot test passes its
  frame straight in. Driver tests that assert `"12.3%"` assert `12.3` instead.

## Verification

- `just lint && just check && just test && just test-lab`. No workbook or golden change.
- Render the PDF with `python -m worker_child.mock_llm <runDirectory>` on the branch and on
  `main`, and compare the driver pages pixel for pixel. Build the run directory the way
  `worker_child/tests/conftest.py`'s `run_directory` fixture does, with `sample_input_csv()` as
  the input.
