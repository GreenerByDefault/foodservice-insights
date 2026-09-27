import warnings
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from gbd_foodservice_insights.categories import (
    get_drink_categories,
    get_food_categories,
)
from gbd_foodservice_insights.plotting_utils import (
    GBD_colors,
    add_grid,
    format_month_labels,
    set_suptitle_font,
    set_title_font,
)
from gbd_foodservice_insights.report.plots import prepare_monthly_trend_data

from gbd_foodservice_insights_lab.plotting_extras import (
    PERIOD_COLORS,
    clean_category_label,
    create_category_subplot_grid,
    plot_time_series_with_periods,
    update_legend_to_title_case,
)


def print_product_overlap_summary(overlap_dict: dict) -> None:
    """Print a formatted summary of the dict returned by calculate_product_overlap()."""
    print("\n" + "=" * 60)
    print("Product Name Overlap Analysis: Baseline vs Pilot")
    print("=" * 60)
    print(f"\nUnique products in baseline period: {overlap_dict['baseline_unique']:,}")
    print(f"Unique products in pilot period:    {overlap_dict['pilot_unique']:,}")
    print(f"Products appearing in both periods: {overlap_dict['overlap_count']:,}")
    print(f"\nOverlap percentage: {overlap_dict['overlap_percentage']:.1f}%")
    print(
        f"  ({overlap_dict['overlap_count']:,} / {overlap_dict['baseline_unique']:,} "
        "baseline products)"
    )
    print("\n" + "=" * 60)

    # Interpretation guidance
    if overlap_dict["overlap_percentage"] >= 80:
        print("✓ High overlap - Menu is fairly consistent between periods")
    elif overlap_dict["overlap_percentage"] >= 50:
        print("⚠ Moderate overlap - Some menu changes between periods")
    else:
        print("⚠ Low overlap - Significant menu changes between periods")
        print("  Consider whether metric changes reflect intervention or menu shifts")
    print("=" * 60 + "\n")


def plot_kilos_per_diner_meal_pilot_changes_by_category(
    period_category_data: pd.DataFrame,
    figsize: tuple = (9, 9),
    title: str = "Changes in kilos of food per diner-meal from baseline to pilot, by Category",
    categories: list[str] | None = None,
) -> plt.Figure:
    """Plot a horizontal barplot of kilos per diner-meal by category, grouped by period.

    `period_category_data` needs 'category', 'kilos per diner-meal', and 'period' columns.
    Category labels are cleaned with clean_GBD_category_name() if available, otherwise shown
    as-is. `categories` sets which to include, in display order (top to bottom); None includes
    all, sorted by kilos per diner-meal.
    """

    fig, ax = plt.subplots(figsize=figsize)

    # Filter data if specific categories are provided
    if categories is not None:
        period_category_data = period_category_data[
            period_category_data["category"].isin(categories)
        ].copy()
        # Use the provided list order (top to bottom)
        sorted_categories = categories
    elif pd.api.types.is_categorical_dtype(period_category_data["category"]):
        sorted_categories = period_category_data["category"].cat.categories
    else:
        # Sort categories by kilos per diner-meal for consistent ordering
        sorted_categories = period_category_data.sort_values(
            "kilos per diner-meal", ascending=False
        )["category"]

    sns.barplot(
        data=period_category_data,
        y="category",
        x="kilos per diner-meal",
        hue="period",
        order=sorted_categories,
        ax=ax,
    )

    cleaned_labels = [clean_category_label(label.get_text()) for label in ax.get_yticklabels()]
    ax.set_yticklabels(cleaned_labels, fontsize=10)

    set_title_font(ax, title, fontsize=14, y=1.05)
    ax.set_xlabel("Kilos of food per diner-meal", fontsize=12)
    ax.set_ylabel("")

    ax.legend(loc="lower right")
    update_legend_to_title_case(ax)

    plt.tight_layout()
    return fig


