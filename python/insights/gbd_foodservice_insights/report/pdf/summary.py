"""The executive summary: a headline figure and plain-English paragraphs about the report."""

from dataclasses import dataclass
from typing import NamedTuple

import matplotlib.pyplot as plt
from matplotlib.figure import Figure

from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    GBD_GREEN,
    GBD_MUTED,
    LETTER_PORTRAIT,
    TITLE_FONT,
)
from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    co2e_kg_per_diner_or_meal,
    date_range_label,
    total_co2e_kg,
)
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.pdf.layout import (
    LINE_HEIGHT,
    PAGE_MARGIN_IN,
    PdfSink,
    new_page_figure,
    wrap_to_width,
)
from gbd_foodservice_insights.report.schema import DinerOrMeal, QualityStatus


class CategoryShare(NamedTuple):
    category: str
    pct_of_footprint: float


class PageRefs(NamedTuple):
    """The page numbers the executive summary points readers to."""

    quality: int
    methodology: int


class Co2ePerHead(NamedTuple):
    diner_or_meal: DinerOrMeal
    kg: float


@dataclass(frozen=True)
class ExecutiveNarrative:
    """The facts behind the plain-English executive summary."""

    client: str
    period: str
    total_food_kg: float
    total_co2e_kg: float
    # `None` without headcounts.
    co2e_per_head: Co2ePerHead | None
    # Percentages of the categorized food by weight.
    plant_pct: float
    animal_pct: float
    # Whether any animal product was bought, which `animal_pct` rounds away below 0.05%.
    any_animal: bool
    # The largest emitters, largest first.
    top_categories: tuple[CategoryShare, ...]
    quality_status: QualityStatus

    def __post_init__(self) -> None:
        if not 1 <= len(self.top_categories) <= 3:
            raise ValueError(f"Expected 1 to 3 top categories, got {len(self.top_categories)}")


def executive_narrative(
    report: FoodReport, client_name: str, quality_status: QualityStatus
) -> ExecutiveNarrative:
    co2e_by_cat = report.emissions_summary.dropna(subset=["total_kg_co2e"])
    total_co2e = total_co2e_kg(report)

    # A category bought only at zero weight sums to 0 and would otherwise fill a spare slot.
    top = co2e_by_cat[co2e_by_cat["total_kg_co2e"] > 0].nlargest(3, "total_kg_co2e")
    return ExecutiveNarrative(
        client=client_name,
        period=date_range_label(report.rows),
        total_food_kg=float(report.rows[KILOS.column].sum()),
        total_co2e_kg=total_co2e,
        co2e_per_head=_co2e_per_head(report),
        plant_pct=report.plant_animal_split.plant_pct,
        animal_pct=report.plant_animal_split.animal_pct,
        any_animal=report.plant_animal_split.animal_total > 0,
        top_categories=tuple(
            CategoryShare(str(category), 100 * kg_co2e / total_co2e)
            for category, kg_co2e in zip(top["category"], top["total_kg_co2e"], strict=True)
        ),
        quality_status=quality_status,
    )


def _co2e_per_head(report: FoodReport) -> Co2ePerHead | None:
    kg = co2e_kg_per_diner_or_meal(report)
    if report.headcounts is None or kg is None:
        return None
    return Co2ePerHead(report.headcounts.diner_or_meal, kg)


def new_summary_figure(fig_size: tuple[float, float]) -> tuple[Figure, plt.Axes]:
    """A page headed "Executive Summary", whose axes coordinates are page coordinates."""
    fig, ax = new_page_figure(fig_size)
    ax.text(
        0.5,
        0.82,
        "Executive Summary",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=20,
        fontweight="bold",
        fontfamily=TITLE_FONT,
        color=GBD_GREEN,
    )
    return fig, ax


