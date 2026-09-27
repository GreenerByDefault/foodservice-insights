from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from gbd_foodservice_insights.categorization import cache, entrees
from gbd_foodservice_insights.categorization.pipeline import categorize_file
from gbd_foodservice_insights.testing import KeywordLlmClient


def _run_serving(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rows: list[tuple[str, str, float]],
    entree_history: dict[str, str],
    flash_labels: dict[str, str],
    pro_labels: dict[str, str],
) -> tuple[pd.DataFrame, dict]:
    """Run `categorize_file(data_type="serving")` with every cache redirected into `tmp_path`
    and Gemini answering from `flash_labels` / `pro_labels`, keyed by the product name."""
    # `run_entree_detector` writes its review sheet to the working directory.
    monkeypatch.chdir(tmp_path)
    pd.DataFrame(
        {
            "product": list(entree_history),
            "entree_classification": list(entree_history.values()),
        }
    ).to_csv(tmp_path / "entrees.csv", index=False)

    def fake_call_gemini_api(prompt, gemini_client, temperature=0.0, model=""):
        labels = flash_labels if model == entrees.ENTREE_FLASH_MODEL else pro_labels
        product = prompt.split("\nProduct: ")[1].split("\n")[0]
        return labels[product]

    input_path = tmp_path / "input.csv"
    pd.DataFrame(rows, columns=["product", "date", "weight"]).to_csv(input_path, index=False)

    with (
        patch.object(entrees, "call_gemini_api", side_effect=fake_call_gemini_api),
        patch.object(entrees, "print_progress", return_value=None),
        patch.object(entrees, "load_prompt", return_value="Prompt"),
        patch.object(cache, "_historical_cache_path", return_value=tmp_path / "categories.csv"),
        patch.object(
            cache, "_web_app_unreviewed_cache_path", return_value=tmp_path / "web_app.csv"
        ),
        patch.object(
            cache,
            "get_previously_classified_entrees_location",
            return_value=tmp_path / "entrees.csv",
        ),
    ):
        return categorize_file(
            input_filepath=input_path,
            output_filepath=tmp_path / "output.csv",
            llm=KeywordLlmClient(),
            gemini_client=object(),
            data_type="serving",
            cache_write_mode="reviewed",
            dayfirst_preference=False,
        )


