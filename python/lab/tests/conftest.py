"""
Pytest configuration and shared fixtures.

This file contains fixtures that are available to all tests in the test suite.
"""

import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

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


@pytest.fixture
def temp_dir(tmp_path):
    """Temporary directory for file operations."""
    return tmp_path


# ----------------------------------------------------------------------
# Mock API Clients
# ----------------------------------------------------------------------


@pytest.fixture
def mock_openai_client():
    """Mock OpenAI client for testing without API calls."""
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "Test response"
    mock_client.chat.completions.create.return_value = mock_response
    return mock_client


@pytest.fixture
def mock_gemini_client():
    """Mock Gemini client for testing without API calls."""
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "Test response"
    mock_client.models.generate_content.return_value = mock_response
    return mock_client


@pytest.fixture
def mock_whisper_client():
    """Mock Whisper client for PDF extraction testing."""
    mock_client = MagicMock()
    return mock_client
