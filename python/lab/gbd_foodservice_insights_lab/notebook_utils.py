from typing import Any

import pandas as pd


def get_head_and_tail(df: Any, n: int) -> Any:
    """Return the first *n* and last *n* rows of a DataFrame, or all rows if there are ≤ 2*n.

    Useful for identifying outliers (highest and lowest values) in sorted data.
    """
    if len(df) > 2 * n:
        return pd.concat([df.head(n), df.tail(n)])
    return df.head(2 * n)
