from typing import Any

import numpy as np
import pandas as pd
from gbd_foodservice_insights.categories import get_GBD_categories
from gbd_foodservice_insights.categorization.cache import read_categorization_cache_csv

# Functions to allow easy testing of the LLM models in our existing pipelines


# ----------------------------------------------------------------------
# Testing a new categorization LLM
# ----------------------------------------------------------------------
# Here, for a new LLM, you write a clean item name function and then you write a match items
# to GPD categories function. And then you run the test new categorization LLM function which
# will basically see if the new model can match the correct classifications from previously
# classified products.
def clean_item_name_challenger(item: str, client: Any = None) -> str | None:
    """Clean an item name using a 'challenger' LLM.

    Placeholder for the actual implementation; returns None until it is replaced.
    """

    return None  # Placeholder for the actual implementation


def match_items_items_to_GBD_categories_challenger(item: str, client: Any = None) -> str | None:
    """Match a cleaned item name to GBD categories using a 'challenger' LLM.

    Placeholder for the actual implementation; returns None until it is replaced.
    """

    return None  # Placeholder for the actual implementation


def test_new_categorization_LLM(n_test_samples: int = 100) -> None:
    """Test a challenger LLM categorization pipeline against previously categorized items.

    Samples ``n_test_samples`` items that have a cleaned name, runs the challenger categorizer
    on them, and prints the share of results that are GBD categories and that match the true
    category. Raises ``ValueError`` if fewer than ``n_test_samples`` items have a cleaned name.
    """

    # Load the previously categorized items
    previously_categorized_items: pd.DataFrame = read_categorization_cache_csv()

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
