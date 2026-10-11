from collections.abc import Callable

import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights.report.thresholds import get_diagnostic_threshold
from gbd_foodservice_insights_lab.food_report import diagnostics
from gbd_foodservice_insights_lab.food_report.diagnostics import (
    category_highest_vs_lowest_months,
    check_category_concentration,
    check_meat_quantities,
    check_missing_weeks_within_month,
    check_single_product_dominance,
    detect_category_discontinuity,
    detect_near_duplicate_product_names,
    find_close_product_pairs,
    identify_potentially_abnormal_weight_meat_items,
    summarise_numeric_columns,
)


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


def test_identify_potentially_abnormal_weight_meat_items_flags_large_or_fractional_quantities():
    df = pd.DataFrame(
        {
            "product": ["beef steak", "pork chop", "tofu", "beef stew"],
            "quantity": [5, 50, 10, 2.5],
            "category": [
                "beef and buffalo meat",
                "pork (pig meat)",
                "legumes",
                "beef and buffalo meat",
            ],
        }
    )

    result = identify_potentially_abnormal_weight_meat_items(df)

    assert isinstance(result, pd.DataFrame)
    assert sorted(result["product"].tolist()) == ["beef stew", "pork chop"]


def test_identify_potentially_abnormal_weight_meat_items_reads_threshold_from_yaml(monkeypatch):
    monkeypatch.setattr(diagnostics, "get_diagnostic_threshold", lambda *_: 50.0)
    df = pd.DataFrame({"category": ["Poultry (Chicken & Turkey)"] * 2, "quantity": [40, 2]})

    assert identify_potentially_abnormal_weight_meat_items(df) is True


def test_check_meat_quantities_warns_about_suspicious_quantities():
    df = pd.DataFrame({"category": ["beef and buffalo meat"] * 2, "quantity": [5, 2.5]})

    findings = check_meat_quantities(df)

    assert [(f["category"], f["status"], f["count"]) for f in findings] == [
        ("meat_weights", "warning", 1)
    ]


def test_check_meat_quantities_skips_rows_without_a_quantity():
    df = pd.DataFrame({"category": ["beef and buffalo meat"], "kilos_total": [5.0]})

    assert check_meat_quantities(df) == []


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


def test_near_duplicate_product_names_read_their_thresholds_from_yaml(monkeypatch):
    overrides = {"max_levenshtein_distance": 1.0, "warning_share_threshold": 0.40}
    monkeypatch.setattr(
        diagnostics, "get_diagnostic_threshold", lambda _, threshold_name: overrides[threshold_name]
    )

    findings, _ = detect_near_duplicate_product_names(
        _curry_split_across_two_names(), metric_total="kilos_total", pdf_extracted=True
    )

    assert find_close_product_pairs(pd.DataFrame({"product": ["abcd", "abef"]}), "product").empty
    assert (findings[0]["status"], findings[0]["count"]) == ("info", 0)
    assert findings[0]["metadata"]["warning_share_threshold"] == 0.40


def _missing_weeks_finding(sample_values: list[str]) -> dict[str, object]:
    return {
        "stage": "diagnostics",
        "category": "missing_weeks_within_month",
        "status": "info",
        "message": (
            f"Found {len(sample_values)} within-month date gaps longer than 10 days. In data "
            "that normally arrives daily or weekly, this can mean part of a month's "
            "transactions were missed."
        ),
        "count": len(sample_values),
        "sample_values": sample_values,
        "metadata": {"max_gap_days": 10},
    }


def test_check_missing_weeks_within_month_flags_long_internal_date_gap():
    """Flags long stretches with no transactions when the data really has day-level dates."""
    df = pd.DataFrame(
        {"date": pd.to_datetime(["2025-01-01", "2025-01-05", "2025-01-20", "2025-01-25"])}
    )

    assert check_missing_weeks_within_month(df) == [
        _missing_weeks_finding(
            ["Jan 2025: no transactions from 2025-01-06 to 2025-01-19 (14 consecutive days)."]
        )
    ]


