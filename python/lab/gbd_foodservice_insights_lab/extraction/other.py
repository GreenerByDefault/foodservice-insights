"""Legacy compatibility facade for tabular extraction helpers."""

from __future__ import annotations

import warnings
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from gbd_foodservice_insights_lab.extraction.tabular_inspection import RawDataFileReport
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    check_same_columns as _check_same_columns,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    compare_baseline_pilot_raw_data as _compare_baseline_pilot_raw_data,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    compare_component_datasets as _compare_component_datasets,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    detect_component_duplicate_risk as _detect_component_duplicate_risk,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    identify_low_cardinality_columns as _identify_low_cardinality_columns,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    raw_data_report as _raw_data_report,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    suggest_column_roles as _suggest_column_roles,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    suggest_date_source_and_coverage as _suggest_date_source_and_coverage,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    suggest_tabular_import_settings as _suggest_tabular_import_settings,
)
from gbd_foodservice_insights_lab.extraction.tabular_inspection import (
    validate_matching_columns as _validate_matching_columns,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    detect_excel_header_row as _detect_excel_header_row,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    detect_file_encoding as _detect_file_encoding,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    detect_single_multi_sheet_excel as _detect_single_multi_sheet_excel,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    experimental_excel_extraction_code as _experimental_excel_extraction_code,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    extract_dates_from_sheet_filenames as _extract_dates_from_sheet_filenames,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    extract_excel_sheet_info as _extract_excel_sheet_info,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    extract_month_year_from_filename as _extract_month_year_from_filename,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    filter_hidden_and_temp_files as _filter_hidden_and_temp_files,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    get_excel_headers as _get_excel_headers,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    get_filtered_data_files as _get_filtered_data_files,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    read_csv_with_auto_detection as _read_csv_with_auto_detection,
)
from gbd_foodservice_insights_lab.extraction.tabular_io import (
    read_in_all_data_files as _read_in_all_data_files,
)

warnings.warn(
    (
        "gbd_foodservice_insights_lab.extraction.other has been split into "
        "gbd_foodservice_insights_lab.extraction.tabular_io and "
        "gbd_foodservice_insights_lab.extraction.tabular_inspection. Update imports "
        "in package code and template notebooks. Legacy client notebooks still work for now "
        "through this compatibility layer."
    ),
    FutureWarning,
    stacklevel=2,
)

_WARNED_FUNCTIONS: set[str] = set()

__all__ = [
    "check_same_columns",
    "compare_baseline_pilot_raw_data",
    "compare_component_datasets",
    "detect_component_duplicate_risk",
    "detect_excel_header_row",
    "detect_file_encoding",
    "detect_single_multi_sheet_excel",
    "experimental_excel_extraction_code",
    "extract_dates_from_sheet_filenames",
    "extract_excel_sheet_info",
    "extract_month_year_from_filename",
    "filter_hidden_and_temp_files",
    "get_excel_headers",
    "get_filtered_data_files",
    "identify_low_cardinality_columns",
    "raw_data_report",
    "read_csv_with_auto_detection",
    "read_in_all_data_files",
    "suggest_column_roles",
    "suggest_date_source_and_coverage",
    "suggest_tabular_import_settings",
    "validate_matching_columns",
]


def _warn_function_use(function_name: str, replacement_module: str) -> None:
    """Emit a one-time deprecation warning for a legacy function name.

    Args:
        function_name: Name of the deprecated function being called.
        replacement_module: Dotted path of the module that now owns the function.
    """
    if function_name in _WARNED_FUNCTIONS:
        return
    warnings.warn(
        (
            f"gbd_foodservice_insights_lab.extraction.other.{function_name} is "
            f"deprecated. Import it from {replacement_module} instead."
        ),
        FutureWarning,
        stacklevel=3,
    )
    _WARNED_FUNCTIONS.add(function_name)


