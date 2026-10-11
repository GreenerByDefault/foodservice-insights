# Plant share types

## Context

`FoodReport.plant_animal_split` and `FoodReport.plant_protein_share` are the last
`dict[str, Any] | None` fields on `FoodReport`. `aggregation.calculate_plant_animal_split` and
`calculate_plant_protein_share` build them. Consumers read them by string key: `food_report.py`
for the summary stats, `plots/panels.py` for the share bars and monthly lines, and `pdf.py`
for `ExecutiveNarrative.plant_and_animal_pct`, a positional `(plant, animal)` tuple that exists
only because the dict has no type to pass along. The lab's `pilot/` functions with similar
names are unrelated and out of scope.

## Decisions

- **Each becomes a frozen dataclass in `report/aggregation.py`**, `PlantAnimalSplit` and
  `PlantProteinShare`, next to `AnimalEmissionsConcentration`. `None` still means there is no
  share to show (no classified rows, or a zero total).
- **`monthly` is not optional.** `build_food_report` adds `month_year` before calling either
  function, and nothing else calls them. Require the column and drop the
  `"month_year" in columns` branch, rather than carrying a `DataFrame | None` that is never
  `None`.
- **`ExecutiveNarrative` holds the `PlantAnimalSplit`** in place of `plant_and_animal_pct`.
- **Percentages stay rounded to one decimal at construction**, as they are now, because the
  summary stats, the chart and the narrative all show that value. *Rejected: unrounded values
  with a `pct` property like `AnimalEmissionsConcentration.share_pct`, which would change the
  summary-stat strings the golden fixture pins.*

## PR 1 — Typed plant shares

- `aggregation.py`: the two dataclasses; both functions return them.
- Consumers: `food_report.py`, `plots/panels.py`, `plots/figures.py`, `plots/report.py`,
  `pdf.py`.
- Tests: `test_aggregation.py` asserts the full dataclass with `==`. Panel and PDF tests build
  the dataclass instead of a dict.
- The golden fixture should not change. Rendered PDFs and chart screenshots should be
  byte-identical; compare PDFs rendered with a fixed `SOURCE_DATE_EPOCH`.

## Verification

`just lint && just check && just test && just test-lab`, the PDF byte comparison, and
`git grep -n "plant_pct\"\|plant_protein_pct\"" python` returns no string-key reads.
