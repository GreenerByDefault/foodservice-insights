"""Putting a document into the run directory without the parent ever seeing half of one."""

import json
import os
import threading
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from worker_child.contract import layout
from worker_child.contract.messages import progress_payload


def dump_json(payload: Mapping[str, Any]) -> bytes:
    """Encode `payload` the way every document in the run directory is written."""
    text = json.dumps(
        payload,
        # Python emits a bare `NaN`, which JavaScript's `JSON.parse` rejects.
        allow_nan=False,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    return f"{text}\n".encode()


def write_atomically(path: Path, data: bytes) -> None:
    """Write `data` to `path` by rename, so a reader never sees a partial file."""
    # Unique per call, not just per process.
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def write_json_atomically(path: Path, payload: Mapping[str, Any]) -> None:
    """Write `payload` to `path` by rename, so a reader never sees a partial file."""
    write_atomically(path, dump_json(payload))


def progress_reporter(run_directory: Path) -> Callable[[], int]:
    """Returns a callable that reports progress once per call and returns the sequence written."""
    path = run_directory / layout.PROGRESS
    sequence = 0
    # Guards concurrent calls to `advance`: without it, increment-and-write races, and writes
    # could land out of order on disk even with a correct in-memory sequence.
    lock = threading.Lock()

    def advance() -> int:
        nonlocal sequence
        with lock:
            sequence += 1
            write_json_atomically(path, progress_payload(sequence))
            return sequence

    return advance