def plot_category_trends(
    monthly_category_data: pd.DataFrame,
    per_diner_meal: bool = True,
    compare_baseline_pilot: bool = True,
    figsize_per_plot: tuple = (5, 3),
    diner_or_meal: str = "diner-meal",
) -> plt.Figure:
    """Plot line graphs showing category trends over time, with separate plots for each category.

    Each subplot shows the % deviation from that category's mean, not raw kilos.

    `monthly_category_data` needs 'month_year', 'category', and either 'kilos per diner-meal'
    (when `per_diner_meal` is True) or 'kilos_total' (when it is False). It also needs 'period'
    when `compare_baseline_pilot` is True. With `compare_baseline_pilot=False`, all rows are
    plotted as a single baseline period. `diner_or_meal` ("diner", "meal", or "diner-meal") only
    changes the overall title.
    """
    data = monthly_category_data.copy()

    # Determine the metric to plot
    if per_diner_meal:
        if "kilos per diner-meal" not in data.columns:
            raise ValueError(
                "When per_diner_meal=True, monthly_category_data must contain "
                "'kilos per diner-meal' column. Use aggregate_by(..., per_diner_meal=True) "
                "to create this column."
            )
        metric = "kilos per diner-meal"
    else:
        if "kilos_total" not in data.columns:
            raise ValueError(
                "When per_diner_meal=False, monthly_category_data must contain "
                "'kilos_total' column."
            )
        metric = "kilos_total"

    all_months = sorted(data["month_year"].unique())

    # Handle period column based on mode
    if compare_baseline_pilot:
        if "period" not in data.columns:
            raise ValueError(
                "compare_baseline_pilot=True requires 'period' column in monthly_category_data"
            )
        all_periods = sorted(data["period"].unique())
    else:
        # For baseline-only, create a dummy period
        data["period"] = "baseline"
        all_periods = ["baseline"]

    categories = sorted(data["category"].unique())

    # Handle empty categories case
    if len(categories) == 0:
        fig, ax = plt.subplots(figsize=figsize_per_plot)
        ax.text(0.5, 0.5, "No categories found in data", ha="center", va="center", fontsize=12)
        ax.axis("off")
        plt.tight_layout()
        return fig

    # Define plotting function for each category subplot
    def plot_category_trend(
        ax: plt.Axes,
        category_data: pd.DataFrame,
        category_name: str,
        metric: str,
        all_months: list,
        all_periods: list,
    ) -> None:
        # Calculate mean across all periods for this category
        category_mean = category_data[metric].mean()

        # Plot each period separately
        for period in all_periods:
            period_data = category_data[category_data["period"] == period].sort_values("month_year")

            # Create a complete dataframe with all months for this period
            complete_data = pd.DataFrame({"month_year": all_months})
            complete_data["period"] = period

            # Merge with actual data
            complete_data = complete_data.merge(
                period_data[["month_year", metric]], on="month_year", how="left"
            )

            # Calculate percentage deviation from mean
            complete_data["pct_deviation"] = (
                (complete_data[metric] - category_mean) / category_mean
            ) * 100

            # Convert Period to string for plotting if needed
            x_values = complete_data["month_year"]
            if pd.api.types.is_period_dtype(x_values):
                x_values = x_values.astype(str)

            ax.plot(
                x_values,
                complete_data["pct_deviation"],
                marker="o",
                label=period.title(),
                color=PERIOD_COLORS.get(period, "gray"),
                linewidth=2,
                markersize=6,
            )

        clean_name = clean_category_label(category_name)

        set_title_font(ax, clean_name, fontsize=10, fontweight="bold")
        ax.set_xlabel("Month", fontsize=9)
        ylabel = "% Deviation from Mean"
        ax.set_ylabel(ylabel, fontsize=9)

        # Add horizontal line at 0 to show the mean
        ax.axhline(y=0, color="gray", linestyle="--", linewidth=1, alpha=0.5)

        # Only show legend if comparing multiple periods
        if len(all_periods) > 1:
            ax.legend(fontsize=8)

        formatted_labels = format_month_labels(all_months)
        ax.set_xticks(range(len(all_months)))
        ax.set_xticklabels(formatted_labels, rotation=45, fontsize=8)

        ax.tick_params(axis="y", labelsize=8)
        add_grid(ax, alpha=0.3, linestyle="--")

    # Use the helper to create the subplot grid
    fig = create_category_subplot_grid(
        categories=categories,
        monthly_data=data,
        plot_func=plot_category_trend,
        n_cols=4,
        figsize_per_plot=figsize_per_plot,
        metric=metric,
        all_months=all_months,
        all_periods=all_periods,
    )

    # Add overall title based on parameters
    metric_str = f"per {diner_or_meal.capitalize()}" if per_diner_meal else "Total"
    set_suptitle_font(
        fig, f"Category Trends by Month ({metric_str})", fontsize=14, fontweight="bold", y=1.00
    )

    plt.tight_layout()
    return fig


def _plot_baseline_pilot_split(
    plant_percentages: pd.Series | None,
    plant_label: str,
    animal_label: str,
    xlabel: str,
    figsize: tuple = (10, 3),
    title: str = "Plant-Based vs. Animal Distribution",
    legend_y: float = 1.25,
    allow_none: bool = False,
) -> plt.Figure | None:
    """Plot stacked horizontal bars of plant vs animal percentages for baseline and pilot periods.

    Shared by plot_plant_animal_split() and plot_milk_split(). `plant_percentages` has period as
    index and plant percentage as values. `plant_label` and `animal_label` are e.g. 'Plant-Based'
    and 'Animal', or 'Plant-Based Milk' and 'Dairy Milk'. Returns None when `plant_percentages`
    is None and `allow_none` is True.
    """
    if plant_percentages is None:
        if allow_none:
            print(f"Skipping {title} - no data available")
            return None
        else:
            raise ValueError("plant_percentages cannot be None")

    # Calculate animal percentages (complement of plant percentages)
    animal_percentages = 100 - plant_percentages

    # Create DataFrame for plotting
    plot_data = pd.DataFrame({plant_label: plant_percentages, animal_label: animal_percentages})

    # Ensure we have both baseline and pilot
    if "baseline" not in plot_data.index or "pilot" not in plot_data.index:
        raise ValueError("plant_percentages must contain both 'baseline' and 'pilot' periods")

    # Reorder to have baseline on top, pilot on bottom
    plot_data = plot_data.loc[["baseline", "pilot"]]

    # Create figure
    fig, ax = plt.subplots(figsize=figsize)

    # Bar height and positions
    bar_height = 0.4
    y_positions = [0.7, 0.2]  # baseline on top, pilot on bottom

    # Plot stacked bars
    for i, (_period, row) in enumerate(plot_data.iterrows()):
        # Plant-based bar (left side)
        ax.barh(
            y_positions[i],
            row[plant_label],
            height=bar_height,
            color=GBD_colors[1],  # Green
            label=plant_label if i == 0 else "",
        )

        # Animal bar (right side, stacked)
        ax.barh(
            y_positions[i],
            row[animal_label],
            height=bar_height,
            left=row[plant_label],
            color=GBD_colors[0],  # Blue
            label=animal_label if i == 0 else "",
        )

        # Add percentage labels on bars
        # Plant-based label
        if row[plant_label] >= 1:
            text_x = row[plant_label] / 2 if row[plant_label] >= 5 else 2.5
            ax.text(
                text_x,
                y_positions[i],
                f"{row[plant_label]:.1f}%",
                ha="center",
                va="center",
                color="white",
                fontweight="bold",
                fontsize=11,
            )

        # Animal label
        if row[animal_label] >= 1:
            ax.text(
                row[plant_label] + row[animal_label] / 2,
                y_positions[i],
                f"{row[animal_label]:.1f}%",
                ha="center",
                va="center",
                color="white",
                fontweight="bold",
                fontsize=11,
            )

    # Customize axes
    ax.set_yticks(y_positions)
    ax.set_yticklabels(["Baseline", "Pilot"], fontsize=11)
    ax.set_xlim(0, 100)
    ax.set_xticks([0, 20, 40, 60, 80, 100])
    ax.set_xticklabels([f"{x}%" for x in [0, 20, 40, 60, 80, 100]])
    ax.set_xlabel(xlabel, fontsize=12)

    # Remove spines and add grid
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.grid(axis="x", linestyle="--", alpha=0.3)

    # Add title and legend
    set_title_font(ax, title, fontsize=14, y=1.15, pad=20)
    ax.legend(
        loc="upper center", bbox_to_anchor=(0.5, legend_y), ncol=2, frameon=False, fontsize=11
    )

    plt.tight_layout()

    return fig


