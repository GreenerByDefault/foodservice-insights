from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import psycopg
import pytest
from gbd_foodservice_insights.categorization.llm import LlmCall, LlmOperation, OnLlmCall
from gbd_foodservice_insights.testing import KeywordLlmClient
from gbd_foodservice_insights_lab.categorization import model_eval, product_cache
from gbd_foodservice_insights_lab.categorization.model_eval import (
    PORK_RULE,
    SLICES,
    Answer,
    ask,
    draw_sample,
    fixes_sql,
    score,
    slice_flags,
)

BEEF = "Beef and Buffalo Meat"
PORK = "Pork (pig meat)"
POULTRY = "Poultry (Chicken & Turkey)"
CHEESE = "Cheese"
MILK = "Milk (Cow's milk)"
NO_MATCH = "No Matches Found"
HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"


def _cache(rows: Sequence[tuple[str, str]]) -> pd.DataFrame:
    return pd.DataFrame(
        [(product, category, "") for product, category in rows],
        columns=["product", "category", "cleaned_item_names"],
    )


@pytest.mark.parametrize(
    ("product", "covered"),
    [
        ("Beef sausages", True),
        ("PEPPERONI SLI HALAL", True),
        ("Chicken Meatballs Halal", True),
        ("Pork and Beef Meatballs", False),
        ("BBQ Pork Sausage Non Halal", False),
        ("Meatballs Italian", False),
        ("Beef Mince", False),
    ],
)
def test_pork_rule(product: str, covered: bool) -> None:
    assert slice_flags(pd.Series([product]))[PORK_RULE].tolist() == [covered]


def test_draw_sample() -> None:
    cache = _cache(
        [(f"Cheddar {i}", CHEESE) for i in range(50)]
        + [(f"Vegan burger {i}", NO_MATCH) for i in range(20)]
        + [(f"Beef sausage {i}", PORK) for i in range(3)]
    )

    sample = draw_sample(cache, random_size=10, slice_cap=5)

    assert sample.columns.tolist() == ["product", *SLICES]
    assert sample["product"].is_unique
    assert sample["random"].sum() == 10
    # Every pork-rule product, though the meatball/sausage slice is capped below their count.
    assert sorted(sample.loc[sample[PORK_RULE], "product"]) == [
        f"Beef sausage {i}" for i in range(3)
    ]
    assert sample["plant_based"].sum() >= 5
    assert sample.equals(draw_sample(cache, random_size=10, slice_cap=5))


def _call(operation: LlmOperation, *, truncated: bool = False) -> LlmCall:
    return LlmCall(
        operation=operation,
        requested_model=SONNET,
        served_model=SONNET,
        requests=1,
        failed_requests=0,
        rate_limited_requests=0,
        truncated=truncated,
        input_tokens=1_000,
        cached_input_tokens=900,
        output_tokens=5,
    )


@dataclass(frozen=True)
class _ScriptedLlm:
    on_call: OnLlmCall
    match: str | ValueError

    def clean_product_name(self, item: str) -> str:
        self.on_call(_call("clean"))
        return item.lower()

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        self.on_call(_call("match", truncated=True))
        if isinstance(self.match, ValueError):
            raise self.match
        return self.match


def test_ask_sums_its_calls() -> None:
    assert ask(lambda on_call: _ScriptedLlm(on_call, BEEF), [BEEF], "Beef Mince") == Answer(
        product="Beef Mince",
        cleaned_name="beef mince",
        answer=BEEF,
        error="",
        calls=2,
        truncated_calls=1,
        input_tokens=2_000,
        cached_input_tokens=1_800,
        output_tokens=10,
    )


def test_ask_records_a_refusal() -> None:
    refusal = ValueError("Claude refused to answer")

    answer = ask(lambda on_call: _ScriptedLlm(on_call, refusal), [BEEF], "Beef Mince")

    assert (answer.cleaned_name, answer.answer, answer.error) == (
        "beef mince",
        "",
        "Claude refused to answer",
    )