def filter_hidden_and_temp_files(
    files: list[Path],
    file_type: Literal["csv", "excel", "pdf"] = "csv",
) -> list[Path]:
    """Filter hidden and temporary files (legacy alias).

    Args:
        files: Candidate file paths to filter.
        file_type: File family to apply filtering rules for.

    Returns:
        File paths that are not hidden or temporary.
    """
    _warn_function_use(
        "filter_hidden_and_temp_files", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _filter_hidden_and_temp_files(files, file_type=file_type)


def get_filtered_data_files(
    path: str | Path,
    file_types: list[Literal["csv", "excel", "pdf"]] | None = None,
    recursive: bool = False,
) -> dict[str, list[Path]]:
    """List filtered data files in a directory (legacy alias).

    Args:
        path: Directory to search.
        file_types: File families to include; defaults to all.
        recursive: Whether to search subdirectories.

    Returns:
        Mapping of file type to list of matching paths.
    """
    _warn_function_use(
        "get_filtered_data_files", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _get_filtered_data_files(path, file_types=file_types, recursive=recursive)


def detect_single_multi_sheet_excel(
    path: str | Path,
    min_sheets: int = 2,
) -> tuple[bool, Path | None]:
    """Detect a single multi-sheet Excel file in a directory (legacy alias).

    Args:
        path: Directory to inspect.
        min_sheets: Minimum sheet count to qualify as multi-sheet.

    Returns:
        Tuple of (matched flag, the Excel file path if matched else ``None``).
    """
    _warn_function_use(
        "detect_single_multi_sheet_excel",
        "gbd_foodservice_insights_lab.extraction.tabular_io",
    )
    return _detect_single_multi_sheet_excel(path, min_sheets=min_sheets)


def detect_file_encoding(filepath: str | Path) -> str:
    """Detect a file's text encoding (legacy alias).

    Args:
        filepath: Path of the file to sniff.

    Returns:
        Detected encoding string (falls back to ``"utf-8"``).
    """
    _warn_function_use("detect_file_encoding", "gbd_foodservice_insights_lab.extraction.tabular_io")
    return _detect_file_encoding(filepath)


def get_excel_headers(worksheet: Any, header_row: int = 1) -> list[Any]:
    """Read header values from an Excel worksheet (legacy alias).

    Args:
        worksheet: An openpyxl worksheet instance.
        header_row: 1-indexed row number to read headers from.

    Returns:
        List of cell values from the header row.
    """
    _warn_function_use("get_excel_headers", "gbd_foodservice_insights_lab.extraction.tabular_io")
    return _get_excel_headers(worksheet, header_row=header_row)


def detect_excel_header_row(worksheet: Any, scan_rows: int = 20) -> int:
    """Guess the most likely header row in an Excel worksheet (legacy alias).

    Args:
        worksheet: An openpyxl worksheet instance.
        scan_rows: Number of leading rows to consider when scoring.

    Returns:
        1-indexed row number that scored highest as a likely header.
    """
    _warn_function_use(
        "detect_excel_header_row", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _detect_excel_header_row(worksheet, scan_rows=scan_rows)


def extract_excel_sheet_info(filepath: str | Path) -> tuple[dict[str, list], int]:
    """Extract sheet column lists and total row count for an Excel file (legacy alias).

    Args:
        filepath: Excel file to inspect.

    Returns:
        Tuple of (mapping of sheet name to header columns, total data-row count
        across sheets).
    """
    _warn_function_use(
        "extract_excel_sheet_info", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _extract_excel_sheet_info(filepath)


def read_csv_with_auto_detection(
    filepath: str | Path,
    nrows: int | None = None,
) -> tuple[pd.DataFrame, str, str]:
    """Read a CSV with auto-detected encoding and delimiter (legacy alias).

    Args:
        filepath: Path of the CSV to read.
        nrows: Optional row cap for previews.

    Returns:
        Tuple of (loaded DataFrame, detected encoding, detected delimiter).
    """
    _warn_function_use(
        "read_csv_with_auto_detection", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _read_csv_with_auto_detection(filepath, nrows=nrows)


def extract_month_year_from_filename(
    filename: str | Path,
    date_format: str | None = None,
) -> pd.Timestamp | None:
    """Extract a month/year ``Timestamp`` from a filename (legacy alias).

    Args:
        filename: Filename or path to inspect.
        date_format: Optional explicit ``strptime`` format to try first.

    Returns:
        Parsed ``pd.Timestamp`` or ``None`` if no pattern matched.
    """
    _warn_function_use(
        "extract_month_year_from_filename",
        "gbd_foodservice_insights_lab.extraction.tabular_io",
    )
    return _extract_month_year_from_filename(filename, date_format=date_format)


def extract_dates_from_sheet_filenames(
    df: pd.DataFrame,
    filename_column: str = "sheet_filename",
    default_year: int | None = None,
    date_format: str | None = None,
    show_warnings: bool = True,
) -> pd.DataFrame:
    """Add a ``date`` column derived from filenames in a DataFrame (legacy alias).

    Args:
        df: DataFrame with a column of filenames.
        filename_column: Name of the column holding the filenames.
        default_year: Year to apply when filenames contain only a month.
        date_format: Optional explicit ``strptime`` format to try first.
        show_warnings: Whether to print extraction-failure warnings.

    Returns:
        Copy of the input DataFrame with a new ``date`` column.
    """
    _warn_function_use(
        "extract_dates_from_sheet_filenames",
        "gbd_foodservice_insights_lab.extraction.tabular_io",
    )
    return _extract_dates_from_sheet_filenames(
        df,
        filename_column=filename_column,
        default_year=default_year,
        date_format=date_format,
        show_warnings=show_warnings,
    )


def experimental_excel_extraction_code(
    csv_filename: str | Path,
    OpenAI_client: Any,
    model: str = "gpt-4.1",
    desired_columns: list[str] | None = None,
    numeric_columns: list[str] | None = None,
    product_name_column: str = "Product name",
) -> pd.DataFrame:
    """Run the experimental LLM-based CSV extractor (legacy alias).

    Args:
        csv_filename: Path of the CSV file to process.
        OpenAI_client: Initialized OpenAI client used for the LLM call.
        model: Model identifier to use.
        desired_columns: Reserved for future use.
        numeric_columns: Reserved for future use.
        product_name_column: Reserved for future use.

    Returns:
        DataFrame produced from the LLM-generated markdown table.
    """
    _warn_function_use(
        "experimental_excel_extraction_code",
        "gbd_foodservice_insights_lab.extraction.tabular_io",
    )
    return _experimental_excel_extraction_code(
        csv_filename,
        OpenAI_client,
        model=model,
        desired_columns=desired_columns,
        numeric_columns=numeric_columns,
        product_name_column=product_name_column,
    )


def read_in_all_data_files(
    data_location: str | Path | None = None,
    file_type: Literal["csv", "excel"] | None = None,
    **read_kwargs: Any,
) -> tuple[list[pd.DataFrame], list[Path]]:
    """Read all CSV or Excel files in a directory into DataFrames (legacy alias).

    Args:
        data_location: Directory to read data from.
        file_type: ``"csv"``, ``"excel"``, or ``None`` to auto-detect.
        **read_kwargs: Extra keyword arguments forwarded to the pandas reader.

    Returns:
        Tuple of (list of loaded DataFrames, list of source file paths).
    """
    _warn_function_use(
        "read_in_all_data_files", "gbd_foodservice_insights_lab.extraction.tabular_io"
    )
    return _read_in_all_data_files(data_location=data_location, file_type=file_type, **read_kwargs)


def check_same_columns(df1: pd.DataFrame, df2: pd.DataFrame) -> None:
    """Compare column names of two DataFrames and print differences (legacy alias).

    Args:
        df1: First DataFrame to compare.
        df2: Second DataFrame to compare.
    """
    _warn_function_use(
        "check_same_columns", "gbd_foodservice_insights_lab.extraction.tabular_inspection"
    )
    return _check_same_columns(df1, df2)


def identify_low_cardinality_columns(
    df: pd.DataFrame,
    threshold: int = 10,
    show_details: bool = True,
    exclude_categorical: bool = False,
) -> list[Any]:
    """Identify low-cardinality columns and recommend action (legacy alias).

    Args:
        df: DataFrame to inspect.
        threshold: Maximum unique values for a column to qualify as low cardinality.
        show_details: Whether to print per-column diagnostics.
        exclude_categorical: If ``True``, skip object-dtype columns.

    Returns:
        List of column names recommended for dropping.
    """
    _warn_function_use(
        "identify_low_cardinality_columns",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _identify_low_cardinality_columns(
        df,
        threshold=threshold,
        show_details=show_details,
        exclude_categorical=exclude_categorical,
    )


def validate_matching_columns(dfs: list[pd.DataFrame]) -> None:
    """Validate that all DataFrames in a list share identical columns (legacy alias).

    Args:
        dfs: DataFrames to compare.

    Raises:
        ValueError: If any DataFrame's columns do not match the first one's.
    """
    _warn_function_use(
        "validate_matching_columns",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _validate_matching_columns(dfs)


def compare_baseline_pilot_raw_data(
    baseline_raw_path: str | Path,
    pilot_raw_path: str | Path,
) -> dict[str, Any]:
    """Compare baseline and pilot raw data for structural differences (legacy alias).

    Args:
        baseline_raw_path: Directory containing baseline raw data.
        pilot_raw_path: Directory containing pilot raw data.

    Returns:
        Dictionary describing file counts, column comparisons, and warnings.
    """
    _warn_function_use(
        "compare_baseline_pilot_raw_data",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _compare_baseline_pilot_raw_data(baseline_raw_path, pilot_raw_path)


def raw_data_report(
    path: str | Path,
    recursive: bool = False,
    return_dict: bool = False,
    max_preview_rows: int = 10,
    baseline_pilot: str | None = None,
    base_filepath: str | None = None,
) -> str | tuple[str, RawDataFileReport]:
    """Print a raw-data report and return a data type classification (legacy alias).

    Args:
        path: Directory of raw data files to inspect.
        recursive: Whether to recurse into subdirectories.
        return_dict: If ``True``, also return the discovered file paths.
        max_preview_rows: Number of preview rows to show per file.
        baseline_pilot: Optional ``"baseline"`` / ``"pilot"`` marker for comparison.
        base_filepath: Filepath used to locate the matching dataset for comparison.

    Returns:
        Either a data type string or a tuple of (data type, discovered files dict).
    """
    _warn_function_use(
        "raw_data_report", "gbd_foodservice_insights_lab.extraction.tabular_inspection"
    )
    return _raw_data_report(
        path,
        recursive=recursive,
        return_dict=return_dict,
        max_preview_rows=max_preview_rows,
        baseline_pilot=baseline_pilot,
        base_filepath=base_filepath,
    )


def compare_component_datasets(dfs: list[pd.DataFrame]) -> None:
    """Compare component DataFrames for row-count and column consistency (legacy alias).

    Args:
        dfs: Component DataFrames to compare.
    """
    _warn_function_use(
        "compare_component_datasets",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _compare_component_datasets(dfs)


def suggest_tabular_import_settings(
    data_location: str | Path,
    recursive: bool = False,
    scan_rows: int = 20,
) -> dict[str, Any]:
    """Suggest header rows and skiprows for tabular imports (legacy alias).

    Args:
        data_location: Directory of CSV/Excel files to inspect.
        recursive: Whether to recurse into subdirectories.
        scan_rows: Number of leading rows to consider when scoring headers.

    Returns:
        Dictionary describing per-component suggestions and a recommended shared
        ``skiprows`` value when one exists.
    """
    _warn_function_use(
        "suggest_tabular_import_settings",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _suggest_tabular_import_settings(
        data_location,
        recursive=recursive,
        scan_rows=scan_rows,
    )


def suggest_column_roles(
    dfs: list[pd.DataFrame],
    component_names: list[str] | None = None,
) -> dict[str, Any]:
    """Suggest likely product, weight, date, and other key columns (legacy alias).

    Args:
        dfs: Component DataFrames to inspect.
        component_names: Optional friendly names for each component.

    Returns:
        Dictionary mapping each role to its best candidate column and confidence.
    """
    _warn_function_use(
        "suggest_column_roles", "gbd_foodservice_insights_lab.extraction.tabular_inspection"
    )
    return _suggest_column_roles(dfs, component_names=component_names)


def suggest_date_source_and_coverage(
    dfs: list[pd.DataFrame],
    component_names: list[str] | None = None,
) -> dict[str, Any]:
    """Suggest the most likely date source and summarize coverage (legacy alias).

    Args:
        dfs: Component DataFrames to inspect.
        component_names: Optional friendly names for each component.

    Returns:
        Dictionary describing the chosen date source and observed period coverage.
    """
    _warn_function_use(
        "suggest_date_source_and_coverage",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _suggest_date_source_and_coverage(dfs, component_names=component_names)


def detect_component_duplicate_risk(
    dfs: list[pd.DataFrame],
    component_names: list[str] | None = None,
    duplicate_share_threshold: float = 0.20,
) -> dict[str, Any]:
    """Flag duplicate-row risk across component datasets (legacy alias).

    Args:
        dfs: Component DataFrames to compare.
        component_names: Optional friendly names for each component.
        duplicate_share_threshold: Share of duplicate rows that triggers a warning.

    Returns:
        Dictionary describing duplicate counts, per-source contributions, and
        pairwise overlap metrics.
    """
    _warn_function_use(
        "detect_component_duplicate_risk",
        "gbd_foodservice_insights_lab.extraction.tabular_inspection",
    )
    return _detect_component_duplicate_risk(
        dfs,
        component_names=component_names,
        duplicate_share_threshold=duplicate_share_threshold,
    )
