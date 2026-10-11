from collections.abc import Callable
from pathlib import Path

import gbd_foodservice_insights.report.thresholds as report_thresholds
import pandas as pd
import pytest
import yaml
from gbd_foodservice_insights.report.checks import (
    check_category_concentration,
    check_date_distribution,
    check_diner_meal_reasonableness,
    check_missing_internal_months,
    check_missing_weeks_within_month,
    check_per_product_weight_bounds,
    check_single_product_dominance,
    detect_category_discontinuity,
    detect_month_over_month_total_volatility,
    detect_unusual_sales,
    run_all_diagnostics,
)
from gbd_foodservice_insights.report.quality import Finding
from gbd_foodservice_insights.report.schema import DinerOrMeal
from gbd_foodservice_insights.report.utils import normalize_diner_meal_mapping

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
            "kilos_total": ["10", "11", "12", "10", "50", "8", "9", "10", "8", "9"],
        }
    )

    findings, outlier_rows = detect_unusual_sales(
        df,
        summary_col="kilos_total",
        product_name_col="product_name",
        threshold=5,
    )

    assert findings[0]["status"] == "warning"
    assert findings[0]["message"] == (
        "Found 1 line far larger than is typical for its category (10.00% of all lines). "
        "The largest is Bean Chili in Legumes at 50 kg, 4.5x that category's typical line of "
        "11 kg. Lines like these are often a unit or entry mistake."
    )
    assert findings[0]["sample_values"] == [
        "Bean Chili in Legumes: 50 kg, 4.5x the category's typical line of 11 kg."
    ]
    assert set(outlier_rows["product_name"]) == {"Bean Chili"}


def test_detect_unusual_sales_samples_only_the_largest_lines():
    df = pd.DataFrame(
        {
            "product_name": [f"Lentils {n}" for n in range(25)],
            "category": ["Legumes"] * 25,
            "kilos_total": [1.0] * 20 + [100.0, 101.0, 102.0, 103.0, 104.0],
        }
    )

    findings, outlier_rows = detect_unusual_sales(
        df, summary_col="kilos_total", product_name_col="product_name", sample_limit=2
    )

    assert findings[0]["count"] == 5
    assert findings[0]["message"] == (
        "Found 5 lines far larger than is typical for their category (20.00% of all lines). "
        "The largest is Lentils 24 in Legumes at 104 kg, 104.0x that category's typical line "
        "of 1 kg. Lines like these are often a unit or entry mistake."
    )
    assert findings[0]["sample_values"] == [
        "Lentils 24 in Legumes: 104 kg, 104.0x the category's typical line of 1 kg.",
        "Lentils 23 in Legumes: 103 kg, 103.0x the category's typical line of 1 kg.",
    ]
    assert len(outlier_rows) == 5


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
            "date": pd.to_datetime(
                ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"]
            ),
            "product": ["Chickpeas", "Tofu", "Beans", "Tempeh", "Lentils"],
            "category": ["Legumes", "Plant-based meats", "Legumes", "Plant-based meats", "Legumes"],
            "kilos_total": [0.0008, 500.0, 700.0, 900.0, 0.0005],
        },
        index=[10, 11, 12, 13, 14],
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, "kilos_total")

    assert findings[0]["status"] == "warning"
    assert findings[0]["count"] == 4
    assert findings[0]["metadata"]["low"] == pytest.approx(0.001)
    assert findings[0]["metadata"]["high"] == pytest.approx(500.0)
    assert findings[0]["message"] == (
        "Found 4 lines with a weight above zero but under 0.001 kg, or over 500 kg, which "
        "usually means a unit mistake. For example, Lentils at 0.0005 kg, below the lower "
        "bound of 0.001 kg."
    )
    assert findings[0]["sample_values"] == [
        "Lentils at 0.0005 kg, below the lower bound of 0.001 kg.",
        "Chickpeas at 0.0008 kg, below the lower bound of 0.001 kg.",
        "Tempeh at 900 kg, above the upper bound of 500 kg.",
        "Beans at 700 kg, above the upper bound of 500 kg.",
    ]
    assert list(flagged_rows["row_index"]) == [14, 10, 13, 12]
    assert list(flagged_rows["breached_bound"]) == ["lower", "lower", "upper", "upper"]
    assert list(flagged_rows["metric_value"]) == pytest.approx([0.0005, 0.0008, 900.0, 700.0])


