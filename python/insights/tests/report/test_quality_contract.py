import json
import warnings
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights import emissions
from gbd_foodservice_insights.report.aggregation import aggregate_data
from gbd_foodservice_insights.report.pipeline import run_food_report
from gbd_foodservice_insights.report.quality import (
    check_required_columns,
    check_required_non_null,
)
from gbd_foodservice_insights.report.schema import (
    per_diner_metric_name,
    quality_status_from_findings,
    validate_missing_data_policy,
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


def test_quality_helpers_detect_missing_columns_and_non_null_violations():
    """Confirms quality checks emit structured findings for both absent columns and null
    violations. This matters because report pipeline schema must remain stable across ingestion,
    quality checks, and outputs."""
    df = pd.DataFrame({"a": [1, None], "b": ["x", "y"]})
    missing = check_required_columns(df, ["a", "c"], stage="ingestion")
    assert len(missing) == 1
    assert missing[0]["status"] == "error"

    non_null = check_required_non_null(df, ["a"], stage="ingestion")
    assert len(non_null) == 1
    assert non_null[0]["column"] == "a"


def test_emissions_returns_structured_findings_for_unmatched_category():
    """Ensures unmatched categories are surfaced as findings so emission gaps are auditable."""
    df = pd.DataFrame(
        {
            "category": ["legumes", "definitely_not_a_real_category"],
            "kilos_total": [10.0, 5.0],
        }
    )

    out, findings = emissions.calculate_emissions(
        df,
        weight_col="kilos_total",
        category_col="category",
        return_findings=True,
    )

    assert "emission_factor_used" in out.columns
    assert any(f["category"] == "unmatched_emission_factors" for f in findings)


def test_aggregate_data_no_default_divide_by_one_behavior():
    """Guards against misleading per-diner metrics by preserving NaN when month coverage is
    missing."""
    df = pd.DataFrame(
        {
            "month_year": [pd.Period("2024-01", freq="M"), pd.Period("2024-02", freq="M")],
            "product": ["a", "a"],
            "kilos_total": [10.0, 20.0],
        }
    )

    out = aggregate_data(
        df,
        group_by="product",
        diner_meal_mapping={"2024-01": 10},
        per_diner_meal=True,
        metrics=["kilos_total"],
        strict_diner_meal_coverage=False,
    )

    col = per_diner_metric_name("kilos_total")
    jan_val = out.loc[out["month_year"] == pd.Period("2024-01", freq="M"), col].iloc[0]
    feb_val = out.loc[out["month_year"] == pd.Period("2024-02", freq="M"), col].iloc[0]
    assert jan_val == 1.0
    assert pd.isna(feb_val)


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


def test_schema_helpers_validate_policy_and_quality_status():
    """Verifies policy validation and status rollup encode the expected report schema behavior.
    This matters because report pipeline schema must remain stable across ingestion, quality
    checks, and outputs."""
    assert validate_missing_data_policy("warn_continue") == "warn_continue"
    assert quality_status_from_findings([{"status": "success"}]) == "pass"
    assert quality_status_from_findings([{"status": "warning"}]) == "warning"
    assert quality_status_from_findings([{"status": "error"}]) == "invalid"


@pytest.fixture
def food_report_tmp_data(tmp_path: Path):
    input_df = pd.DataFrame(
        {
            "date": ["2024-01-05", "bad date"],
            "product": ["tofu", "beef"],
            "category": ["legumes", "beef and buffalo meat"],
            "kilos_total": [10.0, 5.0],
        }
    )

    input_path = tmp_path / "categorized_test.csv"
    input_df.to_csv(input_path, index=False)

    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({"2024-01": 1000}))

    metadata_path = tmp_path / "client_metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "client": "Test Client",
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
            }
        )
    )

    return input_path, diner_path


def test_run_food_report_warn_continue_returns_quality_payload(
    monkeypatch, food_report_tmp_data, tmp_path
):
    """Checks warn-continue mode returns quality metadata needed for downstream diagnostics/UI
    display."""
    input_path, diner_path = food_report_tmp_data

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_client_excel_report",
        lambda **kwargs: str(tmp_path / "out.xlsx"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    assert "quality_status" in result
    assert "missing_data_findings" in result
    assert "quality_summary" in result
    assert result["quality_status"] in {"warning", "invalid"}


def test_run_food_report_flags_unexpected_row_loss_in_emissions_stage(
    monkeypatch, food_report_tmp_data, tmp_path
):
    """Warn-continue mode should still surface silent row loss as an invalid-quality run."""
    input_path, diner_path = food_report_tmp_data

    def fake_calculate_emissions(df, **kwargs):
        out = df.iloc[:-1].copy()
        out["emission_factor_used"] = 1.0
        out["emissions_kg_co2e"] = 1.0
        return out, []

    monkeypatch.setattr(
        "gbd_foodservice_insights.emissions.calculate_emissions",
        fake_calculate_emissions,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_client_excel_report",
        lambda **kwargs: str(tmp_path / "out.xlsx"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    row_drift_finding = next(
        finding
        for finding in result["missing_data_findings"]
        if finding.get("category") == "row_count_drift" and finding.get("stage") == "emissions"
    )

    assert row_drift_finding["status"] == "error"
    assert row_drift_finding["metadata"]["before_rows"] == 2
    assert row_drift_finding["metadata"]["after_rows"] == 1
    assert result["quality_status"] == "invalid"


def test_run_food_report_hard_fail_raises_on_required_missing(monkeypatch, tmp_path):
    """Checks hard-fail mode blocks report generation when required fields are missing. This
    matters because report pipeline contracts must remain stable across ingestion, quality
    checks, and outputs."""
    bad_df = pd.DataFrame(
        {
            "date": ["2024-01-01"],
            "category": ["legumes"],
            "kilos_total": [1.0],
        }
    )
    input_path = tmp_path / "categorized_bad.csv"
    bad_df.to_csv(input_path, index=False)

    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({"2024-01": 1000}))

    (tmp_path / "client_metadata.json").write_text("{}")

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        lambda **kwargs: str(tmp_path / "out.pdf"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_client_excel_report",
        lambda **kwargs: str(tmp_path / "out.xlsx"),
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.excel.build_qa_excel_report",
        lambda **kwargs: str(tmp_path / "out_qa.xlsx"),
    )

    with pytest.raises(ValueError, match="hard_fail"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
            missing_data_policy="hard_fail",
        )


def test_check_required_non_null_handles_context_column_as_required_column():
    """A required column that is also a sample-context column must not be listed twice.

    Listing it twice made pandas drop a column from the sample rows and warn that the
    columns were not unique.
    """
    df = pd.DataFrame(
        {
            "date": ["2024-01-01", "2024-01-02"],
            "month_year": ["Jan 2024", "Jan 2024"],
            "product": ["Tofu", "Beans"],
            "category": ["Plant-based Meats", None],
        }
    )

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        findings = check_required_non_null(df, ["category"], stage="ingestion")

    assert len(findings) == 1
    sample_rows = findings[0]["metadata"]["sample_rows"]
    assert sample_rows == [
        {"date": "2024-01-02", "month_year": "Jan 2024", "product": "Beans", "category": None}
    ]
