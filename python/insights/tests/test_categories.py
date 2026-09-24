"""
Tests for gbd_foodservice_insights/categories.py

This module tests all functions for working with GBD food categories,
including category retrieval, validation, and data cleaning.
"""

import logging

import pandas as pd
import pytest
from gbd_foodservice_insights.categories import (
    GBD_categories_check,
    check_GBD_categories,
    clean_GBD_category_name,
    clean_GBD_category_names,
    get_animal_product_categories,
    get_categories_by_product_category,
    get_dairy_categories,
    get_drink_categories,
    get_egg_categories,
    get_food_categories,
    get_GBD_categories,
    get_meat_categories,
    get_plant_based_categories,
    get_plant_based_dairy_categories,
    get_plant_protein_categories,
    get_protein_categories,
    order_GBD_categories,
)

# ----------------------------------------------------------------------
# Tests for category getter functions
# ----------------------------------------------------------------------


class TestGetGBDCategories:
    """Tests for get_GBD_categories function."""

    def test_returns_list(self):
        result = get_GBD_categories()
        assert isinstance(result, list)

    def test_returns_non_empty_list(self):
        result = get_GBD_categories()
        assert len(result) > 0

    def test_returns_strings(self):
        result = get_GBD_categories()
        assert all(isinstance(item, str) for item in result)

    def test_lowercase_option(self):
        normal = get_GBD_categories(lowercase=False)
        lower = get_GBD_categories(lowercase=True)

        assert len(normal) == len(lower)
        assert all(item.lower() == item for item in lower)

    def test_contains_expected_categories(self):
        result = get_GBD_categories(lowercase=True)
        # These should be present in any GBD category system
        # Note: Actual category names are like 'beef and buffalo meat', not just 'beef'
        expected_substrings = ["beef", "chicken", "milk"]
        for substring in expected_substrings:
            assert any(substring in cat for cat in result), (
                f"Expected category containing '{substring}' not found"
            )


class TestGetCategoriesByProductCategory:
    """Tests for get_categories_by_product_category function."""

    def test_animal_based_proteins(self):
        result = get_categories_by_product_category("Animal Based Proteins")
        assert isinstance(result, list)
        # Should include meat categories
        result_lower = [r.lower() for r in result]
        assert any("beef" in r or "chicken" in r or "pork" in r for r in result_lower)

    def test_plant_based_proteins(self):
        result = get_categories_by_product_category("Plant-Based Proteins")
        assert isinstance(result, list)

    def test_lowercase_option(self):
        normal = get_categories_by_product_category("Dairy", lowercase=False)
        lower = get_categories_by_product_category("Dairy", lowercase=True)

        if len(normal) > 0:
            assert len(normal) == len(lower)
            assert all(item.lower() == item for item in lower)

    def test_nonexistent_category_returns_empty(self):
        result = get_categories_by_product_category("NonExistent Category")
        assert result == []


