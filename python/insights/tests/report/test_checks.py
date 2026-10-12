import dataclasses
from collections.abc import Callable

import gbd_foodservice_insights.report.checks as report_checks
import pandas as pd
import pytest
from gbd_foodservice_insights.report.checks import (
    check_date_distribution,
    check_diner_meal_reasonableness,
    check_missing_internal_months,
    check_per_product_weight_bounds,
    detect_month_over_month_total_volatility,
    detect_unusual_sales,
    run_all_diagnostics,
)
from gbd_foodservice_insights.report.metric import KILOS
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import (
    DiagnosticStatus,
    DinerOrMeal,
    quality_status_from_findings,
)
from gbd_foodservice_insights.report.thresholds import get_diagnostic_threshold

# ----------------------------------------------------------------------
# Outliers and weight bounds
# ----------------------------------------------------------------------

QUANTITY_SOLD = dataclasses.replace(KILOS, column="quantity_sold")
KILO_BOUNDS = (0.001, 500.0)


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
        metric=QUANTITY_SOLD,
        product_name_col="product_name",
    )

    assert [(finding["status"], finding["count"]) for finding in findings] == [("warning", 2)]
    assert list(outlier_rows.columns) == [
        "row_index",
        "date",
        "product_name",
        "category",
        "quantity_sold",
        "category_row_count",
        "category_median",
        "category_mad",
        "ratio_to_category_median",
        "modified_z_score",
        "flag_reason",
        "flagged_by_mad",
        "flagged_by_zero_mad_ratio",
        "flagged_by_small_category_ratio",
        "flagged_by_extreme_ratio",
    ]
    # Most extreme ratio first. Lentil Soup's MAD is 0, so only the ratio fallback can catch it.
    assert outlier_rows["product_name"].tolist() == ["Lentil Soup", "Bean Chili"]
    assert outlier_rows["row_index"].tolist() == [9, 4]
    assert outlier_rows["flag_reason"].tolist() == ["zero-MAD ratio fallback", "MAD threshold"]


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
        metric=QUANTITY_SOLD,
        product_name_col="product_name",
    )
    assert [(finding["status"], finding["count"]) for finding in findings] == [("success", 0)]
    assert outlier_rows.empty


def test_detect_unusual_sales_samples_only_the_largest_lines():
    df = pd.DataFrame(
        {
            "product_name": [f"Lentils {n}" for n in range(25)],
            "category": ["Legumes"] * 25,
            "kilos_total": [1.0] * 20 + [100.0, 101.0, 102.0, 103.0, 104.0],
        }
    )

    findings, outlier_rows = detect_unusual_sales(
        df, metric=KILOS, product_name_col="product_name", sample_limit=2
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
        metric=QUANTITY_SOLD,
        product_name_col="product_name",
    )

    assert [(finding["status"], finding["count"]) for finding in findings] == [("warning", 1)]
    assert outlier_rows["product_name"].tolist() == ["Bean Chili"]
    assert outlier_rows["flagged_by_small_category_ratio"].tolist() == [True]
    assert outlier_rows["flag_reason"].tolist() == ["small-category severe ratio fallback"]


@pytest.mark.parametrize(("spike", "flagged"), [(50, 1), (49, 0)])
def test_detect_unusual_sales_small_category_needs_five_times_the_median(spike, flagged):
    df = pd.DataFrame(
        {
            "product_name": ["Bean Chili"] * 4,
            "category": ["Legumes"] * 4,
            "quantity_sold": [10, 10, 10, spike],
        }
    )

    findings, outlier_rows = detect_unusual_sales(df, QUANTITY_SOLD, "product_name")

    assert (findings[0]["count"], len(outlier_rows)) == (flagged, flagged)


def test_detect_unusual_sales_is_only_info_when_few_lines_are_flagged_and_none_severe():
    # One mild outlier among 502 lines is 0.2% of them, under the 0.25% warning share.
    df = pd.DataFrame(
        {
            "product_name": "Beans",
            "category": "Legumes",
            "quantity_sold": [9, 10, 11] * 167 + [30],
        }
    )

    findings, outlier_rows = detect_unusual_sales(df, QUANTITY_SOLD, "product_name")

    assert [(finding["status"], finding["count"]) for finding in findings] == [("info", 1)]
    assert outlier_rows["flag_reason"].tolist() == ["MAD threshold"]


