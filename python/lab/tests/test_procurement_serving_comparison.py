from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights_lab.procurement_serving_comparison import (
    build_gap_tables,
    compare_diner_numbers,
    compare_month_coverage,
    compare_monthly_categories,
    compare_overall_categories,
    find_baseline_summary_workbooks,
    load_baseline_workbook_data,
    plot_diner_number_comparison,
    plot_per_person_share_comparison,
    plot_share_comparison,
    plot_share_scatter,
    split_activity_tables,
    summarize_procurement_serving_comparison,
)


def _write_legacy_summary_workbook(
    path: Path,
    *,
    monthly_category_rows: list[dict],
    template_rows: list[dict],
    diner_numbers: dict[str, float],
) -> None:
    monthly_product_col = (
        "kilos total" if "purchasing-procurement data" in str(path.parent) else "servings total"
    )
    monthly_per_person_col = (
        "kilos per person" if monthly_product_col == "kilos total" else "servings per person"
    )

    monthly_product_data = pd.DataFrame(
        {
            "month_year": [row["month_year"] for row in monthly_category_rows],
            "product": [f"{row['category']} item" for row in monthly_category_rows],
            monthly_product_col: [row["total"] for row in monthly_category_rows],
            monthly_per_person_col: [row["per_person"] for row in monthly_category_rows],
        }
    )
    monthly_category_data = pd.DataFrame(
        {
            "month_year": [row["month_year"] for row in monthly_category_rows],
            "category": [row["category"] for row in monthly_category_rows],
            monthly_product_col: [row["total"] for row in monthly_category_rows],
            monthly_per_person_col: [row["per_person"] for row in monthly_category_rows],
        }
    )
    monthly_product_pivot = monthly_product_data.pivot_table(
        index="product",
        columns="month_year",
        values=monthly_product_col,
        aggfunc="sum",
        fill_value=0,
    ).reset_index()
    monthly_product_pivot["total"] = monthly_product_pivot.drop(columns=["product"]).sum(axis=1)
    template_data = pd.DataFrame(template_rows)
    diner_numbers_df = pd.DataFrame([diner_numbers])

    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        monthly_product_data.to_excel(writer, sheet_name="Monthly Product Data", index=False)
        monthly_product_pivot.to_excel(
            writer, sheet_name="Monthly Product Data pivotted", index=False
        )
        monthly_category_data.to_excel(writer, sheet_name="Monthly Category Data", index=False)
        template_data.to_excel(writer, sheet_name="Template Data", index=False)
        diner_numbers_df.to_excel(writer, sheet_name="Diner Numbers", index=False)


def _make_baseline_pair(
    tmp_path: Path,
    *,
    procurement_monthly_rows: list[dict],
    serving_monthly_rows: list[dict],
    procurement_diners: dict[str, float] | None = None,
    serving_diners: dict[str, float] | None = None,
) -> Path:
    baseline = tmp_path / "client" / "baseline"
    procurement_dir = baseline / "purchasing-procurement data"
    serving_dir = baseline / "sales-serving data"
    procurement_dir.mkdir(parents=True)
    serving_dir.mkdir(parents=True)

    procurement_path = (
        procurement_dir / "client_baseline_purchasing-procurement data_full_summary.xlsx"
    )
    serving_path = serving_dir / "client_baseline_sales-serving data_full_summary.xlsx"

    template_rows = [
        {"category": "beef and buffalo meat", "2024-01": 10, "2024-02": 11, "total": 21},
        {"category": "legumes", "2024-01": 5, "2024-02": 6, "total": 11},
        {"category": "total", "2024-01": 15, "2024-02": 17, "total": 32},
    ]

    _write_legacy_summary_workbook(
        procurement_path,
        monthly_category_rows=procurement_monthly_rows,
        template_rows=template_rows,
        diner_numbers=procurement_diners or {"2024-01": 1000, "2024-02": 1100, "total": 2100},
    )
    _write_legacy_summary_workbook(
        serving_path,
        monthly_category_rows=serving_monthly_rows,
        template_rows=template_rows,
        diner_numbers=serving_diners or {"2024-01": 1000, "2024-02": 1100, "total": 2100},
    )
    return baseline


def _build_comparison_result(baseline: Path) -> dict:
    workbook_paths = find_baseline_summary_workbooks(baseline)
    loaded_data = load_baseline_workbook_data(
        workbook_paths["procurement_workbook_path"],
        workbook_paths["serving_workbook_path"],
    )
    month_coverage = compare_month_coverage(
        loaded_data["procurement_monthly"],
        loaded_data["serving_monthly"],
    )
    diner_number_comparison = compare_diner_numbers(
        loaded_data["procurement_diners"],
        loaded_data["serving_diners"],
    )
    overall_category_comparison = compare_overall_categories(
        loaded_data["full_comparison_category_list"],
        loaded_data["procurement_monthly"],
        loaded_data["serving_monthly"],
        loaded_data["procurement_template"],
        loaded_data["serving_template"],
        loaded_data["official_gbd_category_list"],
    )
    activity_tables = split_activity_tables(overall_category_comparison)
    gap_tables = build_gap_tables(overall_category_comparison)
    monthly_comparisons = compare_monthly_categories(
        loaded_data["full_comparison_category_list"],
        month_coverage,
        loaded_data["procurement_monthly"],
        loaded_data["serving_monthly"],
    )

    comparison_result = {
        **workbook_paths,
        "official_gbd_category_list": loaded_data["official_gbd_category_list"],
        "extra_client_categories": loaded_data["extra_client_categories"],
        "procurement_non_gbd_categories": loaded_data["procurement_non_gbd_categories"],
        "serving_non_gbd_categories": loaded_data["serving_non_gbd_categories"],
        "month_coverage": month_coverage,
        "months_match": month_coverage["months_match"],
        "months_only_in_procurement": month_coverage["months_only_in_procurement"],
        "months_only_in_serving": month_coverage["months_only_in_serving"],
        "diner_number_comparison": diner_number_comparison,
        "overall_category_comparison": overall_category_comparison,
        "active_only_in_procurement": activity_tables["active_only_in_procurement"],
        "active_only_in_serving": activity_tables["active_only_in_serving"],
        "inactive_in_both": activity_tables["inactive_in_both"],
        "top_share_gaps": gap_tables["top_share_gaps"],
        "top_rank_gaps": gap_tables["top_rank_gaps"],
        "top_per_person_share_gaps": gap_tables["top_per_person_share_gaps"],
        "monthly_comparisons": monthly_comparisons,
    }
    comparison_result["summary_findings"] = summarize_procurement_serving_comparison(
        comparison_result
    )
    return comparison_result


