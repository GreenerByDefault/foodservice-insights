"""Interactive comparison helpers for baseline procurement vs serving workbooks.

This module is designed for analyst-facing Hydrogen files. It loads the client
workbooks step 2 writes, compares the broad category story between procurement
and serving, and returns display-ready tables plus matplotlib figures for
interactive review.
"""

from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import category_names
from gbd_foodservice_insights.plotting_utils import (
    GBD_COLORS,
    add_grid,
    set_title_font,
    setup_gbd_fonts,
)
from gbd_foodservice_insights.report.metric import KILOS, Metric

from gbd_foodservice_insights_lab.food_report.serving import SERVINGS
from gbd_foodservice_insights_lab.plotting_extras import clean_category_label

__all__ = [
    "build_gap_tables",
    "compare_diner_numbers",
    "compare_month_coverage",
    "compare_monthly_categories",
    "compare_overall_categories",
    "find_baseline_summary_workbooks",
    "load_baseline_workbook_data",
    "plot_diner_number_comparison",
    "plot_monthly_category_share_comparison",
    "plot_per_person_share_comparison",
    "plot_share_comparison",
    "plot_share_scatter",
    "split_activity_tables",
    "summarize_procurement_serving_comparison",
]


PROCUREMENT_SUBFOLDER = "purchasing-procurement data"
SERVING_SUBFOLDER = "sales-serving data"
# Step 2's client workbook, from `food_report.artifacts.build_report_artifact_paths`. Searched
# recursively, since step 2 writes it under `outputs/<stem>/` beside its input.
WORKBOOK_PATTERN = "food_report_*.xlsx"
QA_WORKBOOK_SUFFIX = "_qa.xlsx"


def _ensure_path(value: str | Path) -> Path:
    """Return a resolved Path from a string or Path input."""
    return Path(value).expanduser().resolve()


def _find_single_workbook(folder: Path) -> Path:
    """Return the single client workbook under ``folder`` or raise clearly."""
    matches = sorted(
        path
        for path in folder.rglob(WORKBOOK_PATTERN)
        if path.is_file() and not path.name.endswith(QA_WORKBOOK_SUFFIX)
    )
    if len(matches) == 1:
        return matches[0]

    if not matches:
        raise FileNotFoundError(f"No workbook matching '{WORKBOOK_PATTERN}' found in {folder}.")

    raise ValueError(
        f"Expected exactly one workbook matching '{WORKBOOK_PATTERN}' in {folder}, "
        f"but found {len(matches)}: {[str(path.relative_to(folder)) for path in matches]}"
    )


def find_baseline_summary_workbooks(baseline_folder: str | Path) -> dict[str, str]:
    """Locate the baseline procurement and serving summary workbooks."""
    baseline_path = _ensure_path(baseline_folder)
    procurement_folder = baseline_path / PROCUREMENT_SUBFOLDER
    serving_folder = baseline_path / SERVING_SUBFOLDER

    if not procurement_folder.exists():
        raise FileNotFoundError(f"Procurement folder not found: {procurement_folder}")
    if not serving_folder.exists():
        raise FileNotFoundError(f"Serving folder not found: {serving_folder}")

    procurement_workbook = _find_single_workbook(procurement_folder)
    serving_workbook = _find_single_workbook(serving_folder)

    return {
        "baseline_folder": str(baseline_path),
        "procurement_folder": str(procurement_folder),
        "serving_folder": str(serving_folder),
        "procurement_workbook_path": str(procurement_workbook),
        "serving_workbook_path": str(serving_workbook),
    }