def plot_plant_animal_split(
    plant_percentages: pd.Series,
    figsize: tuple = (10, 3),
    title: str = "Plant-Based vs. Animal Protein Distribution",
) -> plt.Figure:
    """Plot stacked horizontal bars of plant-based vs. animal protein for baseline and pilot.

    `plant_percentages` is the output of plant_animal_split(): period as index, plant percentage
    as values.
    """
    figure = _plot_baseline_pilot_split(
        plant_percentages=plant_percentages,
        plant_label="Plant-Based",
        animal_label="Animal",
        xlabel="Percentage of protein products by weight",
        figsize=figsize,
        title=title,
        legend_y=1.25,
        allow_none=False,
    )
    if figure is None:
        raise AssertionError("Plant/animal percentages unexpectedly produced no figure")
    return figure


def plot_kilos_over_time(
    monthly_category_data: pd.DataFrame,
    per_diner_meal: bool = False,
    diner_meal_data: pd.DataFrame | None = None,
    diner_meal_mapping: dict | None = None,
    compare_baseline_pilot: bool = True,
    figsize: tuple = (12, 4),
    title: str | None = None,
) -> plt.Figure:
    """Plot total kilos or kilos per diner-meal over time, baseline-only or baseline vs pilot.

    `monthly_category_data` needs 'month_year', 'kilos_total', and 'category', plus 'period' when
    `compare_baseline_pilot` is True.

    With `per_diner_meal`, kilos are divided by the diner-meal count. That needs `diner_meal_data`
    (columns 'month_year', 'diner-meals', 'period') when `compare_baseline_pilot` is True, or
    `diner_meal_mapping` (month_year to diner-meal count) when it is False. A ValueError is
    raised if the needed one is None. `title` of None picks a default for the mode.
    """
    if compare_baseline_pilot:
        # Baseline + Pilot comparison mode
        # Aggregate kilos by month and period
        monthly_totals = monthly_category_data.groupby(["month_year", "period"], as_index=False)[
            "kilos_total"
        ].sum()
        monthly_totals.rename(columns={"kilos_total": "total_kilos"}, inplace=True)

        if per_diner_meal:
            if diner_meal_data is None:
                raise ValueError(
                    "diner_meal_data is required when per_diner_meal=True and "
                    "compare_baseline_pilot=True"
                )

            # Merge with diner-meal data
            monthly_totals = pd.merge(
                monthly_totals,
                diner_meal_data[["month_year", "diner-meals", "period"]],
                on=["month_year", "period"],
                how="inner",
            )
            monthly_totals["value"] = monthly_totals["total_kilos"] / monthly_totals["diner-meals"]
            y_label = "Kilos per Diner-Meal"
            default_title = "Monthly Kilos per Diner-Meal Over Time by Period"
        else:
            monthly_totals["value"] = monthly_totals["total_kilos"]
            y_label = "Total Kilos"
            default_title = "Total Kilos Over Time by Period"

        # Convert to datetime for plotting
        monthly_totals["month_year"] = pd.to_datetime(monthly_totals["month_year"])

        return plot_time_series_with_periods(
            data=monthly_totals,
            y_col="value",
            y_label=y_label,
            title=title or default_title,
            figsize=figsize,
            ylim_padding_factor=0.1,
            marker="o",
            markersize=8,
            linewidth=2,
        )
    else:
        # Single period mode (baseline only)
        if per_diner_meal:
            if diner_meal_mapping is None:
                raise ValueError(
                    "diner_meal_mapping is required when per_diner_meal=True and "
                    "compare_baseline_pilot=False"
                )

            return plot_metric_over_time(
                monthly_category_data=monthly_category_data,
                metric="kilos_total",
                per_diner_meal=True,
                diner_meal_mapping=diner_meal_mapping,
                custom_title=title,
                figsize=figsize,
            )
        else:
            return plot_metric_over_time(
                monthly_category_data=monthly_category_data,
                metric="kilos_total",
                per_diner_meal=False,
                custom_title=title,
                figsize=figsize,
            )


