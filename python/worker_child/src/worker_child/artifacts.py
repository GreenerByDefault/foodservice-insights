from pathlib import Path

from gbd_foodservice_insights.analysis import AnalysisOutcome

from worker_child import contract
from worker_child.parse import ContractError


def place_result_files(run_directory: Path, outcome: AnalysisOutcome) -> None:
    """Chart-key validation, and moving the library's declared files into `output/files`
    under the names the contract promises. `analyze()` names its own charts; only this
    module knows `chart-{key}.png`.
    """
    destination = run_directory / contract.RESULT_FILES_DIRECTORY
    _place(outcome.pdf, destination / contract.PDF_FILE_NAME)
    _place(outcome.xlsx, destination / contract.XLSX_FILE_NAME)
    for chart_key, path in outcome.charts.items():
        if not contract.CHART_KEY_PATTERN.fullmatch(chart_key):
            raise ContractError(f"chart key '{chart_key}' is not snake_case")
        _place(path, destination / contract.chart_file_name(chart_key))


def _place(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ContractError(f"analyze() declared '{source}' but never wrote it")
    if source != destination:
        # `Path.replace` is atomic, so safe with concurrency.
        source.replace(destination)