def test_detect_unusual_sales_leaves_zero_lines_out_of_the_baseline():
    df = pd.DataFrame(
        {
            "product_name": list("abcdefgh"),
            "category": ["Legumes"] * 8,
            "quantity_sold": [10, 10, 10, 10, 100, 0, 0, 0],
        }
    )

    findings, outlier_rows = detect_unusual_sales(df, QUANTITY_SOLD, "product_name")

    # The zero lines are not purchases: they neither join the baseline nor are flagged, but they
    # still count as lines in the share.
    assert outlier_rows["product_name"].tolist() == ["e"]
    assert findings[0]["metadata"]["outlier_row_share"] == 1 / 8


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

    findings, flagged_rows = check_per_product_weight_bounds(df, KILOS, *KILO_BOUNDS)

    assert (findings[0]["status"], findings[0]["count"]) == ("warning", 4)
    assert findings[0]["metadata"] == {
        "low": 0.001,
        "high": 500.0,
        "unit_label": "kg",
        "flagged_row_count": 4,
    }
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
    assert list(flagged_rows.columns) == [
        "row_index",
        "date",
        "product",
        "category",
        "kilos_total",
        "metric_value",
        "breached_bound",
        "breached_threshold",
    ]
    assert list(flagged_rows["row_index"]) == [14, 10, 13, 12]
    assert list(flagged_rows["breached_bound"]) == ["lower", "lower", "upper", "upper"]
    assert list(flagged_rows["breached_threshold"]) == [0.001, 0.001, 500.0, 500.0]
    assert list(flagged_rows["metric_value"]) == [0.0005, 0.0008, 900.0, 700.0]


def test_check_per_product_weight_bounds_treats_zero_and_the_bounds_as_in_range():
    df = pd.DataFrame(
        {
            "product": ["Rice", "Beans", "Tofu"],
            "kilos_total": [0.0, 0.001, 500.0],
        }
    )

    findings, flagged_rows = check_per_product_weight_bounds(df, KILOS, *KILO_BOUNDS)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("success", 0)]
    assert list(flagged_rows.columns) == ["row_index", "product", "kilos_total", "breached_bound"]
    assert flagged_rows.empty


def test_check_per_product_weight_bounds_flags_values_just_outside_the_bounds():
    df = pd.DataFrame({"product": ["Beans", "Tofu"], "kilos_total": [0.00099, 500.01]})

    findings, flagged_rows = check_per_product_weight_bounds(df, KILOS, *KILO_BOUNDS)

    assert findings[0]["count"] == 2
    assert flagged_rows["breached_bound"].tolist() == ["lower", "upper"]


def test_check_per_product_weight_bounds_samples_only_sample_limit_lines():
    df = pd.DataFrame({"product": ["A", "B", "C"], "kilos_total": [600.0, 700.0, 800.0]})

    findings, flagged_rows = check_per_product_weight_bounds(
        df, KILOS, *KILO_BOUNDS, sample_limit=2
    )

    assert findings[0]["count"] == 3
    assert findings[0]["sample_values"] == [
        "C at 800 kg, above the upper bound of 500 kg.",
        "B at 700 kg, above the upper bound of 500 kg.",
    ]
    assert len(flagged_rows) == 3


def test_check_per_product_weight_bounds_rejects_inverted_bounds():
    with pytest.raises(ValueError, match="low <= high"):
        check_per_product_weight_bounds(
            pd.DataFrame({"product": ["Beans"], "kilos_total": [5.0]}), KILOS, low=10, high=1
        )


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

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

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

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

    assert findings[0]["message"].startswith("Found 1 month where the total kilos changed")
    assert findings[0]["sample_values"] == ["Feb 2025: 50 kg against 0 kg in Jan 2025."]


def test_detect_month_over_month_total_volatility_succeeds_when_changes_are_small():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=3, freq="M"),
            "kilos_total": [100.0, 110.0, 108.0],
        }
    )

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("success", 0)]
    assert findings[0]["message"] == "No months changed by more than 30% versus the previous month."