def _load_workbook_sheets(workbook_path: str | Path, metric: Metric) -> dict[str, pd.DataFrame]:
    """Load the client workbook's sheets, renaming its columns to the ones this module uses.

    The per-head column and the count sheet are named for diners or meals, whichever the
    workbook counted; ``{unit} per person`` and ``value`` stand for either.
    """
    workbook = _ensure_path(workbook_path)
    excel_file = pd.ExcelFile(workbook)
    sheet_names = set(excel_file.sheet_names)
    count_sheets = sorted(sheet_names & {"Diners", "Meals"})
    if not {"Monthly by Category", "Template"} <= sheet_names or len(count_sheets) != 1:
        raise ValueError(
            f"Workbook {workbook.name} needs 'Monthly by Category', 'Template', and exactly one "
            f"of 'Diners' or 'Meals'. Found sheets: {excel_file.sheet_names}"
        )
    count_sheet = count_sheets[0]
    diner_or_meal = "diner" if count_sheet == "Diners" else "meal"

    return {
        "monthly_category_data": pd.read_excel(excel_file, sheet_name="Monthly by Category").rename(
            columns={
                metric.column: f"{metric.per_head_stem} total",
                metric.per_head(diner_or_meal): f"{metric.per_head_stem} per person",
            }
        ),
        "template_data": pd.read_excel(excel_file, sheet_name="Template"),
        "diner_numbers": pd.read_excel(excel_file, sheet_name=count_sheet).rename(
            columns={count_sheet.lower(): "value"}
        ),
    }


def _official_gbd_category_lookup() -> tuple[list[str], dict[str, str]]:
    """Return the official GBD category list and lowercase lookup."""
    official_gbd_category_list = list(category_names())
    lookup = {category.strip().lower(): category for category in official_gbd_category_list}
    return official_gbd_category_list, lookup


def _normalize_category_name(value: Any, lookup: dict[str, str]) -> str:
    """Map workbook category text back onto the official GBD category labels when possible."""
    text = str(value).strip()
    return lookup.get(text.lower(), text)


def _prepare_monthly_category_data(
    df: pd.DataFrame,
    *,
    total_col: str,
    per_person_col: str,
    lookup: dict[str, str],
) -> pd.DataFrame:
    """Clean and aggregate workbook monthly category data."""
    required = {"month_year", "category", total_col, per_person_col}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(
            f"Monthly by Category is missing columns: {sorted(missing)}. Found: {list(df.columns)}"
        )

    prepared = df.loc[:, ["month_year", "category", total_col, per_person_col]].copy()
    prepared["month_year"] = prepared["month_year"].astype(str).str.strip()
    prepared["category"] = prepared["category"].map(
        lambda value: _normalize_category_name(value, lookup)
    )
    prepared[total_col] = pd.to_numeric(prepared[total_col], errors="coerce").fillna(0.0)
    prepared[per_person_col] = pd.to_numeric(prepared[per_person_col], errors="coerce").fillna(0.0)

    return (
        prepared.groupby(["month_year", "category"], dropna=False)[[total_col, per_person_col]]
        .sum()
        .reset_index()
    )


def _prepare_template_data(df: pd.DataFrame, lookup: dict[str, str]) -> pd.DataFrame:
    """Clean the template sheet and remove the synthetic total row."""
    if "category" not in df.columns:
        raise ValueError(f"Template is missing 'category'. Found: {list(df.columns)}")

    prepared = df.copy()
    prepared["category"] = prepared["category"].map(
        lambda value: _normalize_category_name(value, lookup)
    )
    prepared["category"] = prepared["category"].astype(str).str.strip()
    prepared = prepared.loc[prepared["category"].str.lower() != "total"].copy()
    return prepared


