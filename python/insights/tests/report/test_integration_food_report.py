"""End-to-end integration test for the food-report pipeline.

Unlike ``test_outputs.py`` and ``test_quality_contract.py`` -- which call
``run_food_report`` but monkeypatch away PDF rendering, plotting, and (in places)
the Excel builders and emissions calculation -- this test runs the orchestrator
**fully unmocked** on the committed, realistic staged dataset. It exercises the
real chain (emissions -> aggregation -> diagnostics -> matplotlib charts -> PDF
-> client/QA workbooks -> manifest) and asserts the deliverables are produced
and structurally valid.

The run is deterministic and hermetic: the input is already categorized and
emission factors come from the packaged ``GBD_categories.yaml`` -- no API keys
and no network are required. matplotlib is forced to the ``Agg`` backend in
``conftest.py``.
"""

import json
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.report.pipeline import run_food_report


@pytest.fixture
def staged_report_inputs(tmp_path):
    """Copy the committed step-4 dataset into an isolated dir and build a
    diner-meals file whose months are derived from the data itself.

    Copying matters: ``run_food_report`` writes ``client_metadata.json`` next to
    its input, so pointing it at the real fixture file would pollute the
    repository. Working from a copy under ``tmp_path`` keeps every write
    confined to pytest's temp dir.
    """
    src = Path(__file__).parents[1] / "data" / "aggregated_baseline.csv"
    df = pd.read_csv(src)

    # Mirror the canonical end-of-categorization cleanup (see
    # categorization/steps.py:306-310): blank categories become "No Matches Found"
    # and those rows are dropped. The report pipeline is designed to receive
    # data with these already removed -- report_plots rejects any category that
    # is not tagged food or drink -- so this is what run_food_report sees in
    # production, even though the committed step-4 file still contains them.
    df["category"] = df["category"].fillna("No Matches Found")
    df = df.loc[df["category"] != "No Matches Found"].copy()
    assert not df.empty, "Expected at least one genuinely-categorized food row."

    input_path = tmp_path / "categorized_integration.csv"
    df.to_csv(input_path, index=False)

    months = sorted(df["month_year"].dropna().astype(str).unique())
    assert months, "Test data must contain at least one month_year value."
    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({month: 5000 for month in months}))

    return input_path, diner_path


def test_food_report_end_to_end_produces_valid_artifacts(staged_report_inputs, tmp_path):
    """Runs the entire report pipeline UNMOCKED on realistic staged data and
    confirms every deliverable is produced and structurally valid. This matters
    because the real emissions -> charts -> PDF -> Excel -> manifest chain is
    never exercised together by the existing (mocked) report tests, so a break
    at any stage boundary would otherwise ship silently.
    """
    input_path, diner_path = staged_report_inputs

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        region="us",
        missing_data_policy="warn_continue",
    )

    # 1. The run completed and reported a recognised quality status. The staged
    #    data has sparse categories, so quality may legitimately be a warning or
    #    invalid; what must hold is that the run itself succeeded.
    assert result["run_status"] == "success"
    assert result["quality_status"] in {"pass", "warning", "invalid"}

    # 2. All six artifacts exist on disk.
    for key in (
        "pdf_path",
        "client_excel_path",
        "qa_excel_path",
        "manifest_path",
        "log_path",
        "graphs_dir",
    ):
        assert Path(result[key]).exists(), f"Missing artifact: {key}"

    # 3. The PDF is a real, openable PDF (the real builder ran, not a stub).
    assert Path(result["pdf_path"]).read_bytes()[:4] == b"%PDF"

    # 4. Real charts were rendered into the graphs dir.
    assert result["graph_paths"], "Expected at least one rendered chart."
    for graph_path in result["graph_paths"]:
        assert Path(graph_path).exists()
        assert Path(graph_path).parent == Path(result["graphs_dir"])

    # 5. Both workbooks open and carry their expected sheets (real openpyxl
    #    serialization), and the client workbook stays lean (no internal tabs).
    client_sheets = set(pd.ExcelFile(result["client_excel_path"]).sheet_names)
    qa_sheets = set(pd.ExcelFile(result["qa_excel_path"]).sheet_names)

    expected_client_sheets = {
        "Monthly by Product",
        "Monthly by Category",
        "Emissions Summary",
        "Substitution_Scenarios",
    }
    assert expected_client_sheets <= client_sheets, (
        f"Client workbook missing sheets: {expected_client_sheets - client_sheets}"
    )
    assert {"Raw Data", "Data_Quality_Findings"} <= qa_sheets
    assert "Raw Data" not in client_sheets  # internal tabs stay out of the client file

    # 6. The manifest is valid JSON and points at the real outputs.
    manifest = json.loads(Path(result["manifest_path"]).read_text())
    assert manifest["run_status"] == "success"
    assert manifest["run_id"] == result["run_id"]
    assert manifest["outputs"]["client_excel"] == result["client_excel_path"]

    # 7. The run log captured something.
    assert Path(result["log_path"]).read_text().strip()
