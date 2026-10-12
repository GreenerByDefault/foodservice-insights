from pathlib import Path
from typing import Any

import pandas as pd


def get_head_and_tail(df: Any, n: int) -> Any:
    """Return the first *n* and last *n* rows of a DataFrame, or all rows if there are ≤ 2*n.

    Useful for identifying outliers (highest and lowest values) in sorted data.
    """
    if len(df) > 2 * n:
        return pd.concat([df.head(n), df.tail(n)])
    return df.head(2 * n)


def rel_path(p: str | Path | None) -> str | Path | None:
    """Return *p* relative to the current working directory if possible.

    Falls back to the original value if *p* is outside cwd or is ``None``.
    Useful for keeping printed file paths short.
    """
    if p is None:
        return None
    try:
        return Path(p).resolve().relative_to(Path.cwd())
    except ValueError:
        return p