def test_check_per_product_weight_bounds_treats_zero_and_the_bounds_as_in_range():
    df = pd.DataFrame(
        {
            "product": ["Rice", "Beans", "Tofu"],
            "kilos_total": [0.0, 0.001, 500.0],
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
    assert findings[0]["sample_values"] == [
        "Beans at 0.5 servings, below the lower bound of 1 serving.",
        "Salad at 1,200 servings, above the upper bound of 1,000 servings.",
    ]
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
    assert findings[0]["message"] == (
        "Found 2 months where the total kilos changed by more than 30% from the month before. "
        "Large swings like this often mean a month is missing, partial, or counted twice."
    )
    assert findings[0]["sample_values"] == [
        "Feb 2025: 140 kg against 100 kg in Jan 2025 (+40%).",
        "Mar 2025: 80 kg against 140 kg in Feb 2025 (-43%).",
    ]


def test_detect_month_over_month_total_volatility_gives_no_percentage_for_a_rise_from_zero():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=2, freq="M"),
            "kilos_total": [0.0, 50.0],
        }
    )

    findings = detect_month_over_month_total_volatility(df, metric_total="kilos_total")

    assert findings[0]["message"].startswith("Found 1 month where the total kilos changed")
    assert findings[0]["sample_values"] == ["Feb 2025: 50 kg against 0 kg in Jan 2025."]


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


def test_check_date_distribution_warns_for_a_short_first_or_last_month():
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(
                ["2025-01"] * 12 + ["2025-02"] * 40 + ["2025-03"] * 40 + ["2025-04"], freq="M"
            )
        }
    )

    findings = check_date_distribution(df)

    assert [(finding["status"], finding["message"]) for finding in findings] == [
        (
            "warning",
            "Jan 2025, the first month in the file, has 12 lines against about 40 in a typical "
            "month, so it may be a partial month.",
        ),
        (
            "warning",
            "Apr 2025, the last month in the file, has 1 line against about 40 in a typical "
            "month, so it may be a partial month.",
        ),
    ]


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
            "month_year": pd.PeriodIndex(
                ["2025-01", "2025-03", "2025-01", "2025-02", "2025-03"], freq="M"
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


# ----------------------------------------------------------------------
# Diner meals and concentration
# ----------------------------------------------------------------------


def _check_headcounts(
    counts: dict[str, float], food: dict[str, float], diner_or_meal: DinerOrMeal = "diner"
) -> tuple[list[Finding], pd.DataFrame]:
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(list(food), freq="M"),
            "kilos_total": list(food.values()),
        }
    )
    return check_diner_meal_reasonableness(
        df, normalize_diner_meal_mapping(counts), "kilos_total", diner_or_meal=diner_or_meal
    )


@pytest.mark.parametrize(
    ("counts", "food", "flagged"),
    [
        pytest.param(
            {"2025-01": 100, "2025-02": 1000, "2025-03": 100},
            {"2025-01": 10, "2025-02": 10, "2025-03": 10},
            [False, True, False],
            id="extra-digit",
        ),
        pytest.param(
            {"2025-01": 100, "2025-02": 10, "2025-03": 100},
            {"2025-01": 10, "2025-02": 10, "2025-03": 10},
            [False, True, False],
            id="dropped-digit",
        ),
        pytest.param(
            {"2025-01": 100, "2025-02": 30, "2025-03": 100},
            {"2025-01": 10, "2025-02": 3, "2025-03": 10},
            [False, False, False],
            id="quiet-month-with-food-to-match",
        ),
        pytest.param(
            {"2025-01": 100, "2025-02": 100, "2025-03": 100},
            {"2025-01": 10, "2025-02": 30, "2025-03": 1},
            [False, False, False],
            id="food-swings-with-ordinary-counts",
        ),
    ],
)
def test_check_diner_meal_reasonableness_flags_counts_the_food_does_not_follow(
    counts, food, flagged
):
    _, export_df = _check_headcounts(counts, food)

    assert export_df["is_flagged"].tolist() == flagged


def test_check_diner_meal_reasonableness_respects_boundary_ratios():
    findings, export_df = _check_headcounts(
        {"2025-01": 100, "2025-02": 200, "2025-03": 50, "2025-04": 100, "2025-05": 100},
        dict.fromkeys(["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"], 10.0),
    )

    assert findings[0]["status"] == "success"
    assert export_df["count_ratio_to_median"].tolist() == pytest.approx([1, 2, 0.5, 1, 1])
    assert export_df["food_per_count_ratio_to_median"].tolist() == pytest.approx([1, 0.5, 2, 1, 1])
    assert not export_df["is_flagged"].any()


