import gbd_foodservice_insights.report.diagnostics as report_diagnostics
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.diagnostics import (
    check_aggregation_reconciliation,
    check_category_concentration,
    check_diner_meal_reasonableness,
    check_missing_internal_months,
    check_missing_weeks_within_month,
    check_per_product_weight_bounds,
    check_single_product_dominance,
    clean_column_names,
    detect_category_discontinuity,
    detect_exact_duplicate_rows,
    detect_month_over_month_total_volatility,
    detect_near_duplicate_product_names,
    detect_numeric_coercion_loss,
    detect_unusual_sales,
    find_close_product_pairs,
    parse_and_validate_date_column,
    run_all_diagnostics,
    summarise_numeric_columns,
)


def test_clean_column_names():
    data = {"A B C": [1], "  leading_space": [2], "trailing_space  ": [3], "ALL CAPS": [4]}
    df = pd.DataFrame(data)
    cleaned_df = clean_column_names(df)
    expected_columns = ["a_b_c", "leading_space", "trailing_space", "all_caps"]
    assert list(cleaned_df.columns) == expected_columns


@pytest.fixture
def numeric_summary_df():
    """
    Fixture for creating a sample DataFrame for testing summarise_numeric_columns.
    """
    data = {
        "col_a": [1, 2, 3, 4, 5],
        "col_b": [10.0, 20.0, -5.0, np.nan, 30.0],
        "col_c": [-1, -2, -3, -4, -5],
        "page": [1, 1, 1, 1, 1],  # Should be ignored
        "non_numeric": ["a", "b", "c", "d", "e"],
    }
    return pd.DataFrame(data)


def test_summarise_numeric_columns_all_numeric(numeric_summary_df):
    summary_df = summarise_numeric_columns(numeric_summary_df)
    assert len(summary_df) == 3  # col_a, col_b, col_c
    assert "page" not in summary_df["column"].values

    col_b_summary = summary_df[summary_df["column"] == "col_b"].iloc[0]
    assert col_b_summary["mean"] == 13.75
    assert col_b_summary["median"] == 15.0
    assert col_b_summary["highest"] == 30.0
    assert col_b_summary["lowest"] == -5.0
    assert col_b_summary["negative_values_count"] == 1
    assert col_b_summary["nan_count"] == 1


def test_summarise_numeric_columns_specific_columns(numeric_summary_df):
    summary_df = summarise_numeric_columns(numeric_summary_df, numeric_columns=["col_a", "col_c"])
    assert len(summary_df) == 2
    assert "col_a" in summary_df["column"].values
    assert "col_c" in summary_df["column"].values

    col_c_summary = summary_df[summary_df["column"] == "col_c"].iloc[0]
    assert col_c_summary["mean"] == -3.0
    assert col_c_summary["negative_values_count"] == 5


def test_summarise_numeric_columns_raises_error_for_missing_column(numeric_summary_df):
    with pytest.raises(AssertionError, match="Column 'non_existent_col' not found in DataFrame"):
        summarise_numeric_columns(numeric_summary_df, numeric_columns=["non_existent_col"])


@pytest.fixture
def close_pairs_df():
    """
    Fixture for creating a sample DataFrame for testing find_close_product_pairs.
    """
    products = ["testing", "testin", "test", "tesing", "producta", "productb"]  # codespell:ignore
    data = {"product": products}
    return pd.DataFrame(data)


def test_find_close_product_pairs_finds_pairs(close_pairs_df):
    close_pairs = find_close_product_pairs(close_pairs_df, "product")
    assert len(close_pairs) == 5
    # Examples of pairs that should be found
    # ('testing', 'testin') -> dist 1
    # ('testing', 'tesing') -> dist 1
    # ('testin', 'tesing') -> dist 2
    # ('testin', 'test') -> dist 2

    # Check for one specific pair
    pair = close_pairs[close_pairs["Product 1"] == "tesing"]
    assert pair["Product 2"].iloc[0] == "testing"


def test_find_close_product_pairs_sorting(close_pairs_df):
    df = pd.DataFrame(
        {"product": ["apple"] * 10 + ["apply"] * 2 + ["apricot"] * 8 + ["apriot"] * 1}
    )
    close_pairs = find_close_product_pairs(df, "product")
    assert close_pairs["distance_between_counts"].is_monotonic_decreasing
    assert close_pairs.iloc[0]["Product 1"] == "apple"
    assert close_pairs.iloc[0]["Product 2"] == "apply"
    assert close_pairs.iloc[0]["distance_between_counts"] == 8


def test_find_close_product_pairs_includes_combined_metric_share_when_requested():
    """Adds weighted materiality so likely name splits can be prioritised sensibly."""
    df = pd.DataFrame(
        {
            "product": ["apple", "apple", "apply", "apricot"],
            "kilos_total": [4.0, 6.0, 5.0, 5.0],
        }
    )

    close_pairs = find_close_product_pairs(df, "product", metric_column="kilos_total")

    assert "Combined Metric Share" in close_pairs.columns
    apple_pair = close_pairs.iloc[0]
    assert apple_pair["Product 1"] == "apple"
    assert apple_pair["Product 2"] == "apply"
    assert apple_pair["Combined Metric Total"] == pytest.approx(15.0)
    assert apple_pair["Combined Metric Share"] == pytest.approx(0.75)


@pytest.fixture
def unusual_sales_df():
    """
    Fixture for creating a sample DataFrame for testing detect_unusual_sales.
    """
    data = {
        "date": pd.to_datetime(
            [
                "2025-01-01",
                "2025-01-02",
                "2025-01-03",
                "2025-01-04",
                "2025-01-05",
                "2025-01-06",
                "2025-01-07",
                "2025-01-08",
                "2025-01-09",
                "2025-01-10",
                "2025-01-11",
                "2025-01-12",
                "2025-01-13",
                "2025-01-14",
                "2025-01-15",
            ]
        ),
        "product_name": ["Bean Chili"] * 5 + ["Lentil Soup"] * 5 + ["Tofu Curry"] * 5,
        "category": ["Legumes"] * 5 + ["Poultry"] * 5 + ["Plant-based meats"] * 5,
        "quantity_sold": [10, 11, 12, 10, 50, 5, 5, 5, 5, 60, 8, 9, 10, 8, 9],
    }
    return pd.DataFrame(data)