@pytest.mark.parametrize(
    ("totals", "volatile"),
    [
        pytest.param([100.0, 130.0], 0, id="exactly-the-threshold"),
        pytest.param([100.0, 131.0], 1, id="just-over"),
        pytest.param([100.0, 70.0], 0, id="exactly-the-threshold-down"),
        pytest.param([100.0, 0.0], 1, id="drop-to-zero"),
        pytest.param([0.0, 0.0], 0, id="zero-to-zero"),
    ],
)
def test_detect_month_over_month_total_volatility_thresholds_the_change(totals, volatile):
    df = pd.DataFrame(
        {"month_year": pd.period_range("2025-01", periods=2, freq="M"), "kilos_total": totals}
    )

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

    assert findings[0]["count"] == volatile


def test_detect_month_over_month_total_volatility_sums_each_month_before_comparing():
    jan, feb = pd.period_range("2025-01", periods=2, freq="M")
    df = pd.DataFrame({"month_year": [feb, jan, feb, jan], "kilos_total": [70.0, 50.0, 70.0, 50.0]})

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

    assert findings[0]["sample_values"] == ["Feb 2025: 140 kg against 100 kg in Jan 2025 (+40%)."]


def test_detect_month_over_month_total_volatility_samples_only_sample_limit_months():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=5, freq="M"),
            "kilos_total": [100.0, 200.0, 100.0, 200.0, 100.0],
        }
    )

    findings = detect_month_over_month_total_volatility(df, metric=KILOS, sample_limit=2)

    assert findings[0]["count"] == 4
    assert findings[0]["sample_values"] == [
        "Feb 2025: 200 kg against 100 kg in Jan 2025 (+100%).",
        "Mar 2025: 100 kg against 200 kg in Feb 2025 (-50%).",
    ]


def test_detect_month_over_month_total_volatility_notes_a_single_month():
    df = pd.DataFrame(
        {"month_year": pd.period_range("2025-01", periods=1, freq="M"), "kilos_total": [1.0]}
    )

    findings = detect_month_over_month_total_volatility(df, metric=KILOS)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("info", 0)]


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


@pytest.mark.parametrize(("first_month_lines", "warned"), [(20, False), (19, True)])
def test_check_date_distribution_warns_only_below_half_the_typical_month(first_month_lines, warned):
    months = (
        ["2025-01"] * first_month_lines + ["2025-02"] * 40 + ["2025-03"] * 40 + ["2025-04"] * 40
    )

    findings = check_date_distribution(
        pd.DataFrame({"month_year": pd.PeriodIndex(months, freq="M")})
    )

    assert [finding["count"] for finding in findings] == ([first_month_lines] if warned else [])


def test_check_date_distribution_stays_silent_without_a_typical_month_to_compare():
    two_months = pd.DataFrame({"month_year": pd.PeriodIndex(["2025-01", "2025-02"], freq="M")})

    assert check_date_distribution(two_months) == []


def test_check_missing_internal_months_warns_for_missing_middle_month():
    """Flags missing middle months because one gap can change the story in a short report window."""
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-01", freq="M"), pd.Period("2025-03", freq="M")],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = check_missing_internal_months(df)

    assert findings == [
        make_finding(
            stage="diagnostics",
            category="missing_internal_months",
            status="warning",
            message=(
                "Found 1 missing internal month between Jan 2025 and Mar 2025: Feb 2025. In a "
                "three-month report window, that means one-third of the expected period is "
                "missing."
            ),
            count=1,
            sample_values=["Feb 2025"],
            metadata={
                "missing_months": ["2025-02"],
                "expected_month_count": 3,
                "missing_month_share": 1 / 3,
            },
        )
    ]


@pytest.mark.parametrize(
    ("observed", "message"),
    [
        pytest.param(
            ["2024-11", "2025-02"],
            "Found 2 missing internal months between Nov 2024 and Feb 2025: Dec 2024, Jan 2025. "
            "That means about 50% of the expected months in this period are missing.",
            id="across-a-year-boundary",
        ),
        pytest.param(
            ["2025-01", "2025-03", "2025-05", "2025-06"],
            "Found 2 missing internal months between Jan 2025 and Jun 2025: Feb 2025, Apr 2025. "
            "That means about 33% of the expected months in this period are missing.",
            id="exactly-a-third",
        ),
        pytest.param(
            ["2025-01", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07"],
            "Found 1 missing internal month between Jan 2025 and Jul 2025: Feb 2025.",
            id="under-a-third-adds-no-share",
        ),
    ],
)
def test_check_missing_internal_months_words_the_share_of_the_period_missing(observed, message):
    df = pd.DataFrame({"month_year": pd.PeriodIndex(observed, freq="M")})

    findings = check_missing_internal_months(df)

    assert [(finding["status"], finding["message"]) for finding in findings] == [
        ("warning", message)
    ]


def test_check_missing_internal_months_does_not_flag_boundary_months():
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2025-02", freq="M"), pd.Period("2025-03", freq="M")],
            "kilos_total": [100.0, 120.0],
        }
    )

    findings = check_missing_internal_months(df)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("success", 0)]


