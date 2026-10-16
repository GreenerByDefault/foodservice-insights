import pandas as pd
import pytest
from gbd_foodservice_insights.categorization.cache import (
    CACHE_COLUMNS,
    CachedCategorization,
    CategorizationCache,
    normalize_product_name,
)

POULTRY = "Poultry (Chicken & Turkey)"
BEEF = "Beef and Buffalo Meat"


def _frame(rows: list[tuple[str | None, str | None, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["product", "category", "cleaned_item_names"])


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


def test_constructor_rejects_a_category_outside_the_gbd_list():
    with pytest.raises(ValueError, match=r"categories outside the GBD list: \['Mlik'\]"):
        CategorizationCache(
            products=_frame([("Whole Milk", "Mlik", "milk"), ("Cheddar", "Cheese", "cheddar")]),
            cleaned_name_index={},
        )


def test_constructor_rejects_no_matches_found_in_the_cleaned_name_index():
    with pytest.raises(ValueError, match=r"only reuse GBD categories, not \['No Matches Found'\]"):
        CategorizationCache(
            products=_frame([("Plate", "No Matches Found", "plate")]),
            cleaned_name_index={"plate": "No Matches Found"},
        )


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
# CategorizationCache.from_rows
# ----------------------------------------------------------------------
def test_from_rows_drops_an_unknown_category_and_blanks_a_missing_cleaned_name(caplog):
    with caplog.at_level("WARNING"):
        result = CategorizationCache.from_rows(
            (
                CachedCategorization("Whole Milk", "Mlik", "milk"),
                CachedCategorization("Cheddar", "Cheese", "cheddar"),
                CachedCategorization("Napkins", "No Matches Found", None),
            )
        )

    pd.testing.assert_frame_equal(
        result.products,
        _frame([("Cheddar", "Cheese", "cheddar"), ("Napkins", "No Matches Found", "")]),
    )
    assert result.cleaned_name_index == {"cheddar": "Cheese"}
    assert "dropped 1 rows with a blank or unknown category ['Mlik']" in caplog.text


def test_from_rows_of_nothing_is_an_empty_cache():
    result = CategorizationCache.from_rows(())

    assert list(result.products.columns) == list(CACHE_COLUMNS)
    assert result.products.empty
    assert result.cleaned_name_index == {}


def test_normalize_product_name_keeps_digits():
    """Normalization lower-cases and collapses punctuation but preserves digits."""
    assert normalize_product_name("7 Up") == "7 up"
    assert normalize_product_name("100% Beef!!") == "100 beef"
    assert normalize_product_name("Chicken  Breast S/less") == "chicken breast s less"
    assert normalize_product_name(pd.NA) == ""
