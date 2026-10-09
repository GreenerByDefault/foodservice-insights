from collections.abc import Callable
from pathlib import Path

import gbd_foodservice_insights.report.thresholds as report_thresholds
import pandas as pd
import pytest
import yaml
from gbd_foodservice_insights.report.checks import (
    check_aggregation_reconciliation,
    check_category_concentration,
    check_date_distribution,
    check_diner_meal_reasonableness,
    check_missing_internal_months,
    check_missing_weeks_within_month,
    check_per_product_weight_bounds,
    check_required_columns,
    check_single_product_dominance,
    check_zero_category_month_combos,
    detect_category_discontinuity,
    detect_exact_duplicate_rows,
    detect_month_over_month_total_volatility,
    detect_near_duplicate_product_names,
    detect_unusual_sales,
    find_close_product_pairs,
    run_all_diagnostics,
)
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.utils import normalize_diner_meal_mapping

# ----------------------------------------------------------------------
# Product names and duplicate rows
# ----------------------------------------------------------------------


def test_find_close_product_pairs_pairs_names_within_two_edits():
    products = ["testing", "testin", "test", "tesing", "producta", "productb"]  # codespell:ignore

    close_pairs = find_close_product_pairs(pd.DataFrame({"product": products}), "product")

    assert close_pairs[["Product 1", "Product 2", "Levenshtein Distance"]].values.tolist() == [
        ["testin", "testing", 1],  # codespell:ignore
        ["tesing", "testing", 1],  # codespell:ignore
        ["test", "testin", 2],  # codespell:ignore
        ["tesing", "testin", 2],  # codespell:ignore
        ["producta", "productb", 1],
    ]


def test_find_close_product_pairs_sorts_by_row_count_gap_descending():
    # Pairs are found in row-count order, so the sort has to move grape/grope ahead.
    df = pd.DataFrame({"product": ["apple"] * 10 + ["apply"] * 9 + ["grape"] * 8 + ["grope"]})

    close_pairs = find_close_product_pairs(df, "product")

    assert close_pairs[["Product 1", "Product 2", "distance_between_counts"]].values.tolist() == [
        ["grape", "grope", 7],
        ["apple", "apply", 1],
    ]


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


def test_find_close_product_pairs_returns_empty_for_no_products():
    df = pd.DataFrame({"product": pd.Series(dtype="str")})
    result_df = find_close_product_pairs(df, "product")
    assert result_df.empty


def test_find_close_product_pairs_returns_empty_for_one_distinct_product():
    df = pd.DataFrame({"product": ["apple", "apple"]})
    result_df = find_close_product_pairs(df, "product")
    assert result_df.empty


def _curry_split_across_two_names() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "product": ["Chicken Curry", "Ch1cken Curry", "Tofu Stir Fry"],
            "kilos_total": [20.0, 15.0, 65.0],
        }
    )


def test_detect_near_duplicate_product_names_warns_for_material_pdf_pairs():
    """PDF/OCR extracts should warn when likely name splits affect a meaningful share of volume."""
    df = _curry_split_across_two_names()

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
    df = _curry_split_across_two_names()

    findings, _ = detect_near_duplicate_product_names(
        df,
        metric_total="kilos_total",
        pdf_extracted=False,
    )

    assert findings[0]["status"] == "info"
    assert findings[0]["count"] == 1


