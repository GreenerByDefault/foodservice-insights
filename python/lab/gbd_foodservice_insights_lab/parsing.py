"""Parsing messy date and weight columns into `datetime64` and float."""

import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

MISSING_TEXT_TOKENS = {"", "na", "n/a", "nan", "none", "null", "nat", "missing"}


def clean_weight_column(
    df: pd.DataFrame,
    weight_col: str,
    verbose: bool = True,
) -> pd.DataFrame:
    """Clean a weight column and coerce numeric values."""
    if weight_col not in df.columns:
        raise ValueError(f"Column '{weight_col}' not found. Available: {df.columns.tolist()}")

    out = df.copy()
    original_values = out[weight_col].copy()
    original_na_count = original_values.isna().sum()
    if pd.api.types.is_numeric_dtype(out[weight_col]):
        return out

    cleaned_values = out[weight_col].astype(str)
    symbol_pattern = r"[\$£€¥₹#%]|kg|lb|lbs|oz|g|grams|pounds|kilograms|ounces"
    cleaned_values = cleaned_values.str.replace(",", "", regex=False).str.strip()
    cleaned_values = cleaned_values.str.replace(
        symbol_pattern, "", case=False, regex=True
    ).str.strip()
    cleaned_values = cleaned_values.replace("", pd.NA).replace("nan", pd.NA)

    numeric_values = pd.to_numeric(cleaned_values, errors="coerce")

    if verbose:
        new_na_count = numeric_values.isna().sum()
        newly_created_nas = int(new_na_count - original_na_count)
        if newly_created_nas > 0:
            logger.warning(
                "Weight cleaning introduced %d new missing values in '%s'",
                newly_created_nas,
                weight_col,
            )

    out[weight_col] = numeric_values
    return out


# The optional time is so `01/03/2025 00:00`, a common spreadsheet export, cannot slip past to the
# dateutil fallback, which reads it month-first without complaint.
_AMBIGUOUS_NUMERIC_DATE_PATTERN = re.compile(
    r"^\s*(\d{1,2})\D+(\d{1,2})\D+(\d{2}|\d{4})"
    r"(?:[\sT]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AaPp]\.?[Mm]\.?)?)?\s*$"
)


def _is_missing_date_value(value: Any) -> bool:
    """Return True when a value should be treated as a missing date."""
    if pd.isna(value):
        return True

    if isinstance(value, str):
        return value.strip().lower() in MISSING_TEXT_TOKENS

    return False


def _is_numeric_like(value: Any) -> bool:
    """Return True for numeric scalar values excluding booleans."""
    return isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool)


def _is_ambiguous_numeric_date_string(value: str) -> bool:
    """
    Identify ambiguous day/month numeric date strings.

    Examples: 03/04/2025, 03-04-25, 03 04 2025.
    """
    match = _AMBIGUOUS_NUMERIC_DATE_PATTERN.match(value)
    if match is None:
        return False

    first = int(match.group(1))
    second = int(match.group(2))
    return 1 <= first <= 12 and 1 <= second <= 12


def _parse_numeric_date_value(value: float) -> tuple[pd.Timestamp | None, str | None]:
    """
    Parse numeric date encodings.

    Supports:
    - YYYYMMDD integers
    - Excel serial day numbers
    - Unix timestamps in seconds/ms/us/ns
    """
    if pd.isna(value):
        return None, None

    if float(value).is_integer():
        int_value = int(value)
        int_as_str = str(abs(int_value))
        if int_value > 0 and len(int_as_str) == 8:
            try:
                return pd.to_datetime(str(int_value), format="%Y%m%d"), "yyyymmdd_numeric"
            except ValueError, TypeError:
                pass

    abs_value = abs(float(value))

    try:
        if 20_000 <= abs_value <= 80_000:
            parsed = pd.Timestamp("1899-12-30") + pd.to_timedelta(float(value), unit="D")
            if not isinstance(parsed, pd.Timestamp):
                return None, None
            return parsed, "excel_serial"

        if 946_684_800 <= abs_value < 4_102_444_800:
            return pd.to_datetime(value, unit="s", origin="unix"), "unix_seconds"

        if 946_684_800_000 <= abs_value < 4_102_444_800_000:
            return pd.to_datetime(value, unit="ms", origin="unix"), "unix_milliseconds"

        if 946_684_800_000_000 <= abs_value < 4_102_444_800_000_000:
            return pd.to_datetime(value, unit="us", origin="unix"), "unix_microseconds"

        if 946_684_800_000_000_000 <= abs_value < 4_102_444_800_000_000_000:
            return pd.to_datetime(value, unit="ns", origin="unix"), "unix_nanoseconds"
    except OverflowError, ValueError:
        return None, None

    return None, None


