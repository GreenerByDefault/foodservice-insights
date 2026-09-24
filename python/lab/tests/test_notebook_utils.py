"""
Tests for gbd_foodservice_insights_lab/notebook_utils.py
"""

import pandas as pd
import pytest
from gbd_foodservice_insights_lab.notebook_utils import get_head_and_tail

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
