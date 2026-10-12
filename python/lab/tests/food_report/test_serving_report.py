from contextlib import nullcontext
from pathlib import Path
from typing import Any, NoReturn

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.errors import UnusableDataError
from gbd_foodservice_insights.report.food_report import ReportCharts
from gbd_foodservice_insights_lab.food_report import serving
from gbd_foodservice_insights_lab.food_report.serving import (
    SERVINGS,
    ServingReport,
    build_serving_report,
    serving_charts,
    write_serving_pdf,
    write_serving_workbook,
)
from matplotlib.figure import Figure

JAN, FEB, MAR = pd.period_range("2024-01", periods=3, freq="M")


def _rows(**columns: Any) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2024-01-15", "2024-01-20", "2024-02-15", "2024-02-20"]),
            "product": ["Ground Beef", "Lentils", "Ground Beef", "Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes", "Beef and Buffalo Meat", "Legumes"],
            "servings total": [10.0, 20.0, 12.0, 18.0],
        }
    ).assign(**columns)


def _build(rows: pd.DataFrame | None = None, **overrides: Any) -> ServingReport:
    kwargs: dict[str, Any] = {
        "diner_meal_mapping": {JAN: 100, FEB: 120},
        "diner_or_meal": "meal",
        "top_n_drivers": 5,
    }
    return build_serving_report(_rows() if rows is None else rows, **(kwargs | overrides))


# ----------------------------------------------------------------------
# build_serving_report
# ----------------------------------------------------------------------


def test_serving_report_counts_servings_per_meal_and_no_emissions():
    # March has a count but no rows, so it is not part of the data's total.
    report = _build(diner_meal_mapping={JAN: 100, FEB: 120, MAR: 500})

    assert report.metric == SERVINGS
    assert report.rows["month_year"].tolist() == [JAN, JAN, FEB, FEB]
    assert report.diner_meal_mapping == {JAN: 100.0, FEB: 120.0, MAR: 500.0}
    assert report.diner_meals_in_data == 220.0
    assert "emissions_kg_co2e" not in report.rows.columns
    pd.testing.assert_frame_equal(
        report.monthly_category,
        pd.DataFrame(
            {
                "month_year": [JAN, JAN, FEB, FEB],
                "category": ["Beef and Buffalo Meat", "Legumes"] * 2,
                "servings total": [10.0, 20.0, 12.0, 18.0],
                "servings per meal": [0.1, 0.2, 0.1, 0.15],
            }
        ),
    )
    assert list(report.monthly_product.columns) == [
        "month_year",
        "product",
        "servings total",
        "servings per meal",
    ]
    assert report.summary_stats == {
        "Total rows": "4",
        "Unique products": "2",
        "Date range": "Jan 2024 – Feb 2024",
        "Total meals": "220",
        "Data type": "Serving",
        "Plant-based (% of classified food)": "63.3%",
        "Animal-based (% of classified food)": "36.7%",
        "Plant-based total": "38.0 servings",
        "Animal-based total": "22.0 servings",
        "Plant protein share (% of protein categories)": "63.3%",
        "Plant protein total": "38.0 servings",
        "Protein-category total": "60.0 servings",
    }


def test_build_serving_report_leaves_the_callers_rows_alone():
    rows = _rows()

    _build(rows)

    pd.testing.assert_frame_equal(rows, _rows())


def test_summary_stats_leave_out_the_protein_lines_without_protein():
    report = _build(_rows(category=["Cheese", "Oat Milk", "Cheese", "Oat Milk"]))

    assert report.plant_protein_share is None
    assert report.summary_stats.keys().isdisjoint(
        {
            "Plant protein share (% of protein categories)",
            "Plant protein total",
            "Protein-category total",
        }
    )


def test_summary_stats_print_a_single_month_once():
    dates = pd.to_datetime(["2024-01-15", "2024-01-20", "2024-01-25", "2024-01-30"])

    report = _build(_rows(date=dates), diner_meal_mapping={JAN: 100})

    assert report.summary_stats["Date range"] == "Jan 2024"


def test_a_procurement_file_is_not_a_serving_report():
    rows = _rows().rename(columns={"servings total": "kilos_total"})

    with pytest.raises(ValueError, match=r"^Missing required columns: servings total$"):
        _build(rows)


def test_rows_that_count_no_servings_are_unusable():
    with pytest.raises(UnusableDataError, match="Every row has a servings total of 0"):
        _build(_rows(**{"servings total": 0.0}))


@pytest.mark.parametrize(
    ("mapping", "months"),
    [
        ({JAN: 100}, "2024-02"),
        ({JAN: 100, FEB: 0}, "2024-02"),
        ({JAN: float("nan")}, "2024-01, 2024-02"),
    ],
)
def test_a_data_month_without_a_positive_count_aborts(mapping: dict, months: str):
    with pytest.raises(ValueError, match=f"^No positive meal count for {months}$"):
        _build(diner_meal_mapping=mapping)