def test_ask_runs_the_pipeline_calls_in_order() -> None:
    llm = KeywordLlmClient()

    answer = ask(lambda on_call: llm, [CHEESE], "CHEESE CHEDDAR 5LB")

    assert llm.calls == [("clean", "CHEESE CHEDDAR 5LB"), ("match", "cheese cheddar lb")]
    assert (answer.answer, answer.calls) == (CHEESE, 0)


def _answers(rows: Sequence[tuple[str, str, str]]) -> pd.DataFrame:
    """Each row `(product, answer, error)`, with every call costing the same."""
    return pd.DataFrame(
        [
            Answer(product, product.lower(), answer, error, 2, 0, 1_000_000, 0, 0)
            for product, answer, error in rows
        ]
    )


def test_score() -> None:
    cache = _cache(
        [
            ("Beef sausages", PORK),
            ("Cheddar", CHEESE),
            ("Ham", PORK),
            ("Whole Milk", MILK),
            ("Paper Towels", NO_MATCH),
        ]
    )
    sample = draw_sample(cache)
    answers = {
        HAIKU: _answers(
            [
                ("Beef sausages", BEEF, ""),
                ("Cheddar", "cheese.", ""),  # read ignoring case and punctuation
                ("Ham", POULTRY, ""),
                ("Whole Milk", "Dairy", ""),
                ("Paper Towels", "", "Claude returned no text"),
            ]
        ),
        # In another order than the sample's.
        SONNET: _answers(
            [
                ("Whole Milk", MILK, ""),
                ("Paper Towels", NO_MATCH, ""),
                ("Ham", PORK, ""),
                ("Cheddar", CHEESE, ""),
                ("Beef sausages", PORK, ""),
            ]
        ),
    }

    scores = score(sample, answers, cache)

    summary = scores.summary.set_index("model")
    assert summary.loc[HAIKU, ["accuracy_random", "accuracy_pork_rule"]].tolist() == [0.2, 0.0]
    assert summary.loc[SONNET, ["accuracy_random", "accuracy_pork_rule"]].tolist() == [1.0, 1.0]
    # 1M uncached input tokens per product, at $0.10 and $2 a million.
    assert summary[
        ["meat_swaps", "off_list", "errors", "truncated_calls", "usd_per_1000_products"]
    ].to_dict("index") == {
        HAIKU: {
            "meat_swaps": 2,
            "off_list": 1,
            "errors": 1,
            "truncated_calls": 0,
            "usd_per_1000_products": 100.0,
        },
        SONNET: {
            "meat_swaps": 0,
            "off_list": 0,
            "errors": 0,
            "truncated_calls": 0,
            "usd_per_1000_products": 2_000.0,
        },
    }
    assert scores.confusions.to_dict("records") == [
        {"model": HAIKU, "cache_category": MILK, "model_category": NO_MATCH, "products": 1},
        {"model": HAIKU, "cache_category": NO_MATCH, "model_category": "(error)", "products": 1},
        {"model": HAIKU, "cache_category": PORK, "model_category": BEEF, "products": 1},
        {"model": HAIKU, "cache_category": PORK, "model_category": POULTRY, "products": 1},
    ]
    assert scores.disagreements.to_dict("records") == [
        {
            "product": "Ham",
            "slices": "random",
            "cache_category": PORK,
            HAIKU: POULTRY,
            SONNET: PORK,
            "correct_category": "",
        },
        {
            "product": "Paper Towels",
            "slices": "random",
            "cache_category": NO_MATCH,
            HAIKU: "(error)",
            SONNET: NO_MATCH,
            "correct_category": "",
        },
        {
            "product": "Whole Milk",
            "slices": "random",
            "cache_category": MILK,
            HAIKU: "off-list: Dairy",
            SONNET: MILK,
            "correct_category": "",
        },
        {
            "product": "Beef sausages",
            "slices": "random, meatball_sausage, pork_rule",
            "cache_category": PORK,
            HAIKU: BEEF,
            SONNET: PORK,
            "correct_category": "",
        },
    ]