def test_detect_unusual_sales(unusual_sales_df):
    """Flags category-level line-item outliers and returns an export-ready table."""
    findings, outlier_rows = detect_unusual_sales(
        unusual_sales_df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        threshold=5,
        return_details=True,
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert any("Bean Chili" in sample for sample in findings[0]["sample_values"])
    assert set(outlier_rows["product_name"]) == {"Bean Chili", "Lentil Soup"}
    assert "ratio_to_category_median" in outlier_rows.columns
    assert outlier_rows["flag_reason"].str.len().gt(0).all()


def test_detect_unusual_sales_no_abnormal(unusual_sales_df):
    """Returns no flagged products when category-level values stay within the normal range."""
    df = pd.DataFrame(
        {
            "product_name": ["A"] * 5,
            "category": ["Legumes"] * 5,
            "quantity_sold": [10, 11, 10, 9, 12],
        }
    )
    abnormal_products = detect_unusual_sales(
        df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        threshold=5,
    )
    assert len(abnormal_products) == 0


def test_detect_unusual_sales_handles_string_metric_values_when_returning_details():
    """
    Uses coerced numeric values in the finding text so messy string numerics do not crash
    diagnostics.
    """
    df = pd.DataFrame(
        {
            "product_name": ["Bean Chili"] * 5 + ["Tofu Curry"] * 5,
            "category": ["Legumes"] * 5 + ["Plant-based meats"] * 5,
            "quantity_sold": ["10", "11", "12", "10", "50", "8", "9", "10", "8", "9"],
        }
    )

    findings, outlier_rows = detect_unusual_sales(
        df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        threshold=5,
        return_details=True,
    )

    assert findings[0]["status"] == "warning"
    assert "50.00" in findings[0]["message"]
    assert any("50.00" in sample for sample in findings[0]["sample_values"])
    assert set(outlier_rows["product_name"]) == {"Bean Chili"}


def test_detect_unusual_sales_flags_severe_small_category_outlier():
    """
    A very obvious spike in a smaller category should still be surfaced rather than slipping
    through.
    """
    df = pd.DataFrame(
        {
            "product_name": ["Bean Chili"] * 4,
            "category": ["Legumes"] * 4,
            "quantity_sold": [5, 6, 5, 50],
        }
    )

    findings, outlier_rows = detect_unusual_sales(
        df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        return_details=True,
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert set(outlier_rows["product_name"]) == {"Bean Chili"}
    assert outlier_rows["flagged_by_small_category_ratio"].tolist() == [True]
    assert "small-category severe ratio fallback" in outlier_rows["flag_reason"].iloc[0]


def test_detect_exact_duplicate_rows_warns_and_returns_export_table():
    """
    Flags duplicate line items because duplicate transactions can overstate totals and emissions.
    """
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3 + [pd.Timestamp("2025-01-02")] * 197,
            "product": ["Tofu"] * 3 + [f"Item {i}" for i in range(197)],
            "category": ["Legumes"] * 3 + ["Legumes"] * 197,
            "kilos_total": [5.0] * 3 + [float(i + 1) for i in range(197)],
            "quantity": [2] * 3 + [1] * 197,
        }
    )
    df.loc[1:2, ["product", "kilos_total", "quantity"]] = ["Tofu", 5.0, 2]

    findings, duplicate_rows = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert len(findings) == 1
    finding = findings[0]
    assert finding["status"] == "warning"
    assert finding["count"] == 3
    assert finding["metadata"]["duplicate_group_count"] == 1
    assert not duplicate_rows.empty
    assert "duplicate_group_size" in duplicate_rows.columns
    assert duplicate_rows["duplicate_group_size"].eq(3).all()


def test_detect_exact_duplicate_rows_errors_above_threshold():
    """Escalates when duplicate rows are common enough to suggest a serious data issue."""
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3 + [pd.Timestamp("2025-01-02")] * 97,
            "product": ["Beans"] * 3 + [f"Item {i}" for i in range(97)],
            "category": ["Legumes"] * 100,
            "kilos_total": [2.0] * 3 + [float(i + 1) for i in range(97)],
        }
    )
    df.loc[1:2, ["product", "kilos_total"]] = ["Beans", 2.0]

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "error"
    assert findings[0]["metadata"]["duplicate_row_share"] == pytest.approx(0.03)


def test_detect_exact_duplicate_rows_caps_month_bucketed_dates_at_warning():
    """
    Month/year-only client data should not hard-fail because transaction-level duplicate detection
    is ambiguous.
    """
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3 + [pd.Timestamp("2025-02-01")] * 97,
            "product": ["Beans"] * 3 + [f"Item {i}" for i in range(97)],
            "category": ["Legumes"] * 100,
            "kilos_total": [2.0] * 3 + [float(i + 1) for i in range(97)],
        }
    )
    df.loc[1:2, ["product", "kilos_total"]] = ["Beans", 2.0]

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["metadata"]["month_bucketed_dates"] is True
    assert "month-level placeholders" in findings[0]["message"]


def test_detect_exact_duplicate_rows_treats_month_only_string_dates_as_month_bucketed():
    """
    Month-only strings should be recognized as month-bucketed so duplicate severity is not
    overstated.
    """
    df = pd.DataFrame(
        {
            "date": ["04/2025"] * 3 + ["05/2025"] * 97,
            "product": ["Beans"] * 3 + [f"Item {i}" for i in range(97)],
            "category": ["Legumes"] * 100,
            "kilos_total": [2.0] * 3 + [float(i + 1) for i in range(97)],
        }
    )
    df.loc[1:2, ["product", "kilos_total"]] = ["Beans", 2.0]

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["metadata"]["month_bucketed_dates"] is True


def test_detect_exact_duplicate_rows_success_when_none_found():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-02")],
            "product": ["Beans", "Tofu"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": [2.0, 3.0],
        }
    )

    findings, duplicate_rows = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert duplicate_rows.empty


