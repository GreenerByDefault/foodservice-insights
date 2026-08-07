"""The child's half of the golden fixtures in `contract/fixtures/`.

Each side plays its production role: the child reads `run.json` and writes the other three, so
here `run.json` is parsed and the rest are reproduced by their payload builders.
`apps/worker/src/contract/fixtures.test.ts` is the mirror.
"""

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from worker_child.messages import (
    AiUsage,
    failure_payload,
    parse_run_manifest,
    progress_payload,
    result_payload,
)
from worker_child.parse import ContractError

FIXTURES = Path(__file__).resolve().parents[3] / "contract" / "fixtures"

DOCUMENTS = frozenset({"run", "progress", "result", "failure"})

# The child only reads `run.json`; it writes the rest, so the TypeScript side is what rejects
# their invalid fixtures.
PARSED_BY_THE_CHILD = frozenset({"run"})


def fixture_names(directory: str) -> list[str]:
    return sorted(path.name for path in (FIXTURES / directory).glob("*.json"))


def read(directory: str, name: str) -> str:
    return (FIXTURES / directory / name).read_text(encoding="utf-8")


def load(directory: str, name: str) -> Any:
    return json.loads(read(directory, name))


def document_of(file_name: str) -> str:
    return file_name.split(".")[0]


VALID = fixture_names("valid")
INVALID = fixture_names("invalid")

REJECTED_HERE = [name for name in INVALID if document_of(name) in PARSED_BY_THE_CHILD]


def test_names_every_fixture_after_a_document_both_stacks_know() -> None:
    unknown = [name for name in VALID + INVALID if document_of(name) not in DOCUMENTS]
    assert unknown == []


def test_covers_every_document() -> None:
    assert VALID == ["failure.json", "progress.json", "result.json", "run.json"]
    assert REJECTED_HERE != []


def test_parses_the_run_manifest_the_parent_writes() -> None:
    manifest = parse_run_manifest(read("valid", "run.json"))

    assert manifest.analysis_attempt_id == "0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f"
    assert manifest.report.name == "Q1 2026 dining"
    assert manifest.report.site_name is None
    assert manifest.report.counts_basis == "meals"
    assert manifest.report.unit_system == "lb"
    assert dict(manifest.report.monthly_counts) == {
        "2025-01": 12040,
        "2025-02": 11360,
        "2025-03": 12890,
    }
    assert manifest.input_file.original_filename == "Q1 exports (final).xlsx"
    assert manifest.input_file.byte_size == 184320


@pytest.mark.parametrize("name", REJECTED_HERE)
def test_rejects_an_invalid_fixture(name: str) -> None:
    with pytest.raises(ContractError):
        parse_run_manifest(read("invalid", name))


def test_rejects_bytes_that_are_not_json_at_all() -> None:
    # Generated rather than committed: Biome parses `contract/fixtures/`, so a malformed file
    # could not live there.
    with pytest.raises(ContractError):
        parse_run_manifest('{"analysisAttemptId":')


# --- What the child writes ----------------------------------------------------------------
#
# The strong form: the fixture is a golden output, so any change to a payload builder has to
# change the fixture too — and a fixture change is a `contract/` change, which runs both stacks.


def test_progress_payload_is_the_fixture() -> None:
    assert progress_payload(7) == load("valid", "progress.json")


def test_result_payload_is_the_fixture() -> None:
    payload = result_payload(
        analysis_attempt_id="0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
        charts=["emissions_by_month", "emissions_by_category", "top_products"],
        ai=AiUsage(
            model="gemini-2.5-pro",
            input_tokens=918342,
            output_tokens=41207,
            cost_usd=Decimal("2.4713"),
            metadata={"providerRequests": 41, "promptCacheHitRate": 0.62},
        ),
        result_metadata={"rowsIn": 4821, "rowsCategorized": 4790, "productsUncategorized": 31},
    )

    assert payload == load("valid", "result.json")
    assert payload["ai"]["costUsd"] == "2.4713"


def test_failure_payload_is_the_fixture() -> None:
    payload = failure_payload(
        reason="upstream_api",
        detail="Gemini returned 429 on 6 consecutive attempts over 214s (model gemini-2.5-pro)",
        traceback=(
            'Traceback (most recent call last):\n  File "categorize.py", line 88, in categorize\n'
            "    raise UpstreamError(response)\n"
        ),
    )

    assert payload == load("valid", "failure.json")


def test_refuses_to_write_a_reason_only_the_parent_may_claim() -> None:
    with pytest.raises(ContractError):
        failure_payload(reason="hung", detail="whatever")  # ty: ignore[invalid-argument-type]


def test_refuses_to_write_duplicate_chart_keys() -> None:
    with pytest.raises(ContractError):
        result_payload(
            analysis_attempt_id="0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
            charts=["emissions_by_month", "emissions_by_month"],
            ai=AiUsage(
                model="gemini-2.5-pro",
                input_tokens=1,
                output_tokens=1,
                cost_usd=Decimal("0.0001"),
                metadata={},
            ),
            result_metadata={},
        )


# --- The cross-language number traps -------------------------------------------------------
#
# Neither can be expressed as a fixture on both sides at once, so they are pinned here and
# mirrored in `apps/worker/src/contract/fixtures.test.ts`.


def test_accepts_a_whole_number_written_as_a_float() -> None:
    # `JSON.parse` cannot tell 184320.0 from 184320, so this side has to accept both.
    manifest = json.loads(read("valid", "run.json"))
    manifest["inputFile"]["byteSize"] = 184320.0

    assert parse_run_manifest(json.dumps(manifest)).input_file.byte_size == 184320


def test_rejects_a_boolean_where_a_number_belongs() -> None:
    # `bool` subclasses `int`, so `True` would otherwise arrive as 1.
    manifest = json.loads(read("valid", "run.json"))
    manifest["inputFile"]["byteSize"] = True

    with pytest.raises(ContractError):
        parse_run_manifest(json.dumps(manifest))
