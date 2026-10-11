import pytest
from gbd_foodservice_insights_lab.categories import (
    egg_categories,
    meat_categories,
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


@pytest.mark.parametrize("category", ["Pork (pig meat)", "pork (pig meat)", "PORK (PIG MEAT)"])
def test_short_name_ignores_case(category):
    assert short_name(category) == "Pork"


def test_short_name_raises_on_an_unknown_category():
    with pytest.raises(KeyError, match="Not A Category"):
        short_name("Not A Category")
