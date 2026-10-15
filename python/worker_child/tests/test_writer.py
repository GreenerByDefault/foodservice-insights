import json
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    CategorizationSummary,
    InputSummary,
    LlmCall,
    StageFinished,
)
from worker_child.contract import ContractError, layout
from worker_child.writer import (
    dump_json,
    peak_memory_kib,
    progress_reporter,
    telemetry_reporter,
    write_atomically,
    write_json_atomically,
)


def files_in(directory: Path) -> list[str]:
    """Names of the files in `directory`, ignoring the subdirectories the parent created."""
    return sorted(path.name for path in directory.iterdir() if path.is_file())


def test_dump_json_encodes_sorted_indented_utf8_with_a_trailing_newline() -> None:
    assert dump_json({"b": 1, "a": "é"}) == '{\n  "a": "é",\n  "b": 1\n}\n'.encode()


def test_dump_json_refuses_nan() -> None:
    # Python emits a bare `NaN`, which `JSON.parse` rejects.
    with pytest.raises(ValueError):
        dump_json({"value": float("nan")})


def test_write_atomically_leaves_no_temporary_file_behind(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_atomically(path, b"hello")

    assert path.read_bytes() == b"hello"
    assert files_in(path.parent) == ["progress.json"]


def test_write_atomically_replaces_rather_than_truncating(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_atomically(path, b"a longer first payload")
    first_inode = path.stat().st_ino

    write_atomically(path, b"second")

    assert path.stat().st_ino != first_inode
    assert path.read_bytes() == b"second"


def test_write_atomically_cleans_up_the_temporary_file_on_failure(
    run_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = run_directory / layout.PROGRESS

    def broken_fsync(_: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("worker_child.writer.os.fsync", broken_fsync)

    with pytest.raises(OSError):
        write_atomically(path, b"partial")

    assert not path.exists()
    assert files_in(path.parent) == []


def test_write_atomically_survives_concurrent_writers_to_the_same_path(run_directory: Path) -> None:
    path = run_directory / layout.RESULT
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: write_atomically(path, str(i).encode()), range(50)))
    assert files_in(path.parent) == ["result.json"]


def test_write_json_atomically_writes_the_encoded_payload(run_directory: Path) -> None:
    path = run_directory / layout.PROGRESS
    write_json_atomically(path, {"sequence": 1})
    assert json.loads(path.read_text(encoding="utf-8")) == {"sequence": 1}


def test_write_json_atomically_rejects_nan_before_touching_the_filesystem(
    run_directory: Path,
) -> None:
    path = run_directory / layout.RESULT
    with pytest.raises(ValueError):
        write_json_atomically(path, {"value": float("nan")})

    assert not path.exists()
    assert files_in(path.parent) == []


def test_reports_progress_with_a_strictly_increasing_sequence(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / layout.PROGRESS

    assert advance() == 1
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 1
    assert [advance(), advance()] == [2, 3]
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == 3


def test_progress_reporter_is_safe_for_concurrent_callers(run_directory: Path) -> None:
    advance = progress_reporter(run_directory)
    path = run_directory / layout.PROGRESS

    with ThreadPoolExecutor(max_workers=8) as pool:
        sequences = list(pool.map(lambda _: advance(), range(100)))

    # The lock keeps the in-memory counter and the file monotonic together: every call gets a
    # distinct sequence number, and the file on disk ends up agreeing with the highest one.
    assert sorted(sequences) == list(range(1, 101))
    assert json.loads(path.read_text(encoding="utf-8"))["sequence"] == max(sequences)


def test_each_run_reports_its_own_sequence(run_directory: Path, tmp_path_factory) -> None:
    other = tmp_path_factory.mktemp("other")
    (other / "output").mkdir()

    first = progress_reporter(run_directory)
    second = progress_reporter(other)
    first()
    first()

    assert second() == 1
    assert (
        json.loads((run_directory / layout.PROGRESS).read_text(encoding="utf-8"))["sequence"] == 2
    )


CALL = LlmCall(
    operation="clean",
    requested_model="gpt-4.1-mini",
    served_model="gpt-4.1-mini-2025-04-14",
    requests=1,
    failed_requests=0,
    rate_limited_requests=0,
    truncated=False,
    input_tokens=1_000,
    cached_input_tokens=0,
    output_tokens=10,
)
INPUT = InputSummary(rows=10, kilograms=50.0, unique_products=3, categorization_cache_entries=0)
CATEGORIZATION = CategorizationSummary(
    cache_raw_name_products=0,
    cache_cleaned_name_products=0,
    llm_matched_products=3,
    cache_no_match_products=0,
    llm_no_match_products=1,
    unrecognized_llm_answers=0,
    categorized_rows=8,
    categorized_kilograms=40.0,
)


def read_telemetry(run_directory: Path) -> dict:
    return json.loads((run_directory / layout.TELEMETRY).read_text(encoding="utf-8"))


def test_the_first_record_creates_the_telemetry_document(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)
    assert not (run_directory / layout.TELEMETRY).exists()

    report(StageFinished("read", duration_ms=120))

    telemetry = read_telemetry(run_directory)
    assert telemetry == {
        "llmUsage": [],
        "input": None,
        "categorization": None,
        "report": None,
        "stageDurationMs": {"read": 120},
        "peakMemoryKib": telemetry["peakMemoryKib"],
    }


def test_calls_of_one_operation_and_model_fold_into_one_row(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)

    report(CALL)
    report(replace(CALL, requests=3, failed_requests=2, rate_limited_requests=1, truncated=True))
    report(replace(CALL, operation="match"))

    clean, match = read_telemetry(run_directory)["llmUsage"]
    assert clean == {
        "operation": "clean",
        "requestedModel": "gpt-4.1-mini",
        "servedModel": "gpt-4.1-mini-2025-04-14",
        "calls": 2,
        "requests": 4,
        "failedRequests": 2,
        "rateLimitedRequests": 1,
        "truncatedCalls": 1,
        "inputTokens": 2_000,
        "cachedInputTokens": 0,
        "outputTokens": 20,
        "costMicroUsd": 832,
    }
    assert match == {
        "operation": "match",
        "requestedModel": "gpt-4.1-mini",
        "servedModel": "gpt-4.1-mini-2025-04-14",
        "calls": 1,
        "requests": 1,
        "failedRequests": 0,
        "rateLimitedRequests": 0,
        "truncatedCalls": 0,
        "inputTokens": 1_000,
        "cachedInputTokens": 0,
        "outputTokens": 10,
        "costMicroUsd": 416,
    }


def test_the_served_model_is_the_latest_that_answered(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)
    unanswered = replace(CALL, served_model=None, failed_requests=1, input_tokens=0)

    def served_model() -> str | None:
        return read_telemetry(run_directory)["llmUsage"][0]["servedModel"]

    report(unanswered)
    assert served_model() is None
    report(CALL)
    assert served_model() == "gpt-4.1-mini-2025-04-14"
    report(unanswered)
    assert served_model() == "gpt-4.1-mini-2025-04-14"
    report(replace(CALL, served_model="gpt-4.1-mini-2025-09-01"))
    assert served_model() == "gpt-4.1-mini-2025-09-01"


def test_a_served_model_the_parent_would_refuse_is_dropped_not_raised(
    run_directory: Path, caplog: pytest.LogCaptureFixture
) -> None:
    report = telemetry_reporter(run_directory)
    report(CALL)

    report(replace(CALL, served_model="GPT-4.1 Mini"))

    (usage,) = read_telemetry(run_directory)["llmUsage"]
    assert (usage["calls"], usage["servedModel"]) == (2, "gpt-4.1-mini-2025-04-14")
    assert [(name, level) for name, level, _ in caplog.record_tuples] == [
        ("worker_child.writer", logging.WARNING)
    ]


def test_the_sections_fill_in_as_their_stages_finish(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)

    report(StageFinished("read", duration_ms=120))
    report(INPUT)
    assert read_telemetry(run_directory)["categorization"] is None

    report(StageFinished("categorize", duration_ms=900))
    report(CATEGORIZATION)
    telemetry = read_telemetry(run_directory)
    assert telemetry == {
        "llmUsage": [],
        "input": {
            "rows": 10,
            "kilograms": 50.0,
            "uniqueProducts": 3,
            "categorizationCacheEntries": 0,
        },
        "categorization": {
            "cacheRawNameProducts": 0,
            "cacheCleanedNameProducts": 0,
            "llmMatchedProducts": 3,
            "cacheNoMatchProducts": 0,
            "llmNoMatchProducts": 1,
            "unrecognizedLlmAnswers": 0,
            "categorizedRows": 8,
            "categorizedKilograms": 40.0,
        },
        "report": None,
        "stageDurationMs": {"read": 120, "categorize": 900},
        # Read from the process at each write, so not a value this test controls.
        "peakMemoryKib": telemetry["peakMemoryKib"],
    }


def test_concurrent_calls_give_exact_totals(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: report(CALL), range(50)))

    (usage,) = read_telemetry(run_directory)["llmUsage"]
    assert (usage["calls"], usage["requests"], usage["inputTokens"]) == (50, 50, 50_000)
    assert files_in(run_directory / "output") == ["telemetry.json"]


def test_cost_is_rounded_once_over_the_totals(run_directory: Path) -> None:
    report = telemetry_reporter(run_directory)
    # 0.4 micro-USD each, which rounds to 0 per call but to 1 over three.
    one_token = replace(CALL, input_tokens=1, output_tokens=0)

    for _ in range(3):
        report(one_token)

    assert read_telemetry(run_directory)["llmUsage"][0]["costMicroUsd"] == 1


def test_a_record_the_parent_would_refuse_raises_and_keeps_the_last_document(
    run_directory: Path,
) -> None:
    report = telemetry_reporter(run_directory)
    report(StageFinished("read", duration_ms=120))
    before = read_telemetry(run_directory)

    with pytest.raises(ContractError):
        report(CATEGORIZATION)  # before any `InputSummary`

    assert read_telemetry(run_directory) == before
    # The refused record was not folded in either, or this would be refused again.
    report(INPUT)
    assert read_telemetry(run_directory)["categorization"] is None


def test_peak_memory_is_in_kib() -> None:
    # Between 1 MiB and 64 GiB, so bytes reported as KiB, or KiB as bytes, fall outside.
    assert 1024 < peak_memory_kib() < 64 * 1024 * 1024
