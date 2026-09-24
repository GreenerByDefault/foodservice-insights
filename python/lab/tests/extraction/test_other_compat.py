import importlib
import shutil
import sys
import warnings
from pathlib import Path

import pandas as pd
import pytest


@pytest.fixture
def temp_test_dir(tmpdir_factory):
    temp_dir = tmpdir_factory.mktemp("extract_other_compat")
    yield Path(temp_dir)
    shutil.rmtree(temp_dir)


def test_importing_extract_other_emits_futurewarning():
    """Checks that the legacy module is intentionally noisy so migration pressure is real."""
    sys.modules.pop("gbd_foodservice_insights_lab.extraction.other", None)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        importlib.import_module("gbd_foodservice_insights_lab.extraction.other")

    assert any(
        issubclass(warning.category, FutureWarning)
        and (
            "has been split into gbd_foodservice_insights_lab.extraction.tabular_io "
            "and gbd_foodservice_insights_lab.extraction.tabular_inspection"
        )
        in str(warning.message)
        for warning in caught
    )


def test_legacy_wrapper_warns_and_behaves_like_new_module(temp_test_dir):
    """Checks that old client notebooks still work, but get a loud warning the first
    time they call a legacy helper."""
    csv_data = pd.DataFrame({"A": [1, 2], "B": [3, 4]})
    csv_data.to_csv(temp_test_dir / "test.csv", index=False)

    legacy_module = importlib.import_module("gbd_foodservice_insights_lab.extraction.other")
    new_module = importlib.import_module("gbd_foodservice_insights_lab.extraction.tabular_io")
    legacy_module._WARNED_FUNCTIONS.clear()

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        legacy_dfs, legacy_paths = legacy_module.read_in_all_data_files(
            temp_test_dir,
            file_type="csv",
        )

    new_dfs, new_paths = new_module.read_in_all_data_files(temp_test_dir, file_type="csv")

    assert any(
        issubclass(warning.category, FutureWarning)
        and ("gbd_foodservice_insights_lab.extraction.other.read_in_all_data_files is deprecated")
        in str(warning.message)
        for warning in caught
    )
    assert len(legacy_dfs) == len(new_dfs) == 1
    assert legacy_paths == new_paths
    pd.testing.assert_frame_equal(legacy_dfs[0], new_dfs[0])


def test_old_gbd_import_path_is_not_supported():
    """Checks that the hard-cut rename really removed the old package import path."""
    sys.modules.pop("GBD", None)

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("GBD")
