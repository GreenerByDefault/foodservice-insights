import pandas as pd
import pytest
from gbd_foodservice_insights_lab.parsing import parse_and_validate_date_column


class TestParseAndValidateDateColumn:
    def test_parses_mixed_date_formats(self):
        df = pd.DataFrame(
            {
                "date": [
                    "2024-01-01",
                    "January 2, 2024",
                    "03 Jan 2024",
                    "20240104",
                    45296,
                    1704499200,
                    1704585600000,
                    pd.Timestamp("2024-01-08 12:30:00-0500"),
                ]
            }
        )

        parsed_df = parse_and_validate_date_column(df, date_col="date")

        expected = pd.to_datetime(
            [
                "2024-01-01",
                "2024-01-02",
                "2024-01-03",
                "2024-01-04",
                "2024-01-05",
                "2024-01-06",
                "2024-01-07",
                "2024-01-08",
            ]
        )

        pd.testing.assert_series_equal(
            parsed_df["date"].reset_index(drop=True),
            pd.Series(expected, name="date"),
        )

    @pytest.mark.parametrize(
        "value", ["03/04/2025", "01/03/2025 00:00", "3/4/25 10:30:15", "3/4/2025 12:00:00 AM"]
    )
    def test_raises_on_ambiguous_numeric_dates(self, value):
        df = pd.DataFrame({"date": [value]})

        with pytest.raises(ValueError, match="ambiguous"):
            parse_and_validate_date_column(df, date_col="date")

    def test_parses_an_unambiguous_date_with_a_time(self):
        df = pd.DataFrame({"date": ["13/04/2025 10:30"]})

        parsed = parse_and_validate_date_column(df, date_col="date")

        assert parsed["date"].iloc[0] == pd.Timestamp("2025-04-13")

    def test_resolves_ambiguous_dates_with_date_format(self):
        df = pd.DataFrame({"date": ["03/04/2025"]})

        parsed = parse_and_validate_date_column(df, date_col="date", date_format="%d/%m/%Y")

        assert parsed["date"].iloc[0] == pd.Timestamp("2025-04-03")

    def test_accepts_month_only_dates(self):
        """
        Month-only client dates should parse cleanly so monthly datasets do not fail ingestion.
        """
        df = pd.DataFrame({"date": ["04/2025", "2025-05", "Jun 2025"]})

        parsed_df = parse_and_validate_date_column(df, date_col="date")

        expected = pd.to_datetime(["2025-04-01", "2025-05-01", "2025-06-01"])
        pd.testing.assert_series_equal(
            parsed_df["date"].reset_index(drop=True),
            pd.Series(expected, name="date"),
        )

    @pytest.mark.parametrize("value", [None, "n/a"])
    def test_raises_on_missing_dates(self, value):
        df = pd.DataFrame({"date": ["2024-01-01", value]})

        with pytest.raises(ValueError, match="missing"):
            parse_and_validate_date_column(df, date_col="date")

    def test_out_of_range_dates_raise(self):
        df = pd.DataFrame({"date": ["2099-01-01"]})

        with pytest.raises(ValueError, match="out_of_range"):
            parse_and_validate_date_column(
                df,
                date_col="date",
                max_future_days=30,
            )

    def test_missing_configured_date_boundary_raises_clear_error(self):
        """
        A NaT-like configured boundary should fail as bad configuration, not with an AttributeError.
        """
        df = pd.DataFrame({"date": ["2024-01-01"]})

        with pytest.raises(ValueError, match="Date boundary cannot be missing"):
            parse_and_validate_date_column(df, min_date="NaT")