def test_find_baseline_summary_workbooks_finds_expected_pair(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 5, "per_person": 0.0045},
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 8,
                "per_person": 0.008,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 7, "per_person": 0.0064},
        ],
    )

    result = find_baseline_summary_workbooks(baseline)

    assert result["procurement_workbook_path"].endswith(
        "_purchasing-procurement data_full_summary.xlsx"
    )
    assert result["serving_workbook_path"].endswith("_sales-serving data_full_summary.xlsx")


def test_find_baseline_summary_workbooks_raises_on_multiple_matches(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 8,
                "per_person": 0.008,
            },
        ],
    )
    extra = baseline / "purchasing-procurement data" / "extra_full_summary.xlsx"
    extra.write_text("placeholder")

    with pytest.raises(ValueError, match="Expected exactly one workbook"):
        find_baseline_summary_workbooks(baseline)


def test_stepwise_comparison_uses_official_gbd_category_list_and_surfaces_joint_inactivity(
    tmp_path: Path,
):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 6, "per_person": 0.0055},
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 9,
                "per_person": 0.009,
            },
        ],
    )

    result = _build_comparison_result(baseline)
    overall = result["overall_category_comparison"]
    inactive_categories = set(result["inactive_in_both"]["category"].tolist())

    legumes_row = overall.loc[overall["category"].astype(str).str.lower() == "legumes"].iloc[0]

    assert len(result["official_gbd_category_list"]) > len({"beef and buffalo meat", "legumes"})
    assert len(inactive_categories) > 0
    assert legumes_row["activity_status"] == "active only in procurement"
    assert inactive_categories.issubset(set(result["official_gbd_category_list"]))
    assert "official_gbd_order" not in overall.columns


def test_stepwise_comparison_tracks_non_gbd_categories_by_dataset(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "mystery procurement category",
                "total": 10,
                "per_person": 0.01,
            },
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "mystery serving category",
                "total": 9,
                "per_person": 0.009,
            },
        ],
    )

    result = _build_comparison_result(baseline)

    assert result["procurement_non_gbd_categories"] == ["mystery procurement category"]
    assert result["serving_non_gbd_categories"] == ["mystery serving category"]


def test_stepwise_comparison_builds_monthly_comparisons_when_months_match(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 12,
                "per_person": 0.012,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 8, "per_person": 0.0073},
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 9, "per_person": 0.0082},
        ],
    )

    result = _build_comparison_result(baseline)

    assert result["months_match"] is True
    assert set(result["monthly_comparisons"].keys()) == {"2024-01", "2024-02"}


def test_stepwise_comparison_skips_monthly_comparisons_when_months_differ(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 12,
                "per_person": 0.012,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 8, "per_person": 0.0073},
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
            {"month_year": "2024-03", "category": "legumes", "total": 9, "per_person": 0.0082},
        ],
    )

    result = _build_comparison_result(baseline)

    assert result["months_match"] is False
    assert result["monthly_comparisons"] == {}
    assert result["months_only_in_procurement"] == ["2024-02"]
    assert result["months_only_in_serving"] == ["2024-03"]


def test_stepwise_comparison_describes_diner_differences_without_failing(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 12,
                "per_person": 0.012,
            },
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
        ],
        procurement_diners={"2024-01": 1000, "2024-02": 1100, "total": 2100},
        serving_diners={"2024-01": 1040, "2024-02": 1122, "total": 2162},
    )

    result = _build_comparison_result(baseline)
    diner_comparison = result["diner_number_comparison"]

    assert diner_comparison["exact_match"] is False
    assert "close" in diner_comparison["interpretation"].lower()
    assert diner_comparison["table"]["abs_gap"].sum() > 0


def test_plot_helpers_return_figures(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 12,
                "per_person": 0.012,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 8, "per_person": 0.0073},
        ],
        serving_monthly_rows=[
            {
                "month_year": "2024-01",
                "category": "beef and buffalo meat",
                "total": 10,
                "per_person": 0.01,
            },
            {"month_year": "2024-02", "category": "legumes", "total": 9, "per_person": 0.0082},
        ],
    )
    result = _build_comparison_result(baseline)

    figures = [
        plot_share_scatter(result),
        plot_share_comparison(result),
        plot_diner_number_comparison(result),
        plot_per_person_share_comparison(result),
    ]

    for fig in figures:
        assert isinstance(fig, plt.Figure)
        plt.close(fig)
