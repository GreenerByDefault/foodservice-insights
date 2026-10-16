from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization.cache import CACHE_COLUMNS
from gbd_foodservice_insights_lab.categorization import product_cache
from gbd_foodservice_insights_lab.categorization.product_cache import (
    categorization_cache_path,
    load_categorization_cache,
    read_categorization_cache_csv,
)

POULTRY = "Poultry (Chicken & Turkey)"
BEEF = "Beef and Buffalo Meat"


@pytest.fixture
def cache_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "previously_categorized_items.csv"
    monkeypatch.setattr(product_cache, "categorization_cache_path", lambda: path)
    return path


def _frame(rows: list[tuple[str | None, str | None, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["product", "category", "cleaned_item_names"])


def test_categorization_cache_path():
    path = categorization_cache_path()
    assert isinstance(path, Path)
    assert str(path).endswith("data_files/previously_categorized_items.csv")


def test_load_categorization_cache_keeps_a_product_named_like_a_missing_value(cache_path):
    cache_path.write_text(
        "product,category,cleaned_item_names\nNA,Cheese,\nnull,Butter,null\n", encoding="utf-8"
    )

    result = load_categorization_cache()

    pd.testing.assert_frame_equal(
        result.products, _frame([("NA", "Cheese", ""), ("null", "Butter", "null")])
    )
    assert result.cleaned_name_index == {"null": "Butter"}


def test_read_categorization_cache_csv_keeps_rows_the_loader_drops(cache_path):
    cache_path.write_text("product,category,cleaned_item_names\n Mlk ,Mlik,\n", encoding="utf-8")

    pd.testing.assert_frame_equal(read_categorization_cache_csv(), _frame([(" Mlk ", "Mlik", "")]))


def test_load_categorization_cache_is_empty_when_the_file_is_missing(cache_path, caplog):
    with caplog.at_level("WARNING"):
        result = load_categorization_cache()

    pd.testing.assert_frame_equal(result.products, _frame([]).astype(str), check_index_type=False)
    assert result.cleaned_name_index == {}
    assert "not found" in caplog.text


def test_read_categorization_cache_csv_returns_the_file_undeduplicated(cache_path):
    expected = _frame([("a", BEEF, "a"), ("a", POULTRY, "a")])
    expected.to_csv(cache_path, index=False)

    # The lab appends to this frame, so it must not be the pipeline's one-row-per-product view.
    pd.testing.assert_frame_equal(read_categorization_cache_csv(), expected)


def test_read_categorization_cache_csv_has_the_cache_columns_when_the_file_is_missing(cache_path):
    result = read_categorization_cache_csv()

    assert result.empty
    assert list(result.columns) == list(CACHE_COLUMNS)
