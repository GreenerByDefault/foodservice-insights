"""
Model Eval
==========

Scores each model in `MODELS` against the verified product cache, end to end: clean the name, then
match it, as the pipeline does for a cache miss. Nothing is looked up in the cache, since the cache
is the answer key.

The cache is not perfect gold, so a disagreement is not always the model's error:

    uv run python -m gbd_foodservice_insights_lab.categorization.model_eval run [--models ...]
    # A reviewer fills `correct_category` in DIR/disagreements.csv where the cache is wrong.
    uv run python -m gbd_foodservice_insights_lab.categorization.model_eval fixes \
        DIR/disagreements.csv
    # Run the printed SQL in Supabase Studio, then `just pull-caches`.
    uv run python -m gbd_foodservice_insights_lab.categorization.model_eval score DIR

`score` re-scores the answers already in DIR against the re-pulled cache, so adjudicating costs
nothing; it rewrites only `report.md`. Every other file in DIR names products, so DIR is under the
gitignored `client_work/`; only `report.md`, which holds aggregate numbers alone, belongs in a PR.
"""

import argparse
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

import pandas as pd
from dotenv import find_dotenv, load_dotenv
from gbd_foodservice_insights.categories import categories, category_names
from gbd_foodservice_insights.categorization.cache import NO_MATCHES_FOUND, normalize_product_name
from gbd_foodservice_insights.categorization.llm import (
    MODELS,
    AnthropicLlmClient,
    LlmCall,
    LlmClient,
    OnLlmCall,
    cost_micro_usd,
)
from gbd_foodservice_insights.utils import map_concurrently
from psycopg import sql

from gbd_foodservice_insights_lab import PACKAGE_DIR
from gbd_foodservice_insights_lab.categorization.product_cache import (
    read_categorization_cache_csv,
)

logger = logging.getLogger(__name__)

RUNS_DIR: Final = PACKAGE_DIR.parent / "client_work" / "model_eval"
SEED: Final = 20261110
RANDOM_SIZE: Final = 400
SLICE_CAP: Final = 100

# Kinds of product that take judgment, matched case-insensitively against the product name.
HARD_SLICES: Final[Mapping[str, str]] = {
    "kosher_halal": r"\b(?:kosher|halal)\b",
    "meatball_sausage": r"meatball|sausage|hot ?dog|frankfurter",
    "plant_based": r"\bvegan\b|plant.?based|quorn",
    "soup": r"\bsoups?\b",
    "texture_modified": r"\blevel ?[3-7]\b|pur[eé]e",
}
# A meatball, sausage or the like that names another meat, or Halal or Kosher, and no pork: where
# the match prompt's default of Pork for these should not apply, and every model has sometimes
# applied it anyway. Every one is sampled.
PORK_RULE: Final = "pork_rule"
_PORK_RULE_PRODUCTS: Final = r"meatball|sausage|hot ?dog|frankfurter|pepperoni|meat ?loaf|salami"
_NAMES_OTHER_MEAT: Final = (
    r"\b(?:beef|chicken|turkey|lamb|mutton|veal|venison|bison|buffalo|duck|halal|kosher)\b"
)
_NAMES_PORK: Final = r"\bpork|\bham\b|bacon|gammon|\bpig\b|non.?halal"
SLICES: Final = ("random", *HARD_SLICES, PORK_RULE)

ERROR: Final = "(error)"
OFF_LIST: Final = "off-list: "
_TOP_CONFUSIONS: Final = 10


def slice_flags(products: pd.Series) -> pd.DataFrame:
    """Whether each product falls in each hard slice and in `PORK_RULE`."""
    flags = {
        name: products.str.contains(pattern, case=False) for name, pattern in HARD_SLICES.items()
    }
    flags[PORK_RULE] = (
        products.str.contains(_PORK_RULE_PRODUCTS, case=False)
        & products.str.contains(_NAMES_OTHER_MEAT, case=False)
        & ~products.str.contains(_NAMES_PORK, case=False)
    )
    return pd.DataFrame(flags, index=products.index)