def _normalize_date_boundary(
    value: str | date | datetime | pd.Timestamp,
) -> pd.Timestamp:
    """Normalize a configured date boundary and reject missing date values."""
    timestamp = pd.Timestamp(value)
    if not isinstance(timestamp, pd.Timestamp):
        raise ValueError(f"Date boundary cannot be missing: {value!r}")
    return timestamp.normalize()


_FAILING_STATUSES = ("ambiguous", "invalid", "missing", "out_of_range")


def _build_date_parse_error_message(date_col: str, diagnostics: pd.DataFrame) -> str:
    """Build a concise, actionable date parsing error message."""
    failing = diagnostics[diagnostics["parse_status"].isin(_FAILING_STATUSES)].copy()
    counts = failing["parse_status"].value_counts().to_dict()

    lines = [
        f"Date parsing failed for column '{date_col}'.",
        f"Issue counts: {counts}.",
    ]

    for status in _FAILING_STATUSES:
        status_rows = failing[failing["parse_status"] == status]
        if status_rows.empty:
            continue
        examples = status_rows["original_value"].astype(str).head(5).tolist()
        lines.append(f"- {status} examples: {examples}")

    lines.append("Pass `date_format` (for example '%d/%m/%Y') to read ambiguous day/month dates.")
    return "\n".join(lines)


