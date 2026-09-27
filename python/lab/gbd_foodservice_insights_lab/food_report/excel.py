"""The lab's internal QA workbook, built on top of the product's Excel writer."""

import logging

import pandas as pd
from gbd_foodservice_insights.report.excel import write_excel_workbook
from gbd_foodservice_insights.utils import rel_path

logger = logging.getLogger(__name__)


def build_qa_excel_report(
    output_path: str,
    raw_df: pd.DataFrame,
    monthly_product_data: pd.DataFrame,
    monthly_category_data: pd.DataFrame,
    template_data: pd.DataFrame,
    *,
    highest_lowest: pd.DataFrame | None = None,
    diner_meals_df: pd.DataFrame | None = None,
    emissions_summary: pd.DataFrame | None = None,
    animal_emissions_intensity: pd.DataFrame | None = None,
    decision_kpis: pd.DataFrame | None = None,
    substitution_scenarios: pd.DataFrame | None = None,
    quality_findings_df: pd.DataFrame | None = None,
    missingness_summary_df: pd.DataFrame | None = None,
    data_profile_df: pd.DataFrame | None = None,
    diagnostic_sheets: dict[str, pd.DataFrame] | None = None,
    diner_or_meal: str = "diner",
) -> str:
    """Create the internal QA workbook with debug-friendly tabs.

    This exists so analysts can inspect the checks, raw rows, and diagnostic
    exports without overloading the client-facing workbook. This workbook is
    intentionally the internal superset artifact.

    Empty or ``None`` ``diagnostic_sheets`` entries are skipped. Returns the workbook's
    absolute path.
    """
    sheets: dict[str, pd.DataFrame | None] = {
        "Raw Data": raw_df,
        "Monthly by Product": monthly_product_data,
        "Monthly by Category": monthly_category_data,
        "Template": template_data.reset_index(),
        "Category Stability": highest_lowest,
        f"{diner_or_meal.title()}s": diner_meals_df,
        "Emissions Summary": emissions_summary,
        "Animal Emissions Intensity": animal_emissions_intensity,
        "Decision_KPIs": decision_kpis,
        "Substitution_Scenarios": substitution_scenarios,
        "Data_Quality_Findings": quality_findings_df,
        "Missingness_Summary": missingness_summary_df,
        "Data Profile": data_profile_df,
    }

    if diagnostic_sheets:
        for sheet_name, sheet_df in diagnostic_sheets.items():
            if sheet_df is None or sheet_df.empty:
                continue
            sheets[sheet_name] = sheet_df

    saved_path = write_excel_workbook(output_path, sheets)
    logger.info("QA Excel report saved to %s", rel_path(saved_path))
    return saved_path
