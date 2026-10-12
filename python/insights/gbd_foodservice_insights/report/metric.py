"""The quantity a report totals, with the words every page and finding uses for it."""

from dataclasses import dataclass

from gbd_foodservice_insights.report.schema import DinerOrMeal, ReportMode


@dataclass(frozen=True)
class Metric:
    column: str
    # Capitalized, as in "Kilos by Category Across All Months".
    label: str
    # After a number: "1 serving", "2.5 servings".
    unit_singular: str
    unit_plural: str
    per_head_stem: str
    # Singular, as in "a weight above zero".
    line_noun: str

    def per_head(self, diner_or_meal: DinerOrMeal) -> str:
        return f"{self.per_head_stem} per {diner_or_meal}"


KILOS = Metric(
    column="kilos_total",
    label="Kilos",
    unit_singular="kg",
    unit_plural="kg",
    per_head_stem="kilos",
    line_noun="weight",
)
SERVINGS = Metric(
    column="servings total",
    label="Servings",
    unit_singular="serving",
    unit_plural="servings",
    per_head_stem="servings",
    line_noun="serving count",
)

METRIC_BY_MODE: dict[ReportMode, Metric] = {"procurement": KILOS, "serving": SERVINGS}
