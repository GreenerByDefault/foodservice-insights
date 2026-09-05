"""The seam between `worker_child` and the analysis library. It takes a CSV and a form's
answers, and returns either a report, or one of three failure reasons.

Two properties keep this seam agnostic and are worth preserving as the library is ported in:

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
§ Persistence. It needs to come back once the library is ported and its actual output shape is
known.

**Open:** structured result metadata (rows in, rows categorized, products uncategorized, ...) is
dropped from this seam for the same reason — REQUIREMENTS.md § Persistence. `AnalysisOutcome` is
where it will arrive once the library is ported and its shape is known.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from gbd_foodservice_insights.errors import AnalysisError as AnalysisError
from gbd_foodservice_insights.errors import InvalidInputError as InvalidInputError
from gbd_foodservice_insights.errors import UnusableDataError as UnusableDataError
from gbd_foodservice_insights.errors import UpstreamApiError as UpstreamApiError

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


def _ignore() -> None:
    pass


def analyze(
    request: AnalysisRequest, *, report_progress: ReportProgress = _ignore
) -> AnalysisOutcome:
    raise NotImplementedError("gbd_foodservice_insights.analyze is not ported yet")
