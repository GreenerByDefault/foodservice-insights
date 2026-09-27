"""
Pytest configuration and shared fixtures.

This file contains fixtures that are available to all tests in the test suite.
"""

import os
import tempfile
from pathlib import Path

# Keep matplotlib out of the user home directory during tests so imports do not
# spend time trying to build caches in an unwritable location.
_TEST_TMP_ROOT = Path(tempfile.gettempdir()) / "gbd_pytest"
_MPL_CONFIG_DIR = _TEST_TMP_ROOT / "mplconfig"
_XDG_CACHE_DIR = _TEST_TMP_ROOT / "cache"
_MPL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
_XDG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(_MPL_CONFIG_DIR))
os.environ.setdefault("XDG_CACHE_HOME", str(_XDG_CACHE_DIR))


# ----------------------------------------------------------------------
# Sample Data Fixtures
# ----------------------------------------------------------------------