def parse_and_validate_date_column(
    df: pd.DataFrame,
    date_col: str = "date",
    *,
    date_format: str | None = None,
    min_date: str | datetime | pd.Timestamp | None = None,
    max_date: str | datetime | pd.Timestamp | None = None,
    max_future_days: int = 30,
) -> pd.DataFrame:
    """
    Parse and validate a date column using a strict multi-pass strategy.

    The function intentionally fails on ambiguous numeric dates (for example,
    ``03/04/2025``) unless ``date_format`` is supplied.

    Parsing strategy:
    1. Exact custom format (if ``date_format`` is provided)
    2. Native datetime/date objects
    3. Numeric encodings (Excel serial, Unix timestamps, YYYYMMDD integers)
    4. Explicit common string formats
    5. dateutil fallback for remaining non-ambiguous strings
    6. Date range validation

    Raises ValueError if any date is missing, invalid, ambiguous, or out of range.
    """
    if date_col not in df.columns:
        raise ValueError(f"Column '{date_col}' not found in DataFrame.")

    df_copy = df.copy()
    original = df_copy[date_col]

    parsed_dates = pd.Series(pd.NaT, index=df_copy.index, dtype="object")
    parse_status = pd.Series(pd.NA, index=df_copy.index, dtype="object")
    parser_used = pd.Series(pd.NA, index=df_copy.index, dtype="object")

    missing_mask = original.map(_is_missing_date_value)
    parse_status.loc[missing_mask] = "missing"
    parser_used.loc[missing_mask] = "missing"

    non_missing_mask = ~missing_mask
    if date_format is not None and non_missing_mask.any():
        strict_parsed = pd.to_datetime(
            original.loc[non_missing_mask],
            format=date_format,
            errors="coerce",
        )
        parsed_dates.loc[non_missing_mask] = strict_parsed
        strict_success = strict_parsed.notna()
        parse_status.loc[strict_success.index[strict_success]] = "parsed"
        parser_used.loc[strict_success.index[strict_success]] = f"format:{date_format}"
    else:
        # Pass 1: values already datetime-like
        datetime_like_mask = (
            original.map(
                lambda value: isinstance(value, (pd.Timestamp, datetime, date, np.datetime64))
            )
            & non_missing_mask
        )

        if datetime_like_mask.any():
            native_parsed = pd.to_datetime(
                original.loc[datetime_like_mask],
                errors="coerce",
            )
            parsed_dates.loc[datetime_like_mask] = native_parsed
            native_success = native_parsed.notna()
            parse_status.loc[native_success.index[native_success]] = "parsed"
            parser_used.loc[native_success.index[native_success]] = "native_datetime"

        # Pass 2: numeric encodings (Excel serial, unix, YYYYMMDD integer)
        remaining_mask = non_missing_mask & parsed_dates.isna()
        numeric_mask = original.map(_is_numeric_like) & remaining_mask
        if numeric_mask.any():
            for idx, value in original.loc[numeric_mask].items():
                parsed_value, parser_name = _parse_numeric_date_value(float(value))
                if pd.notna(parsed_value):
                    parsed_dates.at[idx] = parsed_value
                    parse_status.at[idx] = "parsed"
                    parser_used.at[idx] = parser_name

        # Pass 3: explicit string formats
        remaining_mask = non_missing_mask & parsed_dates.isna()
        string_mask = original.map(lambda value: isinstance(value, str)) & remaining_mask

        if string_mask.any():
            cleaned_strings = (
                original.loc[string_mask]
                .astype(str)
                .str.strip()
                .str.replace(r"(\d{1,2})(st|nd|rd|th)\b", r"\1", regex=True)  # codespell:ignore nd
                .str.replace(",", "", regex=False)
                .str.replace(r"\s+", " ", regex=True)
            )

            ambiguous_mask = cleaned_strings.map(_is_ambiguous_numeric_date_string)

            if ambiguous_mask.any():
                ambiguous_indices = ambiguous_mask.index[ambiguous_mask]
                parse_status.loc[ambiguous_indices] = "ambiguous"
                parser_used.loc[ambiguous_indices] = "ambiguous_numeric_date"

            non_ambiguous_strings = cleaned_strings.loc[~ambiguous_mask]
            # Only unambiguous strings get here, so at most one order of each pair can match.
            slash_dash_dot_formats = [
                "%m/%d/%Y",
                "%d/%m/%Y",
                "%m-%d-%Y",
                "%d-%m-%Y",
                "%m.%d.%Y",
                "%d.%m.%Y",
                "%m/%d/%y",
                "%d/%m/%y",
                "%m-%d-%y",
                "%d-%m-%y",
            ]

            explicit_formats = [
                "%Y-%m-%d",
                "%Y/%m/%d",
                "%Y.%m.%d",
                "%Y %m %d",
                "%d %m %Y",
                "%Y%m%d",
                *slash_dash_dot_formats,
                "%d %b %Y",
                "%d %B %Y",
                "%b %d %Y",
                "%B %d %Y",
                "%d-%b-%Y",
                "%d-%B-%Y",
                "%b-%d-%Y",
                "%B-%d-%Y",
                "%d %b %y",
                "%d %B %y",
                "%b %d %y",
                "%B %d %y",
            ]

            for date_fmt in explicit_formats:
                still_unparsed = non_ambiguous_strings.index[
                    parsed_dates.loc[non_ambiguous_strings.index].isna()
                ]
                if len(still_unparsed) == 0:
                    break

                parsed = pd.to_datetime(
                    non_ambiguous_strings.loc[still_unparsed],
                    format=date_fmt,
                    errors="coerce",
                )
                parsed_success = parsed.notna()
                if not parsed_success.any():
                    continue

                success_idx = parsed_success.index[parsed_success]
                parsed_dates.loc[success_idx] = parsed.loc[success_idx]
                parse_status.loc[success_idx] = "parsed"
                parser_used.loc[success_idx] = f"format:{date_fmt}"

            # Pass 4: fallback parser (dateutil via pandas)
            fallback_mask = non_ambiguous_strings.index[
                parsed_dates.loc[non_ambiguous_strings.index].isna()
            ]
            if len(fallback_mask) > 0:
                fallback_parsed = pd.to_datetime(
                    non_ambiguous_strings.loc[fallback_mask],
                    errors="coerce",
                )
                fallback_success = fallback_parsed.notna()
                if fallback_success.any():
                    success_idx = fallback_success.index[fallback_success]
                    parsed_dates.loc[success_idx] = fallback_parsed.loc[success_idx]
                    parse_status.loc[success_idx] = "parsed"
                    parser_used.loc[success_idx] = "dateutil_fallback"

    # Mark any remaining non-missing/unparsed rows as invalid.
    invalid_mask = non_missing_mask & parse_status.isna()
    parse_status.loc[invalid_mask] = "invalid"
    parser_used.loc[invalid_mask] = "none"

    # Normalize to date-only (midnight), dropping timezone info consistently.
    parsed_dates = (
        pd.to_datetime(parsed_dates, errors="coerce", utc=True).dt.tz_localize(None).dt.normalize()
    )

    min_date_ts = _normalize_date_boundary(min_date) if min_date is not None else None
    if max_date is not None:
        max_date_ts = _normalize_date_boundary(max_date)
    else:
        max_date_ts = _normalize_date_boundary(date.today() + timedelta(days=max_future_days))

    parsed_mask = parse_status == "parsed"
    if min_date_ts is not None:
        below_min = parsed_mask & (parsed_dates < min_date_ts)
        parse_status.loc[below_min] = "out_of_range"

    above_max = parsed_mask & (parsed_dates > max_date_ts)
    parse_status.loc[above_max] = "out_of_range"

    diagnostics_df = pd.DataFrame(
        {
            "original_value": original,
            "parsed_date": parsed_dates,
            "parse_status": parse_status,
            "parser_used": parser_used,
        },
        index=df_copy.index,
    )

    if diagnostics_df["parse_status"].isin(_FAILING_STATUSES).any():
        raise ValueError(_build_date_parse_error_message(date_col, diagnostics_df))

    df_copy[date_col] = parsed_dates
    return df_copy
