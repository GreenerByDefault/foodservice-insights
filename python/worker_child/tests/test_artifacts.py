from decimal import Decimal
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import AiUsage, AnalysisOutcome
from worker_child import contract
from worker_child.artifacts import place_result_files
from worker_child.parse import ContractError

ZERO_USAGE = AiUsage(model="m", input_tokens=0, output_tokens=0, cost_usd=Decimal("0"), metadata={})


@pytest.fixture
def output_directory(tmp_path: Path) -> Path:
    directory = tmp_path / "output" / "files"
    directory.mkdir(parents=True)
    return directory


def outcome_with(
    output_directory: Path, *, charts: dict[str, Path] | None = None
) -> AnalysisOutcome:
    pdf = output_directory / "some-report-name.pdf"
    xlsx = output_directory / "some-workbook-name.xlsx"
    pdf.write_bytes(b"%PDF-stub")
    xlsx.write_bytes(b"PKstub")
    if charts is None:
        chart_path = output_directory / "chart.png"
        chart_path.write_bytes(b"\x89PNGstub")
        charts = {"category_breakdown": chart_path}
    return AnalysisOutcome(pdf=pdf, xlsx=xlsx, charts=charts, ai=ZERO_USAGE, metadata={})


def test_renames_declared_files_to_contract_names(tmp_path: Path, output_directory: Path) -> None:
    outcome = outcome_with(output_directory)

    place_result_files(tmp_path, outcome)

    assert (output_directory / contract.PDF_FILE_NAME).read_bytes() == b"%PDF-stub"
    assert (output_directory / contract.XLSX_FILE_NAME).read_bytes() == b"PKstub"
    assert (output_directory / contract.chart_file_name("category_breakdown")).is_file()


def test_leaves_no_file_behind_under_the_librarys_own_name(
    tmp_path: Path, output_directory: Path
) -> None:
    outcome = outcome_with(output_directory)

    place_result_files(tmp_path, outcome)

    assert not outcome.pdf.exists()
    assert not outcome.xlsx.exists()


def test_raises_when_the_pdf_was_declared_but_never_written(
    tmp_path: Path, output_directory: Path
) -> None:
    outcome = outcome_with(output_directory)
    outcome.pdf.unlink()

    with pytest.raises(ContractError):
        place_result_files(tmp_path, outcome)


def test_raises_when_a_chart_was_declared_but_never_written(
    tmp_path: Path, output_directory: Path
) -> None:
    missing = output_directory / "missing.png"
    outcome = outcome_with(output_directory, charts={"missing_chart": missing})

    with pytest.raises(ContractError):
        place_result_files(tmp_path, outcome)


def test_rejects_a_chart_key_that_is_not_snake_case(tmp_path: Path, output_directory: Path) -> None:
    chart_path = output_directory / "chart.png"
    chart_path.write_bytes(b"\x89PNGstub")
    outcome = outcome_with(output_directory, charts={"Not Snake": chart_path})

    with pytest.raises(ContractError):
        place_result_files(tmp_path, outcome)
