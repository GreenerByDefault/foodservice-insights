import shutil
from pathlib import Path

import openpyxl
import pandas as pd
import pytest
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    detect_excel_header_row,
    extract_dates_from_sheet_filenames,
    read_in_all_data_files,
)


@pytest.fixture
def temp_test_dir(tmpdir_factory):
    temp_dir = tmpdir_factory.mktemp("tabular_io_data")
    yield Path(temp_dir)
    shutil.rmtree(temp_dir)


@pytest.fixture
def create_test_files(temp_test_dir):
    csv_data1 = pd.DataFrame({"A": [1, 2], "B": [3, 4]})
    csv_data1.to_csv(temp_test_dir / "test1.csv", index=False)

    csv_data2 = pd.DataFrame({"A": [5, 6], "C": [7, 8]})
    csv_data2.to_csv(temp_test_dir / "test2.csv", index=False)

    excel_data1 = pd.DataFrame({"D": [9, 10], "E": [11, 12]})
    excel_data1.to_excel(temp_test_dir / "test1.xlsx", index=False)

    excel_data2 = pd.DataFrame({"D": [13, 14], "F": [15, 16]})
    excel_data2.to_excel(temp_test_dir / "test2.xlsx", index=False)

    return temp_test_dir


def test_read_in_all_data_files_csv(create_test_files):
    dfs, filepaths = read_in_all_data_files(create_test_files, file_type="csv")
    assert len(dfs) == 2
    assert len(filepaths) == 2
    assert all(isinstance(df, pd.DataFrame) for df in dfs)


def test_read_in_all_data_files_excel(create_test_files):
    dfs, filepaths = read_in_all_data_files(create_test_files, file_type="excel")
    assert len(dfs) == 2
    assert len(filepaths) == 2
    assert all(isinstance(df, pd.DataFrame) for df in dfs)


def test_read_in_all_data_files_invalid_type(create_test_files):
    with pytest.raises(ValueError):
        read_in_all_data_files(create_test_files, file_type="invalid")  # ty: ignore[invalid-argument-type]  # Deliberately invalid option verifies unsupported file types fail loudly.


def test_read_in_all_data_files_requires_a_directory():
    with pytest.raises(ValueError, match="data_location is required"):
        read_in_all_data_files()


def test_read_in_all_data_files_empty(temp_test_dir):
    dfs, filepaths = read_in_all_data_files(temp_test_dir, file_type="csv")
    assert len(dfs) == 0
    assert len(filepaths) == 0


def test_extract_dates_from_sheet_filenames_parses_month_year():
    df = pd.DataFrame(
        {
            "sheet_filename": [
                "Purchase Detail_Jan2024_baseline.xlsx",
                "Purchase Detail_Feb2024_baseline.xlsx",
            ]
        }
    )
    result = extract_dates_from_sheet_filenames(df, show_warnings=False)
    assert result["date"].dt.strftime("%Y-%m").tolist() == ["2024-01", "2024-02"]


def test_detect_excel_header_row_finds_metadata_offset(tmp_path):
    path = tmp_path / "messy.xlsx"
    df = pd.DataFrame({"Product Description": ["Apples"], "Net Wght Shipped": [10]})
    with pd.ExcelWriter(path) as writer:
        df.to_excel(writer, index=False, startrow=9)

    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.active
    header_row = detect_excel_header_row(ws)
    wb.close()

    assert header_row == 10
