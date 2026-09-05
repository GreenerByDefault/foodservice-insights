class AnalysisError(Exception):
    """Base for every reason `analyze()` cannot produce a report."""


class UpstreamApiError(AnalysisError):
    """The AI provider was unreachable, or retries were exhausted."""


class InvalidInputError(AnalysisError):
    """`input.csv` is not what the parent promised — a validation hole in `apps/web`."""


class UnusableDataError(AnalysisError):
    """Data is syntactically correct, but cannot be used, such as bogus product names."""
