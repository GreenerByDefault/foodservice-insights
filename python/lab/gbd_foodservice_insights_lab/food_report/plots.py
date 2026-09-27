"""Exporting food-report charts to image files, for the lab's chart bundle."""

import re
from pathlib import Path

from matplotlib.figure import Figure


def _slugify_plot_label(value: str) -> str:
    """Convert plot labels into filesystem-safe filename stems."""
    collapsed = re.sub(r"\s+", " ", str(value)).strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "_", collapsed).strip("_")
    return slug[:80] or "plot"


def _figure_export_label(fig: Figure) -> str:
    """Return the best available human-readable label for a figure."""
    suptitle = getattr(fig, "_suptitle", None)
    if suptitle is not None:
        text = suptitle.get_text().strip()
        if text:
            return text

    for ax in fig.axes:
        title = ax.get_title().strip()
        if title:
            return title

    return ""


def export_report_plots(
    plots: list[tuple[str, Figure]],
    output_dir: str | Path,
    *,
    image_format: str = "png",
    dpi: int = 300,
) -> list[str]:
    """Save report plots as image files and return their absolute paths."""
    export_dir = Path(output_dir).resolve()
    export_dir.mkdir(parents=True, exist_ok=True)

    used_names: dict[str, int] = {}
    saved_paths: list[str] = []

    for index, (caption, fig) in enumerate(plots, start=1):
        base_label = caption.strip() or _figure_export_label(fig) or f"plot_{index:02d}"
        base_name = _slugify_plot_label(base_label)
        duplicate_count = used_names.get(base_name, 0) + 1
        used_names[base_name] = duplicate_count
        if duplicate_count > 1:
            base_name = f"{base_name}_{duplicate_count:02d}"

        output_path = export_dir / f"{index:02d}_{base_name}.{image_format}"
        fig.savefig(output_path, dpi=dpi, bbox_inches="tight")
        saved_paths.append(str(output_path.resolve()))

    return saved_paths