def test_detect_near_duplicate_product_names_warns_for_material_pdf_pairs():
    """PDF/OCR extracts should warn when likely name splits affect a meaningful share of volume."""
    df = pd.DataFrame(
        {
            "product": ["Chicken Curry", "Ch1cken Curry", "Tofu Stir Fry"],
            "kilos_total": [20.0, 15.0, 65.0],
        }
    )

    findings, export_df = detect_near_duplicate_product_names(
        df,
        metric_total="kilos_total",
        pdf_extracted=True,
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert "Chicken Curry" in findings[0]["sample_values"][0]
    assert "Ch1cken Curry" in findings[0]["sample_values"][0]
    assert not export_df.empty
    assert export_df.iloc[0]["Combined Metric Share"] == pytest.approx(0.35)


def test_detect_near_duplicate_product_names_keeps_tabular_pairs_as_info():
    """The same likely split is lower-severity in tabular data because OCR risk is lower."""
    df = pd.DataFrame(
        {
            "product": ["Chicken Curry", "Ch1cken Curry", "Tofu Stir Fry"],
            "kilos_total": [20.0, 15.0, 65.0],
        }
    )

    findings, _ = detect_near_duplicate_product_names(
        df,
        metric_total="kilos_total",
        pdf_extracted=False,
    )

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 1


def test_detect_month_over_month_total_volatility_warns_for_large_swings():
    """Flags large month-to-month total changes before they distort trend storytelling."""
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=4, freq="M"),
            "kilos_total": [100.0, 140.0, 80.0, 78.0],
        }
    )

    findings = detect_month_over_month_total_volatility(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert "Feb 2025" in findings[0]["sample_values"][0]
    assert "Mar 2025" in findings[0]["sample_values"][1]


def test_detect_month_over_month_total_volatility_succeeds_when_changes_are_small():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=3, freq="M"),
            "kilos_total": [100.0, 110.0, 108.0],
        }
    )

    findings = detect_month_over_month_total_volatility(df, metric_total="kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0


def test_check_missing_weeks_within_month_flags_long_internal_date_gap():
    """Flags long stretches with no transactions when the data really has day-level dates."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-01",
                    "2025-01-05",
                    "2025-01-20",
                    "2025-01-25",
                ]
            )
        }
    )

    findings = check_missing_weeks_within_month(df)

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 1
    assert "Jan 2025" in findings[0]["sample_values"][0]
    assert "2025-01-06 to 2025-01-19" in findings[0]["sample_values"][0]


def test_check_missing_weeks_within_month_flags_long_gap_at_start_of_month():
    """Partial extracts that begin late in the month should be surfaced."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-20",
                    "2025-01-25",
                    "2025-02-02",
                    "2025-02-04",
                ]
            )
        }
    )

    findings = check_missing_weeks_within_month(df)

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] >= 1
    assert any("2025-01-01 to 2025-01-19" in sample for sample in findings[0]["sample_values"])


def test_check_missing_weeks_within_month_flags_long_gap_at_end_of_month():
    """Partial extracts that stop early in the month should also be surfaced."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-02",
                    "2025-01-05",
                    "2025-02-01",
                    "2025-02-04",
                ]
            )
        }
    )

    findings = check_missing_weeks_within_month(df)

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] >= 1
    assert any("2025-01-06 to 2025-01-31" in sample for sample in findings[0]["sample_values"])


def test_check_missing_weeks_within_month_skips_month_only_date_strings():
    df = pd.DataFrame(
        {
            "date": ["01/2025", "02/2025", "03/2025"],
        }
    )

    findings = check_missing_weeks_within_month(df)

    assert findings == []


def test_check_missing_weeks_within_month_skips_one_date_per_month_series():
    """A cleaned monthly series with one repeated day-of-month should not trigger A14."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-15",
                    "2025-01-15",
                    "2025-02-15",
                    "2025-03-15",
                ]
            )
        }
    )

    findings = check_missing_weeks_within_month(df)

    assert findings == []


def test_check_missing_internal_months_warns_for_missing_middle_month():
    """Flags missing middle months because one gap can change the story in a short report window."""
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-01", freq="M"), pd.Period("2025-03", freq="M")],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = check_missing_internal_months(df)

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert findings[0]["sample_values"] == ["Feb 2025"]
    assert "one-third of the expected period is missing" in findings[0]["message"]


