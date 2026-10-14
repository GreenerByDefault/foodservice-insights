import string
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization.cache import CategorizationCache
from gbd_foodservice_insights.categorization.llm import LLM_CONCURRENCY
from gbd_foodservice_insights.categorization.pipeline import (
    CategorizationSummary,
    CategorizedProducts,
    categorize_unique_products,
    summarize_categorization,
)
from gbd_foodservice_insights.categorization.steps import merge_categorizations
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


def test_categorize_unique_products_rejects_an_unparsed_date_column():
    df = pd.DataFrame({"product": ["apple"], "date": ["2025-01-01"], "weight": [1.0]})

    with pytest.raises(TypeError, match="date must be datetime64, not str"):
        categorize_unique_products(df=df, llm=KeywordLlmClient(), cache=EMPTY_CACHE)


def test_categorize_unique_products_rejects_a_missing_product():
    df = pd.DataFrame(
        {
            "product": ["apple", None],
            "date": pd.to_datetime(["2025-01-01"] * 2),
            "weight": [1.0, 2.0],
        }
    )

    with pytest.raises(ValueError, match="Column 'product' contains missing values"):
        categorize_unique_products(df=df, llm=KeywordLlmClient(), cache=EMPTY_CACHE)


def test_categorize_unique_products_reuses_cleaned_names_and_skips_llm():
    df = pd.DataFrame(
        {
            "product": ["MLK WHOLE 2L", "Whole Milk Carton"],
            "date": pd.to_datetime(["2025-01-01", "2025-01-01"]),
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

    categorized = categorize_unique_products(df=df, llm=llm, cache=cache)

    # Both unique products were reused via their cleaned name; the LLM categorizer never ran.
    assert [operation for operation, _ in llm.calls] == ["clean", "clean"]
    assert_frame_equal(
        categorized.unique_products_df,
        pd.DataFrame(
            {
                "product": ["MLK WHOLE 2L", "Whole Milk Carton"],
                "category": ["Milk (Cow's milk)"] * 2,
                "match_type": pd.Series(["cleaned_name_history"] * 2, dtype="object"),
                "cleaned_item_names": ["whole milk"] * 2,
            }
        ),
    )


def test_categorize_unique_products_characterization(caplog: pytest.LogCaptureFixture) -> None:
    """Near-miss model answers resolve to their category; an answer that names no category
    ("pork", "None") becomes "No Matches Found" with a warning. A cache row with surrounding
    whitespace hits; one with a blank or non-canonical category is dropped, so its product goes
    to the LLM."""
    products = [
        "Cheddar Shred",
        "Salted Butter",
        "Pork Loin",
        "Oat Milk Carton",
        "Mozzarella Block",
        "Whole Milk Gallon",
        "Cheesecake Slice",
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
            "cheesecake slice": "None",
        }
    )

    categorized = categorize_unique_products(df, llm, cache)

    no_match = "No Matches Found"
    assert_frame_equal(
        categorized.unique_products_df,
        pd.DataFrame(
            {
                "product": products,
                "category": [
                    "Cheese",
                    "Butter",
                    no_match,
                    "Oat Milk",
                    "Cheese",
                    "Milk (Cow's milk)",
                    no_match,
                ],
                "match_type": pd.Series(
                    ["llm"] * 3 + ["raw_product_history", "llm", "raw_product_history", "llm"],
                    dtype="object",
                ),
                "cleaned_item_names": [
                    "cheddar shred",
                    "salted butter",
                    "pork loin",
                    "Oat Milk Carton",
                    "mozzarella block",
                    "Whole Milk Gallon",
                    "cheesecake slice",
                ],
            }
        ),
    )
    assert [r.getMessage() for r in caplog.records if r.name.endswith(".steps")] == [
        "2 of 5 LLM answers were not recognized; most common: [('pork', 1), ('None', 1)]",
    ]


def test_categorize_unique_products_makes_llm_calls_concurrently() -> None:
    # Each call waits until LLM_CONCURRENCY calls are waiting, so a step that makes its calls
    # one at a time breaks the barrier instead of hanging.
    barrier = threading.Barrier(LLM_CONCURRENCY, timeout=5)

    class BarrierLlmClient(KeywordLlmClient):
        def clean_product_name(self, item: str) -> str:
            barrier.wait()
            return super().clean_product_name(item)

        def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
            barrier.wait()
            return super().match_product_to_category(item, categories)

    products = [f"Product {letter}" for letter in string.ascii_uppercase[:LLM_CONCURRENCY]]
    df = pd.DataFrame(
        {
            "product": products,
            "date": pd.to_datetime(["2025-01-15"] * len(products)),
            "weight": [1.0] * len(products),
        }
    )
    llm = BarrierLlmClient()

    categorize_unique_products(df=df, llm=llm, cache=EMPTY_CACHE)

    assert sorted(llm.calls) == [
        *[("clean", product) for product in products],
        *[("match", product.lower()) for product in products],
    ]


def test_summarize_categorization_counts_each_source_and_what_merge_keeps() -> None:
    weights = {
        "Cheddar Block": [1.0, 2.0],
        "Paper Towels": [4.0],
        "MLK WHOLE 2L": [8.0, 16.0],
        " Chicken Thigh ": [32.0],
        "Chicken Thigh": [64.0],
        "Dish Soap": [128.0],
        "Mystery Meat": [256.0, 512.0],
    }
    df = pd.DataFrame(
        {
            "product": [product for product, kgs in weights.items() for _ in kgs],
            "date": pd.Timestamp("2025-01-15"),
            "weight": [kg for kgs in weights.values() for kg in kgs],
        }
    )
    cache = CategorizationCache.from_frame(
        pd.DataFrame(
            {
                "product": ["Cheddar Block", "Paper Towels", "OTHER MILK SKU"],
                "category": ["Cheese", "No Matches Found", "Milk (Cow's milk)"],
                "cleaned_item_names": ["cheddar block", "paper towels", "mlk whole 2l"],
            }
        )
    )
    llm = ScriptedLlmClient(
        {
            "chicken thigh": "Poultry (Chicken & Turkey)",
            "dish soap": "No Matches Found",
            "mystery meat": "Meat",
        }
    )
    categorized = categorize_unique_products(df, llm, cache)

    summary = summarize_categorization(categorized)

    assert summary == CategorizationSummary(
        raw_product_history_products=2,
        cleaned_name_history_products=1,
        llm_products=3,
        history_uncategorized_products=1,
        llm_uncategorized_products=2,
        unrecognized_llm_answers=1,
        categorized_rows=6,
        categorized_kilograms=1.0 + 2.0 + 8.0 + 16.0 + 32.0 + 64.0,
    )
    merged = merge_categorizations(categorized.cleaned_df, categorized.unique_products_df)
    assert (summary.categorized_rows, summary.categorized_kilograms) == (
        len(merged),
        merged["weight"].sum(),
    )


def test_summarize_categorization_counts_a_match_type_no_product_has_as_zero() -> None:
    df = pd.DataFrame(
        {"product": ["Pork Loin"], "date": pd.Timestamp("2025-01-15"), "weight": [1.0]}
    )

    summary = summarize_categorization(
        categorize_unique_products(df, KeywordLlmClient(), EMPTY_CACHE)
    )

    assert summary == CategorizationSummary(
        raw_product_history_products=0,
        cleaned_name_history_products=0,
        llm_products=1,
        history_uncategorized_products=0,
        llm_uncategorized_products=0,
        unrecognized_llm_answers=0,
        categorized_rows=1,
        categorized_kilograms=1.0,
    )


def _categorized(products: pd.DataFrame, rows: Sequence[str]) -> CategorizedProducts:
    return CategorizedProducts(
        cleaned_df=pd.DataFrame({"product": rows, "weight": 1.0}),
        unique_products_df=products,
        unrecognized_llm_answers=0,
    )


def test_summarize_categorization_rejects_an_unknown_match_type() -> None:
    products = pd.DataFrame(
        {"product": ["Pork Loin"], "category": ["Pork (pig meat)"], "match_type": ["guess"]}
    )

    with pytest.raises(ValueError, match=r"Unknown match types: \['guess'\]"):
        summarize_categorization(_categorized(products, ["Pork Loin"]))


def test_summarize_categorization_rejects_a_row_whose_product_was_not_categorized() -> None:
    products = pd.DataFrame(
        {"product": ["Pork Loin"], "category": ["Pork (pig meat)"], "match_type": ["llm"]}
    )

    with pytest.raises(ValueError, match="No categorization for 1 of 2 rows"):
        summarize_categorization(_categorized(products, ["Pork Loin", "Dish Soap"]))
