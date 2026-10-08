import numpy as np
import pandas as pd
import pytest
import yaml
from gbd_foodservice_insights.report import thresholds
from gbd_foodservice_insights_lab.food_report.diagnostics import (
    check_meat_quantities,
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


def test_identify_potentially_abnormal_weight_meat_items_reads_threshold_from_yaml(
    tmp_path, monkeypatch
):
    config_path = tmp_path / "diagnostic_thresholds.yaml"
    config_path.write_text(
        yaml.safe_dump({"meat_quantity_reasonableness": {"large_quantity_threshold": 50}})
    )
    monkeypatch.setattr(thresholds, "DIAGNOSTIC_THRESHOLDS_PATH", config_path)
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