def _three_duplicates_in_100_rows(duplicate_date: object, other_date: object) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": [duplicate_date] * 3 + [other_date] * 97,
            "product": ["Beans"] * 3 + [f"Item {i}" for i in range(97)],
            "category": ["Legumes"] * 100,
            "kilos_total": [2.0] * 3 + [float(i + 1) for i in range(97)],
        }
    )


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
    df = _three_duplicates_in_100_rows(pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-02"))

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "error"
    assert findings[0]["metadata"]["duplicate_row_share"] == pytest.approx(0.03)


def test_detect_exact_duplicate_rows_caps_month_bucketed_dates_at_warning():
    """
    Month/year-only client data should not hard-fail because transaction-level duplicate detection
    is ambiguous.
    """
    df = _three_duplicates_in_100_rows(pd.Timestamp("2025-01-01"), pd.Timestamp("2025-02-01"))

    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["metadata"]["month_bucketed_dates"] is True
    assert "month-level placeholders" in findings[0]["message"]


def test_detect_exact_duplicate_rows_treats_month_only_string_dates_as_month_bucketed():
    """
    Month-only strings should be recognized as month-bucketed so duplicate severity is not
    overstated.
    """
    df = _three_duplicates_in_100_rows("04/2025", "05/2025")

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


# ----------------------------------------------------------------------
# Required columns and numeric parsing
# ----------------------------------------------------------------------


def test_check_required_columns_requires_the_metric_column():
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(["2023-01-01"]),
            "product": ["apple"],
            "category": ["fruit"],
            "kilos_total": [10.0],
        }
    )

    assert check_required_columns(df) is True
    assert check_required_columns(df.drop(columns=["kilos_total"])) is False


# ----------------------------------------------------------------------
# Outliers and weight bounds
# ----------------------------------------------------------------------


@pytest.fixture
def unusual_sales_df():
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


