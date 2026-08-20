from typing import get_args

from gbd_foodservice_insights.analysis import CountsBasis as LibraryCountsBasis
from gbd_foodservice_insights.analysis import UnitSystem as LibraryUnitSystem
from worker_child.contract.names import CountsBasis as ChildCountsBasis
from worker_child.contract.names import UnitSystem as ChildUnitSystem


def test_counts_basis_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildCountsBasis) == get_args(LibraryCountsBasis)


def test_unit_system_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildUnitSystem) == get_args(LibraryUnitSystem)
