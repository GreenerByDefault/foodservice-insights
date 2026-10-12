"""
Tests for gbd_foodservice_insights_lab/notebook_utils.py
"""

from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights_lab.notebook_utils import get_head_and_tail, rel_path

# ----------------------------------------------------------------------
# Tests for DataFrame helpers
# ----------------------------------------------------------------------


class TestGetHeadAndTail:
    """Tests for head-and-tail preview helper."""

    def test_returns_head_and_tail_when_dataframe_is_long(self):
        """Long tables should return the top and bottom rows only."""
        df = pd.DataFrame({"value": [1, 2, 3, 4, 5, 6]})

        result = get_head_and_tail(df, 2)

        assert result["value"].tolist() == [1, 2, 5, 6]

    def test_returns_all_rows_when_dataframe_is_short(self):
        """Short tables should stay intact."""
        df = pd.DataFrame({"value": [1, 2, 3]})

        result = get_head_and_tail(df, 2)

        assert result["value"].tolist() == [1, 2, 3]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


class TestRelPath:
    """Tests for rel_path helper."""

    def test_returns_none_for_none(self):
        """None input should stay as None."""
        assert rel_path(None) is None

    def test_returns_relative_path_inside_cwd(self, tmp_path, monkeypatch):
        """Paths under the working directory should be shortened."""
        nested_file = tmp_path / "nested" / "file.csv"
        nested_file.parent.mkdir()
        nested_file.write_text("x", encoding="utf-8")
        monkeypatch.chdir(tmp_path)

        assert rel_path(nested_file) == Path("nested/file.csv")