class TestGetMeatCategories:
    """Tests for get_meat_categories function."""

    def test_returns_list(self):
        result = get_meat_categories()
        assert isinstance(result, list)

    def test_contains_meat_items(self):
        result = get_meat_categories(lowercase=True)
        # These substrings should be in meat category names
        expected_substrings = ["beef", "pork", "chicken"]
        for item in expected_substrings:
            assert any(item in cat for cat in result), f"Expected '{item}' in meat categories"

    def test_excludes_non_meat(self):
        result = get_meat_categories(lowercase=True)
        # Dairy and plant items should not be in meat categories
        assert "dairy milk" not in result
        assert "tofu" not in result

    def test_lowercase_option(self):
        lower = get_meat_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetPlantProteinCategories:
    """Tests for get_plant_protein_categories function."""

    def test_returns_list(self):
        result = get_plant_protein_categories()
        assert isinstance(result, list)

    def test_lowercase_option(self):
        lower = get_plant_protein_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetDairyCategories:
    """Tests for get_dairy_categories function."""

    def test_returns_list(self):
        result = get_dairy_categories()
        assert isinstance(result, list)

    def test_lowercase_option(self):
        lower = get_dairy_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetPlantBasedDairyCategories:
    """Tests for get_plant_based_dairy_categories function."""

    def test_returns_list(self):
        result = get_plant_based_dairy_categories()
        assert isinstance(result, list)

    def test_lowercase_option(self):
        lower = get_plant_based_dairy_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetEggCategories:
    """Tests for get_egg_categories function."""

    def test_returns_list(self):
        result = get_egg_categories()
        assert isinstance(result, list)

    def test_contains_egg_related_items(self):
        result = get_egg_categories(lowercase=True)
        # All items should contain 'egg'
        assert all("egg" in item for item in result)

    def test_lowercase_option(self):
        lower = get_egg_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetProteinCategories:
    """Tests for get_protein_categories function."""

    def test_returns_list(self):
        result = get_protein_categories()
        assert isinstance(result, list)

    def test_includes_meat(self):
        proteins = set(get_protein_categories(lowercase=True))
        meats = set(get_meat_categories(lowercase=True))
        # All meat should be in protein
        assert meats.issubset(proteins)

    def test_includes_plant_proteins(self):
        proteins = set(get_protein_categories(lowercase=True))
        plant_proteins = set(get_plant_protein_categories(lowercase=True))
        # All plant protein should be in protein
        assert plant_proteins.issubset(proteins)

    def test_lowercase_option(self):
        lower = get_protein_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetAnimalProductCategories:
    """Tests for get_animal_product_categories function."""

    def test_returns_list(self):
        result = get_animal_product_categories()
        assert isinstance(result, list)

    def test_includes_meat(self):
        animal = set(get_animal_product_categories(lowercase=True))
        meats = set(get_meat_categories(lowercase=True))
        assert meats.issubset(animal)

    def test_excludes_plant_based(self):
        animal = set(get_animal_product_categories(lowercase=True))
        plant = set(get_plant_based_categories(lowercase=True))
        # No overlap between animal and plant
        assert animal.isdisjoint(plant)

    def test_lowercase_option(self):
        lower = get_animal_product_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetPlantBasedCategories:
    """Tests for get_plant_based_categories function."""

    def test_returns_list(self):
        result = get_plant_based_categories()
        assert isinstance(result, list)

    def test_excludes_animal_products(self):
        plant = set(get_plant_based_categories(lowercase=True))
        animal = set(get_animal_product_categories(lowercase=True))
        # No overlap
        assert plant.isdisjoint(animal)

    def test_lowercase_option(self):
        lower = get_plant_based_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetFoodCategories:
    """Tests for get_food_categories function."""

    def test_returns_list(self):
        result = get_food_categories()
        assert isinstance(result, list)

    def test_lowercase_option(self):
        lower = get_food_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


class TestGetDrinkCategories:
    """Tests for get_drink_categories function."""

    def test_returns_list(self):
        result = get_drink_categories()
        assert isinstance(result, list)

    def test_lowercase_option(self):
        lower = get_drink_categories(lowercase=True)
        assert all(item.lower() == item for item in lower)


# ----------------------------------------------------------------------
# Tests for category validation functions
# ----------------------------------------------------------------------


class TestCheckGBDCategories:
    """Tests for check_GBD_categories function."""

    def test_warns_on_missing_categories(self, caplog):
        df = pd.DataFrame({"category": ["Beef"]})  # Only one category
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.categories"):
            check_GBD_categories(df)
        assert "missing" in caplog.text.lower()

    def test_warns_on_non_gbd_categories(self, caplog):
        df = pd.DataFrame({"category": ["Not A Real Category"]})
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.categories"):
            check_GBD_categories(df)
        assert "not" in caplog.text.lower() and "gbd" in caplog.text.lower()

    def test_warns_on_missing_column(self, caplog):
        df = pd.DataFrame({"other_col": [1, 2, 3]})
        with caplog.at_level(logging.DEBUG, logger="gbd_foodservice_insights.categories"):
            check_GBD_categories(df)
        assert "category" in caplog.text.lower() and "not found" in caplog.text.lower()


