"""Per-run file logging helpers for the food-report pipeline.

This module owns the internal operational log for one report run. These log
files are for debugging and observability, not for client communication.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

# Named explicitly, not derived from this module's own `__name__`, so capture doesn't silently
# narrow to one package if this module moves again.
_CAPTURED_PACKAGE_NAMES = ("gbd_foodservice_insights", "gbd_foodservice_insights_lab")


class HumanReadableReportFormatter(logging.Formatter):
    """Format report-run logs as plain progress notes rather than raw telemetry."""

    default_time_format = "%Y-%m-%d %H:%M:%S"

    def format(self, record: logging.LogRecord) -> str:
        """Format a log record as a timestamped human-readable line.

        Args:
            record: Log record being formatted.

        Returns:
            Formatted message with a timestamp prefix and severity label, plus
            optional exception/stack traceback when present on the record.
        """
        message = record.getMessage()

        if record.levelno >= logging.ERROR:
            message = f"Error: {message}"
        elif record.levelno >= logging.WARNING:
            message = f"Warning: {message}"
        elif record.levelno == logging.DEBUG:
            message = f"Debug: {message}"

        formatted = f"[{self.formatTime(record, self.datefmt)}] {message}"

        if record.exc_info:
            formatted = f"{formatted}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            formatted = f"{formatted}\n{self.formatStack(record.stack_info)}"

        return formatted


def attach_report_run_file_handler(
    log_path: str | Path,
    *,
    level: int = logging.INFO,
) -> dict[str, Any]:
    """Attach a dedicated file handler for one report run.

    This exists so each run has its own persistent debug trail without leaking
    handlers across repeated calls in notebooks, scripts, or the web app. The
    resulting log file is part of the internal artifact bundle only. The
    handler is attached to both `_CAPTURED_PACKAGE_NAMES` loggers, so every
    module's `logging.getLogger(__name__)` in either package propagates into
    it, including sibling subpackages such as ``categorization``.

    Args:
        log_path: Path to the per-run log file; the parent directory is created.
        level: Effective level applied to the logger if it is currently more
            permissive than ``level``.

    Returns:
        Handler-state dict with keys ``loggers``, ``handler``, ``previous_levels``,
        and ``log_path`` for later passing to ``close_report_run_file_handler``.
    """
    resolved_log_path = Path(log_path).resolve()
    resolved_log_path.parent.mkdir(parents=True, exist_ok=True)

    handler = logging.FileHandler(resolved_log_path, mode="w", encoding="utf-8")
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(HumanReadableReportFormatter())

    loggers = [logging.getLogger(name) for name in _CAPTURED_PACKAGE_NAMES]
    previous_levels: dict[str, int] = {}
    for package_logger in loggers:
        previous_levels[package_logger.name] = package_logger.level
        if package_logger.level == logging.NOTSET or package_logger.level > level:
            package_logger.setLevel(level)
        package_logger.addHandler(handler)

    return {
        "loggers": loggers,
        "handler": handler,
        "previous_levels": previous_levels,
        "log_path": str(resolved_log_path),
    }


def close_report_run_file_handler(handler_state: dict[str, Any] | None) -> None:
    """Remove and close a per-run file handler safely.

    Args:
        handler_state: State dict returned by ``attach_report_run_file_handler``,
            or ``None`` to no-op.
    """
    if not handler_state:
        return

    handler = handler_state["handler"]
    previous_levels = handler_state["previous_levels"]
    for package_logger in handler_state["loggers"]:
        package_logger.removeHandler(handler)
        package_logger.setLevel(previous_levels[package_logger.name])
    handler.close()
