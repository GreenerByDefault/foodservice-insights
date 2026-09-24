from pathlib import Path
from unittest.mock import MagicMock

import gbd_foodservice_insights_lab.extraction.pdf as extract_pdf
import matplotlib
import numpy as np
import pandas as pd
import pytest
from gbd_foodservice_insights_lab.extraction.pdf import (
    LLM_process_extracted_pdf_text,
    check_duplicates,
    check_extraction_by_page,
    check_high_duplicate_pages,
    combine_extracted_pdf_pages,
    find_possible_misspellings,
    identify_unique_product_names,
    markdown_to_df,
    plot_rowcount_against_pagenum,
    sample_files_and_rows,
)
from PyPDF2 import PdfWriter

matplotlib.use("Agg")

# The shared LLM helpers live in the module that extract_pdf imported via importlib.
# Grab a reference so we can monkeypatch time.sleep in the right namespace.
_llms_time = extract_pdf.shared_call_openai_prompt_with_metadata.__globals__["time"]


def _write_test_pdf(path: Path, num_pages: int = 1) -> None:
    """Create a tiny blank PDF for tests that need a real page count."""
    writer = PdfWriter()
    for _ in range(num_pages):
        writer.add_blank_page(width=72, height=72)
    with open(path, "wb") as handle:
        writer.write(handle)


# ----------------------------------------------------------------------
# Tests for markdown_to_df
# ----------------------------------------------------------------------


class TestMarkdownToDf:
    """Tests for markdown_to_df function."""

    def test_converts_simple_markdown_table(self):
        markdown = """| Product name | Quantity | Price |
| --- | --- | --- |
| Apple | 10 | 1.50 |
| Banana | 20 | 0.75 |"""

        result = markdown_to_df(
            markdown,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity", "Price"],
        )

        assert isinstance(result, pd.DataFrame)
        assert len(result) == 2
        assert "product name" in result.columns  # Columns are now lowercase

    def test_removes_separator_rows(self):
        markdown = """| Product name | Quantity |
| --- | --- |
| --- | --- |
| Apple | 10 |"""

        result = markdown_to_df(
            markdown,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
        )

        # Should not have any rows with --- (column name is now lowercase)
        assert not result["product name"].str.contains("---").any()

    def test_handles_numeric_columns(self):
        markdown = """| Product name | Quantity | Price |
| --- | --- | --- |
| Apple | 1,000 | 1.50 |
| Banana | 500 | 0.75 |"""

        result = markdown_to_df(
            markdown,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity", "Price"],
            numeric_columns=["Quantity", "Price"],
        )

        # Column names are now lowercase
        assert result["quantity"].dtype in [np.float64, np.int64, float, int]
        assert result["quantity"].iloc[0] == 1000  # Comma should be removed

    def test_strips_whitespace(self):
        markdown = """| Product name | Quantity |
| --- | --- |
|  Apple  |  10  |"""

        result = markdown_to_df(
            markdown,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
        )

        # Column name is now lowercase
        assert result["product name"].iloc[0] == "Apple"

    def test_drops_null_columns(self):
        markdown = """| Product name | Empty | Quantity |
| --- | --- | --- |
| Apple |  | 10 |
| Banana |  | 20 |"""

        result = markdown_to_df(
            markdown,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
        )

        # Empty column should be dropped (not in desired_columns anyway)
        assert "Empty" not in result.columns

    def test_raises_on_missing_desired_columns(self):
        markdown = """| Product name | Quantity |
| --- | --- |
| Apple | 10 |"""

        with pytest.raises(AssertionError, match="Desired columns"):
            markdown_to_df(
                markdown,
                product_name_column="Product name",
                desired_columns=["Product name", "Quantity", "NonExistent"],
            )


# ----------------------------------------------------------------------
# Tests for LLM_process_extracted_pdf_text
# ----------------------------------------------------------------------


class TestLLMProcessExtractedPdfText:
    """Tests for LLM_process_extracted_pdf_text function."""

    def test_handles_empty_text(self, capsys):
        mock_client = MagicMock()
        result = LLM_process_extracted_pdf_text(mock_client, "")

        assert result == ""
        captured = capsys.readouterr()
        assert "No extracted text" in captured.out

    def test_handles_exception_input(self, capsys):
        pytest.importorskip("unstract.llmwhisperer", reason="llmwhisperer package not installed")
        from unstract.llmwhisperer.client_v2 import LLMWhispererClientException

        mock_client = MagicMock()
        # Create an actual LLMWhispererClientException
        exception = LLMWhispererClientException("Test error", 400)

        result = LLM_process_extracted_pdf_text(mock_client, exception)

        # Should return empty string for exception
        assert result == ""
        captured = capsys.readouterr()
        assert "LLMWhispererClientException" in captured.out

    def test_calls_openai_api(self):
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[
            0
        ].message.content = "| Product | Qty |\n| --- | --- |\n| Apple | 10 |"
        mock_client.chat.completions.create.return_value = mock_response

        result = LLM_process_extracted_pdf_text(mock_client, "Some extracted text")

        mock_client.chat.completions.create.assert_called_once()
        assert "Apple" in result

    def test_retries_temporary_openai_failures(self, monkeypatch):
        monkeypatch.setattr(_llms_time, "sleep", lambda *_args, **_kwargs: None)

        class TemporaryError(Exception):
            status_code = 429

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[
            0
        ].message.content = "| Product | Qty |\n| --- | --- |\n| Apple | 10 |"
        mock_client.chat.completions.create.side_effect = [
            TemporaryError("rate limit"),
            mock_response,
        ]

        result = LLM_process_extracted_pdf_text(mock_client, "Some extracted text", prompt="prompt")

        assert "Apple" in result
        assert mock_client.chat.completions.create.call_count == 2

    def test_does_not_retry_non_retryable_openai_failures(self, monkeypatch):
        monkeypatch.setattr(_llms_time, "sleep", lambda *_args, **_kwargs: None)

        class PermanentError(Exception):
            status_code = 400

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = PermanentError("bad request")

        result = LLM_process_extracted_pdf_text(mock_client, "Some extracted text", prompt="prompt")

        assert result == ""
        assert mock_client.chat.completions.create.call_count == 1


