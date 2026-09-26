import re
from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.errors import InvalidInputError
from gbd_foodservice_insights.input_csv import read_input_csv


def _read(tmp_path: Path, content: bytes) -> pd.DataFrame:
    path = tmp_path / "input.csv"
    path.write_bytes(content)
    return read_input_csv(path)


def test_parses_each_column_to_its_type(tmp_path: Path) -> None:
    df = _read(
        tmp_path, b"product,date,weight\nCheddar Cheese,2025-01-15,1.5\n  Oat Milk,2025-12-31,0\n"
    )

    pd.testing.assert_frame_equal(
        df,
        pd.DataFrame(
            {
                # Verbatim: `apps/web` trims, and the cache matches on the raw name.
                "product": ["Cheddar Cheese", "  Oat Milk"],
                "date": pd.to_datetime(["2025-01-15", "2025-12-31"]),
                "weight": [1.5, 0.0],
            }
        ),
    )


@pytest.mark.parametrize("product", ["NA", "null", "None", "nan"])
def test_a_product_named_like_a_missing_value_is_still_a_product(
    tmp_path: Path, product: str
) -> None:
    df = _read(tmp_path, f"product,date,weight\n{product},2025-01-15,1\n".encode())

    assert df["product"].tolist() == [product]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"", "input.csv is not a readable UTF-8 CSV"),
        (b"product,date,weight\n\xff\xfe,2025-01-15,1\n", "input.csv is not a readable UTF-8 CSV"),
        (
            b"product,weight,date\nCheese,1,2025-01-15\n",
            "input.csv has columns ['product', 'weight', 'date'], "
            "expected ['product', 'date', 'weight']",
        ),
        (
            b"product,date,weight,notes\nCheese,2025-01-15,1,x\n",
            "input.csv has columns ['product', 'date', 'weight', 'notes'], "
            "expected ['product', 'date', 'weight']",
        ),
        (b"product,date,weight\n", "input.csv has no rows"),
        (
            b"product,date,weight\nCheese,2025-01-15,1\n  ,2025-01-15,1\n",
            "input.csv line 3 has an empty product: '  ' (1 such rows)",
        ),
        (
            b"product,date,weight\nCheese,01/15/2025,1\nCheese,2025-01-15,1\nCheese,1/2/25,1\n",
            "input.csv line 2 has a date that is not YYYY-MM-DD: '01/15/2025' (2 such rows)",
        ),
        (b"product,date,weight\nCheese,2025-1-15,1\n", "line 2 has a date that is not YYYY-MM-DD"),
        (b"product,date,weight\nCheese,2025-02-30,1\n", "line 2 has a date that is not YYYY-MM-DD"),
        (
            b"product,date,weight\nCheese,2025-01-15T00:00,1\n",
            "line 2 has a date that is not YYYY-MM-DD",
        ),
        (
            b"product,date,weight\nCheese,2025-01-15,\n",
            "input.csv line 2 has a weight that is not a non-negative number: '' (1 such rows)",
        ),
        (b"product,date,weight\nCheese,2025-01-15,5 lb\n", "line 2 has a weight that is not"),
        (b"product,date,weight\nCheese,2025-01-15,-1\n", "line 2 has a weight that is not"),
        (b"product,date,weight\nCheese,2025-01-15,inf\n", "line 2 has a weight that is not"),
        (b"product,date,weight\nCheese,2025-01-15,nan\n", "line 2 has a weight that is not"),
    ],
)
def test_rejects_input_that_breaks_the_contract(
    tmp_path: Path, content: bytes, message: str
) -> None:
    with pytest.raises(InvalidInputError, match=re.escape(message)):
        _read(tmp_path, content)
