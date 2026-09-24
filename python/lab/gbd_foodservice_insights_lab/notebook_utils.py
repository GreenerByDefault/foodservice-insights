from typing import Any

import pandas as pd


def get_head_and_tail(df: Any, n: int) -> Any:
    """
    Return a concatenation of the first *n* and last *n* rows of a DataFrame.

    Useful for identifying outliers (highest and lowest values) in sorted data.
    If the DataFrame has fewer than 2*n rows, returns all rows.

    Args:
        df: A pandas DataFrame.
        n: Number of rows to take from head and tail.

    Returns:
        A pandas DataFrame containing up to 2*n rows.
    """
    if len(df) > 2 * n:
        return pd.concat([df.head(n), df.tail(n)])
    return df.head(2 * n)
