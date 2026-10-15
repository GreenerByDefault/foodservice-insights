"""The child copies the analysis library's enums into its own contract types so the seam is
typed on both sides. These assert the two copies never drift apart.
"""

from typing import get_args

from gbd_foodservice_insights.analysis import CountsBasis as LibraryCountsBasis
from gbd_foodservice_insights.analysis import LlmOperation as LibraryLlmOperation
from gbd_foodservice_insights.analysis import Stage as LibraryStage
from gbd_foodservice_insights.analysis import UnitSystem as LibraryUnitSystem
from gbd_foodservice_insights.input_csv import INPUT_COLUMNS as LibraryInputColumns
from gbd_foodservice_insights.report.quality import QualityCheck as LibraryQualityCheck
from gbd_foodservice_insights.report.schema import DiagnosticStatus as LibraryDiagnosticStatus
from worker_child.contract.layout import INPUT_CSV_COLUMNS as ChildInputCsvColumns
from worker_child.contract.names import CountsBasis as ChildCountsBasis
from worker_child.contract.names import DiagnosticStatus as ChildDiagnosticStatus
from worker_child.contract.names import LlmOperation as ChildLlmOperation
from worker_child.contract.names import QualityCheck as ChildQualityCheck
from worker_child.contract.names import Stage as ChildStage
from worker_child.contract.names import UnitSystem as ChildUnitSystem


def test_counts_basis_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildCountsBasis) == get_args(LibraryCountsBasis)


def test_unit_system_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildUnitSystem) == get_args(LibraryUnitSystem)


def test_input_csv_columns_agree_between_the_two_stacks() -> None:
    assert ChildInputCsvColumns == LibraryInputColumns


def test_telemetry_enums_agree_between_the_two_stacks() -> None:
    assert get_args(ChildLlmOperation) == get_args(LibraryLlmOperation)
    assert get_args(ChildStage) == get_args(LibraryStage)
    assert get_args(ChildQualityCheck) == get_args(LibraryQualityCheck)
    assert get_args(ChildDiagnosticStatus) == get_args(LibraryDiagnosticStatus)
