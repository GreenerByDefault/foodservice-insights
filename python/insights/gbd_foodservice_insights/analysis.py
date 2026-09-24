"""The seam between `worker_child` and the analysis library. It takes a CSV and a form's
answers, and returns either a report, or one of three failure reasons.

Two properties keep this seam agnostic and are worth preserving:

1. **The library never sees the run directory, the contract's documents, or exit codes.** It is
   handed a CSV, a scratch directory, an output directory, and the form's answers.
2. **`report_progress` is a plain no-argument callable with a no-op default**, so notebooks and
   the lab are unaffected. It carries no payload; the child's only use of it is to bump
   `sequence`.

**Open:** the categorization cache becomes a Postgres table with a human-approved flag; the parent
materializes it into the run directory per run, and the child reports new values back through the
contract. `AnalysisRequest` is where the cache will arrive. Until then the library's cache is
read-only.

**Open:** AI usage (model, tokens, cost) is dropped from this seam for now — REQUIREMENTS.md
§ Persistence. `OpenAiLlmClient` is where token counts would be collected: each `_complete` call
sees the response's `usage`.

**Open:** structured result metadata (rows in, rows categorized, products uncategorized, ...) is
dropped from this seam for the same reason — REQUIREMENTS.md § Persistence. `categorize_products`
already returns it as its `summary` dict (`n_rows_before`, `n_products_after`,
`row_elimination_details`, `match_type_counts`, ...); `AnalysisOutcome` is where it would arrive.
"""

import json
import re
import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import matplotlib

# Before the report modules import pyplot: the child has no display, and on macOS the default
# backend would try to open a window.
matplotlib.use("Agg")

import numpy as np
import pandas as pd

from gbd_foodservice_insights.categorization.cache import get_previously_categorized_items
from gbd_foodservice_insights.categorization.llm import LlmClient, OpenAiLlmClient
from gbd_foodservice_insights.categorization.pipeline import categorize_products
from gbd_foodservice_insights.errors import AnalysisError as AnalysisError
from gbd_foodservice_insights.errors import InvalidInputError as InvalidInputError
from gbd_foodservice_insights.errors import UnusableDataError as UnusableDataError
from gbd_foodservice_insights.errors import UpstreamApiError as UpstreamApiError
from gbd_foodservice_insights.report.pipeline import run_food_report

type ReportProgress = Callable[[], None]

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]


@dataclass(frozen=True)
class AnalysisRequest:
    run_id: str  # opaque; log correlation only
    input_csv: Path  # product,date,weight — UTF-8, ISO dates, plain numbers
    output_directory: Path  # where to write the pdf and xlsx
    work_directory: Path  # scratch; discarded after the run
    report_name: str | None
    site_name: str | None
    organization_name: str
    counts_basis: CountsBasis
    unit_system: UnitSystem
    monthly_counts: Mapping[str, int]  # "YYYY-MM" -> diners or meals


@dataclass(frozen=True)
class AnalysisOutcome:
    pdf: Path
    xlsx: Path


LB_TO_KG: Final = 0.45359237

# What `apps/web` promises `input.csv` holds — `contract/contract.json` § inputCsv.
INPUT_COLUMNS: Final = ("product", "date", "weight")
_ISO_DATE: Final = re.compile(r"\d{4}-\d{2}-\d{2}")


def _ignore() -> None:
    pass