def plot_kilos_per_diner_meal_over_time(
    monthly_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame | None = None,
    diner_meal_mapping: dict | None = None,
    compare_baseline_pilot: bool = True,
    figsize: tuple = (12, 4),
    title: str | None = None,
    diner_or_meal: str = "diner-meal",
) -> plt.Figure:
    """Plot kilos of food per diner-meal over time, optionally comparing baseline and pilot periods.

    A wrapper around plot_kilos_over_time with per_diner_meal=True: `diner_meal_data` (columns
    'month_year', 'diner-meals', 'period') is required when `compare_baseline_pilot`, else
    `diner_meal_mapping` (month_year to diner-meal count); ValueError if it is missing.
    `monthly_category_data` needs 'month_year', 'kilos_total', and 'category', plus 'period'
    when comparing periods.
    """
    if title is None:
        if compare_baseline_pilot:
            title = f"Kilos of Food per {diner_or_meal.capitalize()} Over Time by Period"
        else:
            title = f"Kilos of Food per {diner_or_meal.capitalize()} Over Time"

    return plot_kilos_over_time(
        monthly_category_data=monthly_category_data,
        per_diner_meal=True,
        diner_meal_data=diner_meal_data,
        diner_meal_mapping=diner_meal_mapping,
        compare_baseline_pilot=compare_baseline_pilot,
        figsize=figsize,
        title=title,
    )


def plot_diner_meal_numbers_over_time(
    diner_meal_data: pd.DataFrame,
    figsize: tuple = (12, 4),
    title: str | None = None,
    diner_or_meal: str = "diner-meal",
    baseline_only: bool = True,
) -> plt.Figure:
    """Plot diner-meal numbers over time, comparing baseline and pilot periods.

    `diner_meal_data` needs 'month_year', 'diner-meals', and 'period' columns. `diner_or_meal` and
    `baseline_only` (which drops "by Period") only affect the default title.
    """
    # Generate title if not provided
    if title is None:
        if baseline_only:
            title = f"{diner_or_meal.capitalize()} Numbers Over Time"
        else:
            title = f"{diner_or_meal.capitalize()} Numbers Over Time by Period"

    return plot_time_series_with_periods(
        data=diner_meal_data,
        y_col="diner-meals",
        y_label="Number of Diner-Meals",
        title=title,
        figsize=figsize,
        ylim_padding_factor=0.1,
        marker="o",
        markersize=8,
        linewidth=2,
    )


def plot_unique_products_over_time(
    monthly_product_data: pd.DataFrame,
    compare_baseline_pilot: bool = True,
    figsize: tuple = (12, 6),
    title: str | None = None,
) -> plt.Figure:
    """Plot the number of unique products over time, optionally comparing baseline and pilot.

    `monthly_product_data` needs 'month_year' (a string like '2024-01') and 'product', plus
    'period' when `compare_baseline_pilot`. `title` of None picks a default for the mode.
    """
    data = monthly_product_data.copy()

    if compare_baseline_pilot:
        # Convert month_year to datetime for proper plotting
        data["month_year"] = pd.to_datetime(data["month_year"], format="%Y-%m")

        # Count unique products per month and period
        monthly_product_counts = (
            data.groupby(["month_year", "period"])["product"].nunique().reset_index()
        )
        monthly_product_counts.rename(
            columns={"product": "Number of Unique Products"}, inplace=True
        )

        # Use the helper function for standardized plotting
        return plot_time_series_with_periods(
            data=monthly_product_counts,
            y_col="Number of Unique Products",
            y_label="Number of Unique Products",
            title=title or "Number of Unique Products per Month",
            figsize=figsize,
            ylim_padding_factor=0.1,
            marker="o",
            markersize=8,
            linewidth=2,
        )
    else:
        # Single period plotting
        monthly_product_counts = data.groupby("month_year")["product"].nunique().reset_index()
        monthly_product_counts.rename(columns={"product": "n_unique_products"}, inplace=True)

        # Convert 'month_year' to Period objects for proper sorting, then to string for plotting
        # This handles cases where 'month_year' might be strings like '2023-01'
        try:
            # Create a temporary series for sorting
            month_year_series = pd.Series(monthly_product_counts["month_year"].unique())
            # Attempt conversion to datetime, then to period, then sort
            sorted_unique_months = pd.to_datetime(month_year_series).dt.to_period("M").sort_values()
            # Use the sorted string representation as categories
            monthly_product_counts["month_year_cat"] = pd.Categorical(
                monthly_product_counts["month_year"],
                categories=sorted_unique_months.astype(str).unique(),
                ordered=True,
            )
            monthly_product_counts = monthly_product_counts.sort_values("month_year_cat")
        except Exception:  # Broad exception to catch various conversion/sorting issues
            # Fallback: simple string sort if advanced parsing fails
            unique_months = sorted(monthly_product_counts["month_year"].astype(str).unique())
            monthly_product_counts["month_year_cat"] = pd.Categorical(
                monthly_product_counts["month_year"].astype(str),
                categories=unique_months,
                ordered=True,
            )
            monthly_product_counts = monthly_product_counts.sort_values("month_year_cat")

        fig, ax = plt.subplots(figsize=figsize)

        sns.lineplot(
            data=monthly_product_counts,
            x="month_year",  # Use original month_year for labels
            y="n_unique_products",
            marker="o",
            markersize=8,
            linewidth=2,
            color=GBD_colors[0] if isinstance(GBD_colors, list) and GBD_colors else None,
            ax=ax,
        )

        set_title_font(ax, title or "Number of Unique Products per Month", fontsize=16)
        ax.set_xlabel("Month", fontsize=14)
        ax.set_ylabel("Number of Unique Products", fontsize=14)
        ymin, ymax = (
            monthly_product_counts["n_unique_products"].min(),
            monthly_product_counts["n_unique_products"].max(),
        )
        ax.set_ylim(ymin * 0.8, ymax * 1.2)

        ax.tick_params(axis="x", rotation=45)
        add_grid(ax)

    plt.tight_layout()
    return fig


