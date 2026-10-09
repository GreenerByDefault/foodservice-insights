from pathlib import Path

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache
from gbd_foodservice_insights.categorization.cache import (
    CACHE_COLUMNS,
    CategorizationCache,
    categorization_cache_path,
    load_categorization_cache,
    normalize_product_name,
    read_categorization_cache_csv,
)

POULTRY = "Poultry (Chicken & Turkey)"
BEEF = "Beef and Buffalo Meat"


@pytest.fixture
def cache_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "previously_categorized_items.csv"
    monkeypatch.setattr(cache, "categorization_cache_path", lambda: path)
    return path


def _frame(rows: list[tuple[str | None, str | None, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["product", "category", "cleaned_item_names"])


def test_categorization_cache_path():
    path = categorization_cache_path()
    assert isinstance(path, Path)
    assert str(path).endswith("data_files/previously_categorized_items.csv")


# ----------------------------------------------------------------------
# CategorizationCache.from_frame
# ----------------------------------------------------------------------
def test_from_frame_strips_products_and_keeps_the_last_duplicate(caplog):
    with caplog.at_level("WARNING"):
        result = CategorizationCache.from_frame(
            _frame(
                [
                    (" Chicken Breast ", "Cheese", "chicken breast"),
                    ("Chicken Breast", POULTRY, "chicken breast"),
                    ("Paper Towels", "No Matches Found", None),
                ]
            )
        )

    pd.testing.assert_frame_equal(
        result.products,
        _frame(
            [
                ("Chicken Breast", POULTRY, "chicken breast"),
                ("Paper Towels", "No Matches Found", ""),
            ]
        ),
    )
    assert result.cleaned_name_index == {"chicken breast": POULTRY}
    assert "dropped 1 rows with a product repeated by a later row" in caplog.text


def test_from_frame_drops_blank_and_unknown_categories_and_blank_products(caplog):
    with caplog.at_level("WARNING"):
        result = CategorizationCache.from_frame(
            _frame(
                [
                    ("Mozzarella Block", "cheese", "mozzarella"),
                    ("Salted Butter", None, None),
                    ("  ", "Butter", "butter"),
                    ("Cheddar", "Cheese", "cheddar"),
                ]
            )
        )

    pd.testing.assert_frame_equal(result.products, _frame([("Cheddar", "Cheese", "cheddar")]))
    assert result.cleaned_name_index == {"cheddar": "Cheese"}
    assert "dropped 1 rows with a blank product" in caplog.text
    assert "dropped 2 rows with a blank or unknown category ['', 'cheese']" in caplog.text


def test_from_frame_rejects_a_missing_column():
    with pytest.raises(ValueError, match=r"missing columns: \['cleaned_item_names'\]"):
        CategorizationCache.from_frame(pd.DataFrame({"product": ["a"], "category": ["Cheese"]}))


def test_from_frame_indexes_only_unanimous_real_categories():
    result = CategorizationCache.from_frame(
        _frame(
            [
                ("a", POULTRY, "chicken breast"),
                ("b", POULTRY, "Chicken  Breast"),
                ("c", POULTRY, "mystery"),
                ("d", BEEF, "mystery"),
                ("e", "No Matches Found", "plate"),
                ("f", "No Matches Found", "chicken breast"),
                ("g", BEEF, ""),
            ]
        )
    )

    # "No Matches Found" is neither reused nor a vote against a real category.
    assert result.cleaned_name_index == {"chicken breast": POULTRY}


# ----------------------------------------------------------------------
# Reading the file
# ----------------------------------------------------------------------
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


def test_normalize_product_name_keeps_digits():
    """Normalization lower-cases and collapses punctuation but preserves digits."""
    assert normalize_product_name("7 Up") == "7 up"
    assert normalize_product_name("100% Beef!!") == "100 beef"
    assert normalize_product_name("Chicken  Breast S/less") == "chicken breast s less"
    assert normalize_product_name(pd.NA) == ""
