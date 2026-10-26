"""
Pytest configuration and shared fixtures.

This file contains fixtures that are available to all tests in the test suite.
"""

import os
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock

import psycopg
import pytest
from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parents[3]


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


# ----------------------------------------------------------------------
# The test database
# ----------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_cache_database(monkeypatch: pytest.MonkeyPatch) -> None:
    """On a developer's laptop `CACHE_DB_CONNECTION_STRING` may point at production, where step 1
    would push whatever a test categorized. A test that wants it set sets it."""
    monkeypatch.delenv("CACHE_DB_CONNECTION_STRING", raising=False)


@pytest.fixture
def test_database() -> Iterator[psycopg.Connection]:
    """`postgres` on the migrated test stack, inside a transaction that always rolls back: the
    counterpart of `withRollback` (docs/typescript.md § Tests and the database)."""
    if not os.environ.get("TEST_DB"):
        pytest.skip("Needs the running, migrated test stack and TEST_DB=1; see python/README.md.")
    # From `.env.test` alone, never the environment: there, `CACHE_DB_CONNECTION_STRING` may point
    # at production, where nothing a test inserted could be deleted.
    conninfo = dotenv_values(REPO_ROOT / ".env.test")["DB_CONNECTION_STRING"]
    assert conninfo, ".env.test has no DB_CONNECTION_STRING"
    with (
        psycopg.connect(conninfo, autocommit=True) as connection,
        connection.transaction(force_rollback=True),
    ):
        yield connection
