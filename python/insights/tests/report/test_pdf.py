from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
from gbd_foodservice_insights.report.pdf import (
    _wrap_text_lines,
    build_pdf_report,
)
from PyPDF2 import PdfReader


def test_wrap_text_lines_preserves_bullets_and_wraps_long_lines() -> None:
    wrapped = _wrap_text_lines(
        [
            "  • Warning: Found 1716 rows that are exact duplicates across the key report "
            "fields and the text needs to wrap onto another visual row to avoid collisions.",
            "      - Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149 times and should "
            "also wrap cleanly.",
        ],
        width=60,
    )

    assert len(wrapped) > 2
    assert wrapped[0].startswith("  • ")
    assert wrapped[1].startswith("    ")
    assert any(line.startswith("      - ") for line in wrapped)


def test_build_pdf_report_splits_long_quality_pages(tmp_path: Path) -> None:
    output_path = tmp_path / "quality-report.pdf"
    long_findings = [
        {
            "status": "warning",
            "message": (
                "Found duplicate line items across the report fields. This explanatory "
                "sentence is intentionally long so the rendered PDF needs multiple "
                "wrapped rows for each finding."
            ),
            "sample_values": [
                "Eggs Medium Av51g on 2024-07-01 00:00:00 appears 149 times and remains "
                "long enough to wrap.",
            ]
            * 5,
        }
        for _ in range(12)
    ]

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="warning",
        quality_summary={"by_status": {"warning": len(long_findings)}},
        missing_data_findings=long_findings,
    )

    reader = PdfReader(str(output_path))

    assert len(reader.pages) >= 4


def test_build_pdf_report_does_not_render_plot_captions(tmp_path: Path) -> None:
    output_path = tmp_path / "captionless-report.pdf"
    fig = plt.figure()

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[("This chart caption should not appear in the PDF output.", fig)],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    page_text = "\n".join(page.extract_text() or "" for page in reader.pages)

    assert "This chart caption should not appear in the PDF output." not in page_text


def test_build_pdf_report_places_quality_section_at_end(tmp_path: Path) -> None:
    output_path = tmp_path / "quality-last-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={},
        summary_stats={"Rows": 100},
        quality_status="warning",
        quality_summary={"by_status": {"warning": 1}},
        missing_data_findings=[{"status": "warning", "message": "Example quality finding"}],
    )

    reader = PdfReader(str(output_path))
    page_titles = [page.extract_text() or "" for page in reader.pages]

    assert "About This Report" in page_titles[-2]
    assert "Data Completeness & Quality" in page_titles[-1]


def test_build_pdf_report_renders_table_index_as_a_regular_column(tmp_path: Path) -> None:
    output_path = tmp_path / "table-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={
            "Category Template": pd.DataFrame(
                {"2024-01": [1714.378], "total": [5577.653]},
                index=pd.Index(["Beef and Buffalo Meat"], name="category"),
            )
        },
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    page_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    # PDF text extraction can insert spurious spaces inside words because glyph
    # spacing differs across platforms (some words come back split on Linux CI
    # runners), so assert against the text with all whitespace removed.
    collapsed_text = "".join(page_text.split())

    assert "CategoryTemplate" in collapsed_text
    assert "category" in collapsed_text.lower()
    assert "BeefandBuffaloMeat" in collapsed_text


def test_build_pdf_report_handles_long_decision_kpi_text(tmp_path: Path) -> None:
    output_path = tmp_path / "decision-kpi-report.pdf"

    build_pdf_report(
        output_path=str(output_path),
        title_info={
            "client": "test client",
            "baseline_pilot": "baseline",
            "procurement_serving": "procurement",
        },
        plots=[],
        tables={
            "Decision KPIs": pd.DataFrame(
                {
                    "Focus": ["Top 5 animal products share of animal-product emissions"],
                    "Share of Animal Emissions (%)": [38.8],
                    "Top Animal Products": [
                        "BEEF PATTY, GROUND 80/20, OZ BALL RAW BF SMASH, MEATLOAF, BEEF UNSLICED"
                    ],
                    "Top Products Kg CO2e": [168372],
                    "Total Animal Kg CO2e": [433448],
                }
            )
        },
        summary_stats={"Rows": 100},
        quality_status="pass",
        quality_summary={"by_status": {"success": 1}},
        missing_data_findings=[],
    )

    reader = PdfReader(str(output_path))
    assert output_path.exists()
    assert len(reader.pages) >= 4