def draw_sample(
    cache: pd.DataFrame,
    *,
    seed: int = SEED,
    random_size: int = RANDOM_SIZE,
    slice_cap: int = SLICE_CAP,
) -> pd.DataFrame:
    """`product` and a column per `SLICES`: `random_size` random rows, up to `slice_cap` of each
    hard slice, and every `PORK_RULE` row. A row drawn for one slice still counts in every
    slice it falls in."""
    flags = slice_flags(cache["product"])
    random_rows = cache.sample(n=min(random_size, len(cache)), random_state=seed).index
    hard_rows = [
        flags.loc[flags[name]].sample(n=min(slice_cap, int(flags[name].sum())), random_state=seed)
        for name in HARD_SLICES
    ]
    chosen = pd.Index(
        sorted(
            set(random_rows).union(
                flags.index[flags[PORK_RULE]], *(rows.index for rows in hard_rows)
            )
        )
    )
    sample = pd.concat(
        [
            cache.loc[chosen, ["product"]],
            pd.Series(chosen.isin(random_rows), index=chosen, name="random"),
            flags.loc[chosen],
        ],
        axis="columns",
    )
    logger.info("Sampled %d products: %s", len(sample), sample[list(SLICES)].sum().to_dict())
    return sample.reset_index(drop=True)


@dataclass(frozen=True)
class Answer:
    product: str
    cleaned_name: str
    answer: str  # the match call's text, as Claude wrote it
    error: str  # why Claude gave no answer, or ""
    calls: int
    truncated_calls: int
    input_tokens: int  # cached included
    cached_input_tokens: int
    output_tokens: int


def ask(
    make_llm: Callable[[OnLlmCall], LlmClient], categories: Sequence[str], product: str
) -> Answer:
    calls: list[LlmCall] = []
    llm = make_llm(calls.append)
    cleaned_name = answer = error = ""
    try:
        cleaned_name = llm.clean_product_name(product)
        answer = llm.match_product_to_category(cleaned_name, categories)
    # A refusal or an empty answer: a failed run in the product, but a result to count here.
    except ValueError as err:
        error = str(err)
    return Answer(
        product=product,
        cleaned_name=cleaned_name,
        answer=answer,
        error=error,
        calls=len(calls),
        truncated_calls=sum(call.truncated for call in calls),
        input_tokens=sum(call.input_tokens for call in calls),
        cached_input_tokens=sum(call.cached_input_tokens for call in calls),
        output_tokens=sum(call.output_tokens for call in calls),
    )


def answer_all(
    make_llm: Callable[[OnLlmCall], LlmClient], products: Sequence[str], *, concurrency: int
) -> pd.DataFrame:
    """One row per product, with `Answer`'s fields as columns."""
    names = category_names()
    answers = map_concurrently(
        lambda product: ask(make_llm, names, product),
        products,
        max_workers=concurrency,
        progress_prefix="Model eval",
    )
    return pd.DataFrame(answers, columns=list(Answer.__dataclass_fields__))


def _judge(answers: pd.DataFrame) -> pd.DataFrame:
    """`predicted`, each answer as the pipeline reads it: a category, matched ignoring case and
    punctuation, else "No Matches Found", or `ERROR` where Claude gave no answer. `shown`, the
    same, but with an off-list answer as Claude wrote it."""
    canonical = {
        normalize_product_name(name): name for name in [*category_names(), NO_MATCHES_FOUND]
    }
    recognized = answers["answer"].map(normalize_product_name).map(canonical)
    answered = answers["error"] == ""
    off_list = answered & recognized.isna()
    predicted = recognized.fillna(NO_MATCHES_FOUND).where(answered, ERROR)
    return pd.DataFrame(
        {
            "predicted": predicted,
            "off_list": off_list,
            "shown": predicted.where(~off_list, OFF_LIST + answers["answer"]),
        }
    )


@dataclass(frozen=True)
class Scores:
    summary: pd.DataFrame  # a row per model
    confusions: pd.DataFrame  # model, cache_category, model_category, products
    disagreements: pd.DataFrame  # a row per product some model got wrong, for a reviewer


