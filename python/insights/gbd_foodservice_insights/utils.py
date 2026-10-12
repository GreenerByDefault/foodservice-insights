"""
Shared utility functions for the GBD package.

Includes file I/O helpers, progress reporting, concurrency, and environment detection.
"""

import logging
import time
from collections.abc import Callable, Sequence
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait

logger = logging.getLogger(__name__)


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


# ----------------------------------------------------------------------
# Concurrency
# ----------------------------------------------------------------------


def map_concurrently[T, R](
    fn: Callable[[T], R],
    items: Sequence[T],
    *,
    max_workers: int,
    progress_prefix: str,
) -> list[R]:
    """`[fn(item) for item in items]`, with up to `max_workers` calls in flight at once.

    The first exception propagates once the calls already in flight have finished, and no call
    starts after it.
    """
    started = time.monotonic()
    pending = iter(enumerate(items))
    in_flight: dict[Future[R], int] = {}
    results: dict[int, R] = {}

    with ThreadPoolExecutor(max_workers) as executor:
        # A window of `max_workers` rather than submitting everything up front, which would let
        # an idle thread pick up a queued item before a failure could cancel it.
        def submit_next() -> None:
            if (entry := next(pending, None)) is not None:
                index, item = entry
                in_flight[executor.submit(fn, item)] = index

        for _ in range(max_workers):
            submit_next()
        while in_flight:
            done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
            # Every result is collected before anything new is submitted, so a failure anywhere
            # in `done` stops the window.
            for future in done:
                results[in_flight.pop(future)] = future.result()
                print_progress(progress_prefix, len(results), len(items))
            for _ in done:
                submit_next()

    logger.info(
        "%s: %d calls in %.1f s, %d at a time.",
        progress_prefix,
        len(items),
        time.monotonic() - started,
        max_workers,
    )
    return [results[index] for index in range(len(items))]