def test_check_missing_internal_months_accepts_month_only_date_strings():
    df = pd.DataFrame(
        {
            "date": ["01/2025", "03/2025"],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = check_missing_internal_months(df)

    assert findings[0]["status"] == "warning"
    assert findings[0]["sample_values"] == ["Feb 2025"]


def test_check_missing_internal_months_does_not_flag_boundary_months():
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-02", freq="M"), pd.Period("2025-03", freq="M")],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = check_missing_internal_months(df)

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0


def test_detect_category_discontinuity_warns_when_category_disappears_and_returns():
    """Flags a missing middle month because that often means a category-level data gap."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-10",
                    "2025-03-10",
                    "2025-01-15",
                    "2025-02-15",
                    "2025-03-15",
                ]
            ),
            "product": [
                "Bean Chili",
                "Bean Chili",
                "Tofu Curry",
                "Tofu Curry",
                "Tofu Curry",
            ],
            "category": [
                "Legumes",
                "Legumes",
                "Plant-based meats",
                "Plant-based meats",
                "Plant-based meats",
            ],
            "kilos_total": [10.0, 9.0, 4.0, 5.0, 6.0],
        }
    )

    findings, export_df = detect_category_discontinuity(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert "Legumes" in findings[0]["sample_values"][0]
    assert "Feb 2025" in findings[0]["sample_values"][0]
    assert export_df.iloc[0]["category"] == "Legumes"
    assert export_df.iloc[0]["gap_months"] == "Feb 2025"


def test_detect_category_discontinuity_accepts_month_only_date_strings():
    df = pd.DataFrame(
        {
            "date": [
                "01/2025",
                "03/2025",
                "01/2025",
                "02/2025",
                "03/2025",
            ],
            "product": [
                "Bean Chili",
                "Bean Chili",
                "Tofu Curry",
                "Tofu Curry",
                "Tofu Curry",
            ],
            "category": [
                "Legumes",
                "Legumes",
                "Plant-based meats",
                "Plant-based meats",
                "Plant-based meats",
            ],
            "kilos_total": [10.0, 9.0, 4.0, 5.0, 6.0],
        }
    )

    findings, export_df = detect_category_discontinuity(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert export_df.iloc[0]["gap_months"] == "Feb 2025"


def test_detect_category_discontinuity_succeeds_when_categories_are_continuous():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=3, freq="M").repeat(2),
            "category": [
                "Legumes",
                "Plant-based meats",
                "Legumes",
                "Plant-based meats",
                "Legumes",
                "Plant-based meats",
            ],
            "kilos_total": [10.0, 6.0, 11.0, 7.0, 9.0, 5.0],
        }
    )

    findings, export_df = detect_category_discontinuity(df, metric_total="kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert export_df.empty


def test_detect_category_discontinuity_reads_min_gap_months_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "category_discontinuity:",
                "  min_gap_months: 2",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(
                ["2025-01", "2025-03", "2025-01", "2025-02", "2025-03"], freq="M"
            ),
            "category": ["Legumes", "Legumes", "Poultry", "Poultry", "Poultry"],
            "kilos_total": [10.0, 9.0, 5.0, 6.0, 7.0],
        }
    )

    findings, _ = detect_category_discontinuity(df, metric_total="kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["metadata"]["min_gap_months"] == 2
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_diner_meal_reasonableness_respects_boundary_ratios():
    findings, export_df = check_diner_meal_reasonableness(
        {
            "2025-01": 50,
            "2025-02": 100,
            "2025-03": 200,
        }
    )

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert export_df["ratio_to_median"].tolist() == pytest.approx([0.5, 1.0, 2.0])
    assert not export_df["is_flagged"].any()


def test_check_diner_meal_reasonableness_flags_outside_boundary_ratios_and_escalates():
    findings, export_df = check_diner_meal_reasonableness(
        {
            "2025-01": 49,
            "2025-02": 100,
            "2025-03": 201,
        }
    )

    assert findings[0]["status"] == "error"
    assert findings[0]["count"] == 2
    assert export_df["ratio_to_median"].tolist() == pytest.approx([0.49, 1.0, 2.01])
    assert export_df["is_flagged"].tolist() == [True, False, True]


def test_check_diner_meal_reasonableness_reads_thresholds_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "diner_meal_count_reasonableness:",
                "  low_ratio_threshold: 0.8",
                "  high_ratio_threshold: 1.2",
                "  error_if_flagged_months: 3",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    findings, export_df = check_diner_meal_reasonableness(
        {
            "2025-01": 79,
            "2025-02": 100,
            "2025-03": 121,
        }
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert export_df["is_flagged"].tolist() == [True, False, True]
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_detect_exact_duplicate_rows_reads_thresholds_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "exact_duplicate_rows:",
                "  warning_share_threshold: 0.05",
                "  error_share_threshold: 0.10",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3 + [pd.Timestamp("2025-01-02")] * 97,
            "product": ["Beans"] * 3 + [f"Item {i}" for i in range(97)],
            "category": ["Legumes"] * 100,
            "kilos_total": [2.0] * 3 + [float(i + 1) for i in range(97)],
        }
    )
    df.loc[1:2, ["product", "kilos_total"]] = ["Beans", 2.0]

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["metadata"]["warning_share_threshold"] == pytest.approx(0.05)
    assert findings[0]["metadata"]["error_share_threshold"] == pytest.approx(0.10)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_detect_near_duplicate_product_names_reads_threshold_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "near_duplicate_product_names:",
                "  warning_share_threshold: 0.40",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "product": ["Chicken Curry", "Ch1cken Curry", "Tofu Stir Fry"],
            "kilos_total": [20.0, 15.0, 65.0],
        }
    )

    findings, _ = detect_near_duplicate_product_names(
        df,
        metric_total="kilos_total",
        pdf_extracted=True,
    )

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 0
    assert findings[0]["metadata"]["warning_share_threshold"] == pytest.approx(0.40)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_clean_column_names_empty_df():
    df = pd.DataFrame()
    cleaned_df = clean_column_names(df)
    assert cleaned_df.empty
    assert list(cleaned_df.columns) == []


def test_clean_column_names_already_clean():
    data = {"col1": [1], "col2": [2]}
    df = pd.DataFrame(data)
    cleaned_df = clean_column_names(df)
    assert list(cleaned_df.columns) == ["col1", "col2"]


def test_summarise_numeric_columns_no_numeric_cols():
    df = pd.DataFrame({"a": ["x", "y"], "b": ["z", "w"]})
    summary_df = summarise_numeric_columns(df)
    assert summary_df.empty


def test_summarise_numeric_columns_empty_df():
    df = pd.DataFrame({"a": pd.Series(dtype="float64"), "b": pd.Series(dtype="object")})
    summary_df = summarise_numeric_columns(df)
    # It should produce a summary for the numeric column 'a' with all zero/NaN values
    assert len(summary_df) == 1
    col_a_summary = summary_df[summary_df["column"] == "a"].iloc[0]
    assert col_a_summary["nan_count"] == 0  # An empty series has 0 NaNs
    assert np.isnan(col_a_summary["mean"])


def test_find_close_product_pairs_empty_df():
    df = pd.DataFrame({"product": pd.Series(dtype="str")})
    result_df = find_close_product_pairs(df, "product")
    assert result_df.empty


def test_find_close_product_pairs_one_product():
    df = pd.DataFrame({"product": ["apple", "apple"]})
    result_df = find_close_product_pairs(df, "product")
    assert result_df.empty


def test_detect_unusual_sales_empty_df():
    df = pd.DataFrame({"product_name": [], "category": [], "quantity_sold": []})
    result = detect_unusual_sales(df, "quantity_sold", "product_name")
    assert result == []


def test_detect_unusual_sales_key_error():
    df = pd.DataFrame({"p": ["A"], "q": [1]})
    with pytest.raises(KeyError):
        detect_unusual_sales(df, "quantity_sold", "product_name")


def test_detect_unusual_sales_returns_legacy_product_list():
    """Keeps the legacy return shape for callers that only need product names."""
    df = pd.DataFrame(
        {
            "product_name": ["A"] * 5 + ["B"] * 5,
            "category": ["Legumes"] * 5 + ["Poultry"] * 5,
            "quantity_sold": [10, 11, 12, 10, 50, 5, 5, 5, 5, 60],
        }
    )

    flagged_products = detect_unusual_sales(df, "quantity_sold", "product_name")

    assert flagged_products == ["A", "B"]


def test_detect_unusual_sales_reads_legacy_thresholds_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "outlier_line_items:",
                "  legacy_median_floor: 10",
                "  legacy_absolute_threshold_if_below_floor: 50",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "product_name": ["A"] * 5,
            "quantity_sold": [9, 9, 9, 9, 45],
        }
    )

    flagged_products = detect_unusual_sales(df, "quantity_sold", "product_name")

    assert flagged_products == []
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_per_product_weight_bounds_flags_rows_and_returns_export_table():
    """Hard bounds should catch near-certain unit errors and preserve row traceability."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"]),
            "product": ["Chickpeas", "Tofu", "Beans"],
            "category": ["Legumes", "Plant-based meats", "Legumes"],
            "kilos_total": [0.0005, 500.0, 700.0],
        },
        index=[10, 11, 12],
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, "kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert findings[0]["metadata"]["low"] == pytest.approx(0.001)
    assert findings[0]["metadata"]["high"] == pytest.approx(500.0)
    assert "Row 10: Chickpeas has 0.0005 kg" in findings[0]["sample_values"][0]
    assert list(flagged_rows["row_index"]) == [10, 12]
    assert list(flagged_rows["breached_bound"]) == ["lower", "upper"]
    assert list(flagged_rows["metric_value"]) == pytest.approx([0.0005, 700.0])


