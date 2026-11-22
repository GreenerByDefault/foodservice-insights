"""The words on the report's text pages, as lines for `text_pages.create_text_page`."""

from collections.abc import Sequence

from gbd_foodservice_insights.report.quality import Finding, listed_findings
from gbd_foodservice_insights.report.schema import (
    DiagnosticStatus,
    DinerOrMeal,
    QualityStatus,
    quality_status_from_findings,
    summarize_status_counts,
)

_QUALITY_STATUS_SENTENCES: dict[QualityStatus, str] = {
    "pass": "All automated data checks passed — your data looks complete and consistent.",
    "warning": (
        "Your data passed most checks, but a few things are worth noting. See the details below."
    ),
    "invalid": (
        "One or more data issues were found that may affect the accuracy of these results. "
        "Please review the notes below before sharing this report."
    ),
}

_STATUS_LABELS: dict[DiagnosticStatus, str] = {
    "success": "• Passed",
    "info": "• Note",
    "warning": "• Warning",
    "error": "• Issue",
}


def quality_lines(findings: Sequence[Finding], *, show_successes: bool) -> list[str]:
    """Turn the quality findings into plain lines for the PDF report. Without
    ``show_successes`` (the customer's report), only warnings and issues are listed, and notes
    are not counted."""
    counts = summarize_status_counts(findings)
    count_parts = [
        f"{count} {noun if count == 1 else plural}"
        for count, noun, plural in (
            (counts["success"], "passed", "passed"),
            (counts["info"] if show_successes else 0, "note", "notes"),
            (counts["warning"], "warning", "warnings"),
            (counts["error"], "issue", "issues"),
        )
        if count
    ]
    lines = [
        (
            "This section summarizes the automated checks run on your data before this report "
            "was produced."
        ),
        "",
        _QUALITY_STATUS_SENTENCES[quality_status_from_findings(findings)],
    ]
    if count_parts:
        lines.append("  " + "  ·  ".join(count_parts))

    listed = listed_findings(findings, show_successes=show_successes)
    if not listed:
        return [*lines, "", "No issues were detected."]

    lines += ["", "Check details:"]
    for finding in listed:
        lines.append(f"  {_STATUS_LABELS[finding.status]}:  {finding.message}")
        lines += [f"      - {value}" for value in finding.sample_values]
    return lines


def how_to_read_lines(diner_or_meal: DinerOrMeal | None) -> list[str]:
    """Introductory guide to reading the report, shown before the charts. `diner_or_meal` is
    `None` without headcounts."""
    comparing_months = (
        "Every figure in this report is a total. Totals rise and fall with how many people you "
        "serve, so compare months with that in mind."
        if diner_or_meal is None
        else f"The 'per {diner_or_meal}' figures are the most useful for comparing across "
        f"months, because they account for how many {diner_or_meal}s were served each month."
    )
    return [
        (
            "The charts in this report show your catering operation's food purchasing patterns "
            "and associated greenhouse gas footprint over the reporting period."
        ),
        "",
        "Key things to look for:",
        "  • Which food categories contribute most to your total greenhouse gas footprint.",
        "  • Which specific products are the biggest drivers within those categories.",
        "  • How purchasing volumes vary month to month.",
        "",
        comparing_months,
        "",
        (
            "The plant vs. animal breakdown shows the proportion of food purchased from "
            "plant-based vs. animal-based sources. Shifting this ratio is one of the most "
            "effective ways to reduce your greenhouse gas footprint."
        ),
        "",
        (
            "The top driver products are the ones you bought the most of by weight, which makes "
            "them a good place to start when planning menu changes. They are not ranked by "
            "carbon: a heavy, low-carbon item can outrank a lighter, high-carbon one."
        ),
    ]


REFERENCES_HEADING = "References"


def about_pages(diner_or_meal: DinerOrMeal | None) -> tuple[list[str], list[str]]:
    """The "About This Report" pages, split at a heading rather than wherever the first page
    fills. `diner_or_meal` is `None` without headcounts."""
    normalizing = (
        ""
        if diner_or_meal is None
        else f" Per-{diner_or_meal} figures account for this by normalizing against the number "
        f"of {diner_or_meal}s served."
    )
    first = [
        (
            "This report was produced by Greener By Default using procurement data provided by "
            "your organization."
        ),
        "",
        "What is procurement data?",
        (
            "  Procurement data records the food and ingredients your catering operation "
            "purchases. It captures what was ordered, not necessarily what was served or "
            "consumed by diners."
        ),
        "",
        "How are carbon figures calculated?",
        (
            "  Each food item is assigned to a high-level category (e.g. Poultry, Legumes, "
            "Dairy). A carbon emissions factor — measured in kg of CO₂e per kg of food — is then "
            "applied. These factors are drawn from Poore & Nemecek (2018), a peer-reviewed "
            "meta-analysis of life-cycle assessments. They cover emissions from production up to "
            "the farm gate, and do not include processing, transport, packaging, storage, or "
            "cooking."
        ),
        "",
        (
            "  Total carbon is the sum of (weight × emissions factor) across all items. This "
            "means two foods with the same weight can have very different greenhouse gas "
            "footprints depending on how they are produced."
        ),
    ]
    second = [
        "How should I interpret the monthly figures?",
        (
            "  Month-to-month variation is normal and expected. Purchasing volumes fluctuate with "
            "seasonal menus, catering events, term dates, and other operational factors."
            + normalizing
        ),
        "",
        "How should I use this report?",
        (
            "  The highest-carbon categories and products are the most impactful places to focus "
            "menu changes. Even modest reductions in high-carbon items can produce significant "
            "carbon savings at scale. Greener By Default can help you identify practical "
            "substitutions that maintain menu quality and diner satisfaction."
        ),
        "",
        "Figures in this report are relative to your own data. No external benchmark is applied.",
        "",
        REFERENCES_HEADING,
        (
            "  Poore, J., & Nemecek, T. (2018). Reducing food's environmental impacts through "
            "producers and consumers. Science, 360(6392), 987-992. "
            "https://doi.org/10.1126/science.aaq0216"
        ),
    ]
    return first, second
