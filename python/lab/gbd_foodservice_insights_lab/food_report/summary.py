"""The procurement report's headline numbers as display strings, for `run_food_report`'s result.

A serving report computes its own, in `serving.ServingReport.summary_stats`.
"""

from gbd_foodservice_insights.report.food_report import FoodReport, date_range_label
from gbd_foodservice_insights.report.metric import KILOS

_REGION_LABELS = {"europe": "EU/UK", "us": "US/Canada"}


def procurement_summary_stats(report: FoodReport) -> dict[str, str]:
    """Without "Data Quality Status", which the lab's own findings can still change."""
    rows, diner_or_meal = report.rows, report.diner_or_meal
    total_co2e = float(report.emissions_summary["total_kg_co2e"].sum())
    split, protein = report.plant_animal_split, report.plant_protein_share
    unit = KILOS.unit_plural
    stats = {
        "Total rows": f"{len(rows):,}",
        "Unique products": f"{rows['product'].nunique():,}",
        "Date range": date_range_label(rows),
        f"Total {diner_or_meal}s": f"{report.diner_meals_in_data:,.0f}",
        "Data type": "Procurement",
        "Region used for climate emissions factors": _REGION_LABELS[report.region],
        "Total CO₂e": f"{total_co2e:,.0f} kg",
        f"CO₂e per {diner_or_meal}": f"{total_co2e / report.diner_meals_in_data:.3f} kg",
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