def test_check_diner_meal_reasonableness_warns_outside_boundary_ratios():
    findings, export_df = _check_headcounts(
        {"2025-01": 100, "2025-02": 201, "2025-03": 49, "2025-04": 100, "2025-05": 100},
        dict.fromkeys(["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"], 10.0),
        diner_or_meal="meal",
    )

    assert export_df["is_flagged"].tolist() == [False, True, True, False, False]
    assert (
        findings[0]["status"],
        findings[0]["count"],
        findings[0]["message"],
        findings[0]["sample_values"],
    ) == (
        "warning",
        2,
        "The meal counts entered for 2 months are far higher or lower than in a typical month, "
        "but the food in the file did not rise or fall with them. That can mean a typo, which "
        "would make that month's per-meal figures wrong. If a count is wrong, create a new "
        "report with the same file and the corrected count.",
        [
            "Feb 2025: 201 meals, against 100 in a typical month, with no matching rise in food.",
            "Mar 2025: 49 meals, against 100 in a typical month, with no matching drop in food.",
        ],
    )
    assert export_df.loc[export_df["is_flagged"], "flag_reason"].tolist() == [
        "Count far above a typical month with no matching rise in food: per-meal figures look "
        "too low.",
        "Count far below a typical month with no matching drop in food: per-meal figures look "
        "too high.",
    ]


def test_check_diner_meal_reasonableness_words_a_single_month_in_the_singular():
    findings, _ = _check_headcounts(
        {"2025-01": 1000, "2025-02": 1, "2025-03": 1000},
        dict.fromkeys(["2025-01", "2025-02", "2025-03"], 10.0),
    )

    assert (findings[0]["message"], findings[0]["sample_values"]) == (
        "The diner count entered for one month is far higher or lower than in a typical month, "
        "but the food in the file did not rise or fall with it. That can mean a typo, which "
        "would make that month's per-diner figures wrong. If the count is wrong, create a new "
        "report with the same file and the corrected count.",
        ["Feb 2025: 1 diner, against 1,000 in a typical month, with no matching drop in food."],
    )


def test_check_diner_meal_reasonableness_judges_only_months_with_both_count_and_food():
    findings, export_df = _check_headcounts(
        {"2025-01": 100, "2025-02": 100, "2025-03": 100, "2025-04": 100_000},
        {"2025-01": 10, "2025-02": 10, "2025-03": 10, "2025-05": 1_000},
    )

    assert findings[0]["status"] == "success"
    assert findings[0]["metadata"]["median_count"] == 100
    assert export_df["month_year"].tolist() == ["2025-01", "2025-02", "2025-03"]


def test_check_diner_meal_reasonableness_notes_when_no_month_has_count_and_food():
    findings, export_df = _check_headcounts({"2025-01": 100}, {"2025-02": 10})

    assert [(finding["status"], finding["count"]) for finding in findings] == [("info", 0)]
    assert export_df.empty


def test_check_diner_meal_reasonableness_notes_when_typical_month_has_no_food():
    findings, export_df = _check_headcounts(
        {"2025-01": 100, "2025-02": 100, "2025-03": 100},
        {"2025-01": 0, "2025-02": 0, "2025-03": 10},
    )

    assert [(finding["status"], finding["count"]) for finding in findings] == [("info", 0)]
    assert export_df.empty


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


def _counts_30_percent_off_the_median_with_flat_food() -> dict[str, object]:
    findings, export_df = _check_headcounts(
        {"2025-01": 70, "2025-02": 100, "2025-03": 130},
        dict.fromkeys(["2025-01", "2025-02", "2025-03"], 10.0),
    )
    return {
        "status": findings[0]["status"],
        "count": findings[0]["count"],
        "is_flagged": export_df["is_flagged"].tolist(),
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


def _first_month_at_40_percent_of_the_median() -> list[Finding]:
    df = pd.DataFrame({"month_year": ["2025-01"] * 4 + ["2025-02"] * 10 + ["2025-03"] * 10})
    return check_date_distribution(df)


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
                }
            },
            _counts_30_percent_off_the_median_with_flat_food,
            {"status": "warning", "count": 2, "is_flagged": [True, False, True]},
            id="diner_meal_count_reasonableness",
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


def test_run_all_diagnostics_uses_serving_bounds_for_serving_reports():
    """Serving reports should not describe serving counts as kilograms."""
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03"]),
            "month_year": pd.PeriodIndex(["2025-01"] * 3, freq="M"),
            "product": ["Beans", "Soup", "Salad"],
            "category": ["Legumes", "Legumes", "Legumes"],
            "servings total": [0.5, 600.0, 1200.0],
        }
    )

    findings = run_all_diagnostics(
        df=df, diner_meal_mapping={}, diner_or_meal="diner", serving=True
    )

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
    # Period-keyed mapping. March is short, so the date distribution check, which stays silent
    # on clean data, reports too.
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
        diner_or_meal="diner",
        serving=False,
    )

    assert [(finding["category"], finding["status"]) for finding in findings] == [
        ("month_over_month_total_volatility", "warning"),
        ("missing_internal_months", "success"),
        ("category_discontinuity", "success"),
        ("diner_meal_count_reasonableness", "success"),
        ("single_product_dominance", "info"),
        ("category_concentration", "info"),
        ("outlier_line_items", "success"),
        ("per_product_weight_bounds", "success"),
        ("missing_weeks_within_month", "info"),
        ("date_distribution", "warning"),
    ]
