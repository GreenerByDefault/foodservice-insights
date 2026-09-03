"""The AI analysis library: categorization, emissions, and report generation.

A scaffold today — see `analysis.py` for the seam `worker_child` calls against, and
`analysis.py`'s module docstring for what the port must preserve.
"""

from gbd_foodservice_insights.analysis import (
    AnalysisError,
    AnalysisOutcome,
    AnalysisRequest,
    CountsBasis,
    InvalidInputError,
    ReportProgress,
    UnitSystem,
    UnusableDataError,
    UpstreamApiError,
    analyze,
)

__all__ = [
    "AnalysisError",
    "AnalysisOutcome",
    "AnalysisRequest",
    "CountsBasis",
    "InvalidInputError",
    "ReportProgress",
    "UnitSystem",
    "UnusableDataError",
    "UpstreamApiError",
    "analyze",
]
