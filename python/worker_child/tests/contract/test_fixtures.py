import json
from dataclasses import replace
from pathlib import Path

import pytest
from gbd_foodservice_insights.analysis import (
    CachedCategorization,
    CategorizationSummary,
    FindingCount,
    InputSummary,
    NewCategorization,
    ReportSummary,
)
from support.contract_fixtures import (
    INVALID_CATEGORIZATION_CACHE_FIXTURE_NAMES,
    INVALID_RUN_FIXTURE_NAMES,
    VALID_ANALYSIS_ATTEMPT_ID,
    load,
    names_in,
    read,
)
from worker_child.contract import ContractError, layout
from worker_child.contract.messages import (
    LlmUsage,
    TelemetryState,
    failure_payload,
    new_categorizations_payload,
    parse_categorization_cache,
    parse_run_manifest,
    progress_payload,
    read_run_manifest,
    result_payload,
    telemetry_payload,
)
from worker_child.contract.names import MAX_PRODUCT_BYTES

DOCUMENTS = frozenset(
    {
        "run",
        "progress",
        "result",
        "failure",
        "telemetry",
        "categorization-cache",
        "new-categorizations",
    }
)


def document_of(file_name: str) -> str:
    return file_name.split(".")[0]


VALID = names_in("valid")
INVALID = names_in("invalid")


def test_names_every_fixture_after_a_document_both_stacks_know() -> None:
    unknown = [name for name in VALID + INVALID if document_of(name) not in DOCUMENTS]
    assert unknown == []


def test_covers_every_document() -> None:
    assert VALID == [
        "categorization-cache.json",
        "failure.json",
        "new-categorizations.json",
        "progress.json",
        "result.json",
        "run.json",
        "telemetry.json",
        "telemetry.partial.json",
    ]
    assert INVALID_RUN_FIXTURE_NAMES != []
    assert INVALID_CATEGORIZATION_CACHE_FIXTURE_NAMES != []


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


def test_parses_the_categorization_cache_the_parent_writes() -> None:
    assert parse_categorization_cache(read("valid", "categorization-cache.json")) == (
        CachedCategorization(
            product="Chicken Breast, Boneless 4oz",
            category="Poultry (Chicken & Turkey)",
            cleaned_name="chicken breast",
        ),
        CachedCategorization(
            product="Napkins 2-ply", category="No Matches Found", cleaned_name=None
        ),
        CachedCategorization(
            product='Oat Milk "Barista" 32oz,\ncase of 12',
            category="Oat Milk",
            cleaned_name="oat milk",
        ),
    )


def test_parses_an_empty_categorization_cache() -> None:
    assert parse_categorization_cache('{"rows": []}') == ()


@pytest.mark.parametrize("name", INVALID_CATEGORIZATION_CACHE_FIXTURE_NAMES)
def test_rejects_an_invalid_categorization_cache_fixture(name: str) -> None:
    with pytest.raises(ContractError):
        parse_categorization_cache(read("invalid", name))


def test_rejects_a_categorization_cache_row_that_is_not_an_object() -> None:
    with pytest.raises(ContractError):
        parse_categorization_cache('{"rows": ["Napkins 2-ply"]}')


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


BURGER = NewCategorization(
    product="Beyond Burger Patty 4oz",
    cleaned_name="plant-based burger patty",
    category="Plant-based Meats",
)
FOIL_PAN = NewCategorization(
    product="Foil Pan Half Size", cleaned_name=None, category="No Matches Found"
)


def test_new_categorizations_payload_is_the_fixture() -> None:
    payload = new_categorizations_payload(
        analysis_attempt_id=VALID_ANALYSIS_ATTEMPT_ID, rows=[BURGER, FOIL_PAN]
    )

    assert payload == load("valid", "new-categorizations.json")


@pytest.mark.parametrize("cleaned_name", ["", " \n"])
def test_new_categorizations_payload_writes_a_blank_cleaned_name_as_null(
    cleaned_name: str,
) -> None:
    payload = new_categorizations_payload(
        analysis_attempt_id=VALID_ANALYSIS_ATTEMPT_ID,
        rows=[replace(BURGER, cleaned_name=cleaned_name)],
    )

    assert payload["rows"] == [
        {"product": BURGER.product, "cleanedName": None, "category": BURGER.category}
    ]