@pytest.mark.parametrize("observed", [[], ["2025-01", "2025-01"]])
def test_check_missing_internal_months_succeeds_below_two_distinct_months(observed):
    df = pd.DataFrame({"month_year": pd.PeriodIndex(observed, freq="M")})

    findings = check_missing_internal_months(df)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("success", 0)]


# ----------------------------------------------------------------------
# Diner meals and concentration
# ----------------------------------------------------------------------


def _check_headcounts(
    counts: dict[str, float],
    food: dict[str, float],
    diner_or_meal: DinerOrMeal = "diner",
    **kwargs: int,
) -> tuple[list[Finding], pd.DataFrame]:
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(list(food), freq="M"),
            "kilos_total": list(food.values()),
        }
    )
    return check_diner_meal_reasonableness(
        df,
        dict(zip(pd.PeriodIndex(list(counts), freq="M"), counts.values(), strict=True)),
        "kilos_total",
        diner_or_meal=diner_or_meal,
        **kwargs,
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
    assert findings[0]["metadata"] == {
        "metric_col": "kilos_total",
        "median_count": 100.0,
        "median_food_per_count": 0.1,
        "low_ratio_threshold": 0.5,
        "high_ratio_threshold": 2.0,
    }
    assert export_df["month_year"].tolist() == ["2025-01", "2025-02", "2025-03"]


def test_check_diner_meal_reasonableness_ignores_a_zero_count():
    findings, export_df = _check_headcounts(
        {"2025-01": 100, "2025-02": 0, "2025-03": 100},
        {"2025-01": 10, "2025-02": 10, "2025-03": 10},
    )

    assert findings[0]["status"] == "success"
    assert export_df["month_year"].tolist() == ["2025-01", "2025-03"]


def test_check_diner_meal_reasonableness_samples_only_sample_limit_months():
    counts: dict[str, float] = {
        "2025-01": 100,
        "2025-02": 1000,
        "2025-03": 1000,
        "2025-04": 100,
        "2025-05": 100,
    }

    findings, export_df = _check_headcounts(counts, dict.fromkeys(counts, 10.0), sample_limit=1)

    assert findings[0]["count"] == 2
    assert findings[0]["sample_values"] == [
        "Feb 2025: 1,000 diners, against 100 in a typical month, with no matching rise in food."
    ]
    assert export_df["is_flagged"].sum() == 2


@pytest.mark.parametrize(
    ("counts", "food"),
    [
        pytest.param({"2025-01": 100}, {"2025-02": 10}, id="no-month-has-both"),
        pytest.param({"2025-01": 0}, {"2025-01": 10}, id="the-only-count-is-zero"),
        pytest.param(
            {"2025-01": 100, "2025-02": 100, "2025-03": 100},
            {"2025-01": 0, "2025-02": 0, "2025-03": 10},
            id="typical-month-has-no-food",
        ),
    ],
)
def test_check_diner_meal_reasonableness_notes_when_it_has_nothing_to_judge(counts, food):
    findings, export_df = _check_headcounts(counts, food)

    assert [(finding["status"], finding["count"]) for finding in findings] == [("info", 0)]
    assert export_df.empty


# ----------------------------------------------------------------------
# Thresholds YAML
# ----------------------------------------------------------------------


def _override_thresholds(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, dict[str, float]]
) -> None:
    def get_threshold(diagnostic_name: str, threshold_name: str) -> float:
        override = overrides.get(diagnostic_name, {}).get(threshold_name)
        if override is None:
            return get_diagnostic_threshold(diagnostic_name, threshold_name)
        return override

    monkeypatch.setattr(report_checks, "get_diagnostic_threshold", get_threshold)


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
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(["2025-01"] * 3, freq="M"),
            "product": ["Beans", "Tofu", "Tempeh"],
            "category": ["Legumes", "Plant-based meats", "Plant-based meats"],
            "kilos_total": [1.5, 10.0, 11.0],
        }
    )
    findings = run_all_diagnostics(df, {}, "diner")
    bounds = next(f for f in findings if f["category"] == "per_product_weight_bounds")
    return {
        "status": bounds["status"],
        "count": bounds["count"],
        "low": bounds["metadata"]["low"],
        "high": bounds["metadata"]["high"],
        "sample_values": bounds["sample_values"],
    }


