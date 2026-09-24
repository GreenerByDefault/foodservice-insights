from typing import Any

import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.categorization.cache import get_previously_categorized_items

# Functions to allow easy testing of the LLM models in our existing pipelines


# ----------------------------------------------------------------------
# Testing a new categorization LLM
# ----------------------------------------------------------------------
# Here, for a new LLM, you write a clean item name function and then you write a match items
# to GPD categories function. And then you run the test new categorization LLM function which
# will basically see if the new model can match the correct classifications from previously
# classified products.
def clean_item_name_challenger(item: str, client: Any = None) -> str | None:
    """
    Cleans an item name using a 'challenger' LLM.
    This is a placeholder for the actual implementation.

    Args:
        item (str): The item name to clean.
        client (Any, optional): The LLM client. Defaults to None.

    Returns:
        Optional[str]: The cleaned item name, or None if placeholder is not replaced.
    """

    return None  # Placeholder for the actual implementation


def match_items_items_to_GBD_categories_challenger(item: str, client: Any = None) -> str | None:
    """
    Matches a cleaned item name to GBD categories using a 'challenger' LLM.
    This is a placeholder for the actual implementation.

    Args:
        item (str): The cleaned item name.
        client (Any, optional): The LLM client. Defaults to None.

    Returns:
        Optional[str]: The GBD category, or None if placeholder is not replaced.
    """

    return None  # Placeholder for the actual implementation


def test_new_categorization_LLM(n_test_samples: int = 100) -> None:
    """
    Tests a new LLM categorization pipeline (challenger model) against previously
    categorized items.

    It samples data, applies the challenger's cleaning and categorization functions,
    and compares results (comparison logic is currently commented out).
    Prints progress and potentially saves discrepancies to CSV if uncommented.

    Raises:
        ValueError: If 'previously_categorized_items.csv' is empty.

    Returns:
        None.
    """

    # Load the previously categorized items
    previously_categorized_items: pd.DataFrame = get_previously_categorized_items()

    previously_categorized_items = previously_categorized_items.loc[
        ~previously_categorized_items["cleaned_item_names"].isna(), :
    ]  # make sure they have a cleaned name

    if len(previously_categorized_items) < n_test_samples:
        raise ValueError(
            f"Not enough samples to test. Need {n_test_samples}, but only have "
            f"{len(previously_categorized_items)}."
        )

    test_sample = previously_categorized_items.sample(n_test_samples)

    print("Categorizing items using challenger LLM")

    test_sample.loc[:, "challenger_LLM_categorization"] = [
        match_items_items_to_GBD_categories_challenger(item, client=None)
        for item in test_sample["cleaned_item_names"]
    ]

    gbd_categories = get_GBD_categories()

    percent_in_gbd = test_sample["challenger_LLM_categorization"].isin(gbd_categories).mean() * 100
    print(f"{percent_in_gbd:.2f}% of challenger_LLM_categorization values are in GBD categories.")

    correct_matches = (
        np.mean(test_sample["challenger_LLM_categorization"] == test_sample["category"]) * 100
    )
    print(
        f"{correct_matches:.2f}% of challenger_LLM_categorization values match the true categories."
    )
