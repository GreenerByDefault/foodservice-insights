"""The seam between `worker_child` and the analysis library: a CSV and a form's answers in,
a report and its cost in, or one of three reasons out.

Four properties keep this seam agnostic and worth preserving as the library is ported in:

1. **The library never sees the run directory, the contract's documents, or exit codes.** It is
   handed a CSV, a scratch directory, an artifacts directory, and the form's answers.
2. **`report_progress` is a plain callable with a no-op default**, so notebooks and the lab are
   unaffected. It carries a stage string for the log line; the child throws that away and writes
   only `sequence`. *Rejected: a `logging.Handler` on `greener_by_default.foodservice_insights` as
   the progress seam* — it already emits 15 stages, so this is tempting, but it couples liveness to
   log-message formatting and cannot tell "made progress" from "logged a warning".
3. **The library names its own charts**; the wrapper maps keys to contract filenames. The library
   must not know `chart-{key}.png`.
4. **AI usage is the library's to report** — it makes the calls. The real library tracks *no*
   tokens or cost today, and uses three models (`gpt-4.1-mini`, Gemini Flash, Gemini Pro) against a
   contract with one `ai.model` field: the primary model goes in `model`, the breakdown in
   `metadata`. This is a real gap the port must fill.

**Open:** the categorization cache becomes a Postgres table with a human-approved flag; the parent
materializes it into the run directory per run, and the child reports new values back through the
contract. `AnalysisRequest` is where the cache will arrive. Until then the library's cache is
read-only.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

type ReportProgress = Callable[[str], None]

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]


@dataclass(frozen=True)
class AnalysisRequest:
    run_id: str  # opaque; log correlation only
    input_csv: Path  # product,date,weight — UTF-8, ISO dates, plain numbers
    artifacts_directory: Path  # where to write the pdf, xlsx, and charts
    work_directory: Path  # scratch; discarded after the run
    report_name: str | None
    site_name: str | None
    counts_basis: CountsBasis
    unit_system: UnitSystem
    monthly_counts: Mapping[str, int]  # "YYYY-MM" -> diners or meals


@dataclass(frozen=True)
class AiUsage:
    model: str  # the model that did most of the work
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal
    metadata: Mapping[str, Any]  # per-model breakdown, request counts, cache hit rate


@dataclass(frozen=True)
class AnalysisOutcome:
    pdf: Path
    xlsx: Path
    charts: Mapping[str, Path]  # stable snake_case key -> file in artifacts_directory
    ai: AiUsage
    metadata: Mapping[str, Any]  # rows in, rows categorized, products uncategorized, ...


class AnalysisError(Exception):
    """Base for every reason `analyze()` cannot produce a report."""


class UpstreamApiError(AnalysisError):
    """The AI provider was unreachable, or retries were exhausted."""


class InvalidInputError(AnalysisError):
    """`input.csv` is not what the parent promised — a validation hole in `apps/web`."""


class UnusableDataError(AnalysisError):
    """Well-formed, but too little usable data to stand behind a report. Retrying is pointless
    and nobody has code to fix it."""


def _ignore(stage: str) -> None:
    pass


def analyze(
    request: AnalysisRequest, *, report_progress: ReportProgress = _ignore
) -> AnalysisOutcome:
    raise NotImplementedError("gbd_foodservice_insights.analyze is not ported yet")