def _a_40_percent_swing() -> list[Finding]:
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=2, freq="M"),
            "kilos_total": [100.0, 140.0],
        }
    )
    return detect_month_over_month_total_volatility(df, KILOS)


def _one_mild_outlier_in_five_lines() -> list[Finding]:
    df = pd.DataFrame(
        {
            "product_name": "Beans",
            "category": "Legumes",
            "kilos_total": [10, 10, 10, 10, 100],
        }
    )
    findings, _ = detect_unusual_sales(df, KILOS, "product_name")
    return findings


def _first_month_at_40_percent_of_the_median() -> list[Finding]:
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(
                ["2025-01"] * 4 + ["2025-02"] * 10 + ["2025-03"] * 10, freq="M"
            )
        }
    )
    return check_date_distribution(df)


# Each input lands on the other side of the checked-in threshold from the override, so a case
# passes only if the check read the override rather than the default.
@pytest.mark.parametrize(
    ("overrides", "observe", "expected"),
    [
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
                "sample_values": [
                    "Beans at 1.5 kg, below the lower bound of 2 kg.",
                    "Tempeh at 11 kg, above the upper bound of 10 kg.",
                ],
            },
            id="per_product_weight_bounds",
        ),
        pytest.param(
            {"month_over_month_total_volatility": {"warning_pct_change_threshold": 0.5}},
            _a_40_percent_swing,
            [
                make_finding(
                    stage="diagnostics",
                    category="month_over_month_total_volatility",
                    status="success",
                    message="No months changed by more than 50% versus the previous month.",
                    count=0,
                    metadata={"warning_pct_change_threshold": 0.5},
                )
            ],
            id="month_over_month_total_volatility",
        ),
        pytest.param(
            {"outlier_line_items": {"zero_mad_ratio_threshold": 20}},
            _one_mild_outlier_in_five_lines,
            [
                make_finding(
                    stage="diagnostics",
                    category="outlier_line_items",
                    status="success",
                    message="No unusually large line items found.",
                    count=0,
                    metadata={
                        "outlier_row_share": 0.0,
                        "warning_share_threshold": 0.0025,
                        "extreme_ratio_threshold": 100.0,
                    },
                )
            ],
            id="outlier_line_items",
        ),
        pytest.param(
            {"date_distribution": {"partial_month_ratio_threshold": 0.2}},
            _first_month_at_40_percent_of_the_median,
            [],
            id="date_distribution",
        ),
    ],
)
def test_checks_read_their_thresholds_from_yaml(
    overrides: dict[str, dict[str, float]],
    observe: Callable[[], object],
    expected: object,
    monkeypatch: pytest.MonkeyPatch,
):
    _override_thresholds(monkeypatch, overrides)

    assert observe() == expected


# ----------------------------------------------------------------------
# run_all_diagnostics
# ----------------------------------------------------------------------


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
    )

    assert [(finding["category"], finding["status"]) for finding in findings] == [
        ("month_over_month_total_volatility", "warning"),
        ("missing_internal_months", "success"),
        ("diner_meal_count_reasonableness", "success"),
        ("outlier_line_items", "success"),
        ("per_product_weight_bounds", "success"),
        ("date_distribution", "warning"),
    ]


def _finding(status: DiagnosticStatus) -> Finding:
    return make_finding(stage="test", category="test", status=status, message="")


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], "pass"),
        (["success", "info"], "pass"),
        (["info", "warning", "success"], "warning"),
        (["warning", "error"], "invalid"),
    ],
)
def test_quality_status_rolls_up_the_worst_finding(statuses, expected):
    assert quality_status_from_findings([_finding(status) for status in statuses]) == expected
