import json
from pathlib import Path

import pytest
from support.contract_fixtures import (
    INVALID_RUN_FIXTURE_NAMES,
    VALID_ANALYSIS_ATTEMPT_ID,
    load,
    names_in,
    read,
)
from worker_child.contract import ContractError, layout
from worker_child.contract.messages import (
    failure_payload,
    parse_run_manifest,
    progress_payload,
    read_run_manifest,
    result_payload,
)

DOCUMENTS = frozenset({"run", "progress", "result", "failure"})


def document_of(file_name: str) -> str:
    return file_name.split(".")[0]


VALID = names_in("valid")
INVALID = names_in("invalid")


def test_names_every_fixture_after_a_document_both_stacks_know() -> None:
    unknown = [name for name in VALID + INVALID if document_of(name) not in DOCUMENTS]
    assert unknown == []


def test_covers_every_document() -> None:
    assert VALID == ["failure.json", "progress.json", "result.json", "run.json"]
    assert INVALID_RUN_FIXTURE_NAMES != []


def test_parses_the_run_manifest_the_parent_writes() -> None:
    manifest = parse_run_manifest(read("valid", "run.json"))

    assert manifest.analysis_attempt_id == VALID_ANALYSIS_ATTEMPT_ID
    assert manifest.report.name == "Q1 2026 dining"
    assert manifest.report.site_name is None
    assert manifest.report.organization_name == "Acme Foodservice"
    assert manifest.report.counts_basis == "meals"
    assert manifest.report.unit_system == "lb"
    assert dict(manifest.report.monthly_counts) == {
        "2025-01": 12040,
        "2025-02": 11360,
        "2025-03": 12890,
    }


@pytest.mark.parametrize("name", INVALID_RUN_FIXTURE_NAMES)
def test_rejects_an_invalid_fixture(name: str) -> None:
    with pytest.raises(ContractError):
        parse_run_manifest(read("invalid", name))


def test_rejects_bytes_that_are_not_json_at_all() -> None:
    with pytest.raises(ContractError):
        parse_run_manifest('{"analysisAttemptId":')


def test_reads_the_manifest_from_where_the_parent_writes_it(tmp_path: Path) -> None:
    (tmp_path / "input").mkdir()
    (tmp_path / layout.MANIFEST).write_text(read("valid", "run.json"), encoding="utf-8")

    # `parse_run_manifest` already covers the document's fields exhaustively above; this only
    # checks that `read_run_manifest` finds the file and forwards it there.
    manifest = read_run_manifest(tmp_path)
    assert manifest.analysis_attempt_id == VALID_ANALYSIS_ATTEMPT_ID


def test_raises_a_contract_error_when_the_manifest_file_is_missing(tmp_path: Path) -> None:
    with pytest.raises(ContractError):
        read_run_manifest(tmp_path)


# ---------------------------------------------------------------------------------------
# What the child writes
# ---------------------------------------------------------------------------------------


def test_progress_payload_is_the_fixture() -> None:
    assert progress_payload(7) == load("valid", "progress.json")


def test_result_payload_is_the_fixture() -> None:
    payload = result_payload(analysis_attempt_id=VALID_ANALYSIS_ATTEMPT_ID)

    assert payload == load("valid", "result.json")


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


# ---------------------------------------------------------------------------------------
# Cross-language traps
# ---------------------------------------------------------------------------------------


def test_accepts_a_whole_number_written_as_a_float() -> None:
    # JavaScript's JSON.parse cannot tell 12040.0 from 12040, so this side has to accept both.
    manifest = json.loads(read("valid", "run.json"))
    manifest["report"]["monthlyCounts"]["2025-01"] = 12040.0

    parsed = parse_run_manifest(json.dumps(manifest))
    assert parsed.report.monthly_counts["2025-01"] == 12040


def test_rejects_a_boolean_where_a_number_belongs() -> None:
    # `bool` subclasses `int`, so `True` would otherwise arrive as 1.
    manifest = json.loads(read("valid", "run.json"))
    manifest["report"]["monthlyCounts"]["2025-01"] = True

    with pytest.raises(ContractError):
        parse_run_manifest(json.dumps(manifest))
