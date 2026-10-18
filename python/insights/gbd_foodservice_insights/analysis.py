"""The seam between `worker_child` and the analysis library. It takes a CSV and a form's
answers, and returns either a report, or one of three failure reasons.

Three properties keep this seam agnostic and are worth preserving:

1. **The library never sees the run directory, the contract's documents, or exit codes.** It is
   handed a CSV, an output directory, and the form's answers.
2. **`report_progress` is a plain no-argument callable with a no-op default**, so notebooks and
   the lab are unaffected. It carries no payload; the child's only use of it is to bump
   `sequence`. It is called after every LLM call, from whichever thread made it, so it must be
   thread-safe.
3. **`report_telemetry` is handed facts as they become known**, so a run that later fails or is
   killed has already reported what it spent and how far it got: each stage's summary and time
   as the stage finishes, and so before a later check raises. It too is called from any thread.
   `LlmCall`s come only from the LLM client `analyze()` builds: pass `llm=` and none are
   reported, though the summaries and stage times still are.
"""

import time
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import matplotlib
import pandas as pd

# Before the report modules import pyplot: the child has no display, and on macOS the default
# backend would try to open a window.
matplotlib.use("Agg")

from gbd_foodservice_insights.categorization.cache import (
    CachedCategorization as CachedCategorization,
)
from gbd_foodservice_insights.categorization.cache import CategorizationCache
from gbd_foodservice_insights.categorization.llm import LlmCall as LlmCall
from gbd_foodservice_insights.categorization.llm import LlmClient, OpenAiLlmClient
from gbd_foodservice_insights.categorization.llm import LlmOperation as LlmOperation
from gbd_foodservice_insights.categorization.llm import cost_micro_usd as cost_micro_usd
from gbd_foodservice_insights.categorization.pipeline import (
    CategorizationSummary as CategorizationSummary,
)
from gbd_foodservice_insights.categorization.pipeline import (
    NewCategorization as NewCategorization,
)
from gbd_foodservice_insights.categorization.pipeline import (
    categorize_unique_products,
    summarize_categorization,
)
from gbd_foodservice_insights.categorization.steps import merge_categorizations
from gbd_foodservice_insights.errors import AnalysisError as AnalysisError
from gbd_foodservice_insights.errors import InvalidInputError as InvalidInputError
from gbd_foodservice_insights.errors import UnusableDataError as UnusableDataError
from gbd_foodservice_insights.errors import UpstreamApiError as UpstreamApiError
from gbd_foodservice_insights.input_csv import read_input_csv
from gbd_foodservice_insights.report.excel import write_client_workbook
from gbd_foodservice_insights.report.food_report import FindingCount as FindingCount
from gbd_foodservice_insights.report.food_report import ReportSummary as ReportSummary
from gbd_foodservice_insights.report.food_report import (
    build_food_report,
    build_report_charts,
    summarize_report,
)
from gbd_foodservice_insights.report.pdf import write_report_pdf
from gbd_foodservice_insights.report.quality import ListedFinding as ListedFinding
from gbd_foodservice_insights.report.quality import listed_findings
from gbd_foodservice_insights.report.schema import DinerOrMeal, Headcounts

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]
Stage = Literal["read", "categorize", "report", "pdf", "xlsx"]


@dataclass(frozen=True)
class InputSummary:
    """The upload's size, and the size of the categorization cache it is matched against."""

    rows: int
    kilograms: float
    unique_products: int  # after stripping, as categorization matches them
    # Every entry in the cache, not only those this upload matches. Size alone says nothing of
    # coverage — `CategorizationSummary` counts the hits — but 0 means every product goes to the
    # LLM.
    categorization_cache_entries: int


@dataclass(frozen=True)
class StageFinished:
    stage: Stage
    duration_ms: int


type ReportProgress = Callable[[], None]
type Telemetry = LlmCall | InputSummary | CategorizationSummary | ReportSummary | StageFinished
type ReportTelemetry = Callable[[Telemetry], None]


@dataclass(frozen=True)
class MonthlyCounts:
    basis: CountsBasis
    monthly: Mapping[str, int]  # "YYYY-MM" -> diners or meals