def test_categorize_file_serving_end_to_end(tmp_path, monkeypatch):
    df_final, summary = _run_serving(
        tmp_path,
        monkeypatch,
        rows=[
            ("Chicken Breast Boneless", "2025-01-01", 10.0),
            ("Chicken Breast Boneless", "2025-01-02", 12.0),
            ("Ground Beef 80/20", "2025-01-01", 5.0),
            ("Brown Rice", "2025-01-01", 3.0),
            ("Brown Rice", "2025-01-02", 4.0),
            ("Brown Rice", "2025-01-03", 2.0),
            ("Salmon Fillet", "2025-01-02", 6.0),
            ("Paper Towels", "2025-01-01", 1.0),
        ],
        entree_history={"Chicken Breast Boneless": "entree"},
        flash_labels={
            "Ground Beef 80/20": "entree",
            "Brown Rice": "side/add-on",
            "Salmon Fillet": "unsure",
        },
        pro_labels={"Salmon Fillet": "entree"},
    )

    pd.testing.assert_frame_equal(
        df_final,
        pd.DataFrame(
            {
                "product": [
                    "Chicken Breast Boneless",
                    "Chicken Breast Boneless",
                    "Ground Beef 80/20",
                    "Salmon Fillet",
                ],
                "date": pd.to_datetime(
                    ["2025-01-01", "2025-01-02", "2025-01-01", "2025-01-02"]
                ).as_unit("us"),
                "weight": [10.0, 12.0, 5.0, 6.0],
                "category": [
                    "Poultry (Chicken & Turkey)",
                    "Poultry (Chicken & Turkey)",
                    "Beef and Buffalo Meat",
                    "Fish & Mollusks",
                ],
                "entree_classification": ["entree"] * 4,
            },
            index=[0, 1, 2, 6],
        ),
    )
    assert summary == {
        "n_products_before": 5,
        "n_products_after": 4,
        "pct_remaining": 0.8,
        "n_rows_before": 8,
        "n_rows_after": 4,
        "row_elimination_details": {
            "total_rows_initial": 8,
            "total_rows_final": 4,
            "total_rows_eliminated": 4,
            "total_eliminated_pct": 0.5,
            "rows_eliminated_uncategorized": 1,
            "rows_eliminated_uncategorized_pct": 0.125,
            "rows_eliminated_non_entree": 3,
            "rows_eliminated_non_entree_pct": 0.375,
        },
        "match_type_counts": {"llm": 5},
        "output_file": str(tmp_path / "output.csv"),
        "human_review_file": str(tmp_path / "output_for_human_review.csv"),
        "human_review_n_unique_products": 5,
        "entree_human_review_file": str(tmp_path / "output_entree_for_human_review.csv"),
        "entree_human_review_n_unique_products": 3,
    }
    assert (tmp_path / "output_for_human_review.csv").read_text() == (
        "category,product,occurrence_count\n"
        "Beef and Buffalo Meat,Ground Beef 80/20,1\n"
        "Fish & Mollusks,Salmon Fillet,1\n"
        "No Matches Found,Paper Towels,1\n"
        "Poultry (Chicken & Turkey),Chicken Breast Boneless,2\n"
        "Whole Grains,Brown Rice,3\n"
    )
    # Chicken came from the entree history, so only the other three are up for review.
    assert (tmp_path / "output_entree_for_human_review.csv").read_text() == (
        "entree_classification,product,category,occurrence_count\n"
        "entree,Ground Beef 80/20,Beef and Buffalo Meat,1\n"
        "entree,Salmon Fillet,Fish & Mollusks,1\n"
        "side/add-on,Brown Rice,Whole Grains,3\n"
    )
    assert (tmp_path / "categories.csv").read_text() == (
        "product,category,cleaned_item_names\n"
        "Chicken Breast Boneless,Poultry (Chicken & Turkey),chicken breast boneless\n"
        "Ground Beef 80/20,Beef and Buffalo Meat,ground beef\n"
        "Brown Rice,Whole Grains,brown rice\n"
        "Salmon Fillet,Fish & Mollusks,salmon fillet\n"
        "Paper Towels,No Matches Found,paper towels\n"
    )
    assert (tmp_path / "entrees.csv").read_text() == (
        "product,entree_classification,cleaned_item_names\n"
        "Chicken Breast Boneless,entree,chicken breast boneless\n"
        "Ground Beef 80/20,entree,ground beef\n"
        "Brown Rice,side/add-on,brown rice\n"
        "Salmon Fillet,entree,salmon fillet\n"
    )


def test_categorize_file_serving_side_add_ons_do_not_count_toward_unusable_data(
    tmp_path, monkeypatch
):
    """The 80% elimination check sees only uncategorized products, so a file that is mostly
    sides still produces a report."""
    sides = [
        "Brown Rice",
        "Butter Unsalted",
        "Greek Yogurt",
        "Whole Milk Gallon",
        "CHEESE CHEDDAR 5LB",
    ]
    df_final, summary = _run_serving(
        tmp_path,
        monkeypatch,
        rows=[(product, "2025-01-01", 1.0) for product in ["Pork Loin", *sides]],
        entree_history={},
        flash_labels={"Pork Loin": "entree"} | dict.fromkeys(sides, "side/add-on"),
        pro_labels={},
    )

    assert df_final["product"].tolist() == ["Pork Loin"]
    assert summary["pct_remaining"] == 1.0
    assert summary["row_elimination_details"]["rows_eliminated_non_entree"] == 5
