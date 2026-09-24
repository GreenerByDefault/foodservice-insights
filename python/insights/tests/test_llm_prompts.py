"""Tests for gbd_foodservice_insights/llm_prompts.py"""

import pytest
from gbd_foodservice_insights import llm_prompts


class TestLoadPrompt:
    """Tests for loading prompt files from disk."""

    def test_loads_existing_prompt(self):
        """A known prompt file should load as non-empty text."""
        prompt = llm_prompts.load_prompt("clean_item_name_prompt.md")

        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_raises_on_nonexistent_prompt(self):
        """Missing prompt files should raise a descriptive error."""
        with pytest.raises(FileNotFoundError, match="Prompt file not found"):
            llm_prompts.load_prompt("definitely_missing_prompt.md")

    def test_does_not_read_lab_prompts(self):
        with pytest.raises(FileNotFoundError):
            llm_prompts.load_prompt("extract_pdf_prompt.md")
