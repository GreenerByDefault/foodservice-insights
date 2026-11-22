"""Rewords product names for display, by a fixed list GBD has approved: never by an LLM, so the
same upload always reads the same. Applied after categorization, so the cache and its review
queue keep the customer's own spelling."""

import re
from typing import Final

import pandas as pd

from gbd_foodservice_insights.categorization.steps import canonical_product_names

# Whole words, ignoring case, with any run of spaces or hyphens between them.
APPROVED_RENAMES: Final = (("plant base", "Plant-based"),)


def _phrase_pattern(phrase: str) -> re.Pattern[str]:
    words = r"[\s-]+".join(re.escape(word) for word in phrase.split())
    return re.compile(rf"\b{words}\b", re.IGNORECASE)


_RENAMES: Final = tuple((_phrase_pattern(phrase), new) for phrase, new in APPROVED_RENAMES)


def display_product_names(products: pd.Series) -> pd.Series:
    renamed = products
    for pattern, replacement in _RENAMES:
        renamed = renamed.str.replace(pattern, replacement, regex=True)
    # A rename can make two products one spelling apart, as "Plant Base Ice Cream" becomes
    # "Plant-based ice cream" next to the customer's own "Plant-Based Ice Cream".
    return canonical_product_names(renamed)
