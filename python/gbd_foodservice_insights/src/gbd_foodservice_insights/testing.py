from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisOutcome,
    AnalysisRequest,
    ReportProgress,
)

# Real magic bytes, so a test asserting "this is actually a PDF/xlsx" is not fooled by a
# stub that only gets the file extension right.
PDF_MAGIC_BYTES = b"%PDF-1.4\n%stub\n"
XLSX_MAGIC_BYTES = b"PK\x03\x04stub"


def _ignore() -> None:
    pass


def stub_analysis(
    request: AnalysisRequest,
    *,
    report_progress: ReportProgress = _ignore,
    write_pdf: bool = True,
    write_xlsx: bool = True,
    result_metadata: Mapping[str, Any] = MappingProxyType({}),
    progress_calls: int = 2,
    raises: type[AnalysisError] | None = None,
) -> AnalysisOutcome:
    """The library's own definition of a valid `analyze()`, shipped for `worker_child`'s
    tests the same way `@gbd/db/testing` ships fakes for its consumers.

    It exists to test the *wrapper*, producing outcomes a mocked LLM never could — a missing
    declared file, an out-of-range cost, each exception type on demand. Every keyword names
    an outcome of the seam, not a library internal, so the port landing won't change what it
    expresses. Writes real files with real magic bytes into `request.output_directory`,
    unless told to skip one.
    """
    for _ in range(progress_calls):
        report_progress()

    if raises is not None:
        raise raises(f"stub_analysis: raising {raises.__name__} on request")

    pdf = request.output_directory / "report.pdf"
    if write_pdf:
        pdf.write_bytes(PDF_MAGIC_BYTES)

    xlsx = request.output_directory / "report.xlsx"
    if write_xlsx:
        xlsx.write_bytes(XLSX_MAGIC_BYTES)

    return AnalysisOutcome(
        pdf=pdf,
        xlsx=xlsx,
        metadata=result_metadata,
    )