# ----------------------------------------------------------------------
# Tests for run_pdf_extraction_pipeline
# ----------------------------------------------------------------------


class TestRunPdfExtractionPipeline:
    """Regression tests for page-level PDF extraction orchestration."""

    def test_debug_mode_reports_failed_pages_after_finishing_file(
        self, tmp_path, monkeypatch, capsys
    ):
        mock_whisper_client = MagicMock()
        mock_openai_client = MagicMock()
        exception = extract_pdf.LLMWhispererClientException("Test error", 400)

        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(
            extract_pdf,
            "_extract_pdf_text_whisper_with_metadata",
            lambda **kwargs: {
                "text": "",
                "error": str(exception),
                "retryable": False,
                "attempts": 1,
                "failure_kind": "api_failed",
                "error_type": type(exception).__name__,
            },
        )

        with pytest.raises(
            AssertionError, match="some pages failed and need attention before proceeding"
        ):
            extract_pdf.run_pdf_extraction_pipeline(
                whisper_client=mock_whisper_client,
                OpenAI_client=mock_openai_client,
                pages=[12],
                product_name_column="Product name",
                file_name="08.18.24 - 08.24.24 - AFCH Usage Data.pdf",
                data_location=tmp_path,
                desired_columns=["Product name", "Quantity"],
                numeric_columns=[],
                parse_extracted_pdf_prompt="prompt",
                debug=True,
                save_debug_artifacts=True,
            )

        captured = capsys.readouterr()
        assert "page 12" in captured.out
        assert "Error extracting file 08.18.24 - 08.24.24 - AFCH Usage Data.pdf" in captured.out

        debug_file = (
            tmp_path
            / "debug"
            / (
                "LLM_Whisper_extracted_text_08.18.24 - 08.24.24 - "
                "AFCH Usage Data_page_12_debugging.md"
            )
        )
        assert debug_file.exists()
        assert "LLMWhispererClientException" in debug_file.read_text(encoding="utf-8")

    def test_raises_after_finishing_all_pages_in_file(self, tmp_path, monkeypatch):
        page_calls = []

        def fake_extract(**kwargs):
            page_calls.append(kwargs["page"])
            if kwargs["page"] == "2":
                exception = extract_pdf.LLMWhispererClientException("Test error", 400)
                return {
                    "text": "",
                    "error": str(exception),
                    "retryable": False,
                    "attempts": 1,
                    "failure_kind": "api_failed",
                    "error_type": type(exception).__name__,
                }
            return {
                "text": "raw extracted text",
                "error": "",
                "retryable": False,
                "attempts": 1,
            }

        monkeypatch.setattr(extract_pdf, "_extract_pdf_text_whisper_with_metadata", fake_extract)

        mock_openai_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[
            0
        ].message.content = "| Product name | Quantity |\n| --- | --- |\n| Apple | 10 |"
        mock_openai_client.chat.completions.create.return_value = mock_response

        with pytest.raises(AssertionError, match="page 2"):
            extract_pdf.run_pdf_extraction_pipeline(
                whisper_client=MagicMock(),
                OpenAI_client=mock_openai_client,
                pages=[1, 2],
                product_name_column="Product name",
                file_name="test.pdf",
                data_location=tmp_path,
                desired_columns=["Product name", "Quantity"],
                numeric_columns=[],
                parse_extracted_pdf_prompt="prompt",
                debug=False,
            )

        assert page_calls[0] == "1"
        assert "2" in page_calls
        assert page_calls.index("2") >= 1

    def test_reprocesses_invalid_existing_checkpoint_and_writes_combined_file(
        self, tmp_path, monkeypatch
    ):
        """Corrupt checkpoints should be overwritten instead of silently skipped."""
        extracted_dir = tmp_path / "extracted_pages"
        extracted_dir.mkdir()
        invalid_output = extracted_dir / "test_page_1_extracted.csv"
        pd.DataFrame({"wrong": ["value"]}).to_csv(invalid_output, index=False)

        monkeypatch.setattr(
            extract_pdf,
            "_extract_pdf_text_whisper_with_metadata",
            lambda **_kwargs: {
                "text": "raw extracted text",
                "error": "",
                "retryable": False,
                "attempts": 1,
            },
        )

        mock_openai_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[
            0
        ].message.content = "| Product name | Quantity |\n| --- | --- |\n| Apple | 1,000 |"
        mock_openai_client.chat.completions.create.return_value = mock_response

        summary = extract_pdf.run_pdf_extraction_pipeline(
            whisper_client=MagicMock(),
            OpenAI_client=mock_openai_client,
            pages=[1],
            product_name_column="Product name",
            file_name="test.pdf",
            data_location=tmp_path,
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
        )

        saved_df = pd.read_csv(invalid_output)
        combined_path = tmp_path / "extracted_files" / "test_combined_extracted.csv"

        assert summary["processed"] == 1
        assert summary["skipped_existing"] == 0
        assert "product name" in [column.lower() for column in saved_df.columns]
        assert combined_path.exists()