def test_check_per_product_weight_bounds_treats_boundaries_as_in_range():
    df = pd.DataFrame(
        {
            "product": ["Beans", "Tofu"],
            "kilos_total": [0.001, 500.0],
        }
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, "kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert flagged_rows.empty


def test_check_per_product_weight_bounds_reads_thresholds_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "per_product_weight_bounds:",
                "  low: 2",
                "  high: 10",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "product": ["Beans", "Tofu", "Tempeh"],
            "kilos_total": [1.5, 10.0, 11.0],
        }
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, "kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert findings[0]["metadata"]["low"] == pytest.approx(2.0)
    assert findings[0]["metadata"]["high"] == pytest.approx(10.0)
    assert list(flagged_rows["product"]) == ["Beans", "Tempeh"]
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_per_product_weight_bounds_uses_serving_thresholds_for_serving_metric():
    df = pd.DataFrame(
        {
            "product": ["Beans", "Soup", "Salad"],
            "servings total": [0.5, 600.0, 1200.0],
        },
        index=[20, 21, 22],
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, "servings total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["metadata"]["low"] == pytest.approx(1.0)
    assert findings[0]["metadata"]["high"] == pytest.approx(1000.0)
    assert findings[0]["metadata"]["unit_label"] == "servings"
    assert "0.5000 servings" in findings[0]["sample_values"][0]
    assert list(flagged_rows["row_index"]) == [20, 22]


def test_find_close_product_pairs_reads_max_levenshtein_distance_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "near_duplicate_product_names:",
                "  max_levenshtein_distance: 1",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame({"product": ["abcd", "abef"]})
    result_df = find_close_product_pairs(df, "product")

    assert result_df.empty
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_identify_potentially_abnormal_weight_meat_items_reads_threshold_from_yaml(
    tmp_path, monkeypatch
):
    """The large-quantity cutoff for meat items should be configurable in YAML."""
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "meat_quantity_reasonableness:",
                "  large_quantity_threshold: 50",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "category": ["Poultry (Chicken & Turkey)"] * 2,
            "quantity": [40, 2],
        }
    )

    result = report_diagnostics.identify_potentially_abnormal_weight_meat_items(df)

    assert result is True
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_date_distribution_reads_threshold_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "date_distribution:",
                "  partial_month_ratio_threshold: 0.2",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "month_year": ["2025-01"] * 4 + ["2025-02"] * 10 + ["2025-03"] * 10,
        }
    )

    findings = report_diagnostics.check_date_distribution(df)

    assert findings == []
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


# ----------------------------------------------------------------------
# Tests for parse_and_validate_date_column (moved from test_utils.py)
# ----------------------------------------------------------------------


class TestParseAndValidateDateColumn:
    """Tests for parse_and_validate_date_column function."""

    def test_parses_mixed_date_formats_with_diagnostics(self):
        df = pd.DataFrame(
            {
                "date": [
                    "2024-01-01",
                    "01/02/2024",
                    "03 Jan 2024",
                    "20240104",
                    45296,
                    1704499200,
                    1704585600000,
                    pd.Timestamp("2024-01-08 12:30:00-0500"),
                ]
            }
        )

        parsed_df, diagnostics = parse_and_validate_date_column(
            df,
            date_col="date",
            dayfirst_preference=False,
            return_diagnostics=True,
        )

        expected = pd.to_datetime(
            [
                "2024-01-01",
                "2024-01-02",
                "2024-01-03",
                "2024-01-04",
                "2024-01-05",
                "2024-01-06",
                "2024-01-07",
                "2024-01-08",
            ]
        )

        pd.testing.assert_series_equal(
            parsed_df["date"].reset_index(drop=True),
            pd.Series(expected, name="date"),
        )
        assert diagnostics["parse_status"].eq("parsed").all()
        assert {"original_value", "parsed_date", "parse_status", "parser_used"}.issubset(
            set(diagnostics.columns)
        )

    def test_raises_on_ambiguous_numeric_dates_without_preference(self):
        df = pd.DataFrame({"date": ["03/04/2025"]})

        with pytest.raises(ValueError, match="ambiguous"):
            parse_and_validate_date_column(df, date_col="date")

    def test_resolves_ambiguous_dates_with_dayfirst_preference(self):
        df = pd.DataFrame({"date": ["03/04/2025"]})

        us_parsed = parse_and_validate_date_column(
            df,
            date_col="date",
            dayfirst_preference=False,
        )
        eu_parsed = parse_and_validate_date_column(
            df,
            date_col="date",
            dayfirst_preference=True,
        )

        assert us_parsed["date"].iloc[0] == pd.Timestamp("2025-03-04")
        assert eu_parsed["date"].iloc[0] == pd.Timestamp("2025-04-03")

    def test_accepts_month_only_dates(self):
        """
        Month-only client dates should parse cleanly so monthly datasets do not fail ingestion.
        """
        df = pd.DataFrame({"date": ["04/2025", "2025-05", "Jun 2025"]})

        parsed_df, diagnostics = parse_and_validate_date_column(
            df,
            date_col="date",
            return_diagnostics=True,
        )

        expected = pd.to_datetime(["2025-04-01", "2025-05-01", "2025-06-01"])
        pd.testing.assert_series_equal(
            parsed_df["date"].reset_index(drop=True),
            pd.Series(expected, name="date"),
        )
        assert diagnostics["parse_status"].tolist() == ["parsed", "parsed", "parsed"]

    def test_missing_dates_can_be_allowed_or_blocked(self):
        df = pd.DataFrame({"date": ["2024-01-01", None]})

        with pytest.raises(ValueError, match="missing"):
            parse_and_validate_date_column(df, date_col="date", allow_missing=False)

        parsed_df, diagnostics = parse_and_validate_date_column(
            df,
            date_col="date",
            allow_missing=True,
            return_diagnostics=True,
        )
        assert pd.isna(parsed_df["date"].iloc[1])
        assert diagnostics["parse_status"].tolist() == ["parsed", "missing"]

    def test_out_of_range_dates_raise(self):
        df = pd.DataFrame({"date": ["2099-01-01"]})

        with pytest.raises(ValueError, match="out_of_range"):
            parse_and_validate_date_column(
                df,
                date_col="date",
                max_future_days=30,
            )

    def test_missing_configured_date_boundary_raises_clear_error(self):
        """
        A NaT-like configured boundary should fail as bad configuration, not with an AttributeError.
        """
        df = pd.DataFrame({"date": ["2024-01-01"]})

        with pytest.raises(ValueError, match="Date boundary cannot be missing"):
            parse_and_validate_date_column(df, min_date="NaT")


