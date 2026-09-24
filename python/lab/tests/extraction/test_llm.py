"""These cover the retry layer and the metadata dictionaries the PDF pipeline reads."""

from unittest.mock import MagicMock

from gbd_foodservice_insights_lab.extraction import llm


class TestOpenAiPromptWrapper:
    """Tests for the shared OpenAI chat wrapper."""

    def test_retries_temporary_failures(self, monkeypatch):
        """Temporary OpenAI failures should retry before succeeding."""
        monkeypatch.setattr(llm.time, "sleep", lambda *_args, **_kwargs: None)

        class TemporaryError(Exception):
            status_code = 429

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "parsed table"
        mock_client.chat.completions.create.side_effect = [
            TemporaryError("rate limit"),
            mock_response,
        ]

        result = llm.call_openai_prompt_with_metadata(
            openai_client=mock_client,
            prompt="prompt",
            user_content="Some extracted text",
        )

        assert result["processed_text"] == "parsed table"
        assert result["attempts"] == 2
        assert mock_client.chat.completions.create.call_count == 2

    def test_handles_whisper_exception_input(self):
        """Whisper exceptions should short-circuit before calling OpenAI."""
        mock_client = MagicMock()
        exception = llm.LLMWhispererClientException("Test error", 400)

        result = llm.call_openai_prompt_with_metadata(
            openai_client=mock_client,
            prompt="prompt",
            user_content=exception,
        )

        assert result["processed_text"] == ""
        assert "LLMWhispererClientException" in result["error"]
        mock_client.chat.completions.create.assert_not_called()


class TestGeminiPdfUploadWrapper:
    """Tests for the shared Gemini uploaded-file wrapper."""

    def test_uploads_pdf_and_returns_text(self):
        """The wrapper should upload the PDF and return Gemini's text."""
        mock_client = MagicMock()
        mock_client.files.upload.return_value = "uploaded-file"
        mock_response = MagicMock()
        mock_response.text = "structured rows"
        mock_client.models.generate_content.return_value = mock_response

        result = llm.call_gemini_pdf_upload_with_metadata(
            gemini_client=mock_client,
            pdf_path="/tmp/test.pdf",  # nosec B108
            prompt="prompt",
            model="gemini-3-flash-preview",
        )

        assert result["processed_text"] == "structured rows"
        mock_client.files.upload.assert_called_once_with(file="/tmp/test.pdf")  # nosec B108
        _, kwargs = mock_client.models.generate_content.call_args
        assert kwargs["model"] == "gemini-3-flash-preview"
        assert kwargs["contents"] == ["prompt", "uploaded-file"]


class TestWhisperWrapper:
    """Tests for the shared Whisper extraction wrapper."""

    def test_retries_temporary_whisper_errors(self, monkeypatch, tmp_path):
        """Temporary Whisper failures should retry and eventually return metadata."""
        monkeypatch.setattr(llm.time, "sleep", lambda *_args, **_kwargs: None)

        class TemporaryWhisperError(llm.LLMWhispererClientException):
            pass

        mock_client = MagicMock()
        mock_client.whisper.side_effect = [
            TemporaryWhisperError("429 rate limit", 429),
            {"extraction": {"result_text": "done"}},
        ]

        result = llm.extract_pdf_text_whisper_with_metadata(
            file_path=str(tmp_path),
            file_name="test.pdf",
            whisper_client=mock_client,
            page="1",
            profile_name="table",
            profile_settings={
                "mode": "table",
                "mark_horizontal_lines": True,
                "mark_vertical_lines": True,
            },
        )

        assert result["text"] == "done"
        assert result["attempts"] == 2
        assert mock_client.whisper.call_count == 2

    def test_missing_result_text_returns_descriptive_error(self, monkeypatch, tmp_path):
        """Missing result_text should be surfaced as a descriptive no-text condition."""
        monkeypatch.setattr(llm.time, "sleep", lambda *_args, **_kwargs: None)

        mock_client = MagicMock()
        mock_client.whisper.return_value = {
            "message": "completed without layout payload",
            "status": "processed",
            "status_code": 200,
            "whisper_hash": "hash123",
            "extraction": {},
        }

        result = llm.extract_pdf_text_whisper_with_metadata(
            file_path=str(tmp_path),
            file_name="test.pdf",
            whisper_client=mock_client,
            page="1",
            profile_name="table",
            profile_settings={
                "mode": "table",
                "mark_horizontal_lines": True,
                "mark_vertical_lines": True,
            },
        )

        assert result["text"] == ""
        assert result["retryable"] is False
        assert "missing extraction.result_text" in result["error"]
        assert "response_keys=" in result["error"]
        assert "extraction_keys=[]" in result["error"]
        assert "status=processed" in result["error"]
        assert "status_code=200" in result["error"]

    def test_whisper_exception_returns_empty_text_with_failure_metadata(
        self, monkeypatch, tmp_path
    ):
        """Whisper API failures should keep text string-shaped and describe the failure in
        metadata."""
        monkeypatch.setattr(llm.time, "sleep", lambda *_args, **_kwargs: None)

        mock_client = MagicMock()
        mock_client.whisper.side_effect = llm.LLMWhispererClientException("Test error", 400)

        result = llm.extract_pdf_text_whisper_with_metadata(
            file_path=str(tmp_path),
            file_name="test.pdf",
            whisper_client=mock_client,
            page="1",
            profile_name="table",
            profile_settings={
                "mode": "table",
                "mark_horizontal_lines": True,
                "mark_vertical_lines": True,
            },
            max_retries=1,
        )

        assert result["text"] == ""
        assert result["failure_kind"] == "api_failed"
        assert result["error_type"] == "LLMWhispererClientException"
        assert "Test error" in result["error"]
