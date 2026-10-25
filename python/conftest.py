"""Pytest configuration for every package's tests."""

import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

# Keep matplotlib out of the user home directory during tests so imports do not
# spend time trying to build caches in an unwritable location. This must run before
# anything imports matplotlib, hence before the `pyplot` import below.
_TEST_TMP_ROOT = Path(tempfile.gettempdir()) / "gbd_pytest"
_MPL_CONFIG_DIR = _TEST_TMP_ROOT / "mplconfig"
_XDG_CACHE_DIR = _TEST_TMP_ROOT / "cache"
_MPL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
_XDG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(_MPL_CONFIG_DIR))
os.environ.setdefault("XDG_CACHE_HOME", str(_XDG_CACHE_DIR))

import matplotlib.pyplot as plt  # noqa: E402


@pytest.fixture(autouse=True)
def cleanup_plt() -> Iterator[None]:
    yield
    plt.close("all")
