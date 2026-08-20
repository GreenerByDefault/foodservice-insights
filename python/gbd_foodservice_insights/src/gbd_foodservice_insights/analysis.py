"""The seam between `worker_child` and the analysis library. It takes a CSV and a form's
answers, and returns either a report with its cost, or one of three failure reasons.

Four properties keep this seam agnostic and are worth preserving as the library is ported in:

1. **The library never sees the run directory, the contract's documents, or exit codes.** It is
   handed a CSV, a scratch directory, an output directory, and the form's answers.
2. **`report_progress` is a plain no-argument callable with a no-op default**, so notebooks and
   the lab are unaffected. It carries no payload; the child's only use of it is to bump
   `sequence`.
3. **The library names its own charts**; the wrapper maps keys to contract filenames.
4. **AI usage is the library's to report**.

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

type ReportProgress = Callable[[], None]

CountsBasis = Literal["people", "meals"]
UnitSystem = Literal["lb", "kg"]


@dataclass(frozen=True)
class AnalysisRequest:
    run_id: str  # opaque; log correlation only
    input_csv: Path  # product,date,weight — UTF-8, ISO dates, plain numbers
    output_directory: Path  # where to write the pdf, xlsx, and charts
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
    charts: Mapping[str, Path]  # stable snake_case key -> file in output_directory
    ai: AiUsage
    metadata: Mapping[str, Any]  # rows in, rows categorized, products uncategorized, ...


class AnalysisError(Exception):
    """Base for every reason `analyze()` cannot produce a report."""


class UpstreamApiError(AnalysisError):
    """The AI provider was unreachable, or retries were exhausted."""


class InvalidInputError(AnalysisError):
    """`input.csv` is not what the parent promised — a validation hole in `apps/web`."""


class UnusableDataError(AnalysisError):
    """Data is syntactically correct, but cannot be used, such as bogus product names."""


def _ignore() -> None:
    pass


def analyze(
    request: AnalysisRequest, *, report_progress: ReportProgress = _ignore
) -> AnalysisOutcome:
    raise NotImplementedError("gbd_foodservice_insights.analyze is not ported yet")
