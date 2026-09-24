"""Tests for gbd_foodservice_insights_lab/llm_prompts.py"""

import pytest
from gbd_foodservice_insights_lab import llm_prompts


class TestLoadPrompt:
    """Tests for loading prompt files from disk."""

    def test_reads_only_lab_prompts(self):
        # Guards the lab's copy of llm_prompts.py: importing the product's instead would resolve
        # PROMPTS_DIR to the product package, where the lab's prompt files are not.
        assert llm_prompts.load_prompt("extract_pdf_prompt.md")
        with pytest.raises(FileNotFoundError):
            llm_prompts.load_prompt("clean_item_name_prompt.md")
