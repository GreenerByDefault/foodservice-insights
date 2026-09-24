"""Excel workbook builders for food-report outputs.

This module exists to keep workbook-generation concerns separate from PDF
assembly and overall report orchestration.

Use this module for workbook-boundary decisions:
- the client workbook should stay lean and decision-useful
- the QA workbook should carry raw-data, diagnostics, and debug-friendly tabs
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

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


def _write_excel_workbook(
    output_path: str,
    sheets: dict[str, pd.DataFrame | None],
) -> str:
    """Write a sheet-name to DataFrame mapping into one workbook.

    This exists so the client and QA workbook builders can share one write path
    and stay aligned on Excel-writing behavior.

    Args:
        output_path: Destination workbook path; resolved to an absolute path.
        sheets: Mapping of sheet name to DataFrame; ``None`` values are skipped.

    Returns:
        Absolute path of the workbook that was written.
    """
    output_path = str(Path(output_path).resolve())

    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        for sheet_name, sheet_df in sheets.items():
            if sheet_df is None:
                continue
            # Neutralise formula-injection before the cells hit the workbook.
            sanitize_for_spreadsheet(sheet_df).to_excel(writer, sheet_name=sheet_name, index=False)

    return output_path


def build_client_excel_report(
    output_path: str,
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
    diner_or_meal: str = "diner",
) -> str:
    """Create the lean client-facing Excel workbook.

    This exists so clients get useful final tables without the extra QA and
    debug tabs that are helpful internally but distracting externally. If a
    sheet is primarily for debugging, QA, or raw inspection, it belongs in the
    QA workbook instead.

    Args:
        output_path: Destination workbook path.
        monthly_product_data: Monthly totals broken down by product.
        monthly_category_data: Monthly totals broken down by category.
        template_data: Category template DataFrame; the index is reset before writing.
        highest_lowest: Optional category-stability summary (currently unused for client output).
        diner_meals_df: Optional per-month diner/meal counts.
        emissions_summary: Optional emissions summary table.
        animal_emissions_intensity: Optional animal-emissions intensity table.
        decision_kpis: Optional decision-KPI summary table.
        substitution_scenarios: Optional substitution-scenarios table.
        diner_or_meal: Per-unit label used in the diner/meal sheet name.

    Returns:
        Absolute path of the workbook that was written.
    """
    sheets: dict[str, pd.DataFrame | None] = {
        "Monthly by Product": monthly_product_data,
        "Monthly by Category": monthly_category_data,
        "Template": template_data.reset_index(),
        f"{diner_or_meal.title()}s": diner_meals_df,
        "Emissions Summary": emissions_summary,
        "Animal Emissions Intensity": animal_emissions_intensity,
        "Decision_KPIs": decision_kpis,
        "Substitution_Scenarios": substitution_scenarios,
    }
    saved_path = _write_excel_workbook(output_path, sheets)
    logger.info("Client Excel report saved to %s", rel_path(saved_path))
    return saved_path


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

    This exists so analysts and the web app can inspect the checks, raw rows,
    and diagnostic exports without overloading the client-facing workbook. This
    workbook is intentionally the internal superset artifact.

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

    saved_path = _write_excel_workbook(output_path, sheets)
    logger.info("QA Excel report saved to %s", rel_path(saved_path))
    return saved_path
