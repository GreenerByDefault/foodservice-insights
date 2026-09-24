import pandas as pd
from gbd_foodservice_insights.categorization.reviews import (
    build_ai_review_table,
    build_entree_human_review_table,
)


def test_build_ai_review_table_excludes_historical_and_includes_no_matches():
    original_df = pd.DataFrame({"product": ["apple", "apple", "beef", "beef", "beef", "carrot"]})
    unique_products_df = pd.DataFrame(
        {
            "product": ["apple", "beef", "carrot"],
            "category": ["Vegetables", "No Matches Found", "Vegetables"],
            "previously_categorized": [False, False, True],
        }
    )

    result = build_ai_review_table(original_df, unique_products_df, include_no_matches=True)

    expected = pd.DataFrame(
        {
            "category": ["No Matches Found", "Vegetables"],
            "product": ["beef", "apple"],
            "occurrence_count": [3, 2],
        }
    )

    pd.testing.assert_frame_equal(result, expected)


def test_build_ai_review_table_sorts_within_category_by_count_then_product():
    """Ensures deterministic in-category sort order for stable human-review output files."""
    original_df = pd.DataFrame({"product": ["apple", "apple", "banana", "banana", "apricot"]})
    unique_products_df = pd.DataFrame(
        {
            "product": ["apple", "banana", "apricot"],
            "category": ["Fruit", "Fruit", "Fruit"],
            "previously_categorized": [False, False, False],
        }
    )

    result = build_ai_review_table(original_df, unique_products_df)

    assert result["product"].tolist() == ["apple", "banana", "apricot"]
    assert result["occurrence_count"].tolist() == [2, 2, 1]


def test_build_ai_review_table_sorts_by_category_first():
    """Ensures review output groups by category first, improving analyst scanability."""
    original_df = pd.DataFrame({"product": ["zucchini", "apple"]})
    unique_products_df = pd.DataFrame(
        {
            "product": ["zucchini", "apple"],
            "category": ["Vegetables", "Fruit"],
            "previously_categorized": [False, False],
        }
    )

    result = build_ai_review_table(original_df, unique_products_df)
    assert result["category"].tolist() == ["Fruit", "Vegetables"]


def test_build_ai_review_table_can_exclude_no_matches():
    """Ensures optional filtering can drop no-match rows when analysts only want resolvable
    items."""
    original_df = pd.DataFrame({"product": ["beef", "apple"]})
    unique_products_df = pd.DataFrame(
        {
            "product": ["beef", "apple"],
            "category": ["No Matches Found", "Fruit"],
            "previously_categorized": [False, False],
        }
    )

    result = build_ai_review_table(original_df, unique_products_df, include_no_matches=False)
    assert result["category"].tolist() == ["Fruit"]
    assert result["product"].tolist() == ["apple"]


def test_build_entree_human_review_table_excludes_historical():
    original_df = pd.DataFrame({"product": ["apple", "apple", "banana", "carrot"]})
    unique_products_df = pd.DataFrame(
        {
            "product": ["apple", "banana", "carrot"],
            "category": ["Fruit", "Fruit", "Fruit"],
            "entree_classification": ["entree", "side/add-on", "side/add-on"],
            "previously_entree_classified": [False, True, False],
        }
    )

    review = build_entree_human_review_table(original_df, unique_products_df)
    assert review["product"].tolist() == ["apple", "carrot"]
    assert review["entree_classification"].tolist() == ["entree", "side/add-on"]