def test_check_missing_weeks_within_month_flags_long_gap_at_start_of_month():
    """Partial extracts that begin late in the month should be surfaced."""
    df = pd.DataFrame(
        {"date": pd.to_datetime(["2025-01-20", "2025-01-25", "2025-02-02", "2025-02-04"])}
    )

    # February's early stop is the longer gap, so it sorts first.
    assert check_missing_weeks_within_month(df) == [
        _missing_weeks_finding(
            [
                "Feb 2025: no transactions from 2025-02-05 to 2025-02-28 (24 consecutive days).",
                "Jan 2025: no transactions from 2025-01-01 to 2025-01-19 (19 consecutive days).",
            ]
        )
    ]


def test_check_missing_weeks_within_month_flags_long_gap_at_end_of_month():
    """Partial extracts that stop early in the month should also be surfaced."""
    df = pd.DataFrame(
        {"date": pd.to_datetime(["2025-01-02", "2025-01-05", "2025-02-01", "2025-02-04"])}
    )

    assert check_missing_weeks_within_month(df) == [
        _missing_weeks_finding(
            [
                "Jan 2025: no transactions from 2025-01-06 to 2025-01-31 (26 consecutive days).",
                "Feb 2025: no transactions from 2025-02-05 to 2025-02-28 (24 consecutive days).",
            ]
        )
    ]


def test_check_missing_weeks_within_month_allows_a_gap_of_exactly_the_threshold():
    # 2025-01-02 through 2025-01-11 is ten missing days, the checked-in maximum.
    df = pd.DataFrame(
        {"date": pd.to_datetime(["2025-01-01", "2025-01-12", "2025-01-21", "2025-01-31"])}
    )

    assert check_missing_weeks_within_month(df) == [
        {
            "stage": "diagnostics",
            "category": "missing_weeks_within_month",
            "status": "success",
            "message": "No within-month date gaps longer than 10 days were found.",
            "count": 0,
            "metadata": {"max_gap_days": 10},
        }
    ]


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


@pytest.mark.parametrize(
    ("check", "missing_columns"),
    [
        pytest.param(lambda df: check_missing_weeks_within_month(df), ["date"], id="missing_weeks"),
        pytest.param(
            lambda df: detect_category_discontinuity(df, "kilos_total")[0],
            ["category", "kilos_total"],
            id="category_discontinuity",
        ),
        pytest.param(
            lambda df: check_single_product_dominance(df, "kilos_total"),
            ["product", "kilos_total"],
            id="single_product_dominance",
        ),
    ],
)
def test_checks_report_info_when_their_columns_are_missing(
    check: Callable[[pd.DataFrame], list[dict[str, object]]], missing_columns: list[str]
):
    [finding] = check(pd.DataFrame({"unrelated": [1]}))

    assert (finding["status"], finding["metadata"]) == (
        "info",
        {"missing_columns": missing_columns},
    )


@pytest.mark.parametrize(
    ("kilos", "reason"),
    [
        pytest.param([0.0, 0.0], "the total metric was zero or below.", id="zero_total"),
        pytest.param(
            [5.0, -5.0], "the total metric was zero or below.", id="credits_cancel_purchases"
        ),
        pytest.param([None, "n/a"], "no valid totals were available.", id="no_numeric_totals"),
    ],
)
def test_check_single_product_dominance_reports_info_without_a_positive_total(
    kilos: list[object], reason: str
):
    df = pd.DataFrame({"product": ["Tofu", "Beans"], "kilos_total": kilos})

    assert check_single_product_dominance(df, "kilos_total") == [
        {
            "stage": "diagnostics",
            "category": "single_product_dominance",
            "status": "info",
            "message": f"Could not check for product concentration because {reason}",
            "metadata": {"threshold_pct": 0.30, "metric_col": "kilos_total"},
        }
    ]