class TestGBDCategoriesCheckDeprecated:
    """Tests for deprecated GBD_categories_check function."""

    def test_prints_deprecation_warning(self, capsys):
        df = pd.DataFrame({"category": ["Beef"]})
        GBD_categories_check(df)
        captured = capsys.readouterr()
        assert "DEPRECATED" in captured.out


# ----------------------------------------------------------------------
# Tests for category cleaning functions
# ----------------------------------------------------------------------


class TestCleanGBDCategoryName:
    """Tests for clean_GBD_category_name function."""

    def test_cleans_valid_category(self):
        # Get a known category
        gbd_cats = get_GBD_categories()
        if gbd_cats:
            test_cat = gbd_cats[0]
            result = clean_GBD_category_name(test_cat)
            assert isinstance(result, str)
            assert len(result) > 0

    def test_raises_on_invalid_category(self):
        with pytest.raises(KeyError):
            clean_GBD_category_name("This Is Not A Real Category")

    def test_case_insensitive(self):
        gbd_cats = get_GBD_categories()
        if gbd_cats:
            test_cat = gbd_cats[0]
            result_normal = clean_GBD_category_name(test_cat)
            result_lower = clean_GBD_category_name(test_cat.lower())
            result_upper = clean_GBD_category_name(test_cat.upper())
            assert result_normal == result_lower == result_upper


class TestCleanGBDCategoryNames:
    """Tests for clean_GBD_category_names function."""

    def test_cleans_category_column(self):
        gbd_cats = get_GBD_categories()
        if len(gbd_cats) >= 2:
            df = pd.DataFrame({"category": [gbd_cats[0], gbd_cats[1]]})
            result = clean_GBD_category_names(df)
            assert "category" in result.columns
            # Values should be cleaned
            assert all(isinstance(val, str) for val in result["category"])

    def test_raises_on_missing_column(self):
        df = pd.DataFrame({"other_col": [1, 2, 3]})
        with pytest.raises(ValueError, match="category"):
            clean_GBD_category_names(df)


# ----------------------------------------------------------------------
# Tests for category ordering functions
# ----------------------------------------------------------------------


class TestOrderGBDCategories:
    """Tests for order_GBD_categories function."""

    def test_converts_to_categorical(self):
        gbd_cats = get_GBD_categories(lowercase=True)
        if len(gbd_cats) >= 3:
            df = pd.DataFrame(
                {"category": [gbd_cats[2], gbd_cats[0], gbd_cats[1]], "value": [1, 2, 3]}
            )
            result = order_GBD_categories(df)
            assert isinstance(result["category"].dtype, pd.CategoricalDtype)

    def test_sorts_df_when_sort_df_true(self):
        gbd_cats = get_GBD_categories(lowercase=True)
        if len(gbd_cats) >= 3:
            df = pd.DataFrame(
                {"category": [gbd_cats[2], gbd_cats[0], gbd_cats[1]], "value": [1, 2, 3]}
            )
            result = order_GBD_categories(df, sort_df=True)
            assert result["category"].astype(str).tolist() == [
                gbd_cats[0],
                gbd_cats[1],
                gbd_cats[2],
            ]
            assert result["value"].tolist() == [2, 3, 1]

    def test_does_not_sort_when_sort_df_false(self):
        gbd_cats = get_GBD_categories(lowercase=True)
        if len(gbd_cats) >= 3:
            df = pd.DataFrame(
                {"category": [gbd_cats[2], gbd_cats[0], gbd_cats[1]], "value": [1, 2, 3]}
            )
            result = order_GBD_categories(df.copy(), sort_df=False)
            assert result["category"].astype(str).tolist() == [
                gbd_cats[2],
                gbd_cats[0],
                gbd_cats[1],
            ]
            assert result["value"].tolist() == [1, 2, 3]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
