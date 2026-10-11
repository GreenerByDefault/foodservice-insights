import pytest
from gbd_foodservice_insights_lab.categories import (
    dairy_categories,
    egg_categories,
    meat_categories,
    plant_based_dairy_categories,
    short_name,
)


def test_meat_categories_exclude_eggs():
    assert meat_categories() == [
        "Beef and Buffalo Meat",
        "Lamb/mutton & goat meat",
        "Pork (pig meat)",
        "Poultry (Chicken & Turkey)",
        "Fish & Mollusks",
        "Shellfish (Shrimp & lobster)",
    ]


def test_egg_categories_exclude_plant_based_egg():
    assert egg_categories() == ["Liquid Eggs", "Shelled Eggs"]


def test_dairy_categories_exclude_eggs_and_plant_based_dairy():
    assert dairy_categories() == [
        "Cheese",
        "Butter",
        "Ice Cream",
        "Cream",
        "Milk (Cow's milk)",
        "Yogurt",
        "Mayo",
    ]


def test_plant_based_dairy_categories_include_plant_based_egg():
    assert plant_based_dairy_categories() == [
        "Almond/Coconut Milk",
        "Oat Milk",
        "Rice Milk",
        "Soy Milk",
        "Plant-Based Cheese",
        "Plant-Based Yogurt",
        "Plant-Based Egg",
        "Unspecified non dairy milk",
    ]


def test_short_name_is_the_display_name_not_the_category():
    assert short_name("Unspecified non dairy milk") == "Dairy Alternative (Unspecified)"


@pytest.mark.parametrize("category", ["Pork (pig meat)", "pork (pig meat)", "PORK (PIG MEAT)"])
def test_short_name_ignores_case(category):
    assert short_name(category) == "Pork"


def test_short_name_raises_on_an_unknown_category():
    with pytest.raises(KeyError, match="Not A Category"):
        short_name("Not A Category")
