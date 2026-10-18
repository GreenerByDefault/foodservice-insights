"""The procurement report's headline numbers as display strings, for `run_food_report`'s result.

A serving report computes its own, in `serving.ServingReport.summary_stats`.
"""

from gbd_foodservice_insights.report.food_report import (
    FoodReport,
    date_range_label,
    total_co2e_kg,
)
from gbd_foodservice_insights.report.metric import KILOS

_REGION_LABELS = {"europe": "EU/UK", "us": "US/Canada"}


def procurement_summary_stats(report: FoodReport) -> dict[str, str]:
    """Without "Data Quality Status", which the lab's own findings can still change, and without
    the per-head stats when the report has no headcounts."""
    rows, headcounts = report.rows, report.headcounts
    total_co2e = total_co2e_kg(report)
    split, protein = report.plant_animal_split, report.plant_protein_share
    unit = KILOS.unit_plural
    if headcounts is None:
        total_heads, per_head = {}, {}
    else:
        noun, heads = headcounts.diner_or_meal, headcounts.total_in(rows["month_year"])
        total_heads = {f"Total {noun}s": f"{heads:,.0f}"}
        per_head = {f"CO₂e per {noun}": f"{total_co2e / heads:.3f} kg"}
    stats = {
        "Total rows": f"{len(rows):,}",
        "Unique products": f"{rows['product'].nunique():,}",
        "Date range": date_range_label(rows),
        **total_heads,
        "Data type": "Procurement",
        "Region used for climate emissions factors": _REGION_LABELS[report.region],
        "Total CO₂e": f"{total_co2e:,.0f} kg",
        **per_head,
        "Plant-based (% of classified food)": f"{split.plant_pct:.1f}%",
        "Animal-based (% of classified food)": f"{split.animal_pct:.1f}%",
        "Plant-based total": f"{split.plant_total:,.1f} {unit}",
        "Animal-based total": f"{split.animal_total:,.1f} {unit}",
    }
    if protein is None:
        return stats
    return stats | {
        "Plant protein share (% of protein categories)": f"{protein.plant_protein_pct:.1f}%",
        "Plant protein total": f"{protein.plant_protein_total:,.1f} {unit}",
        "Protein-category total": f"{protein.protein_total:,.1f} {unit}",
    }
