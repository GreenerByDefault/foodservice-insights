from pathlib import Path

from gbd_foodservice_insights.analysis import AnalysisOutcome

from worker_child.contract import ContractError, layout


def place_result_files(run_directory: Path, outcome: AnalysisOutcome) -> None:
    """Moves the library's declared files into `output/files` under the names the contract
    promises.
    """
    destination = run_directory / layout.RESULT_FILES_DIRECTORY
    _place(outcome.pdf, destination / layout.PDF_FILE_NAME)
    _place(outcome.xlsx, destination / layout.XLSX_FILE_NAME)


def _place(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ContractError(f"analyze() declared '{source}' but never wrote it")
    if source != destination:
        # `Path.replace` is atomic, so safe with concurrency.
        source.replace(destination)
