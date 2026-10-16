from pathlib import Path

import pytest
from support.contract_fixtures import VALID_CATEGORIZATION_CACHE, VALID_MANIFEST
from worker_child.contract import layout


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it: every directory it owns, a valid manifest, and a
    valid categorization cache."""
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    (tmp_path / layout.MANIFEST).write_text(VALID_MANIFEST, encoding="utf-8")
    (tmp_path / layout.CATEGORIZATION_CACHE).write_text(
        VALID_CATEGORIZATION_CACHE, encoding="utf-8"
    )
    return tmp_path
