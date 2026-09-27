"""
Shared utility functions for the GBD package.

Includes file I/O helpers, progress reporting, and environment detection.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# File helpers
# ----------------------------------------------------------------------


def rel_path(p: str | Path | None) -> str | Path | None:
    """Return *p* relative to the current working directory if possible.

    Falls back to the original value if *p* is outside cwd or is ``None``.
    Useful for keeping printed file paths short.
    """
    if p is None:
        return None
    try:
        return Path(p).resolve().relative_to(Path.cwd())
    except ValueError:
        return p


# ----------------------------------------------------------------------
# Progress reporting
# ----------------------------------------------------------------------


def print_progress(prefix: str, current: int, total: int, updates: int = 10) -> None:
    """Log a simple textual progress update.

    `current` is 1-indexed; `updates` is roughly how many messages to emit across `total`.
    """
    if total <= 0:
        return

    step = max(1, total // updates)
    if current % step == 0 or current == total:
        percent = int(100 * current / total)
        logger.info("%s: %d%% (%d/%d)", prefix, percent, current, total)
