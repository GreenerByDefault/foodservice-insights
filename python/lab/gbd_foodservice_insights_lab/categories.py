"""Category groupings only the lab's analyses use, over the product's `categories()`."""

from gbd_foodservice_insights.categories import categories


def meat_categories() -> list[str]:
    """Beef, lamb, pork, poultry, fish and shellfish; not eggs."""
    return [c.name for c in categories() if c.meat]


def dairy_categories() -> list[str]:
    return [c.name for c in categories() if c.product_category == "Dairy"]


def egg_categories() -> list[str]:
    return [c.name for c in categories() if c.is_animal_product and c.protein and not c.meat]


def plant_based_dairy_categories() -> list[str]:
    """Plant milks, cheese and yogurt, and plant-based egg."""
    return [c.name for c in categories() if c.product_category == "Plant-Based Dairy & Egg"]


def short_name(category: str) -> str:
    """The display name for a category, matched case-insensitively.

    Raises KeyError if `category` is not a GBD category.
    """
    by_name = {c.name.lower(): c.short_name for c in categories()}
    try:
        return by_name[category.lower()]
    except KeyError:
        raise KeyError(f"Category '{category}' not found in GBD categories") from None
