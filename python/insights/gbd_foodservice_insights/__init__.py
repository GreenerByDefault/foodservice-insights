"""The AI analysis library: categorization, emissions, and report generation.

`analysis.py` is the seam `worker_child` calls against.
"""

from pathlib import Path
from typing import Final

# The package directory, anchored on this file rather than any importing module's `__file__`, so
# every packaged-asset path (data_files/, prompts/) survives modules moving between subpackages.
#
# Defined before the re-export below: library modules import it from here, so once `analysis`
# imports the library, it must already exist while this module is still initializing.
PACKAGE_DIR: Final[Path] = Path(__file__).resolve().parent

from gbd_foodservice_insights.analysis import (  # noqa: E402
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
    "PACKAGE_DIR",
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
