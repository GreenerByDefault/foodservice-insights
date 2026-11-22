from gbd_foodservice_insights.report.pdf.content import quality_lines
from gbd_foodservice_insights.report.quality import Finding, make_finding
from gbd_foodservice_insights.report.schema import DiagnosticStatus


def _finding(
    status: DiagnosticStatus, message: str, *, sample_values: list[str] | None = None
) -> Finding:
    return make_finding(
        stage="test",
        category="date_distribution",
        status=status,
        message=message,
        sample_values=sample_values,
    )


def test_quality_lines_explain_an_invalid_status() -> None:
    assert quality_lines(
        [
            _finding("success", "All required columns present."),
            _finding("error", "Found 2 negative values in 'kilos_total'."),
        ],
        show_successes=True,
    ) == [
        "This section summarizes the automated checks run on your data before this report "
        "was produced.",
        "",
        "One or more data issues were found that may affect the accuracy of these results. "
        "Please review the notes below before sharing this report.",
        "  1 passed  ·  1 issue",
        "",
        "Check details:",
        "  • Passed:  All required columns present.",
        "  • Issue:  Found 2 negative values in 'kilos_total'.",
    ]


def test_quality_lines_for_the_customer_list_only_warnings_and_issues() -> None:
    assert quality_lines(
        [
            _finding("success", "All required columns present."),
            _finding("info", "GBD categories absent from data: ['Butter']"),
            _finding("warning", "Found 1 month with a large swing."),
        ],
        show_successes=False,
    ) == [
        "This section summarizes the automated checks run on your data before this report "
        "was produced.",
        "",
        "Your data passed most checks, but a few things are worth noting. See the details below.",
        "  1 passed  ·  1 warning",
        "",
        "Check details:",
        "  • Warning:  Found 1 month with a large swing.",
    ]


def test_quality_lines_for_the_customer_say_so_when_every_check_passed() -> None:
    assert quality_lines(
        [_finding("success", "All required columns present."), _finding("info", "A note.")],
        show_successes=False,
    ) == [
        "This section summarizes the automated checks run on your data before this report "
        "was produced.",
        "",
        "All automated data checks passed — your data looks complete and consistent.",
        "  1 passed",
        "",
        "No issues were detected.",
    ]


def test_quality_lines_list_at_most_20_findings_with_5_samples_each() -> None:
    findings = [
        _finding("warning", f"Warning {i}", sample_values=[f"sample {j}" for j in range(7)])
        for i in range(25)
    ]

    lines = quality_lines(findings, show_successes=True)

    assert lines[3] == "  25 warnings"
    details = lines[lines.index("Check details:") + 1 :]
    assert details[:6] == [
        "  • Warning:  Warning 0",
        *(f"      - sample {j}" for j in range(5)),
    ]
    assert len(details) == 20 * 6


def test_quality_lines_count_notes_for_the_data_scientist_with_singular_and_plural() -> None:
    def counts(*findings: Finding) -> str:
        return quality_lines(list(findings), show_successes=True)[3]

    assert counts(_finding("info", "a")) == "  1 note"
    assert counts(_finding("info", "a"), _finding("info", "b")) == "  2 notes"


def test_quality_lines_with_no_findings_say_nothing_was_detected() -> None:
    assert quality_lines([], show_successes=True)[2:] == [
        "All automated data checks passed — your data looks complete and consistent.",
        "",
        "No issues were detected.",
    ]
