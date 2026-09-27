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


def get_default_output_file(input_file: str, suffix: str = "_categorized") -> str:
    """
    Generate a default output file path based on the input file.

    Args:
        input_file: Path to the input file.
        suffix: Suffix to add before the file extension.

    Returns:
        Output file path with the suffix added.
    """
    input_path = Path(input_file)
    return str(input_path.with_stem(input_path.stem + suffix))


# ----------------------------------------------------------------------
# Progress reporting
# ----------------------------------------------------------------------


def print_progress(prefix: str, current: int, total: int, updates: int = 10) -> None:
    """
    Log a simple textual progress update.

    Args:
        prefix: Message prefix describing the ongoing task.
        current: The current iteration (1-indexed).
        total: Total number of iterations/items to process.
        updates: Approximate number of times to emit a progress message.
    """
    if total <= 0:
        return

    step = max(1, total // updates)
    if current % step == 0 or current == total:
        percent = int(100 * current / total)
        logger.info("%s: %d%% (%d/%d)", prefix, percent, current, total)