def test_detect_category_discontinuity_warns_when_category_disappears_and_returns():
    """Flags a missing middle month because that often means a category-level data gap."""
    df = pd.DataFrame(
        {
            "month_year": pd.PeriodIndex(
                ["2025-01", "2025-03", "2025-01", "2025-02", "2025-03"], freq="M"
            ),
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

    assert findings == [
        {
            "stage": "diagnostics",
            "category": "category_discontinuity",
            "status": "warning",
            "message": (
                "Found 1 category continuity issues where a category had data, went missing "
                "for at least 1 internal month, and then came back. This usually points to a "
                "missing month of data rather than a real category disappearance."
            ),
            "column": "kilos_total",
            "count": 1,
            "sample_values": ["Legumes is missing in Feb 2025 and then appears again in Mar 2025."],
            "metadata": {"min_gap_months": 1},
        }
    ]
    pd.testing.assert_frame_equal(
        export_df,
        pd.DataFrame(
            {
                "category": ["Legumes"],
                "last_month_with_data": ["2025-01"],
                "first_month_back_with_data": ["2025-03"],
                "gap_month_count": [1],
                "gap_months": ["Feb 2025"],
            }
        ),
    )


def test_detect_category_discontinuity_treats_a_zero_month_as_missing():
    df = pd.DataFrame(
        {
            "month_year": pd.period_range("2025-01", periods=3, freq="M"),
            "category": ["Legumes"] * 3,
            "kilos_total": [10.0, 0.0, 9.0],
        }
    )

    findings, export_df = detect_category_discontinuity(df, metric_total="kilos_total")

    assert findings[0]["status"] == "warning"
    assert export_df["gap_months"].tolist() == ["Feb 2025"]


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

    assert findings == [
        {
            "stage": "diagnostics",
            "category": "category_discontinuity",
            "status": "success",
            "message": "No category continuity issues found.",
            "count": 0,
            "metadata": {"min_gap_months": 1},
        }
    ]
    assert export_df.empty


def test_check_single_product_dominance_does_not_flag_at_exact_thirty_percent():
    """Exactly-on-threshold product concentration should not create a false positive."""
    df = pd.DataFrame(
        {
            "product": ["Tofu", "Beans", "Tempeh", "Lentils"],
            "kilos_total": [30.0, 25.0, 25.0, 20.0],
        }
    )

    assert check_single_product_dominance(df, "kilos_total") == [
        {
            "stage": "diagnostics",
            "category": "single_product_dominance",
            "status": "success",
            "message": "No single product exceeded 30% of total kilos total.",
            "count": 0,
            "metadata": {
                "metric_col": "kilos_total",
                "threshold_pct": 0.30,
                "top_product": "Tofu",
                "top_product_total": 30.0,
                "top_product_share": 0.30,
            },
        }
    ]


def test_check_single_product_dominance_flags_above_thirty_percent():
    df = pd.DataFrame(
        {
            "product": ["Tofu", "Beans", "Tempeh", "Lentils"],
            "kilos_total": [30.01, 24.99, 25.0, 20.0],
        }
    )

    assert check_single_product_dominance(df, "kilos_total") == [
        {
            "stage": "diagnostics",
            "category": "single_product_dominance",
            "status": "info",
            "message": (
                "'Tofu' accounts for 30.0% of total kilos total, above the 30% product "
                "concentration threshold."
            ),
            "count": 1,
            "sample_values": ["Tofu: 30.01 of 100.00 (30.0%)"],
            "metadata": {
                "metric_col": "kilos_total",
                "threshold_pct": 0.30,
                "top_product": "Tofu",
                "top_product_total": 30.01,
                "top_product_share": pytest.approx(0.3001),
            },
        }
    ]


# The threshold boundary lives in the helper `check_single_product_dominance` shares; this only
# pins that the category wrapper groups by category and names its metadata for it.
def test_check_category_concentration_flags_above_thirty_percent():
    df = pd.DataFrame(
        {
            "category": ["Legumes", "Plant-based meats", "Poultry", "Eggs"],
            "kilos_total": [30.01, 24.99, 25.0, 20.0],
        }
    )

    assert check_category_concentration(df, "kilos_total") == [
        {
            "stage": "diagnostics",
            "category": "category_concentration",
            "status": "info",
            "message": (
                "'Legumes' accounts for 30.0% of total kilos total, above the 30% category "
                "concentration threshold."
            ),
            "count": 1,
            "sample_values": ["Legumes: 30.01 of 100.00 (30.0%)"],
            "metadata": {
                "metric_col": "kilos_total",
                "threshold_pct": 0.30,
                "top_category": "Legumes",
                "top_category_total": 30.01,
                "top_category_share": pytest.approx(0.3001),
            },
        }
    ]


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


def _fourteen_day_gap() -> dict[str, object]:
    df = pd.DataFrame({"date": pd.to_datetime(["2025-01-01", "2025-01-16", "2025-01-31"])})
    [finding] = check_missing_weeks_within_month(df)
    return {"status": finding["status"], "max_gap_days": finding["metadata"]["max_gap_days"]}


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
        pytest.param(
            {"missing_weeks_within_month": {"max_gap_days": 20}},
            _fourteen_day_gap,
            {"status": "success", "max_gap_days": 20},
            id="missing_weeks_within_month",
        ),
    ],
)
def test_checks_read_their_thresholds_from_yaml(
    overrides: dict[str, dict[str, float]],
    observe: Callable[[], object],
    expected: object,
    monkeypatch: pytest.MonkeyPatch,
):
    def get_threshold(diagnostic_name: str, threshold_name: str) -> float:
        override = overrides.get(diagnostic_name, {}).get(threshold_name)
        if override is None:
            return get_diagnostic_threshold(diagnostic_name, threshold_name)
        return override

    monkeypatch.setattr(diagnostics, "get_diagnostic_threshold", get_threshold)

    assert observe() == expected


