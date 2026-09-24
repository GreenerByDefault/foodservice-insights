import ast
import os
import shutil
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    check_same_columns,
    detect_component_duplicate_risk,
    raw_data_report,
    suggest_column_roles,
    suggest_date_source_and_coverage,
    suggest_tabular_import_settings,
)

_TABULAR_RUNSCRIPT = (
    Path(__file__).resolve().parents[2] / "runscripts" / "0.5. Prepare tabular data Runscript.py"
)


@pytest.fixture
def temp_test_dir(tmpdir_factory):
    temp_dir = tmpdir_factory.mktemp("tabular_inspection_data")
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


def test_check_same_columns_same(capsys):
    """Confirms the checker explicitly reports matching schemas so users can trust file
    compatibility."""
    df1 = pd.DataFrame({"A": [1], "B": [2]})
    df2 = pd.DataFrame({"A": [3], "B": [4]})
    check_same_columns(df1, df2)
    captured = capsys.readouterr()
    assert "The columns are the same" in captured.out


def test_check_same_columns_different(capsys):
    """Confirms mismatch diagnostics name which columns differ, making cleanup actionable. This
    matters because tabular ingestion must be reliable before any downstream cleaning or
    reporting."""
    df1 = pd.DataFrame({"A": [1], "B": [2]})
    df2 = pd.DataFrame({"A": [3], "C": [4]})
    check_same_columns(df1, df2)
    captured = capsys.readouterr()
    assert "The columns are not the same" in captured.out
    assert "Columns unique to df1: ['B']" in captured.out
    assert "Columns unique to df2: ['C']" in captured.out


def test_raw_data_report_return_dict(create_test_files):
    """Checks report shape so callers can reliably consume counts by file type."""
    data_type, report = raw_data_report(create_test_files, return_dict=True)
    assert isinstance(data_type, str)
    assert isinstance(report, dict)
    assert len(report["csv"]) == 2
    assert len(report["excel"]) == 2
    assert len(report["pdf"]) == 0
    assert len(report["dirs"]) == 0


def test_raw_data_report_recursive(create_test_files):
    """Ensures recursive scanning captures nested files, which is common in client folder drops."""
    sub_dir = create_test_files / "subdir"
    os.makedirs(sub_dir)
    csv_data = pd.DataFrame({"G": [1]})
    csv_data.to_csv(sub_dir / "test3.csv", index=False)

    data_type, report = raw_data_report(create_test_files, recursive=True, return_dict=True)
    assert isinstance(data_type, str)
    assert len(report["csv"]) == 3
    assert len(report["dirs"]) == 1


def test_raw_data_report_column_consistency(create_test_files, capsys):
    """Verifies both the pass and warning messages, so schema drift is visible before analysis."""
    consistent_dir = create_test_files / "consistent"
    os.makedirs(consistent_dir)
    df = pd.DataFrame({"A": [1], "B": [2]})
    df.to_csv(consistent_dir / "cons1.csv", index=False)
    df.to_csv(consistent_dir / "cons2.csv", index=False)

    raw_data_report(consistent_dir)
    captured = capsys.readouterr()
    assert "All Excel and CSV files have IDENTICAL columns" in captured.out

    inconsistent_dir = create_test_files / "inconsistent"
    os.makedirs(inconsistent_dir)
    df1 = pd.DataFrame({"A": [1], "B": [2]})
    df2 = pd.DataFrame({"A": [1], "C": [2]})
    df1.to_csv(inconsistent_dir / "incons1.csv", index=False)
    df2.to_csv(inconsistent_dir / "incons2.csv", index=False)

    raw_data_report(inconsistent_dir)
    captured = capsys.readouterr()
    assert "WARNING: Files have DIFFERENT column structures!" in captured.out


def test_suggest_tabular_import_settings_recommends_shared_skiprows(tmp_path):
    """Checks that messy Excel files with the same leading metadata rows get one shared skiprows
    suggestion."""
    data_dir = tmp_path / "raw_data"
    data_dir.mkdir()
    df = pd.DataFrame({"Product Description": ["Apples"], "Net Wght Shipped": [10]})
    with pd.ExcelWriter(data_dir / "jan.xlsx") as writer:
        df.to_excel(writer, index=False, startrow=9)
    with pd.ExcelWriter(data_dir / "feb.xlsx") as writer:
        df.to_excel(writer, index=False, startrow=9)

    result = suggest_tabular_import_settings(data_dir)
    assert result["recommended_skiprows"] == 9
    assert result["has_consistent_excel_skiprows"] is True


