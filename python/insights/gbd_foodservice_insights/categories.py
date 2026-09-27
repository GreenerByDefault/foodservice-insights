"""Functions for working with GBD food categories.

`data_files/GBD_categories.yaml`, loaded here, is the single source of truth for the categories,
their emissions factors, and which are animal- or plant-based.
"""

from functools import cache
from typing import Any

import yaml

from gbd_foodservice_insights import PACKAGE_DIR


@cache
def _load_gbd_categories_data() -> dict[str, Any]:
    """Private helper to load GBD categories YAML data."""
    yaml_path = PACKAGE_DIR / "data_files" / "GBD_categories.yaml"
    with open(yaml_path) as f:
        loaded_data = yaml.safe_load(f)

    if not isinstance(loaded_data, dict):
        raise ValueError(f"{yaml_path.name} must contain a top-level mapping of category data.")

    return loaded_data


def get_gbd_categories_metadata() -> dict[str, Any]:
    """Return cached category metadata loaded from GBD_categories.yaml."""
    return _load_gbd_categories_data()


def get_GBD_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of GBD categories by reading from the GBD_categories.yaml file."""
    data = _load_gbd_categories_data()
    categories = [item["cool_food_pledge_name"] for item in data["categories"]]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_categories_by_product_category(product_category: str, lowercase: bool = False) -> list[str]:
    """Returns a list of GBD categories filtered by template_product_category field.

    `product_category` is e.g. "Animal Based Proteins", "Plant-Based Proteins", "Dairy", or
    "Plant-Based Dairy & Egg".
    """
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"]
        for item in data["categories"]
        if item.get("template_product_category") == product_category
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_meat_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of meat categories (beef, pork, poultry, lamb, fish, shellfish).

    Excludes eggs and other animal proteins.
    """
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"] for item in data["categories"] if item.get("meat", False)
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_plant_protein_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of plant-based protein categories (whole grains, legumes, nuts & seeds,
    plant-based meats)."""
    return get_categories_by_product_category("Plant-Based Proteins", lowercase=lowercase)


def get_dairy_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of dairy categories (milk, cheese, yogurt, butter, cream, ice cream, mayo)."""
    return get_categories_by_product_category("Dairy", lowercase=lowercase)


def get_plant_based_dairy_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of plant-based dairy alternative categories (plant milks, plant cheese,
    plant yogurt, plant egg)."""
    return get_categories_by_product_category("Plant-Based Dairy & Egg", lowercase=lowercase)


def get_egg_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of egg categories (liquid eggs, shelled eggs)."""
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"]
        for item in data["categories"]
        if "egg" in item["cool_food_pledge_name"].lower() and item.get("is_animal_product", False)
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_protein_categories(lowercase: bool = False) -> list[str]:
    """Returns a sorted list of all protein categories (meat, eggs, plant-based proteins).

    This includes:
    - All meat categories (beef, pork, poultry, lamb, fish, shellfish)
    - Egg categories (liquid eggs, shelled eggs)
    - Plant-based protein categories (legumes, whole grains, nuts & seeds, plant-based meats)
    - Plant-based egg alternatives
    """
    # Filter to only include plant-based egg from plant-based dairy categories
    data = _load_gbd_categories_data()
    plant_egg = [
        item["cool_food_pledge_name"] if not lowercase else item["cool_food_pledge_name"].lower()
        for item in data["categories"]
        if "egg" in item["cool_food_pledge_name"].lower()
        and not item.get("is_animal_product", True)
    ]

    # Remove duplicate plant-based egg entries and non-protein dairy alternatives
    protein_only = set(
        get_meat_categories(lowercase=lowercase)
        + get_egg_categories(lowercase=lowercase)
        + get_plant_protein_categories(lowercase=lowercase)
        + plant_egg
    )

    return sorted(list(protein_only))


def get_animal_product_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of all animal product categories (meat, dairy, eggs)."""
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"]
        for item in data["categories"]
        if item.get("is_animal_product", False)
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_plant_based_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of all plant-based categories."""
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"]
        for item in data["categories"]
        if not item.get("is_animal_product", True)
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_food_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of all food categories (excludes drinks)."""
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"] for item in data["categories"] if item.get("type") == "food"
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def get_drink_categories(lowercase: bool = False) -> list[str]:
    """Returns a list of all drink categories."""
    data = _load_gbd_categories_data()
    categories = [
        item["cool_food_pledge_name"] for item in data["categories"] if item.get("type") == "drink"
    ]

    if lowercase:
        return [category.lower() for category in categories]

    return categories


def clean_GBD_category_name(category: str) -> str:
    """Maps a GBD category string (case-insensitive) to a cleaner, standardized version.

    Raises KeyError if the category is not in GBD_categories.yaml.
    """
    data = _load_gbd_categories_data()

    # Build the mapping from cool_food_pledge_name (lowercase) to name
    category_name_map = {
        item["cool_food_pledge_name"].lower(): item["name"] for item in data["categories"]
    }

    category_lower = category.lower()
    if category_lower not in category_name_map:
        raise KeyError(f"Category '{category}' not found in food dictionary")

    return category_name_map[category_lower]