def test_findings_run_the_report_checks_in_order_in_servings():
    # Under 1 serving in January and over 1,000 in February, each a unit mistake that also
    # swings the monthly total; March, with one line, looks partial.
    dates = pd.date_range("2024-01-08", periods=9, freq="7D")
    rows = pd.DataFrame(
        {
            "date": dates,
            "product": ["Ground Beef", "Lentils"] * 4 + ["Lentils"],
            "category": ["Beef and Buffalo Meat", "Legumes"] * 4 + ["Legumes"],
            "servings total": [0.5, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 1200.0, 20.0],
        }
    )

    report = _build(rows, diner_meal_mapping={JAN: 100, FEB: 100, MAR: 100})

    assert [(finding["category"], finding["status"]) for finding in report.findings] == [
        ("month_over_month_total_volatility", "warning"),
        ("missing_internal_months", "success"),
        ("diner_meal_count_reasonableness", "success"),
        ("outlier_line_items", "warning"),
        ("per_product_weight_bounds", "warning"),
        ("date_distribution", "warning"),
    ]
    volatility, _, _, outlier, bounds, _ = report.findings
    assert volatility["message"].startswith("Found 2 months where the total servings changed")
    assert (
        "at 1,200 servings, 60.0x that category's typical line of 20 servings"
        in (outlier["message"])
    )
    assert bounds["message"] == (
        "Found 2 lines with a serving count above zero but under 1 serving, or over 1,000 "
        "servings, which usually means a unit mistake. For example, Ground Beef at 0.5 servings, "
        "below the lower bound of 1 serving."
    )


# ----------------------------------------------------------------------
# serving_charts
# ----------------------------------------------------------------------


def _title(figure: Figure) -> str:
    suptitle = figure.get_suptitle()
    return suptitle or figure.axes[0].get_title()


def test_serving_charts_title_every_page_in_servings_and_close_on_exit():
    with serving_charts(_build()) as charts:
        figures = [figure for _caption, figure in charts.figures]
        assert [_title(figure) for figure in figures] == [
            "Number of Meals by Month",
            "Servings Over Time",
            "Servings by Category Across All Months",
            "Plant and Protein Breakdown",
            "Top Products Driving Overall (Servings)",
            "Top Products by Category",
        ]

    assert not any(plt.fignum_exists(figure.number) for figure in figures)


def test_serving_charts_close_the_pages_already_drawn_when_one_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    def fail(*_args: object, **_kwargs: object) -> NoReturn:
        raise RuntimeError("chart boom")

    monkeypatch.setattr(serving, "plot_overall_drivers", fail)
    report = _build()
    open_before = plt.get_fignums()

    with pytest.raises(RuntimeError, match="chart boom"), serving_charts(report):
        pass

    assert plt.get_fignums() == open_before


# ----------------------------------------------------------------------
# write_serving_pdf
# ----------------------------------------------------------------------


class _RecordingPdf:
    """Stands in for ``PdfPages``, keeping each page's text instead of writing a file."""

    def __init__(self) -> None:
        self.pages: list[list[str]] = []

    def savefig(self, figure: Figure) -> None:
        self.pages.append([text.get_text() for ax in figure.axes for text in ax.texts])


@pytest.fixture
def recording_pdf(monkeypatch: pytest.MonkeyPatch) -> _RecordingPdf:
    pdf = _RecordingPdf()
    monkeypatch.setattr(serving, "PdfPages", lambda _path: nullcontext(pdf))
    return pdf


def _write_pdf(report: ServingReport, charts: ReportCharts, *, show_successes: bool) -> None:
    write_serving_pdf(
        report,
        charts,
        Path("report.pdf"),
        client_name="Acme",
        show_quality_successes=show_successes,
    )


def test_write_serving_pdf_summarises_as_key_values_without_the_procurement_prose(
    recording_pdf: _RecordingPdf,
):
    report = _build()
    chart, _ax = plt.subplots()

    _write_pdf(report, ReportCharts(figures=[("", chart)]), show_successes=False)
    plt.close(chart)

    # A chart page has no text of its own.
    titles = [page[0] if page else "" for page in recording_pdf.pages]
    assert titles == [
        "Food Report",
        "Executive Summary",
        "",
        "Category Template",
        "Data Completeness & Quality",
    ]
    assert recording_pdf.pages[0][:3] == ["Food Report", "Acme", "Serving"]
    assert recording_pdf.pages[1] == [
        "Executive Summary",
        *(f"{label}:  {value}" for label, value in report.summary_stats.items()),
        "Data Quality Status:  PASS",
    ]


@pytest.mark.parametrize("show_successes", [True, False])
def test_write_serving_pdf_lists_passed_checks_only_for_the_data_scientist(
    recording_pdf: _RecordingPdf, show_successes: bool
):
    _write_pdf(_build(), ReportCharts(figures=[]), show_successes=show_successes)

    quality_page = recording_pdf.pages[-1]
    assert any("Passed" in line for line in quality_page) == show_successes


# ----------------------------------------------------------------------
# write_serving_workbook
# ----------------------------------------------------------------------


def test_write_serving_workbook_has_no_emissions_tabs(tmp_path: Path):
    path = tmp_path / "serving.xlsx"

    write_serving_workbook(_build(), path)

    sheets = pd.read_excel(path, sheet_name=None)
    assert list(sheets) == ["Monthly by Product", "Monthly by Category", "Template", "Meals"]
    assert sheets["Monthly by Category"].columns.tolist() == [
        "month_year",
        "category",
        "servings total",
        "servings per meal",
    ]
    assert sheets["Template"].columns.tolist() == ["category", "2024-01", "2024-02", "total"]
    pd.testing.assert_frame_equal(
        sheets["Meals"], pd.DataFrame({"month_year": ["2024-01", "2024-02"], "meals": [100, 120]})
    )
