"""Excel workbook builders for food-report outputs.

This module exists to keep workbook-generation concerns separate from PDF
assembly and overall report orchestration. It builds the client-facing
workbook only, which stays lean and decision-useful; the lab's QA workbook
(raw data, diagnostics, and other debug-friendly tabs) is
`gbd_foodservice_insights_lab.food_report.excel.build_qa_excel_report`, built
on top of `write_excel_workbook` below.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

from gbd_foodservice_insights.report.food_report import FoodReport
from gbd_foodservice_insights.utils import rel_path

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
    sheets: dict[str, pd.DataFrame | None] = {
        "Monthly by Product": report.aggregation["monthly_product_data"],
        "Monthly by Category": report.aggregation["monthly_category_data"],
        "Template": report.aggregation["template_data"].reset_index(),
        f"{report.diner_or_meal.title()}s": diner_meals_frame(report),
        "Emissions Summary": report.emissions_summary,
        "Animal Emissions Intensity": report.procurement_table("animal_emissions_intensity"),
        "Decision_KPIs": report.procurement_table("decision_kpis"),
        "Substitution_Scenarios": report.procurement_table("substitution_scenarios"),
    }
    saved_path = write_excel_workbook(str(path), sheets)
    logger.info("Client Excel report saved to %s", rel_path(saved_path))


def diner_meals_frame(report: FoodReport) -> pd.DataFrame:
    return pd.DataFrame(
        list(report.diner_meal_mapping.items()),
        columns=["month_year", f"{report.diner_or_meal}s"],
    )