@dataclass(frozen=True)
class AnalysisRequest:
    run_id: str  # opaque; log correlation only
    input_csv: Path  # product,date,weight — UTF-8, ISO dates, plain numbers
    output_directory: Path  # where to write the pdf and xlsx
    report_name: str | None
    site_name: str | None
    organization_name: str
    counts: MonthlyCounts | None  # `None` when the uploader chose not to give counts
    unit_system: UnitSystem
    categorization_cache: tuple[CachedCategorization, ...]


@dataclass(frozen=True)
class AnalysisOutcome:
    pdf: Path
    xlsx: Path
    # The products the LLM categorized, for the worker to suggest to the cache.
    new_categorizations: tuple[NewCategorization, ...] = ()
    # The findings the PDF lists, for the report page to show too.
    findings: tuple[ListedFinding, ...] = ()


LB_TO_KG: Final = 0.45359237
_DINER_OR_MEAL: Final[Mapping[CountsBasis, DinerOrMeal]] = {"people": "diner", "meals": "meal"}


def _ignore() -> None:
    pass


def _ignore_telemetry(telemetry: Telemetry) -> None:
    pass


def analyze(
    request: AnalysisRequest,
    *,
    report_progress: ReportProgress = _ignore,
    report_telemetry: ReportTelemetry = _ignore_telemetry,
    llm: LlmClient | None = None,
) -> AnalysisOutcome:
    """`llm` defaults to `OpenAiLlmClient.from_env()`, which raises when `OPENAI_API_KEY` is
    unset — a deployment bug, so deliberately not an `AnalysisError`."""
    llm = _ReportingLlmClient(
        llm if llm is not None else OpenAiLlmClient.from_env(on_call=report_telemetry),
        report_progress,
    )
    with _stage("read", report_telemetry):
        df = read_input_csv(request.input_csv)
        if request.unit_system == "lb":
            df = df.assign(weight=df["weight"] * LB_TO_KG)
        cache = CategorizationCache.from_rows(request.categorization_cache)
    report_telemetry(_summarize_input(df, cache))

    with _stage("categorize", report_telemetry):
        categorized = categorize_unique_products(df, llm, cache)
    report_telemetry(summarize_categorization(categorized))

    with _stage("report", report_telemetry):
        df_final = merge_categorizations(categorized.cleaned_df, categorized.unique_products_df)
        rows = df_final.rename(columns={"weight": "kilos_total"})[
            ["date", "product", "category", "kilos_total"]
        ].reset_index(drop=True)
        report = build_food_report(
            rows,
            headcounts=None if request.counts is None else _headcounts(request.counts),
            region="us",
            top_n_drivers=5,
            report_progress=report_progress,
        )
        report_telemetry(summarize_report(report))

    with _stage("pdf", report_telemetry):
        report_progress()
        pdf_path = request.output_directory / "report.pdf"
        with build_report_charts(report) as charts:
            report_progress()
            write_report_pdf(
                report,
                charts,
                pdf_path,
                client_name=_title(request),
                show_quality_successes=False,
            )

    with _stage("xlsx", report_telemetry):
        report_progress()
        xlsx_path = request.output_directory / "report.xlsx"
        write_client_workbook(report, xlsx_path)

    return AnalysisOutcome(
        pdf=pdf_path,
        xlsx=xlsx_path,
        new_categorizations=categorized.new_categorizations,
        findings=listed_findings(report.findings, show_successes=False),
    )


@contextmanager
def _stage(stage: Stage, report_telemetry: ReportTelemetry) -> Generator[None]:
    """Reports the stage's time only when it finishes, so a failed stage reports none."""
    start = time.monotonic()
    yield
    report_telemetry(StageFinished(stage, duration_ms=round((time.monotonic() - start) * 1000)))


def _headcounts(counts: MonthlyCounts) -> Headcounts:
    # A `PeriodIndex` rather than `pd.Period(month)` per key, which pandas' stubs type as
    # possibly `NaT`.
    months = pd.PeriodIndex(list(counts.monthly), freq="M")
    return Headcounts(
        _DINER_OR_MEAL[counts.basis],
        {month: float(count) for month, count in zip(months, counts.monthly.values(), strict=True)},
    )


def _summarize_input(df: pd.DataFrame, cache: CategorizationCache) -> InputSummary:
    return InputSummary(
        rows=len(df),
        kilograms=float(df["weight"].sum()),
        # Stripped as `categorize_unique_products` strips, so the match types sum to this.
        unique_products=df["product"].str.strip().nunique(),
        categorization_cache_entries=len(cache.products),
    )


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
