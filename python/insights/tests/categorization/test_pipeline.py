from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import pipeline, steps
from gbd_foodservice_insights.categorization.cache import CategorizationCache
from gbd_foodservice_insights.categorization.pipeline import (
    categorize_unique_products,
)
from gbd_foodservice_insights.testing import KeywordLlmClient
from pandas.testing import assert_frame_equal


@dataclass(frozen=True)
class ScriptedLlmClient:
    """Answers verbatim from `match_answers`, keyed by cleaned name, so a test can hand the
    pipeline the near-miss answers a real model gives and `KeywordLlmClient` never does."""

    match_answers: Mapping[str, str]

    def clean_product_name(self, item: str) -> str:
        return item.lower()

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        return self.match_answers[item]


EMPTY_CACHE = CategorizationCache.from_frame(
    pd.DataFrame(columns=["product", "category", "cleaned_item_names"])
)


@pytest.mark.parametrize("missing_column", ["product", "date", "weight"])
def test_categorize_unique_products_raises_when_a_required_column_is_missing(missing_column):
    columns = [c for c in ("product", "date", "weight") if c != missing_column]
    df = pd.DataFrame({col: ["x"] for col in columns})

    with pytest.raises(ValueError, match=f"Column '{missing_column}' not found"):
        categorize_unique_products(df=df, llm=KeywordLlmClient(), cache=EMPTY_CACHE)


def test_categorize_unique_products_raises_when_date_cleaning_leaves_missing_values():
    df = pd.DataFrame({"product": ["apple"], "date": ["not a date"], "weight": [1.0]})
    parsed_df = df.copy()
    parsed_df["date"] = pd.NaT

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=parsed_df),
        patch.object(pipeline, "clean_weight_column", return_value=parsed_df),
        pytest.raises(ValueError, match=r"Column 'date' contains NaN values after cleaning."),
    ):
        categorize_unique_products(df=df, llm=KeywordLlmClient(), cache=EMPTY_CACHE)


def test_categorize_unique_products_raises_when_weight_cleaning_leaves_missing_values():
    df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": ["unknown"]})
    parsed_df = df.copy()
    parsed_df["date"] = pd.to_datetime(parsed_df["date"])
    cleaned_df = parsed_df.copy()
    cleaned_df["weight"] = pd.NA

    with (
        patch.object(pipeline, "parse_and_validate_date_column", return_value=parsed_df),
        patch.object(pipeline, "clean_weight_column", return_value=cleaned_df),
        pytest.raises(ValueError, match=r"Column 'weight' contains NaN values after cleaning."),
    ):
        categorize_unique_products(df=df, llm=KeywordLlmClient(), cache=EMPTY_CACHE)


def test_categorize_unique_products_reuses_cleaned_names_and_skips_llm():
    df = pd.DataFrame(
        {
            "product": ["MLK WHOLE 2L", "Whole Milk Carton"],
            "date": ["2025-01-01", "2025-01-01"],
            "weight": [1.0, 2.0],
        }
    )
    # Cache holds a *different* raw product whose cleaned name is "whole milk",
    # so the raw lookup misses but the cleaned-name lookup should hit.
    cache = CategorizationCache.from_frame(
        pd.DataFrame(
            {
                "product": ["SOME OTHER MILK SKU"],
                "category": ["Milk (Cow's milk)"],
                "cleaned_item_names": ["whole milk"],
            }
        )
    )

    class EverythingIsWholeMilk(KeywordLlmClient):
        def clean_product_name(self, item: str) -> str:
            super().clean_product_name(item)
            return "whole milk"

    llm = EverythingIsWholeMilk()

    with patch.object(steps, "print_progress", return_value=None):
        categorized = categorize_unique_products(df=df, llm=llm, cache=cache)

    # Both unique products were reused via their cleaned name; the LLM categorizer never ran.
    assert [operation for operation, _ in llm.calls] == ["clean", "clean"]
    assert categorized.match_type_counts.get("cleaned_name_history") == 2
    assert set(categorized.unique_products_df["category"]) == {"Milk (Cow's milk)"}
    # Trusted reuse -> nothing queued for human review.
    assert categorized.ai_review_df.empty


def test_categorize_unique_products_characterization() -> None:
    """Pins today's silent drops, so each later change to them shows up as a diff here: every
    near-miss answer becomes "No Matches Found". A cache row with surrounding whitespace hits;
    one with a blank or non-canonical category is dropped, so its product goes to the LLM and
    the review table."""
    products = [
        "Cheddar Shred",
        "Salted Butter",
        "Pork Loin",
        "Oat Milk Carton",
        "Mozzarella Block",
        "Whole Milk Gallon",
    ]
    df = pd.DataFrame(
        {
            "product": products,
            "date": pd.to_datetime(["2025-01-15"] * len(products)),
            "weight": [10.0] * len(products),
        }
    )
    cache = CategorizationCache.from_frame(
        pd.DataFrame(
            {
                "product": [
                    "Mozzarella Block",
                    "Oat Milk Carton ",
                    "Salted Butter",
                    "Whole Milk Gallon",
                ],
                "category": ["cheese", "Oat Milk", None, "Milk (Cow's milk)"],
                "cleaned_item_names": ["mozzarella block", None, None, "whole milk gallon"],
            }
        )
    )
    llm = ScriptedLlmClient(
        {
            "cheddar shred": "Cheese.",
            "salted butter": '"Butter"',
            "pork loin": "pork",
            "mozzarella block": "cheese",
        }
    )

    categorized = categorize_unique_products(df, llm, cache)

    no_match = "No Matches Found"
    assert_frame_equal(
        categorized.unique_products_df,
        pd.DataFrame(
            {
                "product": products,
                "category": [no_match] * 3 + ["Oat Milk", no_match, "Milk (Cow's milk)"],
                "previously_categorized": [False] * 3 + [True, False, True],
                "match_type": pd.Series(
                    ["llm"] * 3 + ["raw_product_history", "llm", "raw_product_history"],
                    dtype="object",
                ),
                "cleaned_item_names": [
                    "cheddar shred",
                    "salted butter",
                    "pork loin",
                    "Oat Milk Carton",
                    "mozzarella block",
                    "Whole Milk Gallon",
                ],
            }
        ),
    )
    assert_frame_equal(
        categorized.ai_review_df,
        pd.DataFrame(
            {
                "category": [no_match] * 4,
                "product": ["Cheddar Shred", "Mozzarella Block", "Pork Loin", "Salted Butter"],
                "occurrence_count": [1] * 4,
            }
        ),
    )
    assert categorized.match_type_counts == {"llm": 4, "raw_product_history": 2}