def plot_unique_products_by_category(
    monthly_product_data: pd.DataFrame,
    figsize: tuple = (14, 6),
    title: str = "Unique Products per Category by Period",
) -> plt.Figure:
    """Plot a grouped bar chart of unique products per category for baseline and pilot periods.

    `monthly_product_data` needs 'category', 'product', and 'period' columns.
    """
    required_columns = {"category", "product", "period"}
    missing = required_columns - set(monthly_product_data.columns)
    if missing:
        raise ValueError(f"monthly_product_data is missing required columns: {missing}")

    data = monthly_product_data.copy()
    data["category"] = data["category"].astype(str)

    unique_counts = (
        data.groupby(["category", "period"])["product"]
        .nunique()
        .reset_index()
        .rename(columns={"product": "unique_products"})
    )

    category_order = (
        unique_counts.groupby("category")["unique_products"]
        .sum()
        .sort_values(ascending=False)
        .index
    )

    fig, ax = plt.subplots(figsize=figsize)
    sns.barplot(
        data=unique_counts,
        y="category",
        x="unique_products",
        hue="period",
        order=category_order,
        ax=ax,
        orient="h",
    )

    set_title_font(ax, title, fontsize=14)
    ax.set_ylabel("")
    ax.set_xlabel("Number Of Unique Products", fontsize=12)
    ax.tick_params(axis="y", labelsize=10)

    update_legend_to_title_case(ax)

    add_grid(ax, axis="x", alpha=0.4)

    plt.tight_layout()
    return fig


def print_plant_based_product_changes(product_comparison: pd.DataFrame) -> None:
    """Print a table of unique plant-based product count changes between baseline and pilot.

    `product_comparison` is the output of compare_plant_based_product_counts(), with columns
    including 'category', 'baseline_count', 'pilot_count', 'change', 'pct_change', and
    'increased'. If it also has 'products_added_count', 'products_removed_count',
    'products_added', and 'products_removed', the added and removed products per category are
    printed too. Output looks like:

        Plant-Based Unique Product Changes: Baseline → Pilot
        =====================================================

        Category                    Baseline  Pilot  Change  % Change  Status
        ------------------------------------------------------------------------
        beans & legumes                   5      8      +3    +60.0%   ✓ INCREASED
        tofu & tempeh                     2      2       0      0.0%   - No change
    """
    if product_comparison.empty:
        print("No plant-based product comparison data available.")
        return

    print("\nPlant-Based Unique Product Changes: Baseline → Pilot")
    print("=" * 80)
    print()
    has_detail_counts = {
        "products_added_count",
        "products_removed_count",
    }.issubset(product_comparison.columns)
    has_detail_lists = {
        "products_added",
        "products_removed",
    }.issubset(product_comparison.columns)

    if has_detail_counts:
        print(
            f"{'Category':<28} {'Baseline':>8} {'Pilot':>8} {'Net':>8} {'Added':>8} "
            f"{'Removed':>10} {'Status':>15}"
        )
        print("-" * 95)
    else:
        print(
            f"{'Category':<35} {'Baseline':>8} {'Pilot':>8} {'Change':>8} {'% Change':>10} "
            f"{'Status':>15}"
        )
        print("-" * 90)

    for _, row in product_comparison.iterrows():
        category = row["category"]
        baseline = int(row["baseline_count"])
        pilot = int(row["pilot_count"])
        change = int(row["change"])
        pct_change = row["pct_change"]
        increased = row["increased"]

        # Format change with sign
        change_str = f"{change:+d}" if change != 0 else "0"

        # Format percentage change
        pct_str = "N/A" if pd.isna(pct_change) else f"{pct_change:+.1f}%"

        # Status indicator
        if increased:
            status = "✓ Increased"
        elif change < 0:
            status = "↓ Decreased"
        else:
            status = "- No change"

        if has_detail_counts:
            added_count = int(row["products_added_count"])
            removed_count = int(row["products_removed_count"])
            print(
                f"{category:<28} {baseline:>8} {pilot:>8} {change_str:>8} {added_count:>8} "
                f"{removed_count:>10} {status:>15}"
            )
        else:
            print(
                f"{category:<35} {baseline:>8} {pilot:>8} {change_str:>8} {pct_str:>10} "
                f"{status:>15}"
            )

        if has_detail_lists:
            added_products = row["products_added"]
            removed_products = row["products_removed"]

            if added_products:
                print(f"  Added in pilot: {', '.join(added_products)}")
            if removed_products:
                print(f"  Removed after baseline: {', '.join(removed_products)}")
            if not added_products and not removed_products:
                print("  Product mix stayed the same within this category.")

    # Summary statistics
    total_increased = product_comparison["increased"].sum()
    total_decreased = (product_comparison["change"] < 0).sum()
    total_unchanged = (product_comparison["change"] == 0).sum()

    print()
    print(
        f"Summary: {total_increased} categories increased, {total_decreased} decreased, "
        f"{total_unchanged} unchanged"
    )
    print("         (Counting unique products in each category)")
    print()


