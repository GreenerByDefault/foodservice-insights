"""
Tests for gbd_foodservice_insights/gemini.py

This module tests the Gemini model registry and the shared provider-call wrappers that
maintained package code now routes through.
"""

import json

import pytest
from gbd_foodservice_insights import gemini


@pytest.fixture(autouse=True)
def clear_gemini_model_cache():
    """Keep config-cache state from leaking across tests."""
    gemini.load_gemini_model_config.cache_clear()
    yield
    gemini.load_gemini_model_config.cache_clear()


class TestGeminiModelConfig:
    """Tests for repo-level Gemini model configuration helpers."""

    def test_loads_repo_level_config(self):
        """Known keys should load from the shared config file."""
        config = gemini.load_gemini_model_config()

        assert config["utils.call_gemini_api_default"] == "gemini-3-flash-preview"
        assert config["extract_pdf.gemini_visual_fallback"] == "gemini-3-flash-preview"

    def test_raises_when_config_is_not_json_object(self, tmp_path, monkeypatch):
        """Non-dictionary config files should fail loudly."""
        config_path = tmp_path / "gemini_models.json"
        config_path.write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
        monkeypatch.setattr(gemini, "GEMINI_MODEL_CONFIG_PATH", config_path)
        gemini.load_gemini_model_config.cache_clear()

        with pytest.raises(ValueError, match="must be a JSON object"):
            gemini.load_gemini_model_config()

    def test_raises_when_config_contains_blank_values(self, tmp_path, monkeypatch):
        """Blank model names should be rejected."""
        config_path = tmp_path / "gemini_models.json"
        config_path.write_text(
            json.dumps(
                {
                    "utils.call_gemini_api_default": " ",
                    "extract_pdf.gemini_visual_fallback": "model",
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(gemini, "GEMINI_MODEL_CONFIG_PATH", config_path)
        gemini.load_gemini_model_config.cache_clear()

        with pytest.raises(ValueError, match="empty or non-string values"):
            gemini.load_gemini_model_config()

    def test_get_gemini_model_reads_requested_key(self, tmp_path, monkeypatch):
        """Named keys should return the configured model."""
        config_path = tmp_path / "gemini_models.json"
        config_path.write_text(
            json.dumps(
                {
                    "utils.call_gemini_api_default": "default-model",
                    "categorize.entree_flash": "flash-model",
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(gemini, "GEMINI_MODEL_CONFIG_PATH", config_path)
        gemini.load_gemini_model_config.cache_clear()

        assert gemini.get_gemini_model("categorize.entree_flash") == "flash-model"

    def test_get_gemini_model_raises_for_missing_key(self, tmp_path, monkeypatch):
        """Missing config keys should raise a descriptive error."""
        config_path = tmp_path / "gemini_models.json"
        config_path.write_text(
            json.dumps({"utils.call_gemini_api_default": "default-model"}),
            encoding="utf-8",
        )
        monkeypatch.setattr(gemini, "GEMINI_MODEL_CONFIG_PATH", config_path)
        gemini.load_gemini_model_config.cache_clear()

        with pytest.raises(KeyError, match=r"missing key 'categorize.entree_flash'"):
            gemini.get_gemini_model("categorize.entree_flash")


class TestCallGeminiApi:
    """Tests for the shared Gemini text wrapper."""

    def test_uses_default_model_and_strips_response(self, mock_gemini_client):
        """The shared wrapper should use the configured default model."""
        result = gemini.call_gemini_api("Hello Gemini", mock_gemini_client)

        assert result == "Test response"
        _, kwargs = mock_gemini_client.models.generate_content.call_args
        assert kwargs["model"] == gemini.DEFAULT_GEMINI_MODEL
        assert kwargs["contents"] == "Hello Gemini"
        assert kwargs["config"].temperature == 0.0

    def test_uses_explicit_model_when_provided(self, mock_gemini_client):
        """An explicit model should override the default."""
        gemini.call_gemini_api(
            "Hello Gemini",
            mock_gemini_client,
            temperature=0.4,
            model="unit-test-explicit",
        )

        _, kwargs = mock_gemini_client.models.generate_content.call_args
        assert kwargs["model"] == "unit-test-explicit"
        assert kwargs["config"].temperature == 0.4
