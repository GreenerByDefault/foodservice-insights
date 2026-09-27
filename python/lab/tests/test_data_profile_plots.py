import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights_lab import data_profile_plots as plots


def _titles(figs: list[plt.Figure]) -> list[str]:
    titles = [ax.get_title() for fig in figs for ax in fig.axes]
    for fig in figs:
        plt.close(fig)
    return titles


class TestProfileDatePlots:
    """Tests for date-profile helper plots used in validation-style workflows."""

    def test_plot_date_value_counts_returns_figure_with_expected_labels(self):
        df = pd.DataFrame(
            {
                "date": ["2024-01-01", "2024-01-01", "2024-01-02"],
            }
        )

        fig = plots.plot_date_value_counts(df)

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 1
        assert fig.axes[0].get_title() == "Date Value Counts"
        assert fig.axes[0].get_xlabel() == "Date"
        assert fig.axes[0].get_ylabel() == "Counts"
        plt.close(fig)

    def test_plot_date_value_counts_returns_placeholder_when_date_column_missing(self):
        fig = plots.plot_date_value_counts(pd.DataFrame({"weight": [1.0, 2.0]}))

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 1
        assert fig.axes[0].texts[0].get_text() == "Date Value Counts"
        assert fig.axes[0].texts[1].get_text() == "Missing 'date' column."
        plt.close(fig)

    def test_plot_metric_by_date_returns_three_panel_figure(self):
        """Metric-by-date should build the three summary panels rather than silently omitting
        one.
        """
        df = pd.DataFrame(
            {
                "date": ["2024-01-01", "2024-01-01", "2024-01-02"],
                "kilos_total": [10.0, 14.0, 6.0],
            }
        )

        fig = plots.plot_metric_by_date(df, "kilos_total")

        assert isinstance(fig, plt.Figure)
        assert len(fig.axes) == 3
        assert [ax.get_title() for ax in fig.axes] == [
            "Mean kilos_total by date",
            "Median kilos_total by date",
            "Sum kilos_total by date",
        ]
        plt.close(fig)

    def test_plot_metric_by_date_raises_when_metric_column_missing(self):
        """Missing metric columns should fail clearly instead of returning an empty-looking
        chart.
        """
        df = pd.DataFrame({"date": ["2024-01-01", "2024-01-02"]})

        with pytest.raises(KeyError, match="kilos_total"):
            plots.plot_metric_by_date(df, "kilos_total")


EXTRACTED_ROWS = pd.DataFrame(
    {
        "date": ["2024-01-01", "2024-01-15", "2024-02-01"],
        "product": ["Apples", "Apples", "Pears"],
        "kilos_total": [10.0, 14.0, 6.0],
        "page": [1, 1, 2],
    }
)


def test_plot_metrics_by_date_profiles_each_numeric_column_but_the_pdf_page():
    assert _titles(plots.plot_metrics_by_date(EXTRACTED_ROWS)) == [
        "Mean kilos_total by date",
        "Median kilos_total by date",
        "Sum kilos_total by date",
    ]


@pytest.mark.parametrize(
    ("product_name_col", "expected"),
    [
        (None, []),
        ("product", ["Number of Unique Products by Month"]),
        ("not_a_column", []),
    ],
)
def test_plot_metrics_by_month_leads_with_unique_products_given_a_product_column(
    product_name_col, expected
):
    titles = _titles(plots.plot_metrics_by_month(EXTRACTED_ROWS, product_name_col))

    assert titles == [
        *expected,
        "Mean kilos_total by month",
        "Median kilos_total by month",
        "Sum kilos_total by month",
    ]


@pytest.mark.parametrize(
    ("client_name", "title"),
    [
        (None, "Distribution of Food Categories"),
        ("acme_foods", "Distribution Of Food Categories In Acme Foods"),
    ],
)
def test_plot_category_distribution_titles_by_client(client_name, title):
    df = pd.DataFrame({"category": ["Fruit", "Fruit", "Legumes"]})

    fig = plots.plot_category_distribution(df, client_name)

    assert fig.axes[0].get_title() == title
    plt.close(fig)


def test_plot_category_distribution_returns_placeholder_when_category_column_missing():
    fig = plots.plot_category_distribution(pd.DataFrame({"product": ["Apples"]}))

    assert [text.get_text() for text in fig.axes[0].texts] == [
        "Category Distribution",
        "Missing 'category' column.",
    ]
    plt.close(fig)