def test_detect_unusual_sales_flags_category_outliers_with_export_table(unusual_sales_df):
    findings, outlier_rows = detect_unusual_sales(
        unusual_sales_df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        threshold=5,
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 2
    assert any("Bean Chili" in sample for sample in findings[0]["sample_values"])
    assert set(outlier_rows["product_name"]) == {"Bean Chili", "Lentil Soup"}
    assert "ratio_to_category_median" in outlier_rows.columns
    assert outlier_rows["flag_reason"].str.len().gt(0).all()


def test_detect_unusual_sales_returns_nothing_within_normal_range():
    df = pd.DataFrame(
        {
            "product_name": ["A"] * 5,
            "category": ["Legumes"] * 5,
            "quantity_sold": [10, 11, 10, 9, 12],
        }
    )
    findings, outlier_rows = detect_unusual_sales(
        df,
        summary_col="quantity_sold",
        product_name_col="product_name",
        threshold=5,
    )
    assert [finding["status"] for finding in findings] == ["success"]
    assert outlier_rows.empty


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
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 1
    assert set(outlier_rows["product_name"]) == {"Bean Chili"}
    assert outlier_rows["flagged_by_small_category_ratio"].tolist() == [True]
    assert "small-category severe ratio fallback" in outlier_rows["flag_reason"].iloc[0]


def test_detect_unusual_sales_returns_success_for_no_rows():
    df = pd.DataFrame({"product_name": [], "category": [], "quantity_sold": []})
    findings, outlier_rows = detect_unusual_sales(df, "quantity_sold", "product_name")
    assert [finding["status"] for finding in findings] == ["success"]
    assert outlier_rows.empty


def test_detect_unusual_sales_raises_for_missing_columns():
    df = pd.DataFrame({"p": ["A"], "q": [1]})
    with pytest.raises(KeyError):
        detect_unusual_sales(df, "quantity_sold", "product_name")


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


# ----------------------------------------------------------------------
# Dates and months
# ----------------------------------------------------------------------


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


def test_check_zero_category_month_combos_names_missing_months_in_plain_english():
    df = pd.DataFrame(
        {
            "month_year": ["2024-01", "2024-02", "2024-01"],
            "category": ["Lamb/mutton & goat meat", "Legumes", "Legumes"],
            "kilos_total": [10, 5, 7],
        }
    )

    findings = check_zero_category_month_combos(df, "kilos_total")
    missing_finding = next(f for f in findings if f["category"] == "missing_category_month_combos")

    assert "Lamb/mutton and goat meat missing during Feb 2024" in missing_finding["sample_values"]


# ----------------------------------------------------------------------
# Diner meals, reconciliation and concentration
# ----------------------------------------------------------------------


def test_check_diner_meal_reasonableness_respects_boundary_ratios():
    findings, export_df = check_diner_meal_reasonableness(
        normalize_diner_meal_mapping({"2025-01": 50, "2025-02": 100, "2025-03": 200})
    )

    assert findings[0]["status"] == "success"
    assert findings[0]["count"] == 0
    assert export_df["ratio_to_median"].tolist() == pytest.approx([0.5, 1.0, 2.0])
    assert not export_df["is_flagged"].any()


def test_check_diner_meal_reasonableness_flags_outside_boundary_ratios_and_escalates():
    findings, export_df = check_diner_meal_reasonableness(
        normalize_diner_meal_mapping({"2025-01": 49, "2025-02": 100, "2025-03": 201})
    )

    assert findings[0]["status"] == "error"
    assert findings[0]["count"] == 2
    assert export_df["ratio_to_median"].tolist() == pytest.approx([0.49, 1.0, 2.01])
    assert export_df["is_flagged"].tolist() == [True, False, True]


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


# ----------------------------------------------------------------------
# Thresholds YAML
# ----------------------------------------------------------------------


def _override_thresholds(
    monkeypatch: pytest.MonkeyPatch,
    config_path: Path,
    overrides: dict[str, dict[str, float]],
) -> None:
    config_path.write_text(yaml.safe_dump(overrides))
    monkeypatch.setattr(report_thresholds, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)


def test_load_diagnostic_thresholds_refreshes_when_the_path_changes(tmp_path, monkeypatch):
    for mad_threshold in (5, 99):
        _override_thresholds(
            monkeypatch,
            tmp_path / f"thresholds_{mad_threshold}.yaml",
            {"outlier_line_items": {"mad_threshold": mad_threshold}},
        )

        assert (
            report_thresholds.get_diagnostic_threshold("outlier_line_items", "mad_threshold")
            == mad_threshold
        )


def _category_discontinuity_with_a_one_month_gap() -> dict[str, object]:
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
    return {
        "status": findings[0]["status"],
        "min_gap_months": findings[0]["metadata"]["min_gap_months"],
    }


def _diner_meal_counts_about_20_percent_off_the_median() -> dict[str, object]:
    findings, export_df = check_diner_meal_reasonableness(
        normalize_diner_meal_mapping({"2025-01": 79, "2025-02": 100, "2025-03": 121})
    )
    return {
        "status": findings[0]["status"],
        "count": findings[0]["count"],
        "is_flagged": export_df["is_flagged"].tolist(),
    }


def _three_duplicates_in_100_rows_on_distinct_days() -> dict[str, object]:
    df = _three_duplicates_in_100_rows(pd.Timestamp("2025-01-01"), pd.Timestamp("2025-01-02"))
    findings, _ = detect_exact_duplicate_rows(df, metric_total="kilos_total")
    metadata = findings[0]["metadata"]
    return {
        "status": findings[0]["status"],
        "warning_share_threshold": metadata["warning_share_threshold"],
        "error_share_threshold": metadata["error_share_threshold"],
    }


def _curry_split_in_a_pdf_extract() -> dict[str, object]:
    findings, _ = detect_near_duplicate_product_names(
        _curry_split_across_two_names(), metric_total="kilos_total", pdf_extracted=True
    )
    return {
        "status": findings[0]["status"],
        "count": findings[0]["count"],
        "warning_share_threshold": findings[0]["metadata"]["warning_share_threshold"],
    }


def _weights_either_side_of_2_to_10_kg() -> dict[str, object]:
    df = pd.DataFrame({"product": ["Beans", "Tofu", "Tempeh"], "kilos_total": [1.5, 10.0, 11.0]})
    findings, flagged_rows = check_per_product_weight_bounds(df, "kilos_total")
    return {
        "status": findings[0]["status"],
        "count": findings[0]["count"],
        "low": findings[0]["metadata"]["low"],
        "high": findings[0]["metadata"]["high"],
        "flagged": flagged_rows["product"].tolist(),
    }


def _names_two_edits_apart() -> int:
    return len(find_close_product_pairs(pd.DataFrame({"product": ["abcd", "abef"]}), "product"))


def _first_month_at_40_percent_of_the_median() -> list[Finding]:
    df = pd.DataFrame({"month_year": ["2025-01"] * 4 + ["2025-02"] * 10 + ["2025-03"] * 10})
    return check_date_distribution(df)


def _aggregates_0_15_percent_off_the_raw_total() -> dict[str, object]:
    findings, _ = check_aggregation_reconciliation(
        pd.DataFrame({"kilos_total": [1000.0]}),
        pd.DataFrame({"kilos_total": [1001.5]}),
        pd.DataFrame({"kilos_total": [1000.0]}),
        "kilos_total",
    )
    return {
        "status": findings[0]["status"],
        "rel_error_threshold": findings[0]["metadata"]["rel_error_threshold"],
    }


def _top_product_at_35_percent() -> dict[str, object]:
    df = pd.DataFrame({"product": ["Tofu", "Beans", "Tempeh"], "kilos_total": [35.0, 33.0, 32.0]})
    findings = check_single_product_dominance(df, "kilos_total")
    return {
        "status": findings[0]["status"],
        "threshold_pct": findings[0]["metadata"]["threshold_pct"],
    }


def _top_category_at_35_percent() -> dict[str, object]:
    df = pd.DataFrame(
        {"category": ["Legumes", "Poultry", "Eggs"], "kilos_total": [35.0, 33.0, 32.0]}
    )
    findings = check_category_concentration(df, "kilos_total")
    return {
        "status": findings[0]["status"],
        "threshold_pct": findings[0]["metadata"]["threshold_pct"],
    }


# Each input lands on the other side of the checked-in threshold from the override, so a case
# passes only if the check read the override rather than the default.
@pytest.mark.parametrize(
    ("overrides", "observe", "expected"),
    [
        pytest.param(
            {"category_discontinuity": {"min_gap_months": 2}},
            _category_discontinuity_with_a_one_month_gap,
            {"status": "success", "min_gap_months": 2},
            id="category_discontinuity",
        ),
        pytest.param(
            {
                "diner_meal_count_reasonableness": {
                    "low_ratio_threshold": 0.8,
                    "high_ratio_threshold": 1.2,
                    "error_if_flagged_months": 3,
                }
            },
            _diner_meal_counts_about_20_percent_off_the_median,
            {"status": "warning", "count": 2, "is_flagged": [True, False, True]},
            id="diner_meal_count_reasonableness",
        ),
        pytest.param(
            {
                "exact_duplicate_rows": {
                    "warning_share_threshold": 0.05,
                    "error_share_threshold": 0.10,
                }
            },
            _three_duplicates_in_100_rows_on_distinct_days,
            {"status": "success", "warning_share_threshold": 0.05, "error_share_threshold": 0.10},
            id="exact_duplicate_rows",
        ),
        pytest.param(
            {"near_duplicate_product_names": {"warning_share_threshold": 0.40}},
            _curry_split_in_a_pdf_extract,
            {"status": "info", "count": 0, "warning_share_threshold": 0.40},
            id="near_duplicate_product_names",
        ),
        pytest.param(
            {"near_duplicate_product_names": {"max_levenshtein_distance": 1}},
            _names_two_edits_apart,
            0,
            id="max_levenshtein_distance",
        ),
        pytest.param(
            {"per_product_weight_bounds": {"low": 2, "high": 10}},
            _weights_either_side_of_2_to_10_kg,
            {
                "status": "warning",
                "count": 2,
                "low": 2.0,
                "high": 10.0,
                "flagged": ["Beans", "Tempeh"],
            },
            id="per_product_weight_bounds",
        ),
        pytest.param(
            {"date_distribution": {"partial_month_ratio_threshold": 0.2}},
            _first_month_at_40_percent_of_the_median,
            [],
            id="date_distribution",
        ),
        pytest.param(
            {"aggregation_reconciliation": {"rel_error_threshold": 0.002}},
            _aggregates_0_15_percent_off_the_raw_total,
            {"status": "success", "rel_error_threshold": 0.002},
            id="aggregation_reconciliation",
        ),
        pytest.param(
            {"single_product_dominance": {"threshold_pct": 0.40}},
            _top_product_at_35_percent,
            {"status": "success", "threshold_pct": 0.40},
            id="single_product_dominance",
        ),
        pytest.param(
            {"category_concentration": {"threshold_pct": 0.40}},
            _top_category_at_35_percent,
            {"status": "success", "threshold_pct": 0.40},
            id="category_concentration",
        ),
    ],
)
def test_checks_read_their_thresholds_from_yaml(
    overrides: dict[str, dict[str, float]],
    observe: Callable[[], object],
    expected: object,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _override_thresholds(monkeypatch, tmp_path / "diagnostic_thresholds.yaml", overrides)

    assert observe() == expected


# ----------------------------------------------------------------------
# run_all_diagnostics
# ----------------------------------------------------------------------


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


def test_run_all_diagnostics_returns_every_checks_findings_in_order():
    # Shaped like what `build_food_report` hands over: parsed dates, Period months, and a
    # Period-keyed mapping. March is short and has no poultry, so the date distribution and
    # category-month checks, which stay silent on clean data, report too.
    jan, feb, mar = pd.period_range("2025-01", periods=3, freq="M")
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(
                [
                    "2025-01-06",
                    "2025-01-13",
                    "2025-01-20",
                    "2025-01-27",
                    "2025-02-03",
                    "2025-02-10",
                    "2025-02-17",
                    "2025-02-24",
                    "2025-03-03",
                ]
            ),
            "month_year": [jan] * 4 + [feb] * 4 + [mar],
            "product": ["Lentils", "Chicken Thighs"] * 4 + ["Lentils"],
            "category": ["Legumes", "Poultry (Chicken & Turkey)"] * 4 + ["Legumes"],
            "kilos_total": [10.0, 12.0, 11.0, 12.0, 10.0, 13.0, 11.0, 12.0, 10.0],
        }
    )

    findings = run_all_diagnostics(
        df=df,
        diner_meal_mapping={jan: 100.0, feb: 100.0, mar: 100.0},
        serving=False,
        monthly_product_data=df.groupby(["month_year", "product"], as_index=False)[
            "kilos_total"
        ].sum(),
        monthly_category_data=df.groupby(["month_year", "category"], as_index=False)[
            "kilos_total"
        ].sum(),
        pdf_extracted=False,
    )

    assert [(finding["category"], finding["status"]) for finding in findings] == [
        ("exact_duplicate_rows", "success"),
        ("near_duplicate_product_names", "success"),
        ("month_over_month_total_volatility", "warning"),
        ("missing_internal_months", "success"),
        ("category_discontinuity", "success"),
        ("diner_meal_count_reasonableness", "success"),
        ("single_product_dominance", "info"),
        ("category_concentration", "info"),
        ("outlier_line_items", "success"),
        ("per_product_weight_bounds", "success"),
        ("missing_weeks_within_month", "info"),
        ("required_columns", "success"),
        ("date_alignment", "success"),
        ("date_distribution", "warning"),
        ("negative_values", "success"),
        ("aggregation_reconciliation", "success"),
        ("gbd_categories", "success"),
        ("gbd_categories_absent", "info"),
        ("missing_category_month_combos", "info"),
    ]