def plot_milk_split(
    plant_milk_percentages: pd.Series | None,
    figsize: tuple = (10, 3),
    title: str = "Plant-Based vs. Dairy Milk Distribution",
) -> plt.Figure | None:
    """Plot stacked horizontal bars of plant-based vs. dairy milk for baseline and pilot periods.

    `plant_milk_percentages` is the output of calculate_plant_milk_percentage(): period as index,
    plant-based milk percentage as values. If it is None, returns None without plotting.
    """
    return _plot_baseline_pilot_split(
        plant_percentages=plant_milk_percentages,
        plant_label="Plant-Based Milk",
        animal_label="Dairy Milk",
        xlabel="Percentage of milk by weight",
        figsize=figsize,
        title=title,
        legend_y=1.08,
        allow_none=True,
    )


def print_baseline_pilot_percent_changes(
    monthly_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame,
    monthly_product_data: pd.DataFrame | None = None,
    weight_column: str = "kilos_total",
) -> dict:
    """Print topline percentage changes from baseline to pilot and return them.

    Covers diner-meals (total and per month), unique products (only if `monthly_product_data`
    is given), food, drink, and combined weight, and each of those per diner-meal. Required
    columns: `monthly_category_data` ['category', 'period', weight_column], `diner_meal_data`
    ['period', 'diner-meals'], `monthly_product_data` ['product', 'period']. The returned dict
    holds baseline, pilot, and percent change values for each metric.
    """
    required_category_cols = {"category", "period", weight_column}
    if not required_category_cols.issubset(monthly_category_data.columns):
        missing = required_category_cols - set(monthly_category_data.columns)
        raise ValueError(f"monthly_category_data is missing required columns: {missing}")

    required_diner_cols = {"period", "diner-meals"}
    if not required_diner_cols.issubset(diner_meal_data.columns):
        missing = required_diner_cols - set(diner_meal_data.columns)
        raise ValueError(f"diner_meal_data is missing required columns: {missing}")

    def _percent_change(baseline_value: float, pilot_value: float) -> float | None:
        if pd.isna(baseline_value) or pd.isna(pilot_value):
            return None
        if baseline_value == 0:
            return 0.0 if pilot_value == 0 else None
        return ((pilot_value - baseline_value) / baseline_value) * 100

    def _format_pct(pct: float | None) -> str:
        return f"{pct:.1f}%" if pct is not None else "N/A (baseline is 0)"

    def _aggregate_totals(df: pd.DataFrame) -> pd.Series:
        series = df.groupby("period")[weight_column].sum().reindex(["baseline", "pilot"]).fillna(0)
        if series.empty:
            series = pd.Series({"baseline": 0, "pilot": 0})
        return series

    diner_meal_totals = (
        diner_meal_data.groupby("period")["diner-meals"]
        .sum()
        .reindex(["baseline", "pilot"])
        .fillna(0)
    )

    # Calculate average diner-meals per month for each period
    diner_meals_per_month = (
        diner_meal_data.groupby("period")["diner-meals"]
        .mean()
        .reindex(["baseline", "pilot"])
        .fillna(0)
    )

    # Calculate unique products by period if monthly_product_data is provided
    if monthly_product_data is not None:
        unique_products = (
            monthly_product_data.groupby("period")["product"]
            .nunique()
            .reindex(["baseline", "pilot"])
            .fillna(0)
        )
    else:
        unique_products = pd.Series({"baseline": pd.NA, "pilot": pd.NA})

    monthly_category_data = monthly_category_data.copy()
    monthly_category_data["category"] = monthly_category_data["category"].str.lower()

    food_categories = set(get_food_categories(lowercase=True))
    drink_categories = set(get_drink_categories(lowercase=True))

    food_data = monthly_category_data[monthly_category_data["category"].isin(food_categories)]
    drink_data = monthly_category_data[monthly_category_data["category"].isin(drink_categories)]
    food_plus_drink_data = monthly_category_data[
        monthly_category_data["category"].isin(food_categories | drink_categories)
    ]

    food_totals = _aggregate_totals(food_data)
    drink_totals = _aggregate_totals(drink_data)
    food_drink_totals = _aggregate_totals(food_plus_drink_data)

    # Calculate per-diner-meal metrics
    def _calculate_per_diner_meal(weight_totals: pd.Series, diner_totals: pd.Series) -> pd.Series:
        """Calculate weight per diner-meal for each period."""
        result = weight_totals / diner_totals.replace(0, pd.NA)
        return result.fillna(0)

    food_per_diner_meal = _calculate_per_diner_meal(food_totals, diner_meal_totals)
    drink_per_diner_meal = _calculate_per_diner_meal(drink_totals, diner_meal_totals)
    food_drink_per_diner_meal = _calculate_per_diner_meal(food_drink_totals, diner_meal_totals)

    metrics = {
        "diner-meal numbers": {
            "baseline": diner_meal_totals.get("baseline", 0),
            "pilot": diner_meal_totals.get("pilot", 0),
        },
        "diner-meal numbers per month": {
            "baseline": diner_meals_per_month.get("baseline", 0),
            "pilot": diner_meals_per_month.get("pilot", 0),
        },
        "unique products": {
            "baseline": unique_products.get("baseline", 0),
            "pilot": unique_products.get("pilot", 0),
        },
        "total weight of food": {
            "baseline": food_totals.get("baseline", 0),
            "pilot": food_totals.get("pilot", 0),
        },
        "total weight of drink": {
            "baseline": drink_totals.get("baseline", 0),
            "pilot": drink_totals.get("pilot", 0),
        },
        "total weight of food plus drink": {
            "baseline": food_drink_totals.get("baseline", 0),
            "pilot": food_drink_totals.get("pilot", 0),
        },
        "food per diner-meal": {
            "baseline": food_per_diner_meal.get("baseline", 0),
            "pilot": food_per_diner_meal.get("pilot", 0),
        },
        "drink per diner-meal": {
            "baseline": drink_per_diner_meal.get("baseline", 0),
            "pilot": drink_per_diner_meal.get("pilot", 0),
        },
        "food and drink per diner-meal": {
            "baseline": food_drink_per_diner_meal.get("baseline", 0),
            "pilot": food_drink_per_diner_meal.get("pilot", 0),
        },
    }

    for _metric_name, values in metrics.items():
        pct = _percent_change(values["baseline"], values["pilot"])
        values["pct_change"] = pct

    def _format_value(value: float, unit: str) -> str:
        if pd.isna(value):
            return "N/A"
        if unit == "kg/diner-meal":
            return f"{value:,.2f}"
        elif unit == "kg" or unit == "diner-meals/month":
            return f"{value:,.1f}"
        return f"{value:,.0f}"

    def _format_pct_with_sign(pct: float | None) -> str:
        """Format percentage with + sign for positive values."""
        if pct is None:
            return "N/A"
        sign = "+" if pct >= 0 else ""
        return f"{sign}{pct:.1f}%"

    # Check for warnings and collect them
    warnings_list = []

    # Warning 1: Diner-meals per month change > 10%
    diner_meals_per_month_pct = metrics["diner-meal numbers per month"]["pct_change"]
    if diner_meals_per_month_pct is not None and abs(diner_meals_per_month_pct) > 10:
        warnings_list.append(
            f"⚠️  WARNING: Diner-meals per month changed by {diner_meals_per_month_pct:+.1f}% "
            "(threshold: ±10%)"
        )

    # Warning 2: Unique products change > 20%
    unique_products_pct = metrics["unique products"]["pct_change"]
    if unique_products_pct is not None and abs(unique_products_pct) > 20:
        warnings_list.append(
            f"⚠️  WARNING: Unique products changed by {unique_products_pct:+.1f}% (threshold: ±20%)"
        )

    # Warning 3: Food per diner-meal change > 20%
    food_per_diner_meal_pct = metrics["food per diner-meal"]["pct_change"]
    if food_per_diner_meal_pct is not None and abs(food_per_diner_meal_pct) > 20:
        warnings_list.append(
            f"⚠️  WARNING: Food per diner-meal changed by {food_per_diner_meal_pct:+.1f}% "
            "(threshold: ±20%)"
        )

    # Warning 4: Drink per diner-meal change > 20%
    drink_per_diner_meal_pct = metrics["drink per diner-meal"]["pct_change"]
    if drink_per_diner_meal_pct is not None and abs(drink_per_diner_meal_pct) > 20:
        warnings_list.append(
            f"⚠️  WARNING: Drink per diner-meal changed by {drink_per_diner_meal_pct:+.1f}% "
            "(threshold: ±20%)"
        )

    # Print formatted output
    print("\n" + "=" * 70)
    print("BASELINE VS PILOT TOPLINE CHANGES".center(70))
    print("=" * 70 + "\n")

    # Define metric display names
    display_names = {
        "diner-meal numbers": "Diner-Meal Numbers",
        "diner-meal numbers per month": "Diner-Meal Numbers per Month",
        "unique products": "Unique Products",
        "total weight of food": "Total Weight of Food",
        "total weight of drink": "Total Weight of Drink",
        "total weight of food plus drink": "Total Weight of Food + Drink",
        "food per diner-meal": "Food per Diner-Meal",
        "drink per diner-meal": "Drink per Diner-Meal",
        "food and drink per diner-meal": "Food + Drink per Diner-Meal",
    }

    # Calculate column widths for alignment
    max_name_len = max(len(name) for name in display_names.values())
    name_width = max(max_name_len, 30)

    # Print header
    print(f"{'Metric':<{name_width}}  {'Baseline':>15}  {'Pilot':>15}  {'Change':>12}")
    print("-" * (name_width + 45))

    # Print each metric
    for metric_name, values in metrics.items():
        display_name = display_names.get(metric_name, metric_name.title())
        baseline_value = values["baseline"]
        pilot_value = values["pilot"]

        # Determine unit based on metric name
        if metric_name == "diner-meal numbers":
            unit = "diner-meals"
        elif metric_name == "diner-meal numbers per month":
            unit = "diner-meals/month"
        elif metric_name == "unique products":
            unit = "products"
        elif "per diner-meal" in metric_name:
            unit = "kg/diner-meal"
        else:
            unit = "kg"

        baseline_str = f"{_format_value(baseline_value, unit)} {unit}"
        pilot_str = f"{_format_value(pilot_value, unit)} {unit}"
        pct_str = _format_pct_with_sign(values["pct_change"])

        print(f"{display_name:<{name_width}}  {baseline_str:>15}  {pilot_str:>15}  {pct_str:>12}")

    print("\n" + "=" * 70)

    # Print warnings if any
    if warnings_list:
        print("\n" + "!" * 70)
        print("DATA QUALITY WARNINGS".center(70))
        print("!" * 70)
        for warning in warnings_list:
            print(f"\n{warning}")
        print("\n" + "!" * 70)

    print("\n")

    return metrics