def score(sample: pd.DataFrame, answers: Mapping[str, pd.DataFrame], cache: pd.DataFrame) -> Scores:
    """`answers` maps a model to `answer_all`'s frame for `sample`'s products. Each answer is
    scored against the category `cache` has for its product now."""
    truth = sample.merge(cache[["product", "category"]], on="product", how="left", validate="1:1")
    missing = int(truth["category"].isna().sum())
    if missing:
        raise ValueError(f"{missing} sampled products are no longer in the cache")
    meat = {category.name for category in categories() if category.meat}

    summaries = []
    confusions = []
    shown = {}
    for model, frame in answers.items():
        if sorted(frame["product"]) != sorted(truth["product"]):
            raise ValueError(f"{model}'s answers are not for the sampled products")
        frame = frame.set_index("product").loc[truth["product"]].reset_index()
        judged = _judge(frame)
        predicted = judged["predicted"]
        correct = predicted == truth["category"]
        shown[model] = judged["shown"]
        cost = cost_micro_usd(
            model,
            input_tokens=int(frame["input_tokens"].sum()),
            cached_input_tokens=int(frame["cached_input_tokens"].sum()),
            output_tokens=int(frame["output_tokens"].sum()),
        )
        summaries.append(
            {
                "model": model,
                **{f"accuracy_{name}": correct[truth[name]].mean() for name in SLICES},
                "accuracy_all": correct.mean(),
                "meat_swaps": int(
                    (truth["category"].isin(meat) & predicted.isin(meat) & ~correct).sum()
                ),
                "off_list": int(judged["off_list"].sum()),
                "errors": int((predicted == ERROR).sum()),
                "truncated_calls": int(frame["truncated_calls"].sum()),
                "usd_per_1000_products": cost / len(frame) / 1_000,
            }
        )
        wrong = pd.DataFrame(
            {"cache_category": truth["category"], "model_category": predicted}
        ).loc[~correct]
        top = (
            wrong.value_counts()
            .rename("products")
            .reset_index()
            .sort_values(
                ["products", "cache_category", "model_category"], ascending=[False, True, True]
            )
            .head(_TOP_CONFUSIONS)
        )
        confusions.append(top.assign(model=model))

    shown_frame = pd.DataFrame(shown)
    disagreements = pd.concat(
        [
            truth["product"],
            truth[list(SLICES)]
            .apply(lambda flags: ", ".join(flags.index[flags]), axis="columns")
            .rename("slices"),
            truth["category"].rename("cache_category"),
            shown_frame,
        ],
        axis="columns",
    ).loc[shown_frame.ne(truth["category"], axis="index").any(axis="columns")]
    return Scores(
        summary=pd.DataFrame(summaries),
        confusions=pd.concat(confusions, ignore_index=True)[
            ["model", "cache_category", "model_category", "products"]
        ],
        disagreements=disagreements.assign(correct_category="")
        .sort_values(["slices", "product"])
        .reset_index(drop=True),
    )


def _markdown_table(frame: pd.DataFrame) -> str:
    lines = [list(frame.columns), ["---"] * len(frame.columns), *frame.to_numpy().tolist()]
    return "\n".join("| " + " | ".join(map(str, line)) + " |" for line in lines)


def render_report(sample: pd.DataFrame, scores: Scores) -> str:
    """Aggregate numbers alone, with no product named, so it can go in a PR."""
    summary = scores.summary.set_index("model")
    sizes = {name: int(sample[name].sum()) for name in SLICES}
    table = (
        pd.DataFrame(
            {
                **{
                    f"Accuracy, {name} ({sizes[name]})": summary[f"accuracy_{name}"].map(
                        "{:.1%}".format
                    )
                    for name in SLICES
                },
                f"Accuracy, all sampled ({len(sample)})": summary["accuracy_all"].map(
                    "{:.1%}".format
                ),
                "Meat swapped for another meat": summary["meat_swaps"],
                "Off-list answers": summary["off_list"],
                "Refused or empty": summary["errors"],
                "Truncated calls": summary["truncated_calls"],
                "USD per 1,000 products": summary["usd_per_1000_products"].map("${:.2f}".format),
            }
        )
        .T.rename_axis("")
        .reset_index()
    )
    return (
        "\n\n".join(
            [
                "# Model eval",
                "Scored against the verified cache. Only the random rows estimate accuracy on real "
                "uploads; the slices oversample the hard cases.",
                _markdown_table(table),
                "## Top confusions (cache → model)",
                _markdown_table(scores.confusions),
            ]
        )
        + "\n"
    )


