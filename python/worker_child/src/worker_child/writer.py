"""Putting a document into the run directory without the parent ever seeing half of one.

The parent polls `progress.json` while the child rewrites it, and reads a verdict the moment the
process exits. Both are safe only because every write here lands by rename.
"""

import json
import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from worker_child import contract
from worker_child.messages import progress_payload


def write_json_atomically(path: Path, payload: Mapping[str, Any]) -> None:
    """Write `payload` to `path` as one indivisible replacement.

    A reader always opens either the whole previous file or the whole new one, never a mixture,
    because `os.replace` swaps the directory entry rather than truncating in place.

    `allow_nan=False` is not decoration. Python emits a bare `NaN`, which `JSON.parse` rejects,
    and a NaN can reach `resultMetadata` from any aggregation over an empty group. Failing here
    beats handing the parent a document it cannot read.

    Deliberately no `fsync` on the containing directory: rename is atomic without it, and the
    durability it would add buys nothing, since a host crash orphans the attempt and another
    worker reaps it.
    """
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(
                payload, handle, allow_nan=False, ensure_ascii=False, indent=2, sort_keys=True
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def progress_reporter(run_directory: Path) -> Callable[[], int]:
    """A callable that heartbeats once per call, returning the sequence it just wrote.

    The counter lives in the closure because it is the whole of the state: the child calls this
    whenever it makes progress, and nothing else may write `progress.json`.
    """
    path = run_directory / contract.PROGRESS
    sequence = 0

    def advance() -> int:
        nonlocal sequence
        sequence += 1
        write_json_atomically(path, progress_payload(sequence))
        return sequence

    return advance