def create_executive_summary_page(
    pdf: PdfSink,
    narrative: ExecutiveNarrative,
    page_refs: PageRefs,
    fig_size: tuple[float, float] = LETTER_PORTRAIT,
) -> None:
    """Render the executive summary for readers who will never hear the report explained: a
    headline figure followed by short prose paragraphs."""
    fig, ax = new_summary_figure(fig_size)
    text_width_in = fig_size[0] - 2 * PAGE_MARGIN_IN
    left_x = PAGE_MARGIN_IN / fig_size[0]

    headline = _format_co2e(narrative.total_co2e_kg)
    ax.text(
        0.5,
        0.76,
        f"{headline} CO₂e",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=34,
        fontweight="bold",
        fontfamily=TITLE_FONT,
        color=GBD_GREEN,
    )
    subtitle = (
        f"the greenhouse gas footprint of food purchased by {narrative.client}, {narrative.period}"
    )
    y = 0.70
    for line in wrap_to_width(subtitle, text_width_in, fontsize=12, fontfamily=BODY_FONT):
        ax.text(
            0.5,
            y,
            line,
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=12,
            fontfamily=BODY_FONT,
            color=GBD_MUTED,
        )
        y -= LINE_HEIGHT

    y -= 0.035  # gap below the subtitle
    for paragraph in _narrative_paragraphs(narrative, page_refs):
        for line in wrap_to_width(paragraph, text_width_in, fontsize=11.5, fontfamily=BODY_FONT):
            ax.text(
                left_x,
                y,
                line,
                transform=ax.transAxes,
                ha="left",
                va="top",
                fontsize=11.5,
                fontfamily=BODY_FONT,
            )
            y -= LINE_HEIGHT
        y -= 0.017  # paragraph gap

    pdf.savefig(fig)
    plt.close(fig)


def _format_co2e(kg: float) -> str:
    """Human-scale CO₂e: metric tons from 2,000 kg, with one decimal below 10 metric tons."""
    if kg < 2000:
        return f"{kg:,.0f} kg"
    metric_tons = kg / 1000
    if round(metric_tons, 1) < 10:
        return f"{metric_tons:.1f} metric tons"
    return f"{metric_tons:,.0f} metric tons"


def _share_text(pct: float, *, nonzero: bool) -> str:
    """`pct` as a whole percent, except that a nonzero share never reads as 0% or 100%."""
    if nonzero and pct < 0.5:
        return "under 1%"
    if nonzero and pct >= 99.5:
        return "over 99%"
    return f"{pct:.0f}%"


def _narrative_paragraphs(narrative: ExecutiveNarrative, page_refs: PageRefs) -> list[str]:
    headline = _format_co2e(narrative.total_co2e_kg)
    paragraphs = []

    per_head = narrative.co2e_per_head
    paragraphs.append(
        f"Over this period the kitchen purchased about {narrative.total_food_kg:,.0f} kg "
        "of categorized food. Producing that food, up to the farm gate, released an estimated "
        f"{headline} of carbon dioxide equivalent (CO₂e), the standard unit for comparing the "
        "climate impact of different foods. "
        + (
            "No diner or meal counts were provided, so these figures are totals. Sites differ "
            "in size, so they can't be compared directly with other sites."
            if per_head is None
            else f"That works out at roughly {per_head.kg:.2f} kg of CO₂e per "
            f"{per_head.diner_or_meal}."
        )
    )

    top = narrative.top_categories
    if len(top) == 3:
        first, second, third = top
        top_text = (
            f"{first.category} ({first.pct_of_footprint:.0f}% of the food footprint), "
            f"{second.category} ({second.pct_of_footprint:.0f}%) and {third.category} "
            f"({third.pct_of_footprint:.0f}%)"
        )
    else:
        top_text = " and ".join(f"{c.category} ({c.pct_of_footprint:.0f}%)" for c in top)
    paragraphs.append(f"The biggest contributors were {top_text}.")

    paragraphs.append(
        "All of the categorized food was plant-based."
        if not narrative.any_animal
        else (
            "Within the categories this report tracks (mainly animal proteins, dairy, and "
            "their plant-based alternatives), plant-based items made up "
            f"{_share_text(narrative.plant_pct, nonzero=narrative.plant_pct > 0)} of food by "
            f"weight and animal products {_share_text(narrative.animal_pct, nonzero=True)}. "
            "Fruit, vegetables, and other foods outside these categories are not included. "
            "Animal products carry far "
            "higher emissions per kilogram, so a small number of categories drive most of the "
            "footprint. Modest, targeted menu changes in those areas deliver the largest "
            "reductions."
        )
    )

    if narrative.quality_status != "pass":
        paragraphs.append(
            "Some data-quality notes apply to this analysis; they are listed on page "
            f"{page_refs.quality}."
        )
    paragraphs.append(
        "The pages that follow show how the footprint breaks down by month, category and "
        f"product. The methodology is on page {page_refs.methodology}."
    )
    return paragraphs
