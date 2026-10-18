from gbd_foodservice_insights.report.quality import ListedFinding, listed_findings, make_finding


def test_listed_findings_for_the_customer_carry_each_warning_and_its_samples_as_text() -> None:
    findings = [
        make_finding(
            stage="diagnostics",
            category="date_distribution",
            status="success",
            message="Dates look evenly spread.",
        ),
        make_finding(
            stage="diagnostics",
            category="month_over_month_total_volatility",
            status="warning",
            message="Found 1 month where the total changed by more than 50%.",
            sample_values=["Mar 2025", 2025],
        ),
        make_finding(
            stage="diagnostics",
            category="missing_internal_months",
            status="error",
            message="Found 1 missing internal month.",
        ),
    ]

    assert listed_findings(findings, show_successes=False) == (
        ListedFinding(
            quality_check="month_over_month_total_volatility",
            status="warning",
            message="Found 1 month where the total changed by more than 50%.",
            sample_values=("Mar 2025", "2025"),
        ),
        ListedFinding(
            quality_check="missing_internal_months",
            status="error",
            message="Found 1 missing internal month.",
            sample_values=(),
        ),
    )