class TestRunPdfExtractionPipelineMultipleFiles:
    """Tests for multi-file orchestration."""

    def test_prints_startup_message_immediately(self, monkeypatch, tmp_path, capsys):
        summaries = {
            "a.pdf": {
                "file_name": "a.pdf",
                "processed": 1,
                "skipped_existing": 0,
                "no_text": 0,
                "api_failed": 0,
                "llm_empty": 0,
                "parse_failed": 0,
                "retry_events": 0,
                "retryable_api_failures": 0,
                "failed_pages": [],
                "combined_output_path": "a",
            },
        }

        monkeypatch.setattr(
            extract_pdf,
            "run_pdf_extraction_pipeline",
            lambda **kwargs: summaries[kwargs["file_name"]],
        )
        monkeypatch.setattr(
            extract_pdf,
            "every_pdf_page_extracted_check",
            lambda *_args, **_kwargs: True,
        )

        extract_pdf.run_pdf_extraction_pipeline_multiple_files(
            pdf_files=["a.pdf"],
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
            extraction_profile="table",
        )

        captured = capsys.readouterr()
        assert "Starting PDF extraction for 1 file(s)" in captured.out
        assert "PDF extraction complete. Finished processing 1 file(s)." in captured.out

    def test_returns_sorted_file_summaries(self, monkeypatch, tmp_path):
        """Concurrent orchestration should still return stable file summaries."""
        summaries = {
            "b.pdf": {
                "file_name": "b.pdf",
                "processed": 1,
                "skipped_existing": 0,
                "no_text": 0,
                "api_failed": 0,
                "llm_empty": 0,
                "parse_failed": 0,
                "retry_events": 0,
                "retryable_api_failures": 0,
                "failed_pages": [],
                "combined_output_path": "b",
            },
            "a.pdf": {
                "file_name": "a.pdf",
                "processed": 2,
                "skipped_existing": 1,
                "no_text": 0,
                "api_failed": 0,
                "llm_empty": 0,
                "parse_failed": 0,
                "retry_events": 0,
                "retryable_api_failures": 0,
                "failed_pages": [],
                "combined_output_path": "a",
            },
        }

        monkeypatch.setattr(
            extract_pdf,
            "run_pdf_extraction_pipeline",
            lambda **kwargs: summaries[kwargs["file_name"]],
        )
        monkeypatch.setattr(
            extract_pdf,
            "every_pdf_page_extracted_check",
            lambda *_args, **_kwargs: True,
        )

        result = extract_pdf.run_pdf_extraction_pipeline_multiple_files(
            pdf_files=["b.pdf", "a.pdf"],
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
        )

        assert result["file_name"].tolist() == ["a.pdf", "b.pdf"]
        assert result["processed"].tolist() == [2, 1]

    def test_prints_concurrency_warning_when_retry_pressure_is_high(
        self, monkeypatch, tmp_path, capsys
    ):
        summaries = {
            "a.pdf": {
                "file_name": "a.pdf",
                "processed": 1,
                "skipped_existing": 0,
                "no_text": 0,
                "api_failed": 1,
                "llm_empty": 0,
                "parse_failed": 0,
                "retry_events": 4,
                "retryable_api_failures": 1,
                "failed_pages": [],
                "combined_output_path": "a",
            },
        }

        monkeypatch.setattr(
            extract_pdf,
            "run_pdf_extraction_pipeline",
            lambda **kwargs: summaries[kwargs["file_name"]],
        )
        monkeypatch.setattr(
            extract_pdf,
            "every_pdf_page_extracted_check",
            lambda *_args, **_kwargs: True,
        )

        extract_pdf.run_pdf_extraction_pipeline_multiple_files(
            pdf_files=["a.pdf"],
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
            max_concurrent_files=10,
        )

        captured = capsys.readouterr()
        assert "may be too high" in captured.out


class TestProfileRouting:
    """Tests for auto profile routing heuristics."""

    def test_routes_scanned_page_to_high_quality(self, monkeypatch, tmp_path):
        monkeypatch.setattr(extract_pdf, "_extract_native_pdf_text", lambda *_args, **_kwargs: "")
        assert (
            extract_pdf._resolve_page_profile(
                pdf_path=tmp_path / "test.pdf",
                page=1,
                extraction_profile="auto",
                preferred_digital_profile="table",
            )
            == "high_quality"
        )

    def test_routes_tabular_machine_text_to_preferred_digital_profile(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            extract_pdf,
            "_extract_native_pdf_text",
            lambda *_args, **_kwargs: (
                "Item  Qty  Price\nApple  10  12\nBanana  12  20\nOrange  8  19\n"
            ),
        )
        monkeypatch.setattr(
            extract_pdf, "_looks_table_like_native_text", lambda *_args, **_kwargs: True
        )
        assert (
            extract_pdf._resolve_page_profile(
                pdf_path=tmp_path / "test.pdf",
                page=1,
                extraction_profile="auto",
                preferred_digital_profile="table",
            )
            == "table"
        )

    def test_routes_non_tabular_machine_text_to_native_text(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            extract_pdf,
            "_extract_native_pdf_text",
            lambda *_args, **_kwargs: (
                "This page contains machine-readable prose and a few line items for analyst review."
            ),
        )
        monkeypatch.setattr(
            extract_pdf, "_looks_table_like_native_text", lambda *_args, **_kwargs: False
        )
        assert (
            extract_pdf._resolve_page_profile(
                pdf_path=tmp_path / "test.pdf",
                page=1,
                extraction_profile="auto",
                preferred_digital_profile=None,
            )
            == "native_text"
        )