def test_suggest_column_roles_identifies_core_columns():
    """Checks that the new guidance layer can point analysts toward the likely product, weight,
    and date columns."""
    df = pd.DataFrame(
        {
            "product_description": ["Chicken Burger", "Tofu Stir Fry"],
            "net_wght_shipped": [10.5, 12.0],
            "invoice_date": ["2024-01-01", "2024-01-02"],
            "cases": [1, 2],
        }
    )
    result = suggest_column_roles([df])
    assert result["roles"]["product"]["best_column"] == "product_description"
    assert result["roles"]["weight"]["best_column"] == "net_wght_shipped"
    assert result["roles"]["date"]["best_column"] == "invoice_date"


def test_suggest_date_source_and_coverage_prefers_existing_date_column():
    """Checks that a real in-data date column beats filename guessing when both are available."""
    df = pd.DataFrame(
        {
            "invoice_date": ["2024-01-01", "2024-01-20", "2024-02-01"],
            "product": ["a", "b", "c"],
        }
    )
    result = suggest_date_source_and_coverage(
        [df],
        component_names=["Purchase Detail_Jan2024_baseline.xlsx"],
    )
    assert result["source"] == "existing_column"
    assert result["date_column"] == "invoice_date"
    assert "2024-01" in result["observed_periods"]
    assert "2024-02" in result["observed_periods"]


def test_suggest_date_source_and_coverage_uses_component_names_when_needed():
    """Checks that filename or sheet naming can still guide the analyst when the rows themselves
    do not contain dates."""
    dfs = [
        pd.DataFrame({"product": ["a"], "weight": [1]}),
        pd.DataFrame({"product": ["b"], "weight": [2]}),
    ]
    result = suggest_date_source_and_coverage(
        dfs,
        component_names=[
            "Purchase Detail_Jan2024_baseline.xlsx",
            "Purchase Detail_March2024_baseline.xlsx",
        ],
    )
    assert result["source"] == "component_name"
    assert result["observed_periods"] == ["2024-01", "2024-03"]
    assert result["missing_periods"] == ["2024-02"]


def test_mismatched_component_names_raise_instead_of_truncating():
    """A short name list used to silently drop the trailing components from both analyses."""
    dfs = [
        pd.DataFrame({"product": ["a"], "weight": [1]}),
        pd.DataFrame({"product": ["b"], "weight": [2]}),
    ]
    for analysis in (suggest_date_source_and_coverage, detect_component_duplicate_risk):
        with pytest.raises(ValueError, match="same length"):
            analysis(dfs, component_names=["only_one"])


def test_detect_component_duplicate_risk_below_threshold():
    """Checks that small amounts of overlap stay informational rather than looking like a major
    upload problem."""
    base_rows = pd.DataFrame(
        {
            "product": [f"item_{i}" for i in range(20)],
            "weight": list(range(20)),
        }
    )
    repeated_rows = base_rows.head(2).copy()

    result = detect_component_duplicate_risk(
        [base_rows, repeated_rows],
        component_names=["jan", "repeat_fragment"],
        duplicate_share_threshold=0.20,
    )
    assert result["threshold_crossed"] is False


def test_detect_component_duplicate_risk_flags_monthly_plus_combined_tab():
    """Checks the exact upload issue we saw before, where one combined tab repeats the monthly
    tabs."""
    jan = pd.DataFrame({"product": ["a", "b"], "weight": [1, 2]})
    feb = pd.DataFrame({"product": ["c", "d"], "weight": [3, 4]})
    all_months = pd.concat([jan, feb], ignore_index=True)

    result = detect_component_duplicate_risk(
        [jan, feb, all_months],
        component_names=["jan", "feb", "all_months"],
        duplicate_share_threshold=0.20,
    )
    assert result["threshold_crossed"] is True
    assert result["duplicate_row_share"] == pytest.approx(1.0)
    assert result["pairwise_overlap"][0]["right_component"] == "all_months"


def test_template_hydrogen_file_uses_new_tabular_modules():
    """Checks that the canonical 0.5 Hydrogen file has moved off the legacy import path."""
    template_path = _TABULAR_RUNSCRIPT
    all_code = template_path.read_text()
    assert "from gbd_foodservice_insights_lab.extraction.tabular_io import" in all_code
    assert "from gbd_foodservice_insights_lab.extraction.tabular_inspection import" in all_code
    assert "from gbd_foodservice_insights_lab.extraction.other import" not in all_code


def test_context_sensitive_template_calls_pass_local_context():
    """Checks that template file calls do not silently drop baseline or pilot context that is
    already available locally."""
    template_path = _TABULAR_RUNSCRIPT
    all_code = template_path.read_text()
    tree = ast.parse(all_code)

    raw_data_report_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "raw_data_report"
    ]

    assert raw_data_report_calls, "Expected the template file to call raw_data_report()."

    for call in raw_data_report_calls:
        keyword_names = {kw.arg for kw in call.keywords if kw.arg is not None}
        assert "baseline_pilot" in keyword_names
        assert "base_filepath" in keyword_names
