"""Plots for eyeballing a client's rows before trusting a report: row counts per date, each
numeric column's mean, median and sum per date or month, and the category mix."""

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from gbd_foodservice_insights.plotting_utils import GBD_colors
from matplotlib.figure import Figure


def _placeholder_figure(title: str, message: str) -> Figure:
    """Create a placeholder figure when a plot cannot be generated."""
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.axis("off")
    ax.text(0.5, 0.72, title, ha="center", va="center", fontsize=14, fontweight="bold")
    ax.text(0.5, 0.42, message, ha="center", va="center", fontsize=11, wrap=True)
    return fig


def _numeric_columns_for_profile(df: pd.DataFrame) -> list[str]:
    """Numeric columns, less `page`: PDF extraction numbers the page each row came from."""
    numeric_columns = df.select_dtypes(include=[np.number]).columns.tolist()
    return [column for column in numeric_columns if column.lower() != "page"]


def plot_date_value_counts(
    df: pd.DataFrame,
    fig_size: tuple[int, int] = (8, 4),
) -> Figure:
    """Plot row counts per date."""
    _df = df.copy()
    if "date" not in _df.columns:
        return _placeholder_figure("Date Value Counts", "Missing 'date' column.")

    _df["date"] = pd.to_datetime(_df["date"], errors="coerce")
    date_counts = _df["date"].value_counts(dropna=False).sort_index()

    fig, ax = plt.subplots(figsize=fig_size)
    x_data = date_counts.index.to_numpy()
    y_data = date_counts.to_numpy()
    ax.plot(x_data, y_data, "-", linewidth=2)
    ax.scatter(x_data, y_data, s=50, zorder=2)
    ax.set_title("Date Value Counts")
    ax.set_xlabel("Date")
    if len(date_counts) > 0:
        ax.set_ylim(0, date_counts.max() * 1.1)
    ax.set_ylabel("Counts")
    ax.tick_params(axis="x", rotation=45)
    plt.tight_layout()
    return fig


def plot_metric_by_date(
    df: pd.DataFrame,
    metric_column: str,
    fig_size: tuple[int, int] = (8, 8),
) -> Figure:
    """Mean/median/sum subplots of a metric grouped by date."""
    _df = df.copy()
    _df["date"] = pd.to_datetime(_df["date"], errors="coerce")

    grouped_mean = _df.groupby("date", dropna=False)[metric_column].mean().reset_index()
    grouped_median = _df.groupby("date", dropna=False)[metric_column].median().reset_index()
    grouped_sum = _df.groupby("date", dropna=False)[metric_column].sum(min_count=1).reset_index()

    fig, axs = plt.subplots(3, figsize=fig_size)

    for idx, (grouped, stat) in enumerate(
        [(grouped_mean, "Mean"), (grouped_median, "Median"), (grouped_sum, "Sum")]
    ):
        color = GBD_colors[idx]
        sns.lineplot(
            data=grouped,
            x="date",
            y=metric_column,
            ax=axs[idx],
            linewidth=2,
            color=color,
        )
        sns.scatterplot(
            data=grouped,
            x="date",
            y=metric_column,
            ax=axs[idx],
            s=50,
            color=color,
            zorder=3,
        )
        axs[idx].set_title(f"{stat} {metric_column} by date")
        axs[idx].tick_params(axis="x", rotation=45)

    plt.tight_layout()
    return fig


def plot_metrics_by_date(df: pd.DataFrame) -> list[Figure]:
    """Plot date-level metrics for all numeric columns."""
    figs = []
    for metric_column in _numeric_columns_for_profile(df):
        figs.append(plot_metric_by_date(df, metric_column))
    return figs


def plot_metric_by_month(
    df: pd.DataFrame,
    metric_column: str,
    fig_size: tuple[int, int] = (12, 4),
) -> Figure:
    """Mean/median/sum of metric grouped by month."""
    df_copy = df.copy()
    df_copy["date"] = pd.to_datetime(df_copy["date"], errors="coerce").dt.strftime("%Y-%m")
    grouped = (
        df_copy.groupby("date", dropna=False)[metric_column]
        .agg(["mean", "median", "sum"])
        .reset_index()
    )

    fig, axes = plt.subplots(1, 3, figsize=fig_size)
    for idx, (stat, color) in enumerate(
        [("mean", GBD_colors[0]), ("median", GBD_colors[1]), ("sum", GBD_colors[2])]
    ):
        grouped.plot(x="date", y=stat, kind="line", ax=axes[idx], color=color, legend=False)
        axes[idx].set_title(f"{stat.title()} {metric_column} by month")
        axes[idx].set_xlabel("")
        axes[idx].set_ylabel("")
        axes[idx].tick_params(axis="x", rotation=45)

    plt.tight_layout()
    return fig


def plot_metrics_by_month(
    df: pd.DataFrame,
    product_name_col: str | None = None,
) -> list[Figure]:
    """Plot month-level metric profiles for numeric columns."""
    _df = df.copy()
    figs: list[Figure] = []

    if product_name_col and product_name_col in _df.columns:
        _df["month"] = pd.to_datetime(_df["date"], errors="coerce").dt.strftime("%Y-%m")
        unique_counts = _df.groupby("month", dropna=False)[product_name_col].nunique().reset_index()
        fig, ax = plt.subplots(figsize=(12, 4))
        ax.plot(
            unique_counts["month"], unique_counts[product_name_col], marker="o", color=GBD_colors[0]
        )
        ax.set_title("Number of Unique Products by Month")
        ax.set_xlabel("Month")
        ax.set_ylabel("Unique Count")
        ax.tick_params(axis="x", rotation=45)
        plt.tight_layout()
        figs.append(fig)

    for metric_column in _numeric_columns_for_profile(_df):
        figs.append(plot_metric_by_month(_df, metric_column))

    return figs


def plot_category_distribution(df: pd.DataFrame, client_name: str | None = None) -> Figure:
    """Horizontal bar chart of row distribution by category."""
    if "category" not in df.columns:
        return _placeholder_figure("Category Distribution", "Missing 'category' column.")

    category_counts = df["category"].value_counts(dropna=False).reset_index()
    category_counts.columns = ["Category", "Count"]
    category_counts = category_counts.sort_values("Count", ascending=False)

    fig, ax = plt.subplots(figsize=(14, 8))
    sns.set_style("whitegrid")
    sns.barplot(x="Count", y="Category", data=category_counts, ax=ax)

    title = "Distribution of Food Categories"
    if client_name:
        title = f"Distribution of Food Categories in {client_name}".replace("_", " ").title()
    ax.set_title(title, fontsize=16)
    ax.set_xlabel("Number of Rows in Data", fontsize=12)
    ax.set_ylabel("", fontsize=12)

    for i, value in enumerate(category_counts["Count"]):
        ax.text(value * 1.01, i, str(value), va="center")

    fig.tight_layout()
    return fig
