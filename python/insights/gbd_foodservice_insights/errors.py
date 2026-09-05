"""The three reasons `analyze()` can fail. A leaf module so `llm.py` can raise
`UpstreamApiError` without importing `analysis.py`, which would close a
`llm → analysis → categorize` cycle.
"""


class AnalysisError(Exception):
    """Base for every reason `analyze()` cannot produce a report."""


class UpstreamApiError(AnalysisError):
    """The AI provider was unreachable, or retries were exhausted."""


class InvalidInputError(AnalysisError):
    """`input.csv` is not what the parent promised — a validation hole in `apps/web`."""


class UnusableDataError(AnalysisError):
    """Data is syntactically correct, but cannot be used, such as bogus product names."""