def test_run_all_diagnostics_excludes_no_matches_from_missing_categories():
    """
    `No Matches Found` is valid when present but should never appear in missing GBD category
    diagnostics.
    """
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")],
            "product": ["example product"],
            "category": ["No Matches Found"],
            "kilos_total": [1.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)
    missing_categories_finding = next(
        finding for finding in findings if finding.get("category") == "gbd_categories_absent"
    )

    assert "No Matches Found" not in missing_categories_finding["message"]


def test_detect_numeric_coercion_loss_errors_for_unreadable_required_metric_tokens():
    """Unreadable numeric tokens should fail loudly before they silently reduce totals."""
    df = pd.DataFrame(
        {
            "kilos_total": ["12.5", "two cases", None, " "],
        }
    )

    findings, export_df = detect_numeric_coercion_loss(df, ["kilos_total"])

    assert findings[0]["status"] == "error"
    assert findings[0]["count"] == 1
    assert "two cases" in findings[0]["sample_values"][0]
    assert export_df.to_dict("records") == [
        {"row_index": 1, "column": "kilos_total", "raw_value": "two cases"}
    ]


def test_detect_numeric_coercion_loss_reads_allowed_loss_threshold_from_yaml(tmp_path):
    """Tolerance should soften coercion loss to a warning, not hide it as a clean pass."""
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "numeric_coercion_loss:",
                "  allowed_loss_count: 2",
            ]
        )
    )

    original_path = report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH
    report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH = config_path
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame({"kilos_total": ["bad token", "still bad", "4.5"]})
    findings, _ = detect_numeric_coercion_loss(df, ["kilos_total"])

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert findings[0]["metadata"]["allowed_loss_count"] == 2

    report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH = original_path
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_load_diagnostic_thresholds_refreshes_when_path_changes_without_manual_cache_clear(
    tmp_path,
):
    """Changing the configured thresholds file should be enough to refresh cached values."""
    first_config_path = tmp_path / "first_thresholds.yaml"
    first_config_path.write_text(
        "\n".join(
            [
                "outlier_line_items:",
                "  mad_threshold: 5",
            ]
        )
    )
    second_config_path = tmp_path / "second_thresholds.yaml"
    second_config_path.write_text(
        "\n".join(
            [
                "outlier_line_items:",
                "  mad_threshold: 99",
            ]
        )
    )

    original_path = report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH
    report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH = first_config_path
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    assert report_diagnostics.get_diagnostic_threshold("outlier_line_items", "mad_threshold") == 5

    report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH = second_config_path

    assert report_diagnostics.get_diagnostic_threshold("outlier_line_items", "mad_threshold") == 99

    report_diagnostics.DIAGNOSTIC_THRESHOLDS_PATH = original_path
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_aggregation_reconciliation_passes_at_exact_point_one_percent_threshold():
    raw_df = pd.DataFrame({"kilos_total": [1000.0]})
    monthly_product_df = pd.DataFrame({"kilos_total": [999.0]})
    monthly_category_df = pd.DataFrame({"kilos_total": [1000.0]})

    findings, export_df = check_aggregation_reconciliation(
        raw_df,
        monthly_product_df,
        monthly_category_df,
        "kilos_total",
    )

    assert findings[0]["status"] == "success"
    assert findings[0]["metadata"]["relative_difference"] == pytest.approx(0.001)
    assert findings[0]["metadata"]["rel_error_threshold"] == pytest.approx(0.001)
    assert export_df["is_flagged"].tolist() == [False]


def test_check_aggregation_reconciliation_errors_above_point_one_percent_threshold():
    raw_df = pd.DataFrame({"kilos_total": [1000.0]})
    monthly_product_df = pd.DataFrame({"kilos_total": [998.999]})
    monthly_category_df = pd.DataFrame({"kilos_total": [1000.0]})

    findings, export_df = check_aggregation_reconciliation(
        raw_df,
        monthly_product_df,
        monthly_category_df,
        "kilos_total",
    )

    assert findings[0]["status"] == "error"
    assert findings[0]["count"] == 1
    assert findings[0]["metadata"]["relative_difference"] == pytest.approx(0.001001)
    assert (
        findings[0]["metadata"]["relative_difference"]
        > findings[0]["metadata"]["rel_error_threshold"]
    )
    assert export_df["is_flagged"].tolist() == [True]


