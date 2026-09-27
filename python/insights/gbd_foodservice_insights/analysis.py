"""The seam between `worker_child` and the analysis library. It takes a CSV and a form's
answers, and returns either a report, or one of three failure reasons.

Two properties keep this seam agnostic and are worth preserving:

1. **The library never sees the run directory, the contract's documents, or exit codes.** It is
   handed a CSV, an output directory, and the form's answers.
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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import matplotlib

# Before the report modules import pyplot: the child has no display, and on macOS the default
# backend would try to open a window.
matplotlib.use("Agg")

from gbd_foodservice_insights.categorization.cache import get_previously_categorized_items
from gbd_foodservice_insights.categorization.llm import LlmClient, OpenAiLlmClient
from gbd_foodservice_insights.categorization.pipeline import categorize_products
from gbd_foodservice_insights.errors import AnalysisError as AnalysisError
from gbd_foodservice_insights.errors import InvalidInputError as InvalidInputError
from gbd_foodservice_insights.errors import UnusableDataError as UnusableDataError
from gbd_foodservice_insights.errors import UpstreamApiError as UpstreamApiError
from gbd_foodservice_insights.input_csv import read_input_csv
from gbd_foodservice_insights.report.excel import write_client_workbook
from gbd_foodservice_insights.report.food_report import build_food_report, build_report_charts
from gbd_foodservice_insights.report.pdf import write_report_pdf
from gbd_foodservice_insights.report.schema import DinerOrMeal

type ReportProgress = Callable[[], None]

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]


@dataclass(frozen=True)
class AnalysisRequest:
    run_id: str  # opaque; log correlation only
    input_csv: Path  # product,date,weight — UTF-8, ISO dates, plain numbers
    output_directory: Path  # where to write the pdf and xlsx
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
_DINER_OR_MEAL: Final[Mapping[CountsBasis, DinerOrMeal]] = {"people": "diner", "meals": "meal"}


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
    df = read_input_csv(request.input_csv)
    if request.unit_system == "lb":
        df = df.assign(weight=df["weight"] * LB_TO_KG)

    df_final, _summary, _ai_review_df = categorize_products(
        df,
        llm,
        historical_categorizations=get_previously_categorized_items(),
        cache_write_mode="none",
        dayfirst_preference=False,
    )

    rows = df_final.rename(columns={"weight": "kilos_total"})[
        ["date", "product", "category", "kilos_total"]
    ].reset_index(drop=True)
    report = build_food_report(
        rows,
        diner_meal_mapping=request.monthly_counts,
        mode="procurement",
        region="us",
        diner_or_meal=_DINER_OR_MEAL[request.counts_basis],
        top_n_drivers=5,
        report_progress=report_progress,
    )

    report_progress()
    pdf_path = request.output_directory / "report.pdf"
    with build_report_charts(report) as charts:
        report_progress()
        write_report_pdf(
            report,
            charts,
            pdf_path,
            client_name=_title(request),
            baseline_pilot="baseline",
            show_quality_successes=False,
        )

    report_progress()
    xlsx_path = request.output_directory / "report.xlsx"
    write_client_workbook(report, xlsx_path)

    return AnalysisOutcome(pdf=pdf_path, xlsx=xlsx_path)


def _title(request: AnalysisRequest) -> str:
    if not request.site_name:
        return request.organization_name
    return f"{request.organization_name} — {request.site_name}"


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