def test_new_categorizations_payload_accepts_a_product_of_exactly_the_byte_bound() -> None:
    product = "é" * (MAX_PRODUCT_BYTES // 2)

    payload = new_categorizations_payload(
        analysis_attempt_id=VALID_ANALYSIS_ATTEMPT_ID, rows=[replace(BURGER, product=product)]
    )

    assert payload["rows"][0]["product"] == product


# Each mirrors a fixture under `invalid/new-categorizations.*`, bar the shape violations the type
# checker catches on this side.
@pytest.mark.parametrize(
    ("analysis_attempt_id", "rows"),
    [
        pytest.param("not-a-uuid", [BURGER], id="analysis-attempt-id-not-a-uuid"),
        pytest.param(
            VALID_ANALYSIS_ATTEMPT_ID,
            [BURGER, replace(BURGER, category="Beef and Buffalo Meat")],
            id="duplicate-product",
        ),
        pytest.param(
            VALID_ANALYSIS_ATTEMPT_ID, [replace(BURGER, category="")], id="blank-category"
        ),
        pytest.param(
            VALID_ANALYSIS_ATTEMPT_ID,
            [replace(BURGER, category="Plant-based Meats ")],
            id="category-not-stripped",
        ),
        pytest.param(VALID_ANALYSIS_ATTEMPT_ID, [replace(BURGER, product="")], id="blank-product"),
        pytest.param(
            VALID_ANALYSIS_ATTEMPT_ID,
            [replace(BURGER, product="é" * (MAX_PRODUCT_BYTES // 2 + 1))],
            id="product-over-max-bytes",
        ),
        pytest.param(
            VALID_ANALYSIS_ATTEMPT_ID,
            [replace(BURGER, product="\u3000Beyond Burger Patty 4oz")],
            id="product-not-stripped",
        ),
    ],
)
def test_new_categorizations_payload_refuses_what_the_parent_would(
    analysis_attempt_id: str, rows: list[NewCategorization]
) -> None:
    with pytest.raises(ContractError):
        new_categorizations_payload(analysis_attempt_id=analysis_attempt_id, rows=rows)


CLEAN_USAGE = LlmUsage(
    operation="clean",
    requested_model="gpt-4.1-mini",
    served_model="gpt-4.1-mini-2025-04-14",
    calls=412,
    requests=415,
    failed_requests=3,
    rate_limited_requests=2,
    truncated_calls=0,
    input_tokens=432_600,
    cached_input_tokens=380_160,
    output_tokens=3_296,
)
MATCH_USAGE = LlmUsage(
    operation="match",
    requested_model="gpt-4.1-mini",
    served_model="gpt-4.1-mini-2025-04-14",
    calls=396,
    requests=396,
    failed_requests=0,
    rate_limited_requests=0,
    truncated_calls=1,
    input_tokens=451_440,
    cached_input_tokens=418_176,
    output_tokens=2_772,
)
INPUT = InputSummary(
    rows=5210, kilograms=48213.5, unique_products=800, categorization_cache_entries=12000
)
CATEGORIZATION = CategorizationSummary(
    cache_raw_name_products=380,
    cache_cleaned_name_products=8,
    llm_matched_products=412,
    cache_no_match_products=21,
    llm_no_match_products=37,
    unrecognized_llm_answers=2,
    categorized_rows=4870,
    categorized_kilograms=45120.25,
)
REPORT = ReportSummary(
    quality_status="invalid",
    finding_counts=(
        FindingCount("date_distribution", "success", 1),
        FindingCount("missing_internal_months", "success", 1),
        FindingCount("outlier_line_items", "info", 2),
        FindingCount("outlier_line_items", "warning", 3),
        FindingCount("per_product_weight_bounds", "error", 1),
    ),
    total_co2e_kg=98123.5,
    co2e_kg_per_diner_or_meal=2.5,
    plant_pct_by_weight=41.2,
    plant_protein_pct_by_weight=None,
)
FINISHED = TelemetryState(
    # Out of order, as threads may report them.
    llm_usage={("match", "gpt-4.1-mini"): MATCH_USAGE, ("clean", "gpt-4.1-mini"): CLEAN_USAGE},
    input=INPUT,
    categorization=CATEGORIZATION,
    report=REPORT,
    stage_duration_ms={"read": 850, "categorize": 412000, "report": 3100, "pdf": 5200, "xlsx": 900},
)


def test_telemetry_payload_is_the_fixture() -> None:
    payload = telemetry_payload(FINISHED, peak_memory_kib=412345)

    assert payload == load("valid", "telemetry.json")


def test_telemetry_payload_of_a_run_killed_while_categorizing_is_the_fixture() -> None:
    state = TelemetryState(
        llm_usage={
            ("clean", "gpt-4.1-mini"): replace(
                CLEAN_USAGE,
                calls=97,
                requests=98,
                failed_requests=1,
                rate_limited_requests=1,
                input_tokens=101_850,
                cached_input_tokens=89_600,
                output_tokens=776,
            )
        },
        input=INPUT,
        stage_duration_ms={"read": 850},
    )

    payload = telemetry_payload(state, peak_memory_kib=298112)

    assert payload == load("valid", "telemetry.partial.json")


# The violations the child's own state can express, each mirroring a fixture under
# `invalid/telemetry.*`. Unknown fields and enum spellings are the type checker's to catch on this
# side, but a bool or a float where a count belongs gets past it.
def _usage(**changes: object) -> TelemetryState:
    return replace(FINISHED, llm_usage={("clean", "gpt-4.1-mini"): replace(CLEAN_USAGE, **changes)})


@pytest.mark.parametrize(
    "state",
    [
        pytest.param(_usage(input_tokens=2**31), id="input-tokens-overflow-an-integer"),
        pytest.param(
            _usage(input_tokens=True, cached_input_tokens=0), id="input-tokens-are-a-bool"
        ),
        pytest.param(
            replace(FINISHED, input=replace(INPUT, rows=5210.5)), id="fractional-input-rows"
        ),
        # Every count fits, but the cost computed from them does not.
        pytest.param(_usage(output_tokens=2**31 - 1), id="cost-overflows-an-integer"),
        pytest.param(_usage(requested_model="GPT 4.1 mini"), id="requested-model-not-a-model-id"),
        pytest.param(_usage(served_model=""), id="served-model-not-a-model-id"),
        pytest.param(_usage(calls=0), id="zero-calls"),
        pytest.param(_usage(rate_limited_requests=4), id="rate-limited-above-failed"),
        pytest.param(_usage(failed_requests=416), id="failed-above-requests"),
        pytest.param(_usage(failed_requests=2), id="successful-requests-above-calls"),
        pytest.param(_usage(truncated_calls=413), id="truncated-calls-above-calls"),
        pytest.param(_usage(cached_input_tokens=432_601), id="cached-input-tokens-above-input"),
        pytest.param(_usage(output_tokens=-1), id="negative-output-tokens"),
        pytest.param(
            replace(FINISHED, input=replace(INPUT, kilograms=-0.5)), id="negative-kilograms"
        ),
        pytest.param(
            replace(FINISHED, input=replace(INPUT, kilograms=float("inf"))),
            id="infinite-kilograms",
        ),
        pytest.param(replace(FINISHED, input=None, report=None), id="categorization-without-input"),
        pytest.param(
            replace(FINISHED, categorization=replace(CATEGORIZATION, llm_matched_products=411)),
            id="match-types-do-not-sum-to-unique-products",
        ),
        pytest.param(
            replace(FINISHED, categorization=replace(CATEGORIZATION, categorized_rows=5211)),
            id="categorized-rows-above-input-rows",
        ),
        pytest.param(replace(FINISHED, categorization=None), id="report-without-categorization"),
        pytest.param(
            replace(FINISHED, report=replace(REPORT, plant_pct_by_weight=100.5)),
            id="plant-pct-above-100",
        ),
        pytest.param(
            replace(FINISHED, report=replace(REPORT, plant_protein_pct_by_weight=-1.0)),
            id="plant-protein-pct-below-0",
        ),
        pytest.param(
            replace(FINISHED, report=replace(REPORT, total_co2e_kg=-1.0)), id="negative-co2e"
        ),
        pytest.param(
            replace(
                FINISHED,
                report=replace(
                    REPORT, finding_counts=(FindingCount("date_distribution", "success", 0),)
                ),
            ),
            id="zero-findings",
        ),
        pytest.param(
            replace(
                FINISHED,
                report=replace(REPORT, finding_counts=REPORT.finding_counts[:1] * 2),
            ),
            id="duplicate-quality-check-and-status",
        ),
        pytest.param(
            replace(FINISHED, stage_duration_ms={"read": 850, "report": 3100}), id="stage-skipped"
        ),
        pytest.param(
            replace(FINISHED, stage_duration_ms={"read": -1}), id="negative-stage-duration"
        ),
    ],
)
def test_telemetry_payload_refuses_what_the_parent_would(state: TelemetryState) -> None:
    with pytest.raises(ContractError):
        telemetry_payload(state, peak_memory_kib=412345)


def test_telemetry_payload_refuses_zero_peak_memory() -> None:
    with pytest.raises(ContractError):
        telemetry_payload(FINISHED, peak_memory_kib=0)


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
