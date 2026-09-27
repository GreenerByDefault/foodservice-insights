"""The lab's internal QA workbook, built on top of the product's Excel writer."""

from __future__ import annotations

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

    Args:
        output_path: Destination workbook path.
        raw_df: Raw input rows used to build the report.
        monthly_product_data: Monthly totals broken down by product.
        monthly_category_data: Monthly totals broken down by category.
        template_data: Category template DataFrame; the index is reset before writing.
        highest_lowest: Optional category-stability summary table.
        diner_meals_df: Optional per-month diner/meal counts.
        emissions_summary: Optional emissions summary table.
        animal_emissions_intensity: Optional animal-emissions intensity table.
        decision_kpis: Optional decision-KPI summary table.
        substitution_scenarios: Optional substitution-scenarios table.
        quality_findings_df: Optional table of automated data-quality findings.
        missingness_summary_df: Optional table summarising missingness per column.
        data_profile_df: Optional column-level data profile table.
        diagnostic_sheets: Optional extra named diagnostic DataFrames; empty
            frames and ``None`` values are skipped.
        diner_or_meal: Per-unit label used in the diner/meal sheet name.

    Returns:
        Absolute path of the workbook that was written.
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
