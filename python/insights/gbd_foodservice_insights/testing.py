import difflib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Final, Literal

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

    return AnalysisOutcome(pdf=pdf, xlsx=xlsx)


# The first keyword found in a name wins, so a keyword must come before any shorter one it
# contains — "oat milk" before "milk" — or it can never match.
KEYWORD_CATEGORIES: Final[tuple[tuple[str, str], ...]] = (
    ("oat milk", "Oat Milk"),
    ("soy milk", "Soy Milk"),
    ("almond milk", "Almond/Coconut Milk"),
    ("beyond burger", "Plant-based Meats"),
    ("peanut butter", "Nuts & Seeds"),
    ("ice cream", "Ice Cream"),
    ("liquid egg", "Liquid Eggs"),
    ("egg", "Shelled Eggs"),
    ("shrimp", "Shellfish (Shrimp & lobster)"),
    ("salmon", "Fish & Mollusks"),
    ("chicken", "Poultry (Chicken & Turkey)"),
    ("turkey", "Poultry (Chicken & Turkey)"),
    ("beef", "Beef and Buffalo Meat"),
    ("pork", "Pork (pig meat)"),
    ("lamb", "Lamb/mutton & goat meat"),
    ("cheese", "Cheese"),
    ("butter", "Butter"),
    ("yogurt", "Yogurt"),
    ("cream", "Cream"),
    ("milk", "Milk (Cow's milk)"),
    ("mayo", "Mayo"),
    ("lentil", "Legumes"),
    ("brown rice", "Whole Grains"),
)
NO_MATCH: Final = "No Matches Found"

type LlmOperation = Literal["clean", "match", "fuzzy"]


@dataclass
class KeywordLlmClient:
    """An offline `LlmClient` that categorizes by keyword, so a whole analysis can run with no
    network and no API key. `calls` records every operation, for tests that count LLM calls."""

    calls: list[tuple[LlmOperation, str]] = field(default_factory=list)

    def clean_product_name(self, item: str) -> str:
        self.calls.append(("clean", item))
        return " ".join(re.sub(r"[^a-z ]", " ", item.lower()).split())

    def match_product_to_category(self, item: str, categories: Sequence[str]) -> str:
        self.calls.append(("match", item))
        lowered = item.lower()
        return next(
            (category for keyword, category in KEYWORD_CATEGORIES if keyword in lowered),
            NO_MATCH,
        )

    def fuzzy_match_category(self, item: str, categories: Sequence[str]) -> str:
        self.calls.append(("fuzzy", item))
        return next(iter(difflib.get_close_matches(item, categories, n=1)), NO_MATCH)