# ----------------------------------------------------------------------
# DEPRECATED FUNCTIONS
# ----------------------------------------------------------------------
# The following functions are deprecated and maintained only for backward compatibility.
# See individual docstrings for migration instructions.


def plot_monthly_category_trends(
    monthly_category_data: pd.DataFrame, per_diner_meal: bool = True
) -> plt.Figure:
    """DEPRECATED: removed. Use ``plot_category_trends(monthly_category_data, per_diner_meal=...)``.

    ``per_diner_meal=True`` (the default) needs a 'kilos per diner-meal' column in
    `monthly_category_data`.
    """
    warnings.warn(
        (
            "plot_monthly_category_trends() is deprecated and has been removed.\n"
            "Use plot_category_trends(monthly_category_data, per_diner_meal=True) instead."
        ),
        DeprecationWarning,
        stacklevel=2,
    )
    raise NotImplementedError(
        "plot_monthly_category_trends() has been removed. Use "
        "plot_category_trends(monthly_category_data, per_diner_meal=True) instead."
    )


def plot_category_per_diner_by_month(
    monthly_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame,
    category_type: str = "both",
    figsize_per_plot: tuple = (5, 3),
) -> plt.Figure:
    """DEPRECATED: removed. Use ``plot_category_trends(monthly_category_data)``.

    `plot_category_trends` takes no diner-meal data and no `category_type`. Before calling it,
    add a 'kilos per diner-meal' column to `monthly_category_data` (each row's 'kilos_total'
    divided by that month and period's 'diner-meals'), and filter it to the food or drink
    categories you want.
    """
    warnings.warn(
        (
            "plot_category_per_diner_by_month() is deprecated and has been removed.\n"
            "Use plot_category_trends(monthly_category_data) instead."
        ),
        DeprecationWarning,
        stacklevel=2,
    )
    raise NotImplementedError(
        "plot_category_per_diner_by_month() has been removed. Use plot_category_trends() "
        "instead. See docstring for migration guide."
    )


