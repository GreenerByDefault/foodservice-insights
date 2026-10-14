from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.excel import write_client_workbook
from gbd_foodservice_insights.report.food_report import build_food_report
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.schema import DinerOrMeal
from gbd_foodservice_insights_lab.food_report.serving import (
    SERVINGS,
    build_serving_report,
    write_serving_workbook,
)
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

JAN, FEB, MAR = pd.period_range("2024-01", periods=3, freq="M")
BEEF = "Beef and Buffalo Meat"
LEGUMES = "Legumes"

# One (month, category, amount) per row: kilos for procurement, servings for serving.
Rows = list[tuple[pd.Period, str, float]]


def _rows(rows: Rows, metric_column: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": [month.to_timestamp() + pd.Timedelta(days=14) for month, _, _ in rows],
            "product": [f"{category} item" for _, category, _ in rows],
            "category": [category for _, category, _ in rows],
            metric_column: [amount for _, _, amount in rows],
        }
    )


def _workbook_path(data_folder: Path) -> Path:
    """Where step 2 writes the client workbook for an input in ``data_folder``."""
    out_dir = data_folder / "outputs" / "acme"
    out_dir.mkdir(parents=True)
    return out_dir / "food_report_acme.xlsx"


def _make_baseline_pair(
    tmp_path: Path,
    *,
    procurement_rows: Rows,
    serving_rows: Rows,
    procurement_counts: dict[pd.Period, float] | None = None,
    serving_counts: dict[pd.Period, float] | None = None,
    diner_or_meal: DinerOrMeal = "diner",
) -> Path:
    baseline = tmp_path / "client" / "baseline"
    default_counts = {JAN: 1000, FEB: 1100, MAR: 1200}
    write_client_workbook(
        build_food_report(
            _rows(procurement_rows, KILOS.column),
            diner_meal_mapping=procurement_counts or default_counts,
            region="us",
            diner_or_meal=diner_or_meal,
            top_n_drivers=5,
        ),
        _workbook_path(baseline / "purchasing-procurement data"),
    )
    write_serving_workbook(
        build_serving_report(
            _rows(serving_rows, SERVINGS.column),
            diner_meal_mapping=serving_counts or default_counts,
            diner_or_meal=diner_or_meal,
            top_n_drivers=5,
        ),
        _workbook_path(baseline / "sales-serving data"),
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


def test_find_baseline_summary_workbooks_skips_the_qa_workbook(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path, procurement_rows=[(JAN, BEEF, 10)], serving_rows=[(JAN, BEEF, 8)]
    )
    qa_workbook = baseline / "sales-serving data" / "outputs" / "acme" / "food_report_acme_qa.xlsx"
    qa_workbook.write_text("placeholder")

    result = find_baseline_summary_workbooks(baseline)

    assert (
        Path(result["procurement_workbook_path"])
        == (
            baseline / "purchasing-procurement data" / "outputs" / "acme" / "food_report_acme.xlsx"
        ).resolve()
    )
    assert (
        Path(result["serving_workbook_path"])
        == (
            baseline / "sales-serving data" / "outputs" / "acme" / "food_report_acme.xlsx"
        ).resolve()
    )


def test_find_baseline_summary_workbooks_raises_on_multiple_matches(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path, procurement_rows=[(JAN, BEEF, 10)], serving_rows=[(JAN, BEEF, 8)]
    )
    extra = baseline / "purchasing-procurement data" / "outputs" / "other"
    extra.mkdir()
    (extra / "food_report_other.xlsx").write_text("placeholder")

    with pytest.raises(ValueError, match="Expected exactly one workbook"):
        find_baseline_summary_workbooks(baseline)


@pytest.mark.parametrize("diner_or_meal", ["diner", "meal"])
def test_load_baseline_workbook_data_reads_step_2_workbooks(
    tmp_path: Path, diner_or_meal: DinerOrMeal
):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 10), (FEB, LEGUMES, 22)],
        serving_rows=[(JAN, BEEF, 8)],
        procurement_counts={JAN: 1000, FEB: 1100},
        serving_counts={JAN: 1040},
        diner_or_meal=diner_or_meal,
    )
    paths = find_baseline_summary_workbooks(baseline)

    loaded = load_baseline_workbook_data(
        paths["procurement_workbook_path"], paths["serving_workbook_path"]
    )

    pd.testing.assert_frame_equal(
        loaded["procurement_monthly"],
        pd.DataFrame(
            {
                "month_year": ["2024-01", "2024-02"],
                "category": [BEEF, LEGUMES],
                "kilos total": [10, 22],
                "kilos per person": [0.01, 0.02],
            }
        ),
    )
    pd.testing.assert_frame_equal(
        loaded["serving_monthly"],
        pd.DataFrame(
            {
                "month_year": ["2024-01"],
                "category": [BEEF],
                "servings total": [8],
                "servings per person": [8 / 1040],
            }
        ),
    )
    pd.testing.assert_frame_equal(
        loaded["procurement_diners"],
        pd.DataFrame({"month_year": ["2024-01", "2024-02"], "value": [1000.0, 1100.0]}),
    )
    pd.testing.assert_frame_equal(
        loaded["serving_diners"], pd.DataFrame({"month_year": ["2024-01"], "value": [1040.0]})
    )


