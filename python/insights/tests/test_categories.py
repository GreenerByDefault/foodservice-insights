import pytest
from gbd_foodservice_insights.categories import (
    Category,
    _parse_categories,
    animal_product_categories,
    categories,
    category_names,
    drink_categories,
    food_categories,
    plant_based_categories,
    plant_protein_categories,
    protein_categories,
)

BEEF_ENTRY = {
    "name": "Beef",
    "cool_food_pledge_name": "Beef and Buffalo Meat",
    "emission_factor_us": 41.35,
    "emission_factor_europe": 37.44,
    "is_animal_product": True,
    "template_product_category": "Animal Based Proteins",
    "type": "food",
    "meat": True,
    "protein": True,
    "serving_weight_oz": 3,
}

BEEF = Category(
    name="Beef and Buffalo Meat",
    short_name="Beef",
    emission_factor_us=41.35,
    emission_factor_europe=37.44,
    is_animal_product=True,
    product_category="Animal Based Proteins",
    kind="food",
    meat=True,
    protein=True,
)


def test_packaged_yaml_parses():
    assert len(categories()) == 27
    assert categories()[0] == BEEF


def test_protein_is_meat_eggs_plant_proteins_and_plant_egg():
    assert protein_categories() == [
        "Beef and Buffalo Meat",
        "Lamb/mutton & goat meat",
        "Pork (pig meat)",
        "Poultry (Chicken & Turkey)",
        "Fish & Mollusks",
        "Shellfish (Shrimp & lobster)",
        "Liquid Eggs",
        "Shelled Eggs",
        "Whole Grains",
        "Plant-based Meats",
        "Legumes",
        "Nuts & Seeds",
        "Plant-Based Egg",
    ]


def test_plant_protein_categories():
    assert plant_protein_categories() == [
        "Whole Grains",
        "Plant-based Meats",
        "Legumes",
        "Nuts & Seeds",
    ]


def test_drink_categories():
    assert drink_categories() == [
        "Milk (Cow's milk)",
        "Almond/Coconut Milk",
        "Oat Milk",
        "Rice Milk",
        "Soy Milk",
        "Unspecified non dairy milk",
    ]


@pytest.mark.parametrize(
    ("first", "second"),
    [
        (food_categories, drink_categories),
        (animal_product_categories, plant_based_categories),
    ],
)
def test_partitions_every_category(first, second):
    assert sorted(first() + second()) == sorted(category_names())


def test_parse_accepts_an_integer_emission_factor():
    (category,) = _parse_categories({"categories": [{**BEEF_ENTRY, "emission_factor_us": 41}]})
    assert category.emission_factor_us == 41.0
    assert isinstance(category.emission_factor_us, float)


@pytest.mark.parametrize(
    ("key", "value", "match"),
    [
        ("protein", None, r"`protein` must be a bool"),
        ("emission_factor_us", None, r"`emission_factor_us` must be a float"),
        ("emission_factor_us", True, r"`emission_factor_us` must be a float"),
        ("emission_factor_europe", "37.44", r"`emission_factor_europe` must be a float"),
        ("meat", 1, r"`meat` must be a bool"),
        ("type", "snack", r"`type` must be one of \('food', 'drink'\)"),
        ("template_product_category", "Fruit", r"`template_product_category` must be one of"),
    ],
)
def test_parse_rejects_a_malformed_field(key, value, match):
    with pytest.raises(ValueError, match=match):
        _parse_categories({"categories": [{**BEEF_ENTRY, key: value}]})


@pytest.mark.parametrize(
    ("data", "match"),
    [
        ([BEEF_ENTRY], r"must be a mapping with a `categories` list"),
        ({"categories": BEEF_ENTRY}, r"must be a mapping with a `categories` list"),
        ({"categories": ["Beef"]}, r"Each category must be a mapping"),
        ({"categories": [BEEF_ENTRY, BEEF_ENTRY]}, r"repeat: \['Beef and Buffalo Meat'\]"),
    ],
)
def test_parse_rejects_a_malformed_document(data, match):
    with pytest.raises(ValueError, match=match):
        _parse_categories(data)
