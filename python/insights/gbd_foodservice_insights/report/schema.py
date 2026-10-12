"""Shared schema and enums for food report generation."""

from collections import Counter
from collections.abc import Iterable
from typing import TYPE_CHECKING, Literal

# quality.py imports this module at runtime, so its `Finding` can only be imported for the type
# checker. Annotations are lazy on 3.14, so no quotes are needed.
if TYPE_CHECKING:
    from gbd_foodservice_insights.report.quality import Finding

Region = Literal["us", "europe"]
DinerOrMeal = Literal["diner", "meal"]
DiagnosticStatus = Literal["success", "info", "warning", "error"]
QualityStatus = Literal["pass", "warning", "invalid"]


def quality_status_from_findings(findings: Iterable[Finding]) -> QualityStatus:
    """Compute overall quality status from finding severities; ``info`` never counts."""
    statuses = {item["status"] for item in findings}
    if "error" in statuses:
        return "invalid"
    if "warning" in statuses:
        return "warning"
    return "pass"


def summarize_status_counts(findings: Iterable[Finding]) -> dict[str, int]:
    """Count findings by status."""
    counter = Counter(item["status"] for item in findings)
    return {
        "success": counter.get("success", 0),
        "info": counter.get("info", 0),
        "warning": counter.get("warning", 0),
        "error": counter.get("error", 0),
    }