def analyze(
    request: AnalysisRequest,
    *,
    report_progress: ReportProgress = _ignore,
    llm: LlmClient | None = None,
) -> AnalysisOutcome:
    """`llm` defaults to `OpenAiLlmClient.from_env()`, which raises when `OPENAI_API_KEY` is
    unset — a deployment bug, so deliberately not an `AnalysisError`."""
    llm = _ReportingLlmClient(
        llm if llm is not None else OpenAiLlmClient.from_env(), report_progress
    )
    df = _read_input_csv(request.input_csv)
    if request.unit_system == "lb":
        df = df.assign(weight=df["weight"] * LB_TO_KG)

    df_final, _summary, _ai_review_df = categorize_products(
        df,
        llm,
        historical_categorizations=get_previously_categorized_items(),
        cache_write_mode="none",
        dayfirst_preference=False,
    )

    # `run_food_report` reads its input from a file and reads `client_metadata.json` from beside
    # it; it also writes graphs, a QA workbook, a manifest and a log. `work_directory` is
    # discarded, so all of that happens there and only the two deliverables are moved out.
    report_input = request.work_directory / "categorized_report.csv"
    df_final.rename(columns={"weight": "kilos_total"})[
        ["date", "product", "category", "kilos_total"]
    ].to_csv(report_input, index=False)
    (request.work_directory / "client_metadata.json").write_text(
        json.dumps(
            {
                "client": _title(request),
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
            }
        ),
        encoding="utf-8",
    )
    result = run_food_report(
        input_file=report_input,
        # A `dict`, not the `Mapping`: the library checks `isinstance(x, dict)`.
        diner_meal_mapping=dict(request.monthly_counts),
        output_dir=request.work_directory / "report",
        procurement_serving="procurement",
        diner_or_meal={"people": "diner", "meals": "meal"}[request.counts_basis],
        region="us",
        missing_data_policy="warn_continue",
        show_quality_successes=False,
        report_progress=report_progress,
    )
    return AnalysisOutcome(
        pdf=_move(result["pdf_path"], request.output_directory / "report.pdf"),
        xlsx=_move(result["client_excel_path"], request.output_directory / "report.xlsx"),
    )


def _read_input_csv(path: Path) -> pd.DataFrame:
    """Checks every promise `input.csv` makes, since a broken one is a validation hole in
    `apps/web`, not bad customer data. Past this point, a `ValueError` from the library is
    our bug."""
    try:
        # Every cell as text, so a product named "NA" or "null" stays a product.
        raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8")
    except (UnicodeDecodeError, pd.errors.ParserError, pd.errors.EmptyDataError) as err:
        raise InvalidInputError(f"input.csv is not a readable UTF-8 CSV: {err}") from err

    if tuple(raw.columns) != INPUT_COLUMNS:
        raise InvalidInputError(
            f"input.csv has columns {list(raw.columns)}, expected {list(INPUT_COLUMNS)}"
        )
    if raw.empty:
        raise InvalidInputError("input.csv has no rows")

    _require(raw["product"].str.strip() != "", raw, "product", "an empty product")

    iso_shaped = raw["date"].str.fullmatch(_ISO_DATE)
    dates = pd.to_datetime(raw["date"].where(iso_shaped), format="%Y-%m-%d", errors="coerce")
    _require(dates.notna(), raw, "date", "a date that is not YYYY-MM-DD")

    weights = pd.to_numeric(raw["weight"], errors="coerce")
    _require(
        np.isfinite(weights) & (weights >= 0),
        raw,
        "weight",
        "a weight that is not a non-negative number",
    )

    return pd.DataFrame({"product": raw["product"], "date": dates, "weight": weights})


def _require(valid: pd.Series, raw: pd.DataFrame, column: str, problem: str) -> None:
    if valid.all():
        return
    first = int((~valid).to_numpy().argmax())
    # +2: one for the header line, one because file lines count from 1.
    raise InvalidInputError(
        f"input.csv line {first + 2} has {problem}: {raw[column].iloc[first]!r} "
        f"({int((~valid).sum())} such rows)"
    )


def _title(request: AnalysisRequest) -> str:
    if not request.site_name:
        return request.organization_name
    return f"{request.organization_name} — {request.site_name}"


def _move(source: str | Path, destination: Path) -> Path:
    return Path(shutil.move(source, destination))


@dataclass(frozen=True)
class _ReportingLlmClient:
    """Reports progress after every LLM call, so the categorization loops need not know about
    progress: a long run of calls is the stretch where the parent most needs a heartbeat."""

    llm: LlmClient
    report_progress: ReportProgress

    def clean_product_name(self, item: str) -> str:
        cleaned = self.llm.clean_product_name(item)
        self.report_progress()
        return cleaned

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        category = self.llm.match_product_to_category(item, categories)
        self.report_progress()
        return category

    def fuzzy_match_category(self, item: str, categories: Sequence[str]) -> str:
        category = self.llm.fuzzy_match_category(item, categories)
        self.report_progress()
        return category
