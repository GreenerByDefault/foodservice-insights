import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights_lab.food_report.diagnostics import summarise_numeric_columns


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