def _prepare_diner_numbers(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the per-month diner or meal counts."""
    if df.empty:
        raise ValueError("The Diners or Meals sheet is empty.")

    return pd.DataFrame(
        {
            "month_year": df["month_year"].astype(str).str.strip(),
            "value": pd.to_numeric(df["value"], errors="coerce").astype(float),
        }
    )


def _build_full_comparison_category_list(
    official_gbd_category_list: list[str],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> tuple[list[str], list[str]]:
    """Return the full comparison category list plus any extra workbook-only categories."""
    workbook_categories = set(procurement_monthly["category"].dropna().astype(str)) | set(
        serving_monthly["category"].dropna().astype(str)
    )
    extra_client_categories = sorted(
        category for category in workbook_categories if category not in official_gbd_category_list
    )
    return official_gbd_category_list + extra_client_categories, extra_client_categories


def _find_non_gbd_categories_by_dataset(
    official_gbd_category_list: list[str],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> dict[str, list[str]]:
    """Return non-GBD category names found in each dataset separately."""
    official_set = set(official_gbd_category_list)
    procurement_non_gbd = sorted(
        category
        for category in set(procurement_monthly["category"].dropna().astype(str))
        if category not in official_set
    )
    serving_non_gbd = sorted(
        category
        for category in set(serving_monthly["category"].dropna().astype(str))
        if category not in official_set
    )
    return {
        "procurement_non_gbd_categories": procurement_non_gbd,
        "serving_non_gbd_categories": serving_non_gbd,
    }


def _assign_rank(values: pd.Series) -> pd.Series:
    """Assign dense descending ranks to positive values and leave inactive rows unranked."""
    active_mask = values.fillna(0) > 0
    ranked = pd.Series(pd.NA, index=values.index, dtype="Float64")
    if active_mask.any():
        ranked.loc[active_mask] = (
            values.loc[active_mask]
            .rank(method="dense", ascending=False)
            .astype("Int64")
            .astype("Float64")
        )
    return ranked


def _build_month_coverage(
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> dict[str, Any]:
    """Return a plain-English month coverage summary."""
    procurement_months = sorted(
        procurement_monthly["month_year"].dropna().astype(str).unique().tolist()
    )
    serving_months = sorted(serving_monthly["month_year"].dropna().astype(str).unique().tolist())

    return {
        "procurement_months": procurement_months,
        "serving_months": serving_months,
        "months_match": procurement_months == serving_months,
        "months_only_in_procurement": sorted(set(procurement_months) - set(serving_months)),
        "months_only_in_serving": sorted(set(serving_months) - set(procurement_months)),
    }


def compare_month_coverage(
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> dict[str, Any]:
    """Public wrapper for the month coverage comparison step."""
    return _build_month_coverage(procurement_monthly, serving_monthly)


def _build_diner_number_comparison(
    procurement_diners: pd.DataFrame,
    serving_diners: pd.DataFrame,
) -> dict[str, Any]:
    """Compare diner or meal counts with calm, descriptive wording."""
    comparison = procurement_diners.merge(
        serving_diners,
        on="month_year",
        how="outer",
        suffixes=("_procurement", "_serving"),
    )
    comparison["abs_gap"] = (comparison["value_procurement"] - comparison["value_serving"]).abs()
    comparison["pct_gap_vs_procurement"] = (
        comparison["abs_gap"] / comparison["value_procurement"].replace({0.0: np.nan}) * 100
    )

    exact_match = bool(comparison["abs_gap"].fillna(0).eq(0).all())
    max_pct_gap = float(comparison["pct_gap_vs_procurement"].fillna(0).max())

    if exact_match:
        interpretation = (
            "Procurement and serving use the same diner or meal counts here. That is a "
            "reassuring sign, but it is not a strict requirement."
        )
    elif max_pct_gap <= 5:
        interpretation = (
            "The diner or meal counts are close. Small differences can be normal depending "
            "on which denominator each analysis used."
        )
    elif max_pct_gap <= 15:
        interpretation = (
            "The diner or meal counts differ moderately. This is worth checking, but it "
            "does not automatically mean the comparison is invalid."
        )
    else:
        interpretation = (
            "The diner or meal counts differ materially in at least one month. This "
            "deserves a closer look before drawing strong conclusions."
        )

    return {
        "table": comparison,
        "exact_match": exact_match,
        "max_pct_gap": max_pct_gap,
        "interpretation": interpretation,
    }


def compare_diner_numbers(
    procurement_diners: pd.DataFrame,
    serving_diners: pd.DataFrame,
) -> dict[str, Any]:
    """Public wrapper for the diner or meal number comparison step."""
    return _build_diner_number_comparison(procurement_diners, serving_diners)


def _build_overall_category_comparison(
    full_comparison_category_list: list[str],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
    procurement_template: pd.DataFrame,
    serving_template: pd.DataFrame,
    official_gbd_category_list: list[str],
) -> pd.DataFrame:
    """Build the main category comparison table using the full comparison category list."""
    category_list = pd.DataFrame({"category": full_comparison_category_list})
    category_list["official_gbd_order"] = range(len(category_list))

    procurement_totals = (
        procurement_monthly.groupby("category", dropna=False)[["kilos total", "kilos per person"]]
        .sum()
        .reset_index()
        .rename(
            columns={
                "kilos total": "procurement_total",
                "kilos per person": "procurement_per_person_total",
            }
        )
    )
    serving_totals = (
        serving_monthly.groupby("category", dropna=False)[["servings total", "servings per person"]]
        .sum()
        .reset_index()
        .rename(
            columns={
                "servings total": "serving_total",
                "servings per person": "serving_per_person_total",
            }
        )
    )

    overall = category_list.merge(procurement_totals, on="category", how="left").merge(
        serving_totals, on="category", how="left"
    )
    for column in (
        "procurement_total",
        "serving_total",
        "procurement_per_person_total",
        "serving_per_person_total",
    ):
        overall[column] = pd.to_numeric(overall[column], errors="coerce").fillna(0.0)

    procurement_total_sum = float(overall["procurement_total"].sum())
    serving_total_sum = float(overall["serving_total"].sum())
    procurement_per_person_sum = float(overall["procurement_per_person_total"].sum())
    serving_per_person_sum = float(overall["serving_per_person_total"].sum())

    overall["active_in_procurement"] = overall["procurement_total"] > 0
    overall["active_in_serving"] = overall["serving_total"] > 0
    overall["inactive_in_both"] = ~overall["active_in_procurement"] & ~overall["active_in_serving"]

    overall["procurement_share_pct"] = (
        overall["procurement_total"] / procurement_total_sum * 100
        if procurement_total_sum > 0
        else 0.0
    )
    overall["serving_share_pct"] = (
        overall["serving_total"] / serving_total_sum * 100 if serving_total_sum > 0 else 0.0
    )
    overall["procurement_per_person_share_pct"] = (
        overall["procurement_per_person_total"] / procurement_per_person_sum * 100
        if procurement_per_person_sum > 0
        else 0.0
    )
    overall["serving_per_person_share_pct"] = (
        overall["serving_per_person_total"] / serving_per_person_sum * 100
        if serving_per_person_sum > 0
        else 0.0
    )

    shared_active = overall["active_in_procurement"] & overall["active_in_serving"]
    overall["share_gap_pct_pts"] = np.where(
        shared_active,
        (overall["procurement_share_pct"] - overall["serving_share_pct"]).abs(),
        np.nan,
    )
    overall["per_person_share_gap_pct_pts"] = np.where(
        shared_active,
        (
            overall["procurement_per_person_share_pct"] - overall["serving_per_person_share_pct"]
        ).abs(),
        np.nan,
    )

    overall["procurement_rank"] = _assign_rank(overall["procurement_total"])
    overall["serving_rank"] = _assign_rank(overall["serving_total"])
    overall["rank_gap"] = (overall["procurement_rank"] - overall["serving_rank"]).abs()

    procurement_template_categories = set(procurement_template["category"].astype(str))
    serving_template_categories = set(serving_template["category"].astype(str))
    overall["present_in_procurement_template"] = overall["category"].isin(
        procurement_template_categories
    )
    overall["present_in_serving_template"] = overall["category"].isin(serving_template_categories)

    status = np.select(
        [
            overall["active_in_procurement"] & overall["active_in_serving"],
            overall["active_in_procurement"] & ~overall["active_in_serving"],
            ~overall["active_in_procurement"] & overall["active_in_serving"],
            overall["inactive_in_both"],
        ],
        [
            "active in both",
            "active only in procurement",
            "active only in serving",
            "inactive in both",
        ],
        default="unexpected",
    )
    overall["activity_status"] = status
    overall["category_label"] = overall["category"].map(clean_category_label)

    overall = overall.sort_values(["official_gbd_order", "category"]).reset_index(drop=True)
    return overall.drop(columns=["official_gbd_order"])


def compare_overall_categories(
    full_comparison_category_list: list[str],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
    procurement_template: pd.DataFrame,
    serving_template: pd.DataFrame,
    official_gbd_category_list: list[str],
) -> pd.DataFrame:
    """Public wrapper for the overall category comparison step."""
    return _build_overall_category_comparison(
        full_comparison_category_list,
        procurement_monthly,
        serving_monthly,
        procurement_template,
        serving_template,
        official_gbd_category_list,
    )


def _build_monthly_comparisons(
    full_comparison_category_list: list[str],
    month_coverage: dict[str, Any],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> dict[str, pd.DataFrame]:
    """Build month-specific category comparisons when month coverage matches."""
    if not month_coverage["months_match"]:
        return {}

    monthly_comparisons: dict[str, pd.DataFrame] = {}
    for month in month_coverage["procurement_months"]:
        procurement_month = procurement_monthly.loc[
            procurement_monthly["month_year"] == month
        ].copy()
        serving_month = serving_monthly.loc[serving_monthly["month_year"] == month].copy()

        category_list = pd.DataFrame({"category": full_comparison_category_list})
        procurement_total = float(procurement_month["kilos total"].sum())
        serving_total = float(serving_month["servings total"].sum())

        procurement_summary = (
            procurement_month.groupby("category", dropna=False)["kilos total"]
            .sum()
            .reset_index()
            .rename(columns={"kilos total": "procurement_total"})
        )
        serving_summary = (
            serving_month.groupby("category", dropna=False)["servings total"]
            .sum()
            .reset_index()
            .rename(columns={"servings total": "serving_total"})
        )
        month_table = category_list.merge(procurement_summary, on="category", how="left").merge(
            serving_summary, on="category", how="left"
        )
        month_table["procurement_total"] = pd.to_numeric(
            month_table["procurement_total"], errors="coerce"
        ).fillna(0.0)
        month_table["serving_total"] = pd.to_numeric(
            month_table["serving_total"], errors="coerce"
        ).fillna(0.0)
        month_table["active_in_procurement"] = month_table["procurement_total"] > 0
        month_table["active_in_serving"] = month_table["serving_total"] > 0
        month_table["procurement_share_pct"] = (
            month_table["procurement_total"] / procurement_total * 100
            if procurement_total > 0
            else 0.0
        )
        month_table["serving_share_pct"] = (
            month_table["serving_total"] / serving_total * 100 if serving_total > 0 else 0.0
        )
        shared_active = month_table["active_in_procurement"] & month_table["active_in_serving"]
        month_table["share_gap_pct_pts"] = np.where(
            shared_active,
            (month_table["procurement_share_pct"] - month_table["serving_share_pct"]).abs(),
            np.nan,
        )
        month_table["procurement_rank"] = _assign_rank(month_table["procurement_total"])
        month_table["serving_rank"] = _assign_rank(month_table["serving_total"])
        month_table["rank_gap"] = (
            month_table["procurement_rank"] - month_table["serving_rank"]
        ).abs()
        month_table["activity_status"] = np.select(
            [
                month_table["active_in_procurement"] & month_table["active_in_serving"],
                month_table["active_in_procurement"] & ~month_table["active_in_serving"],
                ~month_table["active_in_procurement"] & month_table["active_in_serving"],
                ~month_table["active_in_procurement"] & ~month_table["active_in_serving"],
            ],
            [
                "active in both",
                "active only in procurement",
                "active only in serving",
                "inactive in both",
            ],
            default="unexpected",
        )
        month_table["category_label"] = month_table["category"].map(clean_category_label)
        monthly_comparisons[month] = month_table

    return monthly_comparisons


def compare_monthly_categories(
    full_comparison_category_list: list[str],
    month_coverage: dict[str, Any],
    procurement_monthly: pd.DataFrame,
    serving_monthly: pd.DataFrame,
) -> dict[str, pd.DataFrame]:
    """Public wrapper for the month-by-month category comparison step."""
    return _build_monthly_comparisons(
        full_comparison_category_list,
        month_coverage,
        procurement_monthly,
        serving_monthly,
    )


def _top_gap_table(
    overall: pd.DataFrame,
    *,
    gap_col: str,
    n_rows: int = 10,
) -> pd.DataFrame:
    """Return the biggest positive gaps for display."""
    return (
        overall.loc[overall[gap_col].notna()]
        .sort_values(gap_col, ascending=False)
        .head(n_rows)
        .reset_index(drop=True)
    )


def build_gap_tables(overall: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Return the headline gap tables used in the interactive notebook."""
    return {
        "top_share_gaps": _top_gap_table(overall, gap_col="share_gap_pct_pts"),
        "top_rank_gaps": _top_gap_table(overall, gap_col="rank_gap"),
        "top_per_person_share_gaps": _top_gap_table(
            overall,
            gap_col="per_person_share_gap_pct_pts",
        ),
    }


def split_activity_tables(overall: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Split the overall comparison table into analyst-friendly activity groups."""
    return {
        "active_only_in_procurement": overall.loc[
            overall["activity_status"] == "active only in procurement"
        ].reset_index(drop=True),
        "active_only_in_serving": overall.loc[
            overall["activity_status"] == "active only in serving"
        ].reset_index(drop=True),
        "inactive_in_both": overall.loc[
            overall["activity_status"] == "inactive in both"
        ].reset_index(drop=True),
    }


def summarize_procurement_serving_comparison(result: dict[str, Any]) -> list[str]:
    """Return a short plain-English summary list for notebook display."""
    overall = result["overall_category_comparison"]
    shared_active = overall.loc[overall["activity_status"] == "active in both"].copy()
    top_gap_row = (
        shared_active.sort_values("share_gap_pct_pts", ascending=False).head(1)
        if not shared_active.empty
        else pd.DataFrame()
    )
    top_rank_row = (
        shared_active.sort_values("rank_gap", ascending=False).head(1)
        if not shared_active.empty
        else pd.DataFrame()
    )

    lines = []
    if result["diner_number_comparison"]["exact_match"]:
        lines.append(
            "Diner or meal numbers match exactly in this pair, which is reassuring but "
            "not required."
        )
    else:
        lines.append(result["diner_number_comparison"]["interpretation"])

    inactive_both_count = len(result["inactive_in_both"])
    lines.append(
        f"{inactive_both_count} official GBD categories are inactive in both files, "
        "which is a useful sign of alignment."
    )

    if not top_gap_row.empty:
        row = top_gap_row.iloc[0]
        lines.append(
            "The largest overall share difference is in "
            f"{clean_category_label(row['category'])} at "
            f"{row['share_gap_pct_pts']:.1f} percentage points."
        )

    if not top_rank_row.empty:
        row = top_rank_row.iloc[0]
        lines.append(
            f"The largest rank difference is in {clean_category_label(row['category'])} "
            f"with a gap of {int(row['rank_gap'])} rank places."
        )

    if result["months_match"]:
        lines.append(
            "Month coverage matches, so the notebook can show month-by-month category comparisons."
        )
    else:
        lines.append(
            "Month coverage differs, so the notebook should stop at the overall comparison "
            "and avoid misleading month-by-month views."
        )

    return lines


def load_baseline_workbook_data(
    procurement_workbook_path: str | Path,
    serving_workbook_path: str | Path,
) -> dict[str, Any]:
    """Load and prepare the workbook data needed for each visible comparison step."""
    setup_gbd_fonts()
    official_gbd_category_list, lookup = _official_gbd_category_lookup()
    procurement_workbook = _load_workbook_sheets(procurement_workbook_path, KILOS)
    serving_workbook = _load_workbook_sheets(serving_workbook_path, SERVINGS)

    procurement_monthly = _prepare_monthly_category_data(
        procurement_workbook["monthly_category_data"],
        total_col="kilos total",
        per_person_col="kilos per person",
        lookup=lookup,
    )
    serving_monthly = _prepare_monthly_category_data(
        serving_workbook["monthly_category_data"],
        total_col="servings total",
        per_person_col="servings per person",
        lookup=lookup,
    )
    procurement_template = _prepare_template_data(procurement_workbook["template_data"], lookup)
    serving_template = _prepare_template_data(serving_workbook["template_data"], lookup)
    procurement_diners = _prepare_diner_numbers(procurement_workbook["diner_numbers"])
    serving_diners = _prepare_diner_numbers(serving_workbook["diner_numbers"])

    full_comparison_category_list, extra_client_categories = _build_full_comparison_category_list(
        official_gbd_category_list,
        procurement_monthly,
        serving_monthly,
    )
    non_gbd_categories_by_dataset = _find_non_gbd_categories_by_dataset(
        official_gbd_category_list,
        procurement_monthly,
        serving_monthly,
    )
    return {
        "procurement_workbook_path": str(_ensure_path(procurement_workbook_path)),
        "serving_workbook_path": str(_ensure_path(serving_workbook_path)),
        "official_gbd_category_list": official_gbd_category_list,
        "extra_client_categories": extra_client_categories,
        **non_gbd_categories_by_dataset,
        "full_comparison_category_list": full_comparison_category_list,
        "procurement_monthly": procurement_monthly,
        "serving_monthly": serving_monthly,
        "procurement_template": procurement_template,
        "serving_template": serving_template,
        "procurement_diners": procurement_diners,
        "serving_diners": serving_diners,
    }


def plot_share_scatter(
    comparison_result: dict[str, Any],
    figsize: tuple[float, float] = (7.5, 6.5),
) -> plt.Figure:
    """Plot procurement share vs serving share for shared active categories."""
    data = comparison_result["overall_category_comparison"]
    shared = data.loc[data["activity_status"] == "active in both"].copy()

    fig, ax = plt.subplots(figsize=figsize)
    if shared.empty:
        ax.text(0.5, 0.5, "No categories are active in both files.", ha="center", va="center")
        ax.axis("off")
        return fig

    ax.scatter(
        shared["procurement_share_pct"],
        shared["serving_share_pct"],
        color=GBD_COLORS[0],
        alpha=0.8,
    )
    axis_max = float(
        max(shared["procurement_share_pct"].max(), shared["serving_share_pct"].max()) * 1.05
    )
    ax.plot([0, axis_max], [0, axis_max], linestyle="--", color="gray", linewidth=1)

    for _, row in shared.iterrows():
        ax.annotate(
            clean_category_label(row["category"]),
            (row["procurement_share_pct"], row["serving_share_pct"]),
            fontsize=8,
            alpha=0.9,
        )

    set_title_font(ax, "Category Share: Procurement vs Serving")
    ax.set_xlabel("Procurement share of total weight (%)")
    ax.set_ylabel("Serving share of total servings (%)")
    add_grid(ax, alpha=0.3)
    plt.tight_layout()
    return fig


def plot_share_comparison(
    comparison_result: dict[str, Any],
    *,
    top_n: int = 12,
    figsize: tuple[float, float] = (11, 6),
) -> plt.Figure:
    """Plot the biggest total-share gaps side by side."""
    data = comparison_result["top_share_gaps"].head(top_n).copy()
    fig, ax = plt.subplots(figsize=figsize)

    if data.empty:
        ax.text(0.5, 0.5, "No shared active categories to compare.", ha="center", va="center")
        ax.axis("off")
        return fig

    plot_data = data.iloc[::-1].copy()
    labels = [clean_category_label(category) for category in plot_data["category"]]
    positions = np.arange(len(plot_data))
    width = 0.38

    ax.barh(
        positions - width / 2,
        plot_data["procurement_share_pct"],
        height=width,
        color=GBD_COLORS[0],
        label="Procurement share",
    )
    ax.barh(
        positions + width / 2,
        plot_data["serving_share_pct"],
        height=width,
        color=GBD_COLORS[1],
        label="Serving share",
    )
    ax.set_yticks(positions)
    ax.set_yticklabels(labels)
    set_title_font(ax, "Largest Category Share Gaps")
    ax.set_xlabel("Share of each dataset total (%)")
    ax.legend()
    add_grid(ax, axis="x", alpha=0.3)
    plt.tight_layout()
    return fig


def plot_per_person_share_comparison(
    comparison_result: dict[str, Any],
    *,
    top_n: int = 12,
    figsize: tuple[float, float] = (11, 6),
) -> plt.Figure:
    """Plot the biggest per-person share gaps side by side."""
    data = comparison_result["top_per_person_share_gaps"].head(top_n).copy()
    fig, ax = plt.subplots(figsize=figsize)

    if data.empty:
        ax.text(0.5, 0.5, "No shared active categories to compare.", ha="center", va="center")
        ax.axis("off")
        return fig

    plot_data = data.iloc[::-1].copy()
    labels = [clean_category_label(category) for category in plot_data["category"]]
    positions = np.arange(len(plot_data))
    width = 0.38

    ax.barh(
        positions - width / 2,
        plot_data["procurement_per_person_share_pct"],
        height=width,
        color=GBD_COLORS[2],
        label="Procurement per-person share",
    )
    ax.barh(
        positions + width / 2,
        plot_data["serving_per_person_share_pct"],
        height=width,
        color=GBD_COLORS[3],
        label="Serving per-person share",
    )
    ax.set_yticks(positions)
    ax.set_yticklabels(labels)
    set_title_font(ax, "Largest Per-Person Category Share Gaps")
    ax.set_xlabel("Share of each dataset per-person total (%)")
    ax.legend()
    add_grid(ax, axis="x", alpha=0.3)
    plt.tight_layout()
    return fig


def plot_diner_number_comparison(
    comparison_result: dict[str, Any],
    figsize: tuple[float, float] = (9, 4.5),
) -> plt.Figure:
    """Plot procurement and serving diner or meal counts by month."""
    data = comparison_result["diner_number_comparison"]["table"].copy()

    fig, ax = plt.subplots(figsize=figsize)
    if data.empty:
        ax.text(0.5, 0.5, "No diner or meal numbers available.", ha="center", va="center")
        ax.axis("off")
        return fig

    positions = np.arange(len(data))
    width = 0.38
    ax.bar(
        positions - width / 2,
        data["value_procurement"],
        width=width,
        color=GBD_COLORS[0],
        label="Procurement",
    )
    ax.bar(
        positions + width / 2,
        data["value_serving"],
        width=width,
        color=GBD_COLORS[1],
        label="Serving",
    )
    ax.set_xticks(positions)
    ax.set_xticklabels(data["month_year"].tolist())
    set_title_font(ax, "Diner or Meal Numbers by Month")
    ax.set_ylabel("Count")
    ax.legend()
    add_grid(ax, axis="y", alpha=0.3)
    plt.tight_layout()
    return fig


def plot_monthly_category_share_comparison(
    comparison_result: dict[str, Any],
    month: str,
    *,
    top_n: int = 10,
    figsize: tuple[float, float] = (11, 5.5),
) -> plt.Figure:
    """Plot the biggest category-share gaps for one month."""
    monthly = comparison_result["monthly_comparisons"]
    if month not in monthly:
        raise KeyError(f"Month {month!r} not found in monthly comparisons.")

    data = (
        monthly[month]
        .loc[monthly[month]["share_gap_pct_pts"].notna()]
        .sort_values("share_gap_pct_pts", ascending=False)
        .head(top_n)
        .iloc[::-1]
        .copy()
    )

    fig, ax = plt.subplots(figsize=figsize)
    if data.empty:
        ax.text(
            0.5,
            0.5,
            "No shared active categories to compare for this month.",
            ha="center",
            va="center",
        )
        ax.axis("off")
        return fig

    positions = np.arange(len(data))
    width = 0.38
    ax.barh(
        positions - width / 2,
        data["procurement_share_pct"],
        height=width,
        color=GBD_COLORS[0],
        label="Procurement share",
    )
    ax.barh(
        positions + width / 2,
        data["serving_share_pct"],
        height=width,
        color=GBD_COLORS[1],
        label="Serving share",
    )
    ax.set_yticks(positions)
    ax.set_yticklabels([clean_category_label(category) for category in data["category"]])
    set_title_font(ax, f"Monthly Category Share Gaps: {month}")
    ax.set_xlabel("Share of that month total (%)")
    ax.legend()
    add_grid(ax, axis="x", alpha=0.3)
    plt.tight_layout()
    return fig
