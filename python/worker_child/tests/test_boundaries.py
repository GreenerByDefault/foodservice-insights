import ast
from pathlib import Path
from typing import get_args

from gbd_foodservice_insights.analysis import CountsBasis as LibraryCountsBasis
from gbd_foodservice_insights.analysis import UnitSystem as LibraryUnitSystem
from worker_child.contract import CountsBasis as ChildCountsBasis
from worker_child.contract import UnitSystem as ChildUnitSystem

WORKER_CHILD_SRC = Path(__file__).resolve().parents[1] / "src" / "worker_child"
# Never `gbd_foodservice_insights.testing`, which exists for tests, and never a future
# private module.
ALLOWED_GBD_MODULES = {"gbd_foodservice_insights", "gbd_foodservice_insights.analysis"}


def _imported_gbd_modules(source: str) -> set[str]:
    tree = ast.parse(source)
    modules: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.ImportFrom)
            and node.module
            and node.module.startswith("gbd_foodservice_insights")
        ):
            modules.add(node.module)
        elif isinstance(node, ast.Import):
            modules.update(
                alias.name
                for alias in node.names
                if alias.name.startswith("gbd_foodservice_insights")
            )
    return modules


def test_only_imports_the_librarys_public_surface() -> None:
    offenders = {
        path.name: modules - ALLOWED_GBD_MODULES
        for path in WORKER_CHILD_SRC.rglob("*.py")
        for modules in [_imported_gbd_modules(path.read_text(encoding="utf-8"))]
        if not modules <= ALLOWED_GBD_MODULES
    }
    assert offenders == {}


def test_counts_basis_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildCountsBasis) == get_args(LibraryCountsBasis)


def test_unit_system_agrees_between_the_two_stacks() -> None:
    assert get_args(ChildUnitSystem) == get_args(LibraryUnitSystem)
