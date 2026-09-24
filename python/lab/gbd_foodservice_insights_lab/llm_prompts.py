"""
Loading for the prompt files packaged alongside this module.

`PROMPTS_DIR` resolves against this file, so a package that ships its own prompts needs its own
copy of this module rather than importing another package's.
"""

from gbd_foodservice_insights_lab import PACKAGE_DIR

PROMPTS_DIR = PACKAGE_DIR / "prompts"


def load_prompt(prompt_filename: str) -> str:
    """
    Load a prompt file from the package prompts directory.

    Args:
        prompt_filename: The name of the prompt file (e.g., "clean_item_name_prompt.md").

    Returns:
        The contents of the prompt file as a string.

    Raises:
        FileNotFoundError: If the prompt file doesn't exist.
    """
    prompt_file_path = PROMPTS_DIR / prompt_filename

    try:
        return prompt_file_path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise FileNotFoundError(f"Prompt file not found at {prompt_file_path}") from err