def test_load_baseline_workbook_data_rejects_a_workbook_missing_a_sheet(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path, procurement_rows=[(JAN, BEEF, 10)], serving_rows=[(JAN, BEEF, 8)]
    )
    paths = find_baseline_summary_workbooks(baseline)
    with pd.ExcelWriter(paths["serving_workbook_path"], engine="openpyxl") as writer:
        pd.DataFrame({"category": [BEEF]}).to_excel(writer, sheet_name="Template", index=False)

    with pytest.raises(ValueError, match="needs 'Monthly by Category'"):
        load_baseline_workbook_data(
            paths["procurement_workbook_path"], paths["serving_workbook_path"]
        )


def test_stepwise_comparison_uses_official_gbd_category_list_and_surfaces_joint_inactivity(
    tmp_path: Path,
):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 10), (FEB, LEGUMES, 6)],
        serving_rows=[(JAN, BEEF, 9)],
    )

    result = _build_comparison_result(baseline)
    overall = result["overall_category_comparison"]
    inactive_categories = set(result["inactive_in_both"]["category"].tolist())

    legumes_row = overall.loc[overall["category"] == LEGUMES].iloc[0]

    assert len(result["official_gbd_category_list"]) > len({BEEF, LEGUMES})
    assert len(inactive_categories) > 0
    assert legumes_row["activity_status"] == "active only in procurement"
    assert inactive_categories.issubset(set(result["official_gbd_category_list"]))
    assert "official_gbd_order" not in overall.columns


def test_stepwise_comparison_builds_monthly_comparisons_when_months_match(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 12), (FEB, LEGUMES, 8)],
        serving_rows=[(JAN, BEEF, 10), (FEB, LEGUMES, 9)],
    )

    result = _build_comparison_result(baseline)

    assert result["months_match"] is True
    assert set(result["monthly_comparisons"].keys()) == {"2024-01", "2024-02"}


def test_stepwise_comparison_skips_monthly_comparisons_when_months_differ(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 12), (FEB, LEGUMES, 8)],
        serving_rows=[(JAN, BEEF, 10), (MAR, LEGUMES, 9)],
    )

    result = _build_comparison_result(baseline)

    assert result["months_match"] is False
    assert result["monthly_comparisons"] == {}
    assert result["months_only_in_procurement"] == ["2024-02"]
    assert result["months_only_in_serving"] == ["2024-03"]


def test_stepwise_comparison_describes_diner_differences_without_failing(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 12)],
        serving_rows=[(JAN, BEEF, 10)],
        procurement_counts={JAN: 1000, FEB: 1100},
        serving_counts={JAN: 1040, FEB: 1122},
    )

    result = _build_comparison_result(baseline)
    diner_comparison = result["diner_number_comparison"]

    assert diner_comparison["exact_match"] is False
    assert "close" in diner_comparison["interpretation"].lower()
    assert diner_comparison["table"]["abs_gap"].sum() > 0


def test_plot_helpers_return_figures(tmp_path: Path):
    baseline = _make_baseline_pair(
        tmp_path,
        procurement_rows=[(JAN, BEEF, 12), (FEB, LEGUMES, 8)],
        serving_rows=[(JAN, BEEF, 10), (FEB, LEGUMES, 9)],
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