# Keep old function name as an alias for backward compatibility
def plot_kilos_per_diner_over_time(
    monthly_category_data: pd.DataFrame,
    diner_meal_data: pd.DataFrame | None = None,
    diner_meal_mapping: dict | None = None,
    compare_baseline_pilot: bool = True,
    figsize: tuple = (12, 4),
    title: str | None = None,
) -> plt.Figure:
    """
    DEPRECATED: Use plot_kilos_per_diner_meal_over_time() instead.

    This function is maintained for backward compatibility and calls
    plot_kilos_per_diner_meal_over_time().
    """
    return plot_kilos_per_diner_meal_over_time(
        monthly_category_data=monthly_category_data,
        diner_meal_data=diner_meal_data,
        diner_meal_mapping=diner_meal_mapping,
        compare_baseline_pilot=compare_baseline_pilot,
        figsize=figsize,
        title=title,
    )


def plot_metric_over_time(
    monthly_category_data: pd.DataFrame,
    metric: str = "kilos_total",
    per_diner_meal: bool = False,
    diner_meal_mapping: dict[Any, Any] | None = None,
    custom_title: str | None = None,
    figsize: tuple[int, int] = (10, 5),
) -> plt.Figure:
    """Line graph of total or per-diner metric over time."""
    if metric not in {"kilos_total", "servings total"}:
        raise ValueError("metric must be 'kilos_total' or 'servings total'")

    plot_data, metric_label = prepare_monthly_trend_data(
        monthly_category_data,
        metric,
        per_diner_meal=per_diner_meal,
        diner_meal_mapping=diner_meal_mapping,
    )

    plot_title = custom_title or f"{metric_label.title()} Over Time"
    fig = plot_time_series_with_periods(
        data=plot_data,
        y_col="value",
        y_label=metric_label.title(),
        title=plot_title,
        figsize=figsize,
        ylim_padding_factor=0.2,
        use_period_hue=False,
    )

    # Add a note if month-to-month variation is large (coefficient of variation > 25%)
    if "value" in plot_data.columns and len(plot_data) > 1:
        vals = plot_data["value"].dropna()
        mean_val = vals.mean()
        if mean_val > 0 and (vals.std() / mean_val) > 0.25:
            fig.text(
                0.5,
                0.01,
                (
                    "Note: month-to-month variation is normal and may reflect seasonal menus, "
                    "catering events, or changes in diner numbers."
                ),
                ha="center",
                va="bottom",
                fontsize=8,
                color="gray",
                style="italic",
            )

    return fig
