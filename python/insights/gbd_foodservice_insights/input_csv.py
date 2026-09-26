"""Checks every promise `input.csv` makes — `contract/contract.json` § inputCsv. A broken one is a
validation hole in `apps/web`, not bad customer data, so it is checked once, here, and nowhere
else: past `read_input_csv`, a `ValueError` from the library is our bug."""

import re
from pathlib import Path
from typing import Final

import numpy as np
import pandas as pd

from gbd_foodservice_insights.errors import InvalidInputError

INPUT_COLUMNS: Final = ("product", "date", "weight")
_ISO_DATE: Final = re.compile(r"\d{4}-\d{2}-\d{2}")


def read_input_csv(path: Path) -> pd.DataFrame:
    try:
        # Every cell as text, so a product named "NA" or "null" stays a product.
        raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8")
    except (UnicodeDecodeError, pd.errors.ParserError, pd.errors.EmptyDataError) as err:
        raise InvalidInputError(f"input.csv is not a readable UTF-8 CSV: {err}") from err

    if tuple(raw.columns) != INPUT_COLUMNS:
        raise InvalidInputError(
            f"input.csv has columns {list(raw.columns)}, expected {list(INPUT_COLUMNS)}"
        )
    if raw.empty:
        raise InvalidInputError("input.csv has no rows")

    _require(raw["product"].str.strip() != "", raw, "product", "an empty product")

    iso_shaped = raw["date"].str.fullmatch(_ISO_DATE)
    dates = pd.to_datetime(raw["date"].where(iso_shaped), format="%Y-%m-%d", errors="coerce")
    _require(dates.notna(), raw, "date", "a date that is not YYYY-MM-DD")

    weights = pd.to_numeric(raw["weight"], errors="coerce")
    _require(
        np.isfinite(weights) & (weights >= 0),
        raw,
        "weight",
        "a weight that is not a non-negative number",
    )

    return pd.DataFrame({"product": raw["product"], "date": dates, "weight": weights})


def _require(valid: pd.Series, raw: pd.DataFrame, column: str, problem: str) -> None:
    if valid.all():
        return
    first = int((~valid).to_numpy().argmax())
    # +2: one for the header line, one because file lines count from 1.
    raise InvalidInputError(
        f"input.csv line {first + 2} has {problem}: {raw[column].iloc[first]!r} "
        f"({int((~valid).sum())} such rows)"
    )
