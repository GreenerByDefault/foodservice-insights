import pandas as pd
import pytest
from gbd_foodservice_insights.report.aggregation import aggregate_data
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import (
    DiagnosticStatus,
    quality_status_from_findings,
)
from gbd_foodservice_insights.report.utils import (
    divide_by_diner_meals,
    ensure_month_year_column,
    monthly_totals,
    normalize_diner_meal_mapping,
)


def test_normalize_diner_meal_mapping_and_invalid_keys():
    """Verifies month keys are normalized to Periods and malformed keys fail loudly. This matters
    because report pipeline schema must remain stable across ingestion, quality checks, and
    outputs."""
    mapping = normalize_diner_meal_mapping({"2024-01": 100, "2024-02": "200"})
    assert all(isinstance(k, pd.Period) for k in mapping)
    january = pd.Period("2024-01", freq="M")
    assert isinstance(january, pd.Period)
    assert mapping[january] == 100.0

    with pytest.raises(ValueError):
        normalize_diner_meal_mapping({"bad-month": 1})

    with pytest.raises(ValueError, match="value is missing"):
        normalize_diner_meal_mapping({"NaT": 1})


def test_divide_by_diner_meals_reports_missing_months_without_fallback():
    """Checks missing diner-meal coverage stays missing (NaN) instead of silently dividing by 1.
    This matters because report pipeline schema must remain stable across ingestion, quality
    checks, and outputs."""
    series = pd.Series(
        [10.0, 20.0],
        index=[pd.Period("2024-01", freq="M"), pd.Period("2024-02", freq="M")],
    )
    result, missing_months, invalid_months = divide_by_diner_meals(
        series,
        {"2024-01": 5},
        strict=False,
    )

    assert missing_months == [pd.Period("2024-02", freq="M")]
    assert invalid_months == []
    assert result.loc[pd.Period("2024-01", freq="M")] == 2.0
    assert pd.isna(result.loc[pd.Period("2024-02", freq="M")])


def test_ensure_month_year_column_creates_periods_from_date():
    """Verifies date parsing produces monthly Periods, the canonical key used across aggregations.
    This matters because report pipeline schema must remain stable across ingestion, quality
    checks, and outputs."""
    df = pd.DataFrame({"date": ["2024-01-01", "2024-02-02"]})
    out = ensure_month_year_column(df)
    assert str(out["month_year"].iloc[0]) == "2024-01"
    assert str(out["month_year"].iloc[1]) == "2024-02"


def test_ensure_month_year_column_accepts_month_only_date_strings():
    """Month-only date inputs should normalize to Periods without requiring placeholder days."""
    df = pd.DataFrame({"date": ["04/2025", "2025-05", "Jun 2025"]})
    out = ensure_month_year_column(df)
    assert [str(value) for value in out["month_year"]] == ["2025-04", "2025-05", "2025-06"]


def test_ensure_month_year_column_accepts_string_period_and_datetime_inputs():
    """Verifies mixed month representations normalize to one stable month key format. This
    matters because report pipeline schema must remain stable across ingestion, quality checks,
    and outputs."""
    df = pd.DataFrame(
        {
            "month_year": [
                "2024-01",
                pd.Period("2024-02", freq="M"),
                pd.Timestamp("2024-03-15"),
            ]
        }
    )
    out = ensure_month_year_column(df)
    assert [str(value) for value in out["month_year"]] == ["2024-01", "2024-02", "2024-03"]


@pytest.mark.parametrize(
    ("mapping", "detail"),
    [
        ({"2024-01": 10}, r"missing months in diner_meal_mapping: \[Period\('2024-02', 'M'\)\]"),
        (
            {"2024-01": 10, "2024-02": 0},
            r"non-positive diner-meal counts: \[Period\('2024-02', 'M'\)\]",
        ),
    ],
)
def test_aggregate_data_refuses_per_diner_metrics_without_a_positive_count_per_month(
    mapping: dict[str, int], detail: str
):
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2024-01", freq="M"), pd.Period("2024-02", freq="M")],
            "product": ["a", "a"],
            "kilos_total": [10.0, 20.0],
        }
    )

    with pytest.raises(ValueError, match=f"Cannot compute per-diner metrics: {detail}"):
        aggregate_data(
            df,
            group_by="product",
            diner_meal_mapping=mapping,
            per_diner_meal=True,
            metrics=["kilos_total"],
        )


def test_aggregate_data_keeps_rows_with_missing_group_keys():
    """Ensures missing group labels are retained so totals stay complete during aggregation."""
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2024-01", freq="M"), pd.Period("2024-01", freq="M")],
            "category": ["legumes", pd.NA],
            "kilos_total": [10.0, 5.0],
        }
    )
    out = aggregate_data(
        df,
        group_by="category",
        per_diner_meal=False,
        metrics=["kilos_total"],
    )
    assert out["category"].isna().sum() == 1
    assert out["kilos_total"].sum() == 15.0


def test_monthly_totals_preserve_all_missing_month_as_missing():
    """Ensures all-null monthly values remain missing rather than being coerced to zero."""
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2024-01", freq="M"), pd.Period("2024-01", freq="M")],
            "kilos_total": [pd.NA, pd.NA],
        }
    )
    totals = monthly_totals(df, "kilos_total")
    assert pd.isna(totals.iloc[0])


def _finding(status: DiagnosticStatus) -> Finding:
    return make_finding(stage="test", category="test", status=status, message="")


def test_quality_status_rolls_up_the_worst_finding():
    assert quality_status_from_findings([_finding("success")]) == "pass"
    assert quality_status_from_findings([_finding("success"), _finding("info")]) == "pass"
    assert quality_status_from_findings([_finding("warning")]) == "warning"
    assert quality_status_from_findings([_finding("error")]) == "invalid"