def test_check_aggregation_reconciliation_reads_threshold_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "aggregation_reconciliation:",
                "  rel_error_threshold: 0.002",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    raw_df = pd.DataFrame({"kilos_total": [1000.0]})
    monthly_product_df = pd.DataFrame({"kilos_total": [1001.5]})
    monthly_category_df = pd.DataFrame({"kilos_total": [1000.0]})

    findings, _ = check_aggregation_reconciliation(
        raw_df,
        monthly_product_df,
        monthly_category_df,
        "kilos_total",
    )

    assert findings[0]["status"] == "success"
    assert findings[0]["metadata"]["rel_error_threshold"] == pytest.approx(0.002)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_single_product_dominance_does_not_flag_at_exact_thirty_percent():
    """Exactly-on-threshold product concentration should not create a false positive."""
    df = pd.DataFrame(
        {
            "product": ["Tofu", "Beans", "Tempeh", "Lentils"],
            "kilos_total": [30.0, 25.0, 25.0, 20.0],
        }
    )

    findings = check_single_product_dominance(df, "kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert findings[0]["metadata"]["top_product_share"] == pytest.approx(0.30)


def test_check_single_product_dominance_flags_above_thirty_percent():
    df = pd.DataFrame(
        {
            "product": ["Tofu", "Beans", "Tempeh", "Lentils"],
            "kilos_total": [30.01, 24.99, 25.0, 20.0],
        }
    )

    findings = check_single_product_dominance(df, "kilos_total", threshold_pct=0.30)

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 1
    assert findings[0]["metadata"]["top_product"] == "Tofu"
    assert findings[0]["metadata"]["top_product_share"] == pytest.approx(0.3001)


def test_check_single_product_dominance_reads_threshold_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "single_product_dominance:",
                "  threshold_pct: 0.40",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "product": ["Tofu", "Beans"],
            "kilos_total": [39.0, 61.0],
        }
    )

    findings = check_single_product_dominance(df, "kilos_total")

    assert findings[0]["status"] == "info"
    assert findings[0]["metadata"]["threshold_pct"] == pytest.approx(0.40)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_check_category_concentration_does_not_flag_at_exact_thirty_percent():
    df = pd.DataFrame(
        {
            "category": ["Legumes", "Plant-based meats", "Poultry", "Eggs"],
            "kilos_total": [30.0, 25.0, 25.0, 20.0],
        }
    )

    findings = check_category_concentration(df, "kilos_total")

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert findings[0]["metadata"]["top_category_share"] == pytest.approx(0.30)


def test_check_category_concentration_flags_above_thirty_percent():
    df = pd.DataFrame(
        {
            "category": ["Legumes", "Plant-based meats", "Poultry", "Eggs"],
            "kilos_total": [30.01, 24.99, 25.0, 20.0],
        }
    )

    findings = check_category_concentration(df, "kilos_total")

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 1
    assert findings[0]["metadata"]["top_category"] == "Legumes"
    assert findings[0]["metadata"]["top_category_share"] == pytest.approx(0.3001)


def test_check_category_concentration_reads_threshold_from_yaml(tmp_path, monkeypatch):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        "\n".join(
            [
                "category_concentration:",
                "  threshold_pct: 0.40",
            ]
        )
    )
    monkeypatch.setattr(report_diagnostics, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()

    df = pd.DataFrame(
        {
            "category": ["Legumes", "Poultry"],
            "kilos_total": [39.0, 61.0],
        }
    )

    findings = check_category_concentration(df, "kilos_total")

    assert findings[0]["status"] == "info"
    assert findings[0]["metadata"]["threshold_pct"] == pytest.approx(0.40)
    report_diagnostics.load_diagnostic_thresholds.cache_clear()


def test_run_all_diagnostics_includes_exact_duplicate_row_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-01")],
            "product": ["Tofu", "Tofu"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": [1.5, 1.5],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    duplicate_finding = next(
        finding for finding in findings if finding.get("category") == "exact_duplicate_rows"
    )
    assert duplicate_finding["status"] == "warning"
    assert duplicate_finding["count"] == 2
    assert duplicate_finding["metadata"]["month_bucketed_dates"] is True


def test_run_all_diagnostics_includes_aggregation_reconciliation_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-02")],
            "month_year": [pd.Period("2025-01", freq="M"), pd.Period("2025-01", freq="M")],
            "product": ["Tofu", "Beans"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": [60.0, 40.0],
        }
    )
    monthly_product_data = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-01", freq="M"), pd.Period("2025-01", freq="M")],
            "product": ["Tofu", "Beans"],
            "kilos_total": [60.0, 40.0],
        }
    )
    monthly_category_data = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-01", freq="M")],
            "category": ["Legumes"],
            "kilos_total": [100.0],
        }
    )

    findings = run_all_diagnostics(
        df=df,
        diner_meal_mapping={},
        serving=False,
        monthly_product_data=monthly_product_data,
        monthly_category_data=monthly_category_data,
    )

    reconciliation_finding = next(
        finding for finding in findings if finding.get("category") == "aggregation_reconciliation"
    )
    assert reconciliation_finding["status"] == "success"
    assert reconciliation_finding["metadata"]["raw_total"] == pytest.approx(100.0)


def test_run_all_diagnostics_includes_single_product_dominance_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3,
            "product": ["Tofu", "Beans", "Tempeh"],
            "category": ["Legumes", "Legumes", "Plant-based meats"],
            "kilos_total": [15.0, 60.0, 25.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    dominance_finding = next(
        finding for finding in findings if finding.get("category") == "single_product_dominance"
    )
    assert dominance_finding["status"] == "info"
    assert dominance_finding["count"] == 1
    assert dominance_finding["metadata"]["top_product"] == "Beans"


def test_run_all_diagnostics_includes_category_concentration_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3,
            "product": ["Tofu", "Beans", "Chicken"],
            "category": ["Legumes", "Legumes", "Poultry"],
            "kilos_total": [35.0, 30.0, 35.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    concentration_finding = next(
        finding for finding in findings if finding.get("category") == "category_concentration"
    )
    assert concentration_finding["status"] == "info"
    assert concentration_finding["count"] == 1
    assert concentration_finding["metadata"]["top_category"] == "Legumes"


def test_run_all_diagnostics_includes_near_duplicate_name_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01")] * 3,
            "product": ["Chicken Curry", "Ch1cken Curry", "Tofu Stir Fry"],
            "category": ["Poultry", "Poultry", "Legumes"],
            "kilos_total": [20.0, 15.0, 65.0],
        }
    )

    findings = run_all_diagnostics(
        df=df,
        diner_meal_mapping={},
        serving=False,
        pdf_extracted=True,
    )

    near_duplicate_finding = next(
        finding for finding in findings if finding.get("category") == "near_duplicate_product_names"
    )
    assert near_duplicate_finding["status"] == "warning"
    assert near_duplicate_finding["count"] == 1


