import pandas as pd
from gbd_foodservice_insights.report.display_names import display_product_names


def test_display_product_names_applies_an_approved_rename_to_whole_words_only():
    products = pd.Series(
        ["Plant Base Ice Cream", "PLANT-BASE burger", "Plant Based Milk", "Implant Base"]
    )

    assert display_product_names(products).tolist() == [
        "Plant-based Ice Cream",
        "Plant-based burger",
        "Plant Based Milk",
        "Implant Base",
    ]


def test_display_product_names_merges_products_a_rename_makes_one_spelling_apart():
    products = pd.Series(["Plant Base Ice Cream", "Plant-Based Ice Cream", "Plant Base Ice Cream"])

    assert display_product_names(products).tolist() == ["Plant-based Ice Cream"] * 3
