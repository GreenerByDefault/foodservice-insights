"""
Loading for the prompt files packaged alongside this module.

`PROMPTS_DIR` resolves against this file, so a package that ships its own prompts needs its own
copy of this module rather than importing another package's.
"""

from gbd_foodservice_insights import PACKAGE_DIR

PROMPTS_DIR = PACKAGE_DIR / "prompts"


def load_prompt(prompt_filename: str) -> str:
    """Load a prompt file (e.g. "clean_item_name_prompt.md") from the package prompts directory.

    Raises FileNotFoundError, naming the full path, if the file doesn't exist.
    """
    prompt_file_path = PROMPTS_DIR / prompt_filename

    try:
        return prompt_file_path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise FileNotFoundError(f"Prompt file not found at {prompt_file_path}") from err