def test_run_all_diagnostics_includes_numeric_coercion_loss_finding():
    df = pd.DataFrame(
        {
            "date": [pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-02")],
            "product": ["Tofu", "Tempeh"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": ["4.0", "not a number"],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    coercion_finding = next(
        finding for finding in findings if finding.get("category") == "numeric_coercion_loss"
    )
    assert coercion_finding["status"] == "error"
    assert coercion_finding["count"] == 1


def test_run_all_diagnostics_includes_outlier_line_item_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-01",
                    "2025-01-02",
                    "2025-01-03",
                    "2025-01-04",
                    "2025-01-05",
                    "2025-01-06",
                    "2025-01-07",
                    "2025-01-08",
                    "2025-01-09",
                    "2025-01-10",
                ]
            ),
            "product": ["Bean Chili"] * 5 + ["Tofu Curry"] * 5,
            "category": ["Legumes"] * 5 + ["Plant-based meats"] * 5,
            "kilos_total": [10.0, 11.0, 12.0, 10.0, 50.0, 8.0, 9.0, 10.0, 8.0, 9.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    outlier_finding = next(
        finding for finding in findings if finding.get("category") == "outlier_line_items"
    )
    assert outlier_finding["status"] == "warning"
    assert outlier_finding["count"] == 1


def test_run_all_diagnostics_includes_per_product_weight_bounds_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"]),
            "product": ["Beans", "Tofu", "Tempeh"],
            "category": ["Legumes", "Plant-based meats", "Plant-based meats"],
            "kilos_total": [0.001, 0.0005, 600.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    bounds_finding = next(
        finding for finding in findings if finding.get("category") == "per_product_weight_bounds"
    )
    assert bounds_finding["status"] == "warning"
    assert bounds_finding["count"] == 2
    assert bounds_finding["metadata"]["low"] == pytest.approx(0.001)
    assert bounds_finding["metadata"]["high"] == pytest.approx(500.0)


def test_run_all_diagnostics_uses_serving_bounds_for_serving_reports():
    """Serving reports should not describe serving counts as kilograms."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"]),
            "product": ["Beans", "Soup", "Salad"],
            "category": ["Legumes", "Legumes", "Legumes"],
            "servings total": [0.5, 600.0, 1200.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=True)

    bounds_finding = next(
        finding for finding in findings if finding.get("category") == "per_product_weight_bounds"
    )
    assert bounds_finding["metadata"]["low"] == pytest.approx(1.0)
    assert bounds_finding["metadata"]["high"] == pytest.approx(1000.0)
    assert bounds_finding["metadata"]["unit_label"] == "servings"
    assert "servings" in bounds_finding["message"]
    assert "kg" not in bounds_finding["message"]


def test_run_all_diagnostics_includes_missing_weeks_within_month_finding():
    """Wires the missing-weeks check into the report diagnostics when dates are truly day-level."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-01",
                    "2025-01-05",
                    "2025-01-20",
                    "2025-01-25",
                ]
            ),
            "product": ["Beans"] * 4,
            "category": ["Legumes"] * 4,
            "kilos_total": [10.0, 12.0, 11.0, 9.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    gap_finding = next(
        finding for finding in findings if finding.get("category") == "missing_weeks_within_month"
    )
    assert gap_finding["status"] == "info"
    assert gap_finding["count"] == 1


def test_run_all_diagnostics_skips_missing_weeks_within_month_for_monthly_dates():
    """A monthly series cleaned to one date per month should not surface the missing-weeks check."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-01",
                    "2025-02-01",
                    "2025-03-01",
                ]
            ),
            "product": ["Beans"] * 3,
            "category": ["Legumes"] * 3,
            "kilos_total": [10.0, 12.0, 11.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    assert not any(finding.get("category") == "missing_weeks_within_month" for finding in findings)


def test_run_all_diagnostics_includes_month_over_month_total_volatility_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-15",
                    "2025-02-15",
                    "2025-03-15",
                ]
            ),
            "product": ["Beans", "Beans", "Beans"],
            "category": ["Legumes", "Legumes", "Legumes"],
            "kilos_total": [100.0, 140.0, 80.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    volatility_finding = next(
        finding
        for finding in findings
        if finding.get("category") == "month_over_month_total_volatility"
    )
    assert volatility_finding["status"] == "warning"
    assert volatility_finding["count"] == 2


def test_run_all_diagnostics_includes_missing_internal_months_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-15",
                    "2025-03-15",
                ]
            ),
            "product": ["Beans", "Beans"],
            "category": ["Legumes", "Legumes"],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    missing_months_finding = next(
        finding for finding in findings if finding.get("category") == "missing_internal_months"
    )
    assert missing_months_finding["status"] == "warning"
    assert missing_months_finding["count"] == 1
    assert missing_months_finding["sample_values"] == ["Feb 2025"]


def test_run_all_diagnostics_includes_category_discontinuity_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-10",
                    "2025-03-10",
                    "2025-01-15",
                    "2025-02-15",
                    "2025-03-15",
                ]
            ),
            "product": [
                "Bean Chili",
                "Bean Chili",
                "Tofu Curry",
                "Tofu Curry",
                "Tofu Curry",
            ],
            "category": [
                "Legumes",
                "Legumes",
                "Plant-based meats",
                "Plant-based meats",
                "Plant-based meats",
            ],
            "kilos_total": [10.0, 9.0, 4.0, 5.0, 6.0],
        }
    )

    findings = run_all_diagnostics(df=df, diner_meal_mapping={}, serving=False)

    discontinuity_finding = next(
        finding for finding in findings if finding.get("category") == "category_discontinuity"
    )
    assert discontinuity_finding["status"] == "warning"
    assert discontinuity_finding["count"] == 1


def test_run_all_diagnostics_includes_diner_meal_reasonableness_finding():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-15",
                    "2025-02-15",
                    "2025-03-15",
                ]
            ),
            "product": ["Beans", "Beans", "Beans"],
            "category": ["Legumes", "Legumes", "Legumes"],
            "kilos_total": [100.0, 100.0, 100.0],
        }
    )

    findings = run_all_diagnostics(
        df=df,
        diner_meal_mapping={
            "2025-01": 49,
            "2025-02": 100,
            "2025-03": 201,
        },
        serving=False,
    )

    denominator_finding = next(
        finding
        for finding in findings
        if finding.get("category") == "diner_meal_count_reasonableness"
    )
    assert denominator_finding["status"] == "error"
    assert denominator_finding["count"] == 2
