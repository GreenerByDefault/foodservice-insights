"""Tests for defensive behavior in the Gemini API examples."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from gbd_foodservice_insights_lab.experiments.gemini_api_examples import (
    _require_response_text,
    analyze_multiple_images,
    analyze_multiple_pdfs,
)
from google.genai import types


def test_require_response_text_returns_generated_text():
    assert _require_response_text(SimpleNamespace(text="result")) == "result"


def test_require_response_text_rejects_textless_response():
    """Filtered or otherwise textless responses should fail with a useful explanation."""
    with pytest.raises(ValueError, match="Gemini returned no text"):
        _require_response_text(SimpleNamespace(text=None))


def test_analyze_multiple_images_builds_one_typed_user_message(tmp_path):
    """Mixed text and image bytes should be packaged into one SDK-supported user message."""
    first_image = tmp_path / "first.jpg"
    second_image = tmp_path / "second.jpg"
    first_image.write_bytes(b"first image")
    second_image.write_bytes(b"second image")
    client = MagicMock()
    client.models.generate_content.return_value = SimpleNamespace(text="comparison")

    result = analyze_multiple_images(
        client,
        [str(first_image), str(second_image)],
    )

    assert result == "comparison"
    content = client.models.generate_content.call_args.kwargs["contents"]
    assert isinstance(content, types.UserContent)
    assert content.parts[0].text == "Compare these images and describe the differences:"
    assert len(content.parts) == 3
    assert all(part.inline_data is not None for part in content.parts[1:])


def test_analyze_multiple_pdfs_builds_one_typed_user_message():
    """Mixed prompt text and uploaded PDFs should use the SDK's file-part conversion."""
    uploaded_files = [
        types.File(uri="https://example.test/first", mime_type="application/pdf"),
        types.File(uri="https://example.test/second", mime_type="application/pdf"),
    ]
    client = MagicMock()
    client.files.upload.side_effect = uploaded_files
    client.models.generate_content.return_value = SimpleNamespace(text="summary")

    result = analyze_multiple_pdfs(client, ["first.pdf", "second.pdf"])

    assert result == "summary"
    content = client.models.generate_content.call_args.kwargs["contents"]
    assert isinstance(content, types.UserContent)
    assert content.parts[0].text == "Compare these documents and summarize the key differences:"
    assert len(content.parts) == 3
    assert [part.file_data.file_uri for part in content.parts[1:]] == [
        "https://example.test/first",
        "https://example.test/second",
    ]
