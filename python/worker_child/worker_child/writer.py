"""Putting a document into the run directory without the parent ever seeing half of one."""

import json
import logging
import os
import resource
import sys
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from gbd_foodservice_insights.analysis import (
    CategorizationSummary,
    InputSummary,
    LlmCall,
    ReportSummary,
    ReportTelemetry,
    StageFinished,
    Telemetry,
)

from worker_child.contract import layout
from worker_child.contract.messages import (
    MODEL_PATTERN,
    LlmUsage,
    TelemetryState,
    progress_payload,
    telemetry_payload,
)

logger = logging.getLogger(__name__)


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


def telemetry_reporter(run_directory: Path) -> ReportTelemetry:
    """Returns a callable that folds each record into `telemetry.json` and rewrites it, so the
    document is current however the run ends. Nothing reported means no document."""
    path = run_directory / layout.TELEMETRY
    state = TelemetryState()
    # As in `progress_reporter`: LLM calls report from `map_concurrently`'s threads, and a fold
    # outside the lock would lose a call.
    lock = threading.Lock()

    def report(record: Telemetry) -> None:
        nonlocal state
        with lock:
            folded = fold_telemetry(state, record)
            write_json_atomically(
                path, telemetry_payload(folded, peak_memory_kib=peak_memory_kib())
            )
            state = folded

    return report


def fold_telemetry(state: TelemetryState, record: Telemetry) -> TelemetryState:
    match record:
        case LlmCall():
            key = (record.operation, record.requested_model)
            usage = _add_call(state.llm_usage.get(key), record)
            return replace(state, llm_usage={**state.llm_usage, key: usage})
        case InputSummary():
            return replace(state, input=record)
        case CategorizationSummary():
            return replace(state, categorization=record)
        case ReportSummary():
            return replace(state, report=record)
        case StageFinished():
            return replace(
                state,
                stage_duration_ms={**state.stage_duration_ms, record.stage: record.duration_ms},
            )


def _add_call(usage: LlmUsage | None, call: LlmCall) -> LlmUsage:
    if usage is None:
        usage = LlmUsage(
            operation=call.operation,
            requested_model=call.requested_model,
            served_model=None,
            calls=0,
            requests=0,
            failed_requests=0,
            rate_limited_requests=0,
            truncated_calls=0,
            input_tokens=0,
            cached_input_tokens=0,
            output_tokens=0,
        )
    return replace(
        usage,
        served_model=_served_model(call) or usage.served_model,
        calls=usage.calls + 1,
        requests=usage.requests + call.requests,
        failed_requests=usage.failed_requests + call.failed_requests,
        rate_limited_requests=usage.rate_limited_requests + call.rate_limited_requests,
        truncated_calls=usage.truncated_calls + int(call.truncated),
        input_tokens=usage.input_tokens + call.input_tokens,
        cached_input_tokens=usage.cached_input_tokens + call.cached_input_tokens,
        output_tokens=usage.output_tokens + call.output_tokens,
    )


def _served_model(call: LlmCall) -> str | None:
    # OpenAI spells this, not us. One the parent's CHECK would refuse must not fail the call it
    # rode in on, and with it the report, so it is dropped as if nothing had answered.
    if call.served_model is None or MODEL_PATTERN.fullmatch(call.served_model):
        return call.served_model
    logger.warning("Dropping a served model that is not a model id: %r", call.served_model)
    return None


def peak_memory_kib() -> int:
    """This process's peak resident set size so far."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux, which the worker image runs, reports KiB; macOS reports bytes.
    return peak // 1024 if sys.platform == "darwin" else peak
