"""Excel workbook builders for food-report outputs.

This module exists to keep workbook-generation concerns separate from PDF
assembly and overall report orchestration. It builds the client-facing
workbook only, which stays lean and decision-useful; the lab's QA workbook
(raw data, diagnostics, and other debug-friendly tabs) is
`gbd_foodservice_insights_lab.food_report.excel.build_qa_excel_report`, built
on top of `write_excel_workbook` below.
"""

import logging
from collections.abc import Mapping
from pathlib import Path

import pandas as pd

from gbd_foodservice_insights.report.aggregation import Aggregation, AnimalEmissionsConcentration
from gbd_foodservice_insights.report.food_report import FoodReport
from gbd_foodservice_insights.report.schema import DinerOrMeal

logger = logging.getLogger(__name__)

# Characters that make a spreadsheet cell behave as a formula when the file
# is opened in Excel / Sheets / LibreOffice (CSV & XLSX formula injection,
# CWE-1236). User-supplied product names and invalid-row values flow into our
# outputs, so they must be neutralised before export.
_FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r", "\n")


def sanitize_for_spreadsheet(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy of ``df`` with formula-triggering text cells neutralised.

    Any text cell whose value starts with a formula trigger gets a leading
    apostrophe, which spreadsheet software treats as "this is literal text",
    so ``=HYPERLINK(...)`` in a product name displays as text instead of
    executing. Numeric columns are untouched, so genuine negative numbers
    (stored as numbers, not strings) are unaffected.
    """
    safe = df.copy()
    for column in safe.columns:
        if safe[column].dtype == object or pd.api.types.is_string_dtype(safe[column]):
            safe[column] = safe[column].map(_neutralise_cell)
    return safe


def _neutralise_cell(value):
    if isinstance(value, str) and value[:1] in _FORMULA_TRIGGERS:
        return "'" + value
    return value


def write_excel_workbook(
    output_path: str,
    sheets: dict[str, pd.DataFrame | None],
) -> str:
    """Write a sheet-name to DataFrame mapping into one workbook.

    This exists so the client workbook and the lab's QA workbook share one write
    path and stay aligned on Excel-writing behavior. It is public because the lab
    builds its QA workbook from a different package.

    ``None`` sheets are skipped. Returns the absolute path of the written workbook.
    """
    output_path = str(Path(output_path).resolve())

    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        for sheet_name, sheet_df in sheets.items():
            if sheet_df is None:
                continue
            # Neutralise formula-injection before the cells hit the workbook.
            sanitize_for_spreadsheet(sheet_df).to_excel(writer, sheet_name=sheet_name, index=False)

    return output_path


def write_client_workbook(report: FoodReport, path: Path) -> None:
    aggregation = report.aggregation
    sheets: dict[str, pd.DataFrame | None] = {
        "Monthly by Product": aggregation.monthly_product,
        "Monthly by Category": aggregation.monthly_category,
        "Template": aggregation.template.reset_index(),
        f"{report.diner_or_meal.title()}s": diner_meals_frame(
            report.diner_meal_mapping, report.diner_or_meal
        ),
        "Emissions Summary": report.emissions_summary,
        **procurement_sheets(aggregation),
    }
    saved_path = write_excel_workbook(str(path), sheets)
    logger.info("Client Excel report saved to %s", saved_path)


def diner_meals_frame(
    diner_meal_mapping: Mapping[pd.Period, float], diner_or_meal: DinerOrMeal
) -> pd.DataFrame:
    return pd.DataFrame(
        list(diner_meal_mapping.items()), columns=["month_year", f"{diner_or_meal}s"]
    )


def procurement_sheets(aggregation: Aggregation) -> dict[str, pd.DataFrame | None]:
    return {
        "Animal Emissions Intensity": aggregation.animal_emissions_intensity,
        "Decision KPIs": _animal_emissions_concentration_frame(
            aggregation.animal_emissions_concentration
        ),
        "Substitution Scenarios": aggregation.substitution_scenarios,
    }


def _animal_emissions_concentration_frame(
    concentration: AnimalEmissionsConcentration | None,
) -> pd.DataFrame | None:
    if concentration is None:
        return None
    return pd.DataFrame(
        [
            {
                "KPI": (
                    f"Top {len(concentration.top_products)} animal products share of "
                    "animal-product emissions"
                ),
                "Value": round(concentration.share_pct, 1),
                "Unit": "%",
                "Denominator": "Animal-product emissions only",
                "Top products": " | ".join(concentration.top_products),
                "Top product emissions (kg CO2e)": round(concentration.top_products_kg_co2e, 1),
                "Total animal emissions (kg CO2e)": round(concentration.total_animal_kg_co2e, 1),
            }
        ]
    )
