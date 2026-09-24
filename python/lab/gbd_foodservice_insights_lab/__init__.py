"""Greener by Default Foodservice Insights lab: extraction, pilot analysis, and notebook helpers."""

from pathlib import Path
from typing import Final

# The package directory, anchored on this file rather than any importing module's `__file__`, so
# every packaged-asset path (data_files/, prompts/) survives modules moving between subpackages.
PACKAGE_DIR: Final[Path] = Path(__file__).resolve().parent

__all__: list[str] = ["PACKAGE_DIR"]