def test_category_highest_vs_lowest_months_reports_the_peak_to_trough_ratio():
    df = pd.DataFrame(
        {"category": ["fruit"] * 3, "kilos per diner": [0.1, 0.4, 0.05]},
    )

    result = category_highest_vs_lowest_months(df, metric_col="kilos per diner")

    assert result.to_dict("records") == [{"category": "fruit", "times_higher": 8.0}]


def test_category_highest_vs_lowest_months_ranks_categories_and_keeps_the_exact_2x_boundary():
    df = pd.DataFrame(
        {
            "category": ["a", "a", "b", "b", "c", "c"],
            "kilos per diner": [1.0, 2.0, 1.0, 3.04, 1.0, 1.99],
        }
    )

    result = category_highest_vs_lowest_months(df, metric_col="kilos per diner")

    # "c" is under 2x so it is dropped; the rest sort descending and round to one decimal.
    assert result.to_dict("records") == [
        {"category": "b", "times_higher": 3.0},
        {"category": "a", "times_higher": 2.0},
    ]


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        pytest.param([0.0, 5.0], float("inf"), id="zero-trough-with-a-peak-is-infinite"),
        pytest.param([0.0, 0.0], None, id="all-zero-is-flat-and-dropped"),
    ],
)
def test_category_highest_vs_lowest_months_handles_a_zero_trough(values, expected):
    df = pd.DataFrame({"category": ["fruit"] * 2, "kilos per diner": values})

    result = category_highest_vs_lowest_months(df, metric_col="kilos per diner")

    expected_rows = [] if expected is None else [{"category": "fruit", "times_higher": expected}]
    assert result.to_dict("records") == expected_rows


def test_category_highest_vs_lowest_months_skips_categories_with_no_values():
    df = pd.DataFrame(
        {
            "category": ["empty", "empty", "fruit", "fruit"],
            "kilos per diner": [float("nan"), float("nan"), 1.0, 4.0],
        }
    )

    result = category_highest_vs_lowest_months(df, metric_col="kilos per diner")

    assert result["category"].tolist() == ["fruit"]


def test_category_highest_vs_lowest_months_returns_empty_frame_when_no_category_hits_threshold():
    df = pd.DataFrame({"category": ["legumes", "legumes"], "kilos per diner": [0.1, 0.12]})

    result = category_highest_vs_lowest_months(df, metric_col="kilos per diner")

    assert result.empty
    assert result.columns.tolist() == ["category", "times_higher"]


def test_category_highest_vs_lowest_months_rejects_a_missing_metric_column():
    df = pd.DataFrame({"category": ["fruit"], "kilos per diner": [1.0]})

    with pytest.raises(ValueError, match="kilos per meal"):
        category_highest_vs_lowest_months(df, metric_col="kilos per meal")
