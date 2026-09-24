import pandas as pd
import pytest
from gbd_foodservice_insights_lab.extraction.pdf import (
    find_possible_misspellings,
    identify_unique_product_names,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    compare_component_datasets,
)
from pandas.testing import assert_frame_equal


@pytest.fixture
def misspellings_df():
    """
    Fixture for creating a sample DataFrame for testing find_possible_misspellings.
    """
    data = {
        "product": ["apple", "aple", "banana", "banan", "orange", "pear"],
        "date": pd.to_datetime(
            ["2023-01-01", "2023-01-01", "2023-01-02", "2023-01-02", "2023-01-03", "2023-01-04"]
        ),
    }
    return pd.DataFrame(data)


def test_find_possible_misspellings_finds_pairs(misspellings_df):
    similar_pairs_df = find_possible_misspellings(misspellings_df, threshold=80)
    assert len(similar_pairs_df) == 2
    assert "apple" in similar_pairs_df["Product 1"].values
    assert "aple" in similar_pairs_df["Product 2"].values
    assert "banana" in similar_pairs_df["Product 1"].values
    assert "banan" in similar_pairs_df["Product 2"].values


def test_find_possible_misspellings_respects_threshold(misspellings_df):
    similar_pairs_df = find_possible_misspellings(misspellings_df, threshold=95)
    assert len(similar_pairs_df) == 0


def test_find_possible_misspellings_no_similar_pairs(misspellings_df):
    df = pd.DataFrame(
        {
            "product": ["apple", "banana", "xylophone"],
            "date": pd.to_datetime(["2023-01-01", "2023-01-02", "2023-01-03"]),
        }
    )
    similar_pairs_df = find_possible_misspellings(df, threshold=90)
    assert len(similar_pairs_df) == 0
    assert list(similar_pairs_df.columns) == ["Product 1", "Product 2", "Similarity Score (%)"]


def test_find_possible_misspellings_raises_error_for_missing_columns():
    with pytest.raises(ValueError, match=r"The DataFrame must have a 'product' column."):
        find_possible_misspellings(pd.DataFrame({"date": [1]}))

    with pytest.raises(ValueError, match=r"The DataFrame must have a 'date' column."):
        find_possible_misspellings(pd.DataFrame({"product": ["a"]}))


def test_identify_unique_product_names():
    data = {"product": ["apple", "banana", "apple", "orange", "banana", "grape"]}
    df = pd.DataFrame(data)
    unique_df = identify_unique_product_names(df)

    assert len(unique_df) == 2
    assert "orange" in unique_df["product"].values
    assert "grape" in unique_df["product"].values
    assert "apple" not in unique_df["product"].values
    assert "banana" not in unique_df["product"].values


def test_identify_unique_product_names_no_uniques():
    data = {"product": ["apple", "apple", "banana", "banana"]}
    df = pd.DataFrame(data)
    unique_df = identify_unique_product_names(df)
    assert len(unique_df) == 0


def test_identify_unique_product_names_all_uniques():
    data = {"product": ["apple", "banana", "orange"]}
    df = pd.DataFrame(data)
    unique_df = identify_unique_product_names(df)
    assert len(unique_df) == 3
    assert_frame_equal(df.reset_index(drop=True), unique_df.reset_index(drop=True))


@pytest.fixture
def component_dfs():
    """
    Fixture for creating sample DataFrames for testing compare_component_datasets.
    """
    df1 = pd.DataFrame({"A": [1], "B": [2], "common": [0]})
    df2 = pd.DataFrame({"A": [3], "C": [4], "common": [0]})
    df3 = pd.DataFrame({"D": [5], "C": [6], "common": [0]})
    return [df1, df2, df3]


def test_compare_component_datasets(component_dfs, capsys):
    compare_component_datasets(component_dfs)
    captured = capsys.readouterr()

    # Check row counts
    assert "comparing number of rows:  [1, 1, 1]" in captured.out

    # Check common columns
    assert "Columns found in all 3 DataFrames:   ['common']" in captured.out

    # Check unique columns
    assert "In DataFrame 0: ['B']" in captured.out
    assert "In DataFrame 2: ['D']" in captured.out

    # Check partially shared columns
    assert "Columns found in multiple (but not all) DataFrames:" in captured.out
    assert "['A', 'C']" in captured.out  # The output is sorted


def test_compare_component_datasets_empty_list(capsys):
    compare_component_datasets([])
    captured = capsys.readouterr()
    assert "Warning: No DataFrames provided to compare." in captured.out


def test_compare_component_datasets_single_df(capsys):
    df = pd.DataFrame({"a": [1]})
    compare_component_datasets([df])
    captured = capsys.readouterr()
    assert "comparing number of rows:  [1]" in captured.out
    assert "Comparison requires at least two DataFrames." in captured.out


def test_find_possible_misspellings_empty_df():
    df = pd.DataFrame(
        {"product": pd.Series(dtype="str"), "date": pd.Series(dtype="datetime64[ns]")}
    )
    result_df = find_possible_misspellings(df)
    assert result_df.empty
    assert list(result_df.columns) == ["Product 1", "Product 2", "Similarity Score (%)"]


def test_find_possible_misspellings_type_error():
    with pytest.raises(TypeError):
        find_possible_misspellings("not a dataframe")  # ty: ignore[invalid-argument-type]  # Deliberately wrong input verifies the function rejects non-DataFrames.


def test_identify_unique_product_names_empty_df():
    df = pd.DataFrame({"product": pd.Series(dtype="str")})
    result_df = identify_unique_product_names(df)
    assert result_df.empty


def test_identify_unique_product_names_missing_col():
    df = pd.DataFrame({"not_product": [1, 2]})
    with pytest.raises(AssertionError):
        identify_unique_product_names(df)