class TestStructuredParsingAndSampling:
    """Tests for new structured parsing helpers and sample selection."""

    def test_tuning_sampler_uses_two_pass_rule_without_duplicate_pages(self, tmp_path):
        pdf_files = ["a.pdf", "b.pdf", "c.pdf"]
        for file_name in pdf_files:
            _write_test_pdf(tmp_path / file_name, num_pages=5)

        sampled_pages = extract_pdf._sample_tuning_pages(
            pdf_files,
            tmp_path,
            sample_cap=10,
            random_seed=42,
        )

        assert len(sampled_pages) == 6
        counts = {}
        for sample in sampled_pages:
            counts.setdefault(sample["file_name"], set()).add(sample["page"])
        assert all(len(pages) == 2 for pages in counts.values())

    def test_json_rows_parser_preserves_source_lines_and_numeric_columns(self):
        processed_text = """
        {
          "status": "ok",
          "rows": [
            {
              "item name": "Apple",
              "quantity": "1,200",
              "source_line_numbers": [4, 5],
              "row_confidence": 0.98,
              "parse_notes": ""
            }
          ]
        }
        """

        parsed = extract_pdf._parse_json_rows_response(
            processed_text=processed_text,
            desired_columns=["Item Name", "Quantity"],
            numeric_columns=["Quantity"],
            product_name_column="Item Name",
            debug=False,
        )

        assert parsed["status"] == "processed"
        assert parsed["page_df"]["quantity"].iloc[0] == 1200
        assert parsed["json_rows"][0]["source_line_numbers"] == [4, 5]

    def test_json_rows_parser_handles_no_table_detected(self):
        parsed = extract_pdf._parse_json_rows_response(
            processed_text='{"status": "no_table_detected", "rows": []}',
            desired_columns=["Item Name", "Quantity"],
            numeric_columns=["Quantity"],
            product_name_column="Item Name",
            debug=False,
        )

        assert parsed["status"] == extract_pdf.NO_TABLE_STATUS
        assert parsed["page_df"].empty

    def test_parser_mode_auto_resolves_by_cbord_mode(self):
        tmp_data_location = Path.cwd()

        cbord_context = extract_pdf._build_pipeline_context(
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_data_location,
            file_name="test.pdf",
            product_name_column="product name",
            desired_columns=["product name", "quantity"],
            numeric_columns=["quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
            CBORD=True,
            save_debug_artifacts=False,
            extraction_profile="auto",
            parser_mode="auto",
            auto_repair=True,
            enable_gemini_fallback=False,
            gemini_client=None,
            max_repair_attempts=2,
            audit_threshold=0.9,
            visual_audit_threshold=0.75,
            persist_audit_manifest=False,
            preferred_digital_profile=None,
        )
        non_cbord_context = extract_pdf._build_pipeline_context(
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_data_location,
            file_name="test.pdf",
            product_name_column="product name",
            desired_columns=["product name", "quantity"],
            numeric_columns=["quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
            CBORD=False,
            save_debug_artifacts=False,
            extraction_profile="auto",
            parser_mode="auto",
            auto_repair=True,
            enable_gemini_fallback=False,
            gemini_client=None,
            max_repair_attempts=2,
            audit_threshold=0.9,
            visual_audit_threshold=0.75,
            persist_audit_manifest=False,
            preferred_digital_profile=None,
        )

        assert cbord_context["parser_mode"] == "json_rows"
        assert non_cbord_context["parser_mode"] == "markdown"


class TestExtractPdfTextWhisper:
    """Tests for Whisper extraction retry behavior."""

    def test_retries_temporary_whisper_errors(self, monkeypatch, tmp_path):
        monkeypatch.setattr(_llms_time, "sleep", lambda *_args, **_kwargs: None)

        class TemporaryWhisperError(extract_pdf.LLMWhispererClientException):
            pass

        mock_client = MagicMock()
        mock_client.whisper.side_effect = [
            TemporaryWhisperError("429 rate limit", 429),
            {"extraction": {"result_text": "done"}},
        ]

        result = extract_pdf._extract_pdf_text_whisper_with_metadata(
            file_path=str(tmp_path),
            file_name="test.pdf",
            whisper_client=mock_client,
            page="1",
            profile_name="table",
            profile_settings=extract_pdf.WHISPER_PROFILE_OPTIONS["table"],
        )

        assert result["text"] == "done"
        assert result["attempts"] == 2
        assert mock_client.whisper.call_count == 2

    def test_missing_result_text_returns_descriptive_error(self, monkeypatch, tmp_path):
        """Missing result_text should be surfaced as a recoverable no-text condition."""
        monkeypatch.setattr(_llms_time, "sleep", lambda *_args, **_kwargs: None)

        mock_client = MagicMock()
        mock_client.whisper.return_value = {
            "message": "completed without layout payload",
            "status": "processed",
            "status_code": 200,
            "whisper_hash": "hash123",
            "extraction": {},
        }

        result = extract_pdf._extract_pdf_text_whisper_with_metadata(
            file_path=str(tmp_path),
            file_name="test.pdf",
            whisper_client=mock_client,
            page="1",
            profile_name="table",
            profile_settings=extract_pdf.WHISPER_PROFILE_OPTIONS["table"],
        )

        assert result["text"] == ""
        assert result["retryable"] is False
        assert "missing extraction.result_text" in result["error"]
        assert "response_keys=" in result["error"]
        assert "extraction_keys=[]" in result["error"]
        assert "status=processed" in result["error"]
        assert "status_code=200" in result["error"]


class TestPageProcessingAndArtifacts:
    """Tests for page-level audit, repair, and sidecar behavior."""

    def test_no_table_detected_writes_sidecar_without_csv(self, tmp_path, monkeypatch):
        mock_openai_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "No table found on this page."
        mock_openai_client.chat.completions.create.return_value = mock_response

        monkeypatch.setattr(
            extract_pdf,
            "_extract_pdf_text_whisper_with_metadata",
            lambda **_kwargs: {
                "text": "raw extracted text",
                "error": "",
                "retryable": False,
                "attempts": 1,
                "profile_name": "table",
                "profile_settings": extract_pdf.WHISPER_PROFILE_OPTIONS["table"],
                "whisper_hash": "hash",
                "confidence_metadata": {},
            },
        )

        context = extract_pdf._build_pipeline_context(
            whisper_client=MagicMock(),
            OpenAI_client=mock_openai_client,
            data_location=tmp_path,
            file_name="test.pdf",
            product_name_column="product name",
            desired_columns=["product name", "quantity"],
            numeric_columns=["quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
            CBORD=False,
            save_debug_artifacts=False,
            extraction_profile="table",
            parser_mode="markdown",
            auto_repair=False,
            enable_gemini_fallback=False,
            gemini_client=None,
            max_repair_attempts=2,
            audit_threshold=0.9,
            visual_audit_threshold=0.75,
            persist_audit_manifest=True,
            preferred_digital_profile=None,
        )

        result = extract_pdf._process_pdf_page(
            1,
            context,
            validate_existing_outputs=False,
            force_reprocess=True,
            persist_outputs=True,
        )

        metadata_path = tmp_path / "page_metadata" / "test_page_1_metadata.json"
        csv_path = tmp_path / "extracted_pages" / "test_page_1_extracted.csv"

        assert result["status"] == extract_pdf.NO_TABLE_STATUS
        assert metadata_path.exists()
        assert not csv_path.exists()

    def test_choose_best_candidate_prefers_passing_higher_score(self):
        losing_candidate = {
            "candidate_name": "first",
            "status": "processed",
            "audit": {"score": 0.80, "passed": False},
        }
        winning_candidate = {
            "candidate_name": "second",
            "status": "processed",
            "audit": {"score": 0.92, "passed": True},
        }

        winner = extract_pdf._choose_best_candidate([losing_candidate, winning_candidate])

        assert winner["candidate_name"] == "second"

    def test_run_parser_candidate_preserves_whisper_no_text_error(self, tmp_path, capsys):
        result = extract_pdf._run_parser_candidate(
            page=1,
            context={
                "data_location": tmp_path,
                "file_name": "test.pdf",
                "whisper_client": MagicMock(),
                "OpenAI_client": MagicMock(),
                "parse_extracted_pdf_prompt": "prompt",
                "desired_columns": ["product name", "quantity"],
                "numeric_columns": ["quantity"],
                "product_name_column": "product name",
                "debug": False,
                "CBORD": False,
                "save_debug_artifacts": False,
                "audit_threshold": 0.9,
                "visual_audit_threshold": 0.75,
            },
            profile_name="table",
            parser_mode="json_rows",
            candidate_name="initial_json_rows",
            whisper_result_override={
                "text": "",
                "error": (
                    "Whisper response missing extraction.result_text; "
                    "response_keys=['extraction', 'message']"
                ),
                "retryable": False,
                "attempts": 1,
            },
        )

        captured = capsys.readouterr()

        assert result["status"] == "no_text"
        assert "missing extraction.result_text" in result["error"]
        assert "missing extraction.result_text" in result["audit"]["failure_reasons"][0]
        assert "candidate=initial_json_rows" in captured.out
        assert "missing extraction.result_text" in captured.out

    def test_run_gemini_candidate_marks_parse_failures_non_retryable(self, monkeypatch, tmp_path):
        """Gemini parse failures happen after the upload succeeded, so they should not be
        retried.
        """
        monkeypatch.setattr(
            extract_pdf,
            "call_gemini_pdf_upload_with_metadata",
            lambda **_kwargs: {
                "processed_text": '[{"product name": "apple"}]',
                "error": "",
                "retryable": False,
                "attempts": 1,
                "model": "gemini-test",
            },
        )
        monkeypatch.setattr(
            extract_pdf,
            "_parse_json_rows_response",
            lambda **_kwargs: (_ for _ in ()).throw(ValueError("bad rows")),
        )

        result = extract_pdf._run_gemini_candidate(
            page=1,
            context={
                "data_location": tmp_path,
                "file_name": "test.pdf",
                "gemini_client": MagicMock(),
                "parse_extracted_pdf_prompt": "prompt",
                "desired_columns": ["product name", "quantity"],
                "numeric_columns": ["quantity"],
                "product_name_column": "product name",
                "debug": False,
                "CBORD": False,
                "audit_threshold": 0.9,
                "visual_audit_threshold": 0.75,
            },
        )

        assert result["status"] == "parse_failed"
        assert result["retryable"] is False
        assert "parsing failed" in result["error"]
        assert result["audit"]["failure_reasons"] == ["bad rows"]

    def test_repair_order_reparses_same_text_before_profile_rerun(self, tmp_path, monkeypatch):
        call_order = []

        def fake_run_parser_candidate(*, candidate_name, profile_name, parser_mode, **_kwargs):
            call_order.append(candidate_name)
            successful = candidate_name == "same_text_structured_reparse"
            return {
                "candidate_name": candidate_name,
                "status": "processed",
                "error": "",
                "retry_count": 0,
                "retryable": False,
                "output_path": tmp_path / "extracted_pages" / "test_page_1_extracted.csv",
                "profile_name": profile_name,
                "parser_mode": parser_mode,
                "raw_text": "raw text",
                "processed_text": "{}",
                "page_df": pd.DataFrame({"product name": ["apple"], "quantity": [1]}),
                "saved_df": pd.DataFrame(
                    {
                        "product name": ["apple"],
                        "quantity": [1],
                        "page": [1],
                        "original_file": ["test.pdf"],
                    }
                ),
                "row_provenance": [
                    {"source_line_numbers": [1], "row_confidence": 1.0, "parse_notes": ""}
                ],
                "audit": {
                    "score": 0.95 if successful else 0.50,
                    "passed": successful,
                    "failure_reasons": [],
                },
                "whisper_result": {"attempts": 1},
                "model": "gpt-4o",
            }

        monkeypatch.setattr(extract_pdf, "_run_parser_candidate", fake_run_parser_candidate)
        monkeypatch.setattr(extract_pdf, "_resolve_page_profile", lambda **_kwargs: "table")
        monkeypatch.setattr(
            extract_pdf, "_existing_checkpoint_status", lambda *_args, **_kwargs: None
        )

        context = extract_pdf._build_pipeline_context(
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            file_name="test.pdf",
            product_name_column="product name",
            desired_columns=["product name", "quantity"],
            numeric_columns=["quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
            CBORD=False,
            save_debug_artifacts=False,
            extraction_profile="table",
            parser_mode="markdown",
            auto_repair=True,
            enable_gemini_fallback=False,
            gemini_client=None,
            max_repair_attempts=2,
            audit_threshold=0.9,
            visual_audit_threshold=0.75,
            persist_audit_manifest=False,
            preferred_digital_profile=None,
        )

        extract_pdf._process_pdf_page(
            1,
            context,
            validate_existing_outputs=False,
            force_reprocess=True,
            persist_outputs=False,
        )

        assert call_order[:3] == [
            "initial_markdown",
            "same_text_structured_reparse",
            "profile_repair_native_text",
        ]

    def test_stale_checkpoint_is_ignored_when_settings_signature_changes(self, tmp_path):
        extracted_dir = tmp_path / "extracted_pages"
        extracted_dir.mkdir()
        pd.DataFrame(
            {"product name": ["apple"], "quantity": [1], "page": [1], "original_file": ["test.pdf"]}
        ).to_csv(
            extracted_dir / "test_page_1_extracted.csv",
            index=False,
        )
        metadata_dir = tmp_path / "page_metadata"
        metadata_dir.mkdir()
        (metadata_dir / "test_page_1_metadata.json").write_text(
            '{"status": "processed", "settings_signature": "old-signature"}',
            encoding="utf-8",
        )

        context = extract_pdf._build_pipeline_context(
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            file_name="test.pdf",
            product_name_column="product name",
            desired_columns=["product name", "quantity"],
            numeric_columns=["quantity"],
            parse_extracted_pdf_prompt="new prompt",
            debug=False,
            CBORD=False,
            save_debug_artifacts=False,
            extraction_profile="table",
            parser_mode="markdown",
            auto_repair=False,
            enable_gemini_fallback=False,
            gemini_client=None,
            max_repair_attempts=2,
            audit_threshold=0.9,
            visual_audit_threshold=0.75,
            persist_audit_manifest=False,
            preferred_digital_profile=None,
        )

        assert (
            extract_pdf._existing_checkpoint_status(1, context, validate_existing_outputs=True)
            is None
        )


class TestValidationSummariesAndPageCoverage:
    """Tests for PDF QA summaries and no-table sidecars."""

    def test_summarize_pdf_validation_data_returns_plot_inputs(self):
        df = pd.DataFrame(
            {
                "original_file": ["a.pdf", "a.pdf", "b.pdf"],
                "page": [1, 2, 1],
                "value": [1, 2, 3],
            }
        )

        summary = extract_pdf.summarize_pdf_validation_data(df)

        assert set(summary.keys()) == {
            "file_counts",
            "page_counts",
            "page_file_counts",
            "plot_page_file_counts",
            "file_summary",
        }
        assert list(summary["file_counts"].index) == ["a.pdf", "b.pdf"]
        assert list(summary["page_counts"].sort_index().index) == [1, 2]
        assert "median_row_count" in summary["page_file_counts"].columns
        assert "deviation_from_pdf_median" in summary["page_file_counts"].columns
        assert list(summary["file_summary"].columns) == [
            "original_file",
            "total_rows",
            "total_pages",
        ]

    def test_every_page_check_accepts_no_table_sidecar(self, tmp_path):
        pdf_path = tmp_path / "test.pdf"
        _write_test_pdf(pdf_path, num_pages=1)

        metadata_dir = tmp_path / "page_metadata"
        metadata_dir.mkdir()
        (metadata_dir / "test_page_1_metadata.json").write_text(
            '{"status": "no_table_detected"}',
            encoding="utf-8",
        )

        assert extract_pdf.every_pdf_page_extracted_check(pdf_path, debug=False) is True


class TestPublicRefactorBehaviors:
    """Tests that exercise the new public orchestration behaviors from the plan."""

    def test_run_pdf_preflight_sample_returns_human_review_columns(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            extract_pdf,
            "_sample_tuning_pages",
            lambda *_args, **_kwargs: [{"file_name": "test.pdf", "page": 1}],
        )
        monkeypatch.setattr(
            extract_pdf,
            "_process_pdf_page",
            lambda *_args, **_kwargs: {
                "status": "processed",
                "audit_score": 0.97,
                "selected_profile": "table",
                "parser_mode": "markdown",
                "raw_extracted_text_preview": "raw preview",
                "parsed_preview": '[{"product name": "apple"}]',
                "null_summary": '{"quantity": 0}',
                "candidate_scores": '{"initial_markdown": 0.97}',
            },
        )

        result = extract_pdf.run_pdf_preflight_sample(
            pdf_files=["test.pdf"],
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            data_location=tmp_path,
            product_name_column="Product name",
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
            extraction_profile="table",
        )

        assert result.columns.tolist() == [
            "file_name",
            "page",
            "selected_profile",
            "parser_mode",
            "status",
            "audit_score",
            "null_summary",
            "raw_extracted_text_preview",
            "parsed_preview",
            "candidate_scores",
        ]
        assert result.iloc[0]["selected_profile"] == "table"

    def test_run_pdf_extraction_pipeline_serial_sweep_reruns_audit_failed_page(
        self, monkeypatch, tmp_path
    ):
        call_log = []

        def fake_process_pdf_page(
            page, context, *, validate_existing_outputs, force_reprocess=False, persist_outputs=True
        ):
            call_log.append({"page": page, "force_reprocess": force_reprocess})
            if not force_reprocess:
                return {
                    "page": page,
                    "status": extract_pdf.AUDIT_FAILED_STATUS,
                    "error": "candidate failed audit threshold",
                    "output_path": str(tmp_path / "extracted_pages" / "test_page_1_extracted.csv"),
                    "retry_count": 0,
                    "retryable": False,
                    "audit_score": 0.5,
                    "metadata_path": "",
                }
            return {
                "page": page,
                "status": "processed",
                "error": "",
                "output_path": str(tmp_path / "extracted_pages" / "test_page_1_extracted.csv"),
                "retry_count": 0,
                "retryable": False,
                "audit_score": 0.95,
                "metadata_path": "",
            }

        monkeypatch.setattr(extract_pdf, "_process_pdf_page", fake_process_pdf_page)
        monkeypatch.setattr(extract_pdf, "_write_qa_flags_artifact", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            extract_pdf,
            "_build_combined_file_output",
            lambda **_kwargs: tmp_path / "extracted_files" / "test_combined_extracted.csv",
        )

        summary = extract_pdf.run_pdf_extraction_pipeline(
            whisper_client=MagicMock(),
            OpenAI_client=MagicMock(),
            pages=[1],
            product_name_column="Product name",
            file_name="test.pdf",
            data_location=tmp_path,
            desired_columns=["Product name", "Quantity"],
            numeric_columns=["Quantity"],
            parse_extracted_pdf_prompt="prompt",
            debug=False,
        )

        assert summary["processed"] == 1
        assert call_log == [
            {"page": 1, "force_reprocess": False},
            {"page": 1, "force_reprocess": True},
        ]

    def test_auto_tuning_cache_reuses_saved_profile(self, monkeypatch, tmp_path):
        pdf_path = tmp_path / "test.pdf"
        _write_test_pdf(pdf_path, num_pages=1)
        sample_pages = [{"file_name": "test.pdf", "page": 1}]
        benchmark_calls = []

        monkeypatch.setattr(
            extract_pdf,
            "_sample_tuning_pages",
            lambda *_args, **_kwargs: sample_pages,
        )

        def fake_benchmark(sample_pages_arg, *, data_location, whisper_client):
            benchmark_calls.append(
                {
                    "sample_pages": sample_pages_arg,
                    "data_location": data_location,
                }
            )
            return {
                "preferred_digital_profile": "table",
                "scores": {"table": 0.9, "native_text": 0.4},
                "sample_pages": sample_pages_arg,
            }

        monkeypatch.setattr(extract_pdf, "_benchmark_digital_profiles", fake_benchmark)

        first_result = extract_pdf._resolve_auto_tuning_result(
            ["test.pdf"],
            tmp_path,
            whisper_client=MagicMock(),
            sample_cap=10,
            random_seed=42,
            announce=False,
        )
        second_result = extract_pdf._resolve_auto_tuning_result(
            ["test.pdf"],
            tmp_path,
            whisper_client=MagicMock(),
            sample_cap=10,
            random_seed=42,
            announce=False,
        )

        assert first_result["preferred_digital_profile"] == "table"
        assert second_result["preferred_digital_profile"] == "table"
        assert benchmark_calls == [
            {
                "sample_pages": sample_pages,
                "data_location": tmp_path,
            }
        ]


# ----------------------------------------------------------------------
# Tests for check_duplicates
# ----------------------------------------------------------------------


class TestCheckDuplicates:
    """Tests for check_duplicates function."""

    def test_returns_true_with_no_duplicates(self):
        df = pd.DataFrame({"A": [1, 2, 3], "B": ["a", "b", "c"]})
        result = check_duplicates(df)
        assert result is True

    def test_raises_assertion_error_with_duplicates(self):
        df = pd.DataFrame({"A": [1, 1, 2], "B": ["a", "a", "b"]})
        with pytest.raises(AssertionError) as excinfo:
            check_duplicates(df)
        assert "duplicate rows" in str(excinfo.value)


# ----------------------------------------------------------------------
# Tests for sample_files_and_rows
# ----------------------------------------------------------------------


class TestSampleFilesAndRows:
    """Tests for sample_files_and_rows function."""

    def test_samples_correct_number_of_files(self):
        df = pd.DataFrame(
            {
                "original_file": ["file1.pdf"] * 10 + ["file2.pdf"] * 10 + ["file3.pdf"] * 10,
                "data": range(30),
            }
        )

        result = sample_files_and_rows(df, num_files=2, rows_per_file=3)

        unique_files = result["original_file"].nunique()
        assert unique_files <= 2

    def test_samples_correct_number_of_rows(self):
        df = pd.DataFrame(
            {"original_file": ["file1.pdf"] * 20 + ["file2.pdf"] * 20, "data": range(40)}
        )

        result = sample_files_and_rows(df, num_files=2, rows_per_file=5)

        # Should have at most num_files * rows_per_file rows
        assert len(result) <= 2 * 5

    def test_handles_fewer_files_than_requested(self):
        df = pd.DataFrame({"original_file": ["file1.pdf"] * 5, "data": range(5)})

        result = sample_files_and_rows(df, num_files=10, rows_per_file=3)

        # Should sample all available files
        assert result["original_file"].nunique() == 1


# ----------------------------------------------------------------------
# Tests for find_possible_misspellings
# ----------------------------------------------------------------------


class TestFindPossibleMisspellings:
    """Tests for find_possible_misspellings function."""

    def test_finds_similar_products(self):
        df = pd.DataFrame(
            {
                "product": ["apple", "aple", "banana", "orange"],
                "date": pd.to_datetime(["2024-01-01"] * 4),
            }
        )

        result = find_possible_misspellings(df, threshold=80)

        assert len(result) >= 1
        # apple and aple should be found as similar
        assert any((result["Product 1"] == "apple") | (result["Product 2"] == "aple"))

    def test_respects_threshold(self):
        df = pd.DataFrame(
            {"product": ["apple", "banana", "orange"], "date": pd.to_datetime(["2024-01-01"] * 3)}
        )

        result = find_possible_misspellings(df, threshold=95)

        # No products are 95% similar
        assert len(result) == 0

    def test_returns_correct_columns(self):
        df = pd.DataFrame(
            {"product": ["apple", "aple"], "date": pd.to_datetime(["2024-01-01"] * 2)}
        )

        result = find_possible_misspellings(df, threshold=70)

        assert "Product 1" in result.columns
        assert "Product 2" in result.columns
        assert "Similarity Score (%)" in result.columns


# ----------------------------------------------------------------------
# Tests for identify_unique_product_names
# ----------------------------------------------------------------------


class TestIdentifyUniqueProductNames:
    """Tests for identify_unique_product_names function."""

    def test_finds_unique_products(self):
        df = pd.DataFrame({"product": ["apple", "banana", "apple", "orange"]})

        result = identify_unique_product_names(df)

        assert "banana" in result["product"].values
        assert "orange" in result["product"].values
        assert "apple" not in result["product"].values

    def test_empty_when_all_duplicate(self):
        df = pd.DataFrame({"product": ["apple", "apple", "banana", "banana"]})

        result = identify_unique_product_names(df)

        assert len(result) == 0


# ----------------------------------------------------------------------
# Tests for combine_extracted_pdf_pages
# ----------------------------------------------------------------------


class TestCombineExtractedPdfPages:
    """Tests for combine_extracted_pdf_pages function."""

    def test_combines_csv_files(self, tmp_path):
        # Create test CSV files
        extracted_dir = tmp_path / "extracted_pages"
        extracted_dir.mkdir()

        df1 = pd.DataFrame({"Product name": ["Apple"], "Quantity": [10]})
        df1.to_csv(extracted_dir / "file1_page_1_extracted.csv", index=False)

        df2 = pd.DataFrame({"Product name": ["Banana"], "Quantity": [20]})
        df2.to_csv(extracted_dir / "file1_page_2_extracted.csv", index=False)

        result = combine_extracted_pdf_pages(
            tmp_path, intended_columns=["Product name", "Quantity"]
        )

        assert len(result) == 2
        # Function combines columns from intended_columns (lowercased)
        assert "product name" in result.columns
        assert "quantity" in result.columns

    def test_standardizes_column_names(self, tmp_path):
        extracted_dir = tmp_path / "extracted_pages"
        extracted_dir.mkdir()

        df = pd.DataFrame({"Product Name": ["Apple"], "QUANTITY": [10]})
        df.to_csv(extracted_dir / "test_page_5_extracted.csv", index=False)

        result = combine_extracted_pdf_pages(
            tmp_path, intended_columns=["product name", "quantity"]
        )

        # Columns should be lowercase
        assert "product name" in result.columns
        assert "quantity" in result.columns


# ----------------------------------------------------------------------
# Tests for check_high_duplicate_pages
# ----------------------------------------------------------------------


class TestCheckHighDuplicatePages:
    """Tests for check_high_duplicate_pages function."""

    def test_identifies_duplicate_pages(self):
        data = {
            "original_file": ["file1"] * 10 + ["file2"] * 4 + ["file3"] * 4,
            "page": [1] * 5 + [2] * 5 + [3] * 4 + [4] * 4,
            "product": (
                ["Apple"] * 5
                + ["Banana", "Orange", "Grape", "Melon", "Kiwi"]
                + ["Pear", "Pear", "Plum", "Plum"]
                + ["Mango", "Mango", "Mango", "Papaya"]
            ),
        }
        df = pd.DataFrame(data)

        result = check_high_duplicate_pages(df, product_name_col="product")

        assert isinstance(result, pd.DataFrame)
        assert result["page"].tolist() == [1, 3, 4]
        assert result["duplicate_percentage"].tolist() == [100.0, 100.0, 75.0]

    def test_returns_stable_empty_schema_when_no_pages_flagged(self):
        df = pd.DataFrame(
            {
                "original_file": ["file1", "file1", "file2", "file2"],
                "page": [1, 1, 1, 1],
                "product": ["Apple", "Banana", "Carrot", "Dates"],
            }
        )

        result = check_high_duplicate_pages(df, product_name_col="product")

        assert result.empty
        assert list(result.columns) == [
            "original_file",
            "page",
            "duplicate_percentage",
            "repeated_products_count",
            "warning",
        ]


# ----------------------------------------------------------------------
# Tests for check_extraction_by_page
# ----------------------------------------------------------------------


class TestCheckExtractionByPage:
    """Tests for check_extraction_by_page function."""

    def test_returns_page_summary(self):
        # Refactored function now requires 'original_file' column to calculate mean counts
        # across files
        df = pd.DataFrame(
            {
                "original_file": ["file1.pdf", "file1.pdf", "file1.pdf", "file2.pdf", "file2.pdf"],
                "page": [1, 1, 2, 2, 2],
                "data": range(5),
            }
        )

        result = check_extraction_by_page(df, n=10)

        assert isinstance(result, pd.DataFrame)
        assert "page" in result.columns


# ----------------------------------------------------------------------
# Tests for plot_rowcount_against_pagenum
# ----------------------------------------------------------------------


class TestPlotRowcountAgainstPagenum:
    """Tests for plot_rowcount_against_pagenum function."""

    def test_runs_without_returning_summary(self):
        df = pd.DataFrame(
            {
                "original_file": ["file1.pdf", "file1.pdf", "file2.pdf", "file2.pdf", "file2.pdf"],
                "page": [1, 2, 1, 2, 3],
                "data": range(5),
            }
        )

        result = plot_rowcount_against_pagenum(df)

        assert result is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