def test_score_refuses_a_product_gone_from_the_cache() -> None:
    sample = draw_sample(_cache([("Cheddar", CHEESE), ("Brie", CHEESE)]))

    with pytest.raises(ValueError, match="1 sampled products are no longer in the cache"):
        score(sample, {HAIKU: _answers([("Cheddar", CHEESE, "")])}, _cache([("Cheddar", CHEESE)]))


def test_score_refuses_answers_for_other_products() -> None:
    cache = _cache([("Cheddar", CHEESE), ("Brie", CHEESE)])

    with pytest.raises(ValueError, match="answers are not for the sampled products"):
        score(draw_sample(cache), {HAIKU: _answers([("Cheddar", CHEESE, "")])}, cache)


def test_score_run_reads_back_what_run_wrote(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache_path = tmp_path / "cache.csv"
    monkeypatch.setattr(product_cache, "categorization_cache_path", lambda: cache_path)
    cache = _cache([("Beef sausages", PORK), ("Cheddar", CHEESE)])
    cache.to_csv(cache_path, index=False)
    draw_sample(cache).to_csv(tmp_path / "sample.csv", index=False)
    (tmp_path / "answers").mkdir()
    _answers([("Beef sausages", BEEF, ""), ("Cheddar", CHEESE, "")]).to_csv(
        tmp_path / "answers" / f"{HAIKU}.csv", index=False
    )

    scores = model_eval._score_run(tmp_path)

    # The slice flags and token counts survive the round trip through CSV.
    assert scores.summary[["accuracy_pork_rule", "usd_per_1000_products"]].to_dict("records") == [
        {"accuracy_pork_rule": 0.0, "usd_per_1000_products": 100.0}
    ]
    assert (tmp_path / "report.md").read_text() == model_eval.render_report(
        draw_sample(cache), scores
    )


def _reviewed(rows: Sequence[tuple[str, str, str]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["product", "cache_category", "correct_category"])


def test_fixes_sql_refuses_a_category_off_the_list() -> None:
    with pytest.raises(ValueError, match=r"Not GBD categories: \['Beef'\]"):
        fixes_sql(_reviewed([("Beef sausages", PORK, "Beef")]))


def test_fixes_sql_refuses_a_review_with_nothing_to_fix() -> None:
    with pytest.raises(ValueError, match="No row has a correct_category"):
        fixes_sql(_reviewed([("Beef sausages", PORK, ""), ("Ham", PORK, PORK)]))


def test_fixes_sql_updates_only_the_verified_rows_still_wrong(
    test_database: psycopg.Connection,
) -> None:
    rows = [
        # product, category, is_verified
        ("eval-test Theo's Beef sausages", PORK, True),
        ("eval-test Hot Dog Beef", PORK, True),
        ("eval-test Ham", PORK, True),
        ("eval-test Beef Meatballs", BEEF, True),  # fixed since the review
        ("eval-test Beef Burger", PORK, False),
    ]
    with test_database.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO product_categorization (product, category, is_verified) "
            "VALUES (%s, %s, %s)",
            rows,
        )
    reviewed = _reviewed(
        [
            ("eval-test Theo's Beef sausages", PORK, BEEF),
            ("eval-test Hot Dog Beef", PORK, MILK),  # a quote in the category too
            ("eval-test Ham", PORK, ""),
            ("eval-test Beef Meatballs", PORK, BEEF),
            ("eval-test Beef Burger", PORK, BEEF),
        ]
    )

    with test_database.cursor() as cursor:
        returned = cursor.execute(fixes_sql(reviewed).encode()).fetchall()
        after = cursor.execute(
            "SELECT product, category FROM product_categorization "
            "WHERE product LIKE 'eval-test %' ORDER BY product"
        ).fetchall()

    assert sorted(returned) == [
        ("eval-test Hot Dog Beef", PORK, MILK),
        ("eval-test Theo's Beef sausages", PORK, BEEF),
    ]
    assert after == [
        ("eval-test Beef Burger", PORK),
        ("eval-test Beef Meatballs", BEEF),
        ("eval-test Ham", PORK),
        ("eval-test Hot Dog Beef", MILK),
        ("eval-test Theo's Beef sausages", BEEF),
    ]