def fixes_sql(reviewed: pd.DataFrame) -> str:
    """One UPDATE, for Supabase Studio's SQL editor, of every row whose `correct_category` a
    reviewer filled with something other than its `cache_category`."""
    fixes = reviewed.loc[
        (reviewed["correct_category"] != "")
        & (reviewed["correct_category"] != reviewed["cache_category"])
    ]
    if fixes.empty:
        raise ValueError("No row has a correct_category other than its cache_category")
    unknown = sorted(set(fixes["correct_category"]) - {*category_names(), NO_MATCHES_FOUND})
    if unknown:
        raise ValueError(f"Not GBD categories: {unknown}")

    def literal(value: str) -> str:
        return sql.Literal(value).as_string().strip()

    values = ",\n".join(
        f"  ({literal(product)}, {literal(old)}, {literal(new)})"
        for product, old, new in fixes[
            ["product", "cache_category", "correct_category"]
        ].itertuples(index=False)
    )
    # Matching the old category too makes it safe to run twice, and leaves alone a row someone
    # has corrected since.
    return f"""\
-- Expect {len(fixes)} rows back. Fewer means some were already fixed, or changed since.
UPDATE public.product_categorization AS p
SET category = fix.new_category
FROM (VALUES
{values}
) AS fix (product, old_category, new_category)
WHERE p.product = fix.product AND p.category = fix.old_category AND p.is_verified
RETURNING p.product, fix.old_category, p.category AS new_category;
"""


def _read_text_csv(path: Path) -> pd.DataFrame:
    # Every cell a `str`, so a product named `NA` stays one.
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def _read_answers(path: Path) -> pd.DataFrame:
    counts = [name for name, field in Answer.__dataclass_fields__.items() if field.type is int]
    return _read_text_csv(path).astype(dict.fromkeys(counts, int))


def _score_run(run_dir: Path) -> Scores:
    """Scores the answers in `run_dir` against the pulled cache, and rewrites its report."""
    sample = _read_text_csv(run_dir / "sample.csv")
    # Not `astype(bool)`, which reads "False" as True.
    sample[list(SLICES)] = sample[list(SLICES)] == "True"
    answers = {
        path.stem: _read_answers(path) for path in sorted((run_dir / "answers").glob("*.csv"))
    }
    scores = score(sample, answers, read_categorization_cache_csv())
    report = render_report(sample, scores)
    (run_dir / "report.md").write_text(report)
    print(report)
    return scores


def _run(models: Sequence[str], concurrency: int) -> None:
    llm = AnthropicLlmClient.from_env()
    cache = read_categorization_cache_csv()
    if cache.empty:
        raise ValueError("No cache to score against; run `just pull-caches` first.")
    run_dir = RUNS_DIR / datetime.now(UTC).strftime("%Y-%m-%dT%H%M%SZ")
    (run_dir / "answers").mkdir(parents=True)
    sample = draw_sample(cache)
    sample.to_csv(run_dir / "sample.csv", index=False)

    for model in models:
        logger.info("Asking %s about %d products.", model, len(sample))
        answer_all(
            lambda on_call, model=model: replace(llm, model=model, on_call=on_call),
            sample["product"].tolist(),
            concurrency=concurrency,
        ).to_csv(run_dir / "answers" / f"{model}.csv", index=False)

    disagreements_path = run_dir / "disagreements.csv"
    disagreements = _score_run(run_dir).disagreements
    disagreements.to_csv(disagreements_path, index=False)
    logger.info("%d disagreements are in %s.", len(disagreements), disagreements_path)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s  %(name)s  %(levelname)s  %(message)s"
    )
    # The SDK's HTTP client logs an INFO line per request, which buries progress across thousands
    # of calls.
    logging.getLogger("httpx2").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Sample the cache, ask each model, and score them.")
    run.add_argument("--models", nargs="+", choices=list(MODELS), default=list(MODELS))
    run.add_argument("--concurrency", type=int, default=8)
    rescore = commands.add_parser("score", help="Re-score a run against the pulled cache.")
    rescore.add_argument("run_dir", type=Path)
    fixes = commands.add_parser("fixes", help="Print SQL applying a reviewed disagreements.csv.")
    fixes.add_argument("reviewed_csv", type=Path)
    args = parser.parse_args()

    load_dotenv(find_dotenv(usecwd=True))
    match args.command:
        case "run":
            _run(args.models, args.concurrency)
        case "score":
            _score_run(args.run_dir)
        case "fixes":
            print(fixes_sql(_read_text_csv(args.reviewed_csv)), end="")


if __name__ == "__main__":
    main()
