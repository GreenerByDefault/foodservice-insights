"""The GBD food categories.

`data_files/GBD_categories.yaml`, loaded here, is the single source of truth for the categories,
their emissions factors, and which are animal- or plant-based.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from typing import Literal, get_args

import yaml

from gbd_foodservice_insights import PACKAGE_DIR

Kind = Literal["food", "drink"]
ProductCategory = Literal[
    "Animal Based Proteins", "Dairy", "Plant-Based Proteins", "Plant-Based Dairy & Egg"
]


@dataclass(frozen=True)
class Category:
    name: str
    """The `cool_food_pledge_name`, which is what rows carry and the report shows."""
    short_name: str
    emission_factor_us: float
    emission_factor_europe: float
    is_animal_product: bool
    product_category: ProductCategory
    kind: Kind
    meat: bool
    protein: bool


@cache
def categories() -> tuple[Category, ...]:
    with open(PACKAGE_DIR / "data_files" / "GBD_categories.yaml") as f:
        return _parse_categories(yaml.safe_load(f))


def _parse_categories(data: object) -> tuple[Category, ...]:
    if not isinstance(data, Mapping) or not isinstance(data.get("categories"), list):
        raise ValueError("GBD categories must be a mapping with a `categories` list.")

    result = tuple(_parse_category(entry) for entry in data["categories"])
    # Case-insensitively, because emissions, aggregation and the lab look categories up by
    # lowercased name, where two spellings of one name would silently collapse into one.
    names = [category.name.lower() for category in result]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ValueError(f"GBD categories repeat: {duplicates}")
    return result


def _parse_category(entry: object) -> Category:
    if not isinstance(entry, Mapping):
        raise ValueError(f"Each category must be a mapping, got {entry!r}")

    def field[T](key: str, expected: type[T]) -> T:
        value = entry.get(key)
        if expected is float and type(value) is int:
            value = float(value)
        # `bool` subclasses `int`, so check it both ways: `true` is not a number.
        if not isinstance(value, expected) or isinstance(value, bool) != (expected is bool):
            raise ValueError(f"{entry!r}: `{key}` must be a {expected.__name__}, got {value!r}")
        return value

    def choice[T: str](key: str, options: tuple[T, ...]) -> T:
        value = field(key, str)
        for option in options:
            if value == option:
                return option
        raise ValueError(f"{entry!r}: `{key}` must be one of {options}, got {value!r}")

    def emission_factor(key: str) -> float:
        value = field(key, float)
        # YAML reads `.nan` and `.inf` as floats.
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{entry!r}: `{key}` must be finite and non-negative, got {value!r}")
        return value

    return Category(
        name=field("cool_food_pledge_name", str),
        short_name=field("name", str),
        emission_factor_us=emission_factor("emission_factor_us"),
        emission_factor_europe=emission_factor("emission_factor_europe"),
        is_animal_product=field("is_animal_product", bool),
        product_category=choice("template_product_category", get_args(ProductCategory)),
        kind=choice("type", get_args(Kind)),
        meat=field("meat", bool),
        protein=field("protein", bool),
    )


def category_names() -> list[str]:
    return [c.name for c in categories()]


def animal_product_categories() -> list[str]:
    return [c.name for c in categories() if c.is_animal_product]


def plant_based_categories() -> list[str]:
    return [c.name for c in categories() if not c.is_animal_product]


def plant_protein_categories() -> list[str]:
    return [c.name for c in categories() if c.product_category == "Plant-Based Proteins"]


def protein_categories() -> list[str]:
    """Meat, eggs, plant proteins and plant-based egg."""
    return [c.name for c in categories() if c.protein]


def food_categories() -> list[str]:
    return [c.name for c in categories() if c.kind == "food"]


def drink_categories() -> list[str]:
    return [c.name for c in categories() if c.kind == "drink"]
