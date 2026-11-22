"""The report's PDF, its pages in order and numbered."""

import logging
from pathlib import Path

from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.figure import Figure

from gbd_foodservice_insights.plotting_utils import (
    BODY_FONT,
    GBD_MUTED,
    PAGE_FOOTER_HEIGHT,
    close_new_figures_on_error,
)
from gbd_foodservice_insights.report.food_report import FoodReport, ReportCharts, date_range_label
from gbd_foodservice_insights.report.pdf.content import (
    REFERENCES_HEADING,
    about_pages,
    how_to_read_lines,
    quality_lines,
)
from gbd_foodservice_insights.report.pdf.layout import PdfSink
from gbd_foodservice_insights.report.pdf.summary import (
    PageRefs,
    create_executive_summary_page,
    executive_narrative,
)
from gbd_foodservice_insights.report.pdf.tables import (
    create_animal_intensity_page,
    create_category_template_pages,
    create_substitution_scenarios_page,
)
from gbd_foodservice_insights.report.pdf.text_pages import (
    create_decision_kpis_page,
    create_text_page,
    create_title_page,
)
from gbd_foodservice_insights.report.schema import quality_status_from_findings

logger = logging.getLogger(__name__)


class _PageCollector:
    """Holds pages back, so the pages that refer to them can be written once their numbers are
    known."""

    def __init__(self) -> None:
        self.figures: list[Figure] = []

    def savefig(self, figure: Figure, /) -> None:
        self.figures.append(figure)


class _NumberedPdf:
    """Stamps a page number in the footer of each page after the title page."""

    def __init__(self, pdf: PdfSink) -> None:
        self._pdf = pdf
        self.page_count = 0

    def savefig(self, figure: Figure, /) -> None:
        self.page_count += 1
        if self.page_count == 1:
            self._pdf.savefig(figure)
            return
        # Removed after saving, because a chart figure belongs to the caller.
        number = figure.text(
            0.5,
            PAGE_FOOTER_HEIGHT / 2,
            str(self.page_count),
            ha="center",
            va="center",
            fontsize=9,
            fontfamily=BODY_FONT,
            color=GBD_MUTED,
        )
        try:
            self._pdf.savefig(figure)
        finally:
            number.remove()


def write_report_pdf(
    report: FoodReport,
    charts: ReportCharts,
    path: Path,
    *,
    client_name: str,
    show_quality_successes: bool,
) -> None:
    """Write the report's PDF. With ``show_quality_successes`` (the data scientist's report),
    the quality section lists passed checks and notes too; without it (the customer's), only
    warnings and issues."""
    quality_status = quality_status_from_findings(report.findings)
    aggregation = report.aggregation
    diner_or_meal = None if report.headcounts is None else report.headcounts.diner_or_meal

    with close_new_figures_on_error():
        body = _PageCollector()
        create_text_page(
            body,
            "Data Completeness & Quality",
            quality_lines(report.findings, show_successes=show_quality_successes),
        )
        create_text_page(body, "How to Read This Report", how_to_read_lines(diner_or_meal))

        for fig in charts.figures:
            body.savefig(fig)

        create_category_template_pages(body, aggregation.template)
        if aggregation.animal_emissions_intensity is not None:
            create_animal_intensity_page(body, aggregation.animal_emissions_intensity)
        if aggregation.animal_emissions_concentration is not None:
            create_decision_kpis_page(body, aggregation.animal_emissions_concentration)
        if aggregation.substitution_scenarios is not None:
            create_substitution_scenarios_page(body, aggregation.substitution_scenarios)

        methodology_index = len(body.figures)
        for title, lines in zip(
            ("About This Report", "About This Report (cont.)"),
            about_pages(diner_or_meal),
            strict=True,
        ):
            create_text_page(
                body,
                title,
                lines,
                bold_lines={
                    line for line in lines if line.endswith("?") or line == REFERENCES_HEADING
                },
            )

        with PdfPages(path) as pdf_pages:
            pdf = _NumberedPdf(pdf_pages)
            create_title_page(pdf, client_name, f"Procurement | {date_range_label(report.rows)}")
            # The summary takes the next page, and the body follows it.
            first_body_page = pdf.page_count + 2
            create_executive_summary_page(
                pdf,
                executive_narrative(report, client_name, quality_status),
                PageRefs(quality=first_body_page, methodology=first_body_page + methodology_index),
            )
            for fig in body.figures:
                pdf.savefig(fig)

    logger.info("PDF report saved to %s", path)
