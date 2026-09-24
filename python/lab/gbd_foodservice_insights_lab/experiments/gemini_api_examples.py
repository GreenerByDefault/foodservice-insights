"""
Comprehensive Google Gemini API Examples
==========================================

This file contains examples for using the latest Google GenAI SDK (2026).
These examples are meant to help migrate from OpenAI to Gemini.

Key differences from OpenAI:
1. Uses `from google import genai` instead of `import openai`
2. Client initialization: `genai.Client()` instead of `OpenAI()`
3. API key from `GEMINI_API_KEY` environment variable
4. Model names: `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, etc.
5. Configuration uses `types.GenerateContentConfig` instead of direct parameters

Installation:
    pip install -U google-genai

Setup:
    export GEMINI_API_KEY=your_api_key_here
    Get your API key at: https://aistudio.google.com/apikey
"""

from __future__ import annotations

from typing import Any

from gbd_foodservice_insights.gemini import get_gemini_model
from google import genai
from google.genai import types
from pydantic import BaseModel

EXAMPLE_FLASH_MODEL = get_gemini_model("gemini_api_examples.flash")
EXAMPLE_PRO_MODEL = get_gemini_model("gemini_api_examples.pro")


def _require_response_text(response: Any) -> str:
    """Return Gemini response text or fail clearly when no text was produced."""
    text = response.text
    if text is None:
        raise ValueError(
            "Gemini returned no text. Inspect the response for filtering or generation details."
        )
    return text


# ----------------------------------------------------------------------
# 1. CLIENT INITIALIZATION
# ----------------------------------------------------------------------


def initialize_client_basic() -> genai.Client:
    """Initialize a Gemini client using the ``GEMINI_API_KEY`` environment variable.

    This is the recommended approach for most use cases.

    Returns:
        Initialized ``genai.Client`` instance.
    """
    client = genai.Client()
    return client


def initialize_client_with_api_key() -> genai.Client:
    """Initialize a Gemini client by explicitly passing an API key.

    Use this when you need to override the environment variable.

    Returns:
        Initialized ``genai.Client`` instance.
    """
    client = genai.Client(api_key="your_api_key_here")
    return client


def initialize_vertex_ai_client() -> genai.Client:
    """Initialize a Gemini client for Vertex AI on Google Cloud.

    Use this when deploying on Google Cloud Platform.

    Returns:
        Initialized ``genai.Client`` configured for Vertex AI.
    """
    client = genai.Client(vertexai=True, project="your-project-id", location="us-central1")
    return client


# ----------------------------------------------------------------------
# 2. BASIC TEXT GENERATION
# ----------------------------------------------------------------------


def basic_text_generation(client: genai.Client) -> str:
    """Generate text from a simple prompt.

    Equivalent to OpenAI's ``client.chat.completions.create()``.

    Args:
        client: The Gemini API client.

    Returns:
        The generated text response.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL, contents="Why is the sky blue?"
    )
    return _require_response_text(response)


def text_generation_with_config(client: genai.Client) -> str:
    """Generate text using configuration options like temperature and max tokens.

    This is the Gemini equivalent of OpenAI's completion parameters.

    Args:
        client: The Gemini API client.

    Returns:
        The generated text response.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="Explain quantum computing",
        config=types.GenerateContentConfig(
            system_instruction="Be concise and technical",
            max_output_tokens=200,
            temperature=0.0,  # 0.0 for deterministic, higher for creative
            top_p=0.95,
            top_k=20,
        ),
    )
    return _require_response_text(response)


def text_generation_with_thinking_config(client: genai.Client) -> str:
    """Generate text while controlling the Gemini 3 thinking level.

    Setting ``thinking_level='minimal'`` keeps latency low for simple tasks.
    This is useful when you want faster responses.

    Args:
        client: The Gemini API client.

    Returns:
        The generated text response.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="Explain how photosynthesis works",
        config=types.GenerateContentConfig(
            temperature=0.0,
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        ),
    )
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 3. STREAMING RESPONSES
# ----------------------------------------------------------------------


def streaming_text_generation(client: genai.Client) -> None:
    """Stream model responses to stdout as they are generated.

    Equivalent to OpenAI's ``stream=True`` parameter.

    Args:
        client: The Gemini API client.
    """
    for chunk in client.models.generate_content_stream(
        model=EXAMPLE_FLASH_MODEL,
        contents="Tell me a story about a robot learning to feel emotions.",
    ):
        print(chunk.text, end="", flush=True)


async def async_streaming_text_generation(client: genai.Client) -> None:
    """Asynchronously stream model responses to stdout as they are generated.

    Args:
        client: The Gemini API client.
    """
    async for chunk in await client.aio.models.generate_content_stream(
        model=EXAMPLE_FLASH_MODEL,
        contents="Tell me a story about a robot learning to feel emotions.",
    ):
        print(chunk.text, end="", flush=True)


# ----------------------------------------------------------------------
# 4. FUNCTION CALLING (TOOL USE)
# ----------------------------------------------------------------------


def get_current_weather(location: str, unit: str = "fahrenheit") -> dict:
    """
    Example function that can be called by the model.
    The docstring is important - it's used by the model to understand the function.

    Args:
        location: The city and state, e.g. San Francisco, CA
        unit: Temperature unit (fahrenheit or celsius)

    Returns:
        Weather information dictionary
    """
    # In production, this would call a real weather API
    return {"location": location, "temperature": "72", "unit": unit, "forecast": ["sunny", "windy"]}


def function_calling_automatic(client: genai.Client) -> str:
    """Demonstrate automatic function calling by passing Python functions directly.

    Gemini automatically extracts the schema from docstrings and type hints.
    This is similar to OpenAI's function calling but more automatic.

    Args:
        client: The Gemini API client.

    Returns:
        The model's text response after any function calls.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="What is the weather like in Boston?",
        config=types.GenerateContentConfig(
            tools=[get_current_weather],
        ),
    )
    return _require_response_text(response)


def function_calling_manual(client: genai.Client) -> str:
    """Demonstrate manual function declaration for precise schema control.

    Use this when you need precise control over function definitions.

    Args:
        client: The Gemini API client.

    Returns:
        The model's text response after any function calls.
    """
    function = types.FunctionDeclaration(
        name="get_current_weather",
        description="Get the current weather in a given location",
        parameters_json_schema={
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state, e.g. San Francisco, CA",
                },
                "unit": {
                    "type": "string",
                    "enum": ["fahrenheit", "celsius"],
                    "description": "Temperature unit",
                },
            },
            "required": ["location"],
        },
    )

    tool = types.Tool(function_declarations=[function])

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="What is the weather like in Boston in celsius?",
        config=types.GenerateContentConfig(tools=[tool]),
    )
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 5. STRUCTURED OUTPUT (JSON SCHEMA)
# ----------------------------------------------------------------------


class ProductInfo(BaseModel):
    """Example Pydantic model for structured output."""

    name: str
    category: str
    price: float
    in_stock: bool
    description: str


class CountryInfo(BaseModel):
    """Another example showing structured output for geographic data."""

    name: str
    population: int
    capital: str
    continent: str
    gdp: int
    official_language: str
    total_area_sq_mi: int


def structured_output_pydantic(client: genai.Client) -> dict[str, Any]:
    """Force the model to output JSON matching a Pydantic schema.

    Extremely useful for data extraction and categorization tasks.
    Similar to OpenAI's ``response_format`` parameter but more powerful.

    Args:
        client: The Gemini API client.

    Returns:
        The parsed JSON response as a dict.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="Give me information about organic bananas sold at Whole Foods.",
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ProductInfo,
        ),
    )
    # Parse the JSON response
    import json

    return json.loads(_require_response_text(response))


def structured_output_json_schema(client: genai.Client) -> dict[str, Any]:
    """Force the model to output JSON matching a raw JSON schema.

    This gives more flexibility than Pydantic when you don't want to use it.

    Args:
        client: The Gemini API client.

    Returns:
        The parsed JSON response as a dict.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="Give me information for France.",
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_json_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "population": {"type": "integer"},
                    "capital": {"type": "string"},
                    "continent": {"type": "string"},
                },
                "required": ["name", "population", "capital"],
            },
        ),
    )
    import json

    return json.loads(_require_response_text(response))


def structured_list_output(client: genai.Client) -> dict[str, Any]:
    """Extract a structured list from free text using a Pydantic schema.

    Useful for categorization tasks where you need multiple items.

    Args:
        client: The Gemini API client.

    Returns:
        The parsed JSON response as a dict containing the list.
    """

    class FoodItem(BaseModel):
        name: str
        category: str
        is_plant_based: bool

    class FoodList(BaseModel):
        items: list[FoodItem]

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=(
            'Extract food items from: "I had a veggie burger, french fries, and a '
            'chocolate milkshake"'
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=FoodList,
        ),
    )
    import json

    return json.loads(_require_response_text(response))


# ----------------------------------------------------------------------
# 6. IMAGE UNDERSTANDING
# ----------------------------------------------------------------------


def analyze_image_from_url(client: genai.Client) -> str:
    """Analyze an image stored at a Google Cloud Storage URL.

    Useful when images are already in cloud storage.

    Args:
        client: The Gemini API client.

    Returns:
        The model's text description of the image.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=[
            "What food items are in this image? List them with their categories.",
            types.Part.from_uri(
                file_uri="gs://generativeai-downloads/images/scones.jpg",
                mime_type="image/jpeg",
            ),
        ],
    )
    return _require_response_text(response)


def analyze_local_image(client: genai.Client, image_path: str) -> str:
    """Analyze a local image file by uploading its bytes.

    This is the most common use case for image analysis.

    Args:
        client: The Gemini API client.
        image_path: Path to the image file on disk.

    Returns:
        The model's text description of the image.
    """
    with open(image_path, "rb") as f:
        image_bytes = f.read()

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=[
            "What food items are visible in this image? Categorize each one.",
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
        ],
    )
    return _require_response_text(response)


def analyze_multiple_images(client: genai.Client, image_paths: list[str]) -> str:
    """Analyze multiple images in a single request.

    Useful for comparing images or analyzing a sequence.

    Args:
        client: The Gemini API client.
        image_paths: List of paths to image files to analyze.

    Returns:
        The model's text response comparing the images.
    """
    content_parts: list[types.PartUnionDict] = [
        "Compare these images and describe the differences:"
    ]

    for image_path in image_paths:
        with open(image_path, "rb") as f:
            image_bytes = f.read()
        content_parts.append(types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"))

    content = types.UserContent(content_parts)

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=content,
    )
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 7. CHAT SESSIONS (MULTI-TURN CONVERSATIONS)
# ----------------------------------------------------------------------


def chat_session_basic(client: genai.Client) -> None:
    """Create a stateful chat session that maintains conversation history.

    Similar to OpenAI's chat completions but with automatic history management.

    Args:
        client: The Gemini API client.
    """
    chat = client.chats.create(model=EXAMPLE_FLASH_MODEL)

    response1 = chat.send_message("Tell me about plant-based proteins.")
    print("Assistant:", response1.text)

    response2 = chat.send_message("Which one has the most protein per 100g?")
    print("Assistant:", response2.text)

    response3 = chat.send_message("Give me a recipe using that ingredient.")
    print("Assistant:", response3.text)


def chat_session_streaming(client: genai.Client) -> None:
    """Create a chat session with streaming responses to stdout.

    Best for user-facing applications where you want to show responses as they arrive.

    Args:
        client: The Gemini API client.
    """
    chat = client.chats.create(model=EXAMPLE_FLASH_MODEL)

    print("User: Tell me a story about sustainable food systems")
    print("Assistant: ", end="", flush=True)
    for chunk in chat.send_message_stream("Tell me a story about sustainable food systems"):
        print(chunk.text, end="", flush=True)
    print("\n")


def chat_session_with_system_prompt(client: genai.Client) -> str:
    """Create a chat with a system instruction that persists across messages.

    Args:
        client: The Gemini API client.

    Returns:
        The model's text response.
    """
    chat = client.chats.create(
        model=EXAMPLE_FLASH_MODEL,
        config=types.GenerateContentConfig(
            system_instruction=(
                "You are a helpful assistant specializing in food categorization and "
                "nutrition. Always be concise and accurate."
            ),
            temperature=0.0,
        ),
    )

    response = chat.send_message('What category would "Beyond Burger" fall into?')
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 8. FILE HANDLING (PDFs, DOCUMENTS)
# ----------------------------------------------------------------------


def analyze_pdf_document(client: genai.Client, pdf_path: str) -> str:
    """Upload and analyze a PDF document.

    Useful for extracting information from invoices, menus, reports, etc.

    Args:
        client: The Gemini API client.
        pdf_path: Path to the PDF file to upload.

    Returns:
        The model's text response describing the document contents.
    """
    # Upload the file first
    uploaded_file = client.files.upload(file=pdf_path)

    # Then analyze it
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=["Extract all food items from this document and categorize them.", uploaded_file],
    )
    return _require_response_text(response)


def analyze_multiple_pdfs(client: genai.Client, pdf_paths: list[str]) -> str:
    """Upload and analyze multiple PDFs in a single request.

    Useful for comparing documents or extracting data from multiple sources.

    Args:
        client: The Gemini API client.
        pdf_paths: List of paths to PDF files to analyze.

    Returns:
        The model's text comparison of the documents.
    """
    uploaded_files = [client.files.upload(file=path) for path in pdf_paths]

    content_parts: list[types.PartUnionDict] = [
        "Compare these documents and summarize the key differences:"
    ]
    content_parts.extend(uploaded_files)
    content = types.UserContent(content_parts)

    response = client.models.generate_content(model=EXAMPLE_FLASH_MODEL, contents=content)
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 9. SAFETY SETTINGS
# ----------------------------------------------------------------------


def generate_with_safety_settings(client: genai.Client) -> str:
    """Generate text while configuring safety settings for content filtering.

    Use this to adjust the model's behavior for your use case.

    Args:
        client: The Gemini API client.

    Returns:
        The model's text response.
    """
    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents="Write about controversial food topics.",
        config=types.GenerateContentConfig(
            safety_settings=[
                types.SafetySetting(
                    category="HARM_CATEGORY_HATE_SPEECH",
                    threshold="BLOCK_ONLY_HIGH",
                ),
                types.SafetySetting(
                    category="HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold="BLOCK_ONLY_HIGH",
                ),
            ]
        ),
    )
    return _require_response_text(response)


# ----------------------------------------------------------------------
# 12. CONTEXT MANAGERS (BEST PRACTICE)
# ----------------------------------------------------------------------


def use_context_manager() -> str:
    """Use a context manager for automatic Gemini client resource cleanup.

    This is the recommended way to use the client in production.

    Returns:
        The model's text response.
    """
    with genai.Client() as client:
        response = client.models.generate_content(
            model=EXAMPLE_FLASH_MODEL,
            contents="Hello, how are you?",
        )
        return _require_response_text(response)


async def use_async_context_manager() -> str:
    """Use an async context manager for the Gemini client.

    Returns:
        The model's text response.
    """
    async with genai.Client().aio as aclient:
        response = await aclient.models.generate_content(
            model=EXAMPLE_FLASH_MODEL,
            contents="Hello, how are you?",
        )
        return _require_response_text(response)


# ----------------------------------------------------------------------
# 13. MIGRATION HELPERS (OPENAI -> GEMINI)
# ----------------------------------------------------------------------


def openai_style_call(client: genai.Client, messages: list[dict[str, str]]) -> str:
    """Make a call similar to OpenAI's ``chat.completions.create()``.

    Use this as a starting point when migrating from OpenAI.

    Args:
        client: The Gemini API client.
        messages: List of message dicts like ``[{"role": "user", "content": "..."}]``.

    Returns:
        The model's text response.
    """
    # Extract system message if present
    system_instruction = None
    user_messages = []

    for msg in messages:
        if msg["role"] == "system":
            system_instruction = msg["content"]
        elif msg["role"] == "user":
            user_messages.append(msg["content"])
        elif msg["role"] == "assistant":
            # For multi-turn, you'd need to use chat sessions
            pass

    # Simple single-turn example
    config = types.GenerateContentConfig()
    if system_instruction:
        config.system_instruction = system_instruction

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=user_messages[-1],  # Last user message
        config=config,
    )
    return _require_response_text(response)


class GeminiWrapper:
    """
    A wrapper class to make Gemini work more like OpenAI's API.
    Use this for easier migration if you have a lot of OpenAI code.
    """

    def __init__(self, api_key: str | None = None) -> None:
        """Initialize the wrapper with an optional explicit API key.

        Args:
            api_key: Optional Gemini API key. If ``None``, the client falls
                back to the ``GEMINI_API_KEY`` environment variable.
        """
        self.client = genai.Client(api_key=api_key) if api_key else genai.Client()

    def chat_completion(
        self,
        messages: list[dict[str, str]],
        model: str = EXAMPLE_FLASH_MODEL,
        temperature: float = 0.0,
        max_tokens: int = 1000,
    ) -> dict[str, Any]:
        """Make an OpenAI-style chat completion call against Gemini.

        Args:
            messages: List of OpenAI-style message dicts.
            model: Gemini model name to use. Defaults to ``EXAMPLE_FLASH_MODEL``.
            temperature: Sampling temperature. Defaults to ``0.0``.
            max_tokens: Maximum tokens to generate. Defaults to ``1000``.

        Returns:
            Dict shaped like an OpenAI chat completion response.
        """
        system_instruction = None
        user_content = []

        for msg in messages:
            if msg["role"] == "system":
                system_instruction = msg["content"]
            elif msg["role"] == "user":
                user_content.append(msg["content"])

        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        )

        if system_instruction:
            config.system_instruction = system_instruction

        response = self.client.models.generate_content(
            model=model,
            contents=user_content[-1] if user_content else "",
            config=config,
        )

        # Return in OpenAI-like format
        return {"choices": [{"message": {"content": response.text, "role": "assistant"}}]}


# ----------------------------------------------------------------------
# 14. USAGE EXAMPLES
# ----------------------------------------------------------------------


def main() -> None:
    """Run a demonstration of various Gemini API calls."""

    # Initialize client
    client = initialize_client_basic()

    # Example 1: Basic text generation
    print("=== Basic Text Generation ===")
    result = basic_text_generation(client)
    print(result)
    print()

    # Example 2: Text generation with config (like GBD categorization)
    print("=== Text Generation with Config (GBD-style) ===")
    result = text_generation_with_thinking_config(client)
    print(result)
    print()

    # Example 3: Structured output for categorization
    print("=== Structured Output for Product Info ===")
    result = structured_output_pydantic(client)
    print(result)
    print()

    # Example 4: OpenAI-style migration
    print("=== OpenAI-Style Migration ===")
    wrapper = GeminiWrapper()
    result = wrapper.chat_completion(
        messages=[
            {"role": "system", "content": "You are a food categorization expert."},
            {"role": "user", "content": "Categorize 'Beyond Burger'"},
        ],
        temperature=0.0,
    )
    print(result["choices"][0]["message"]["content"])
    print()


if __name__ == "__main__":
    # Note: Make sure GEMINI_API_KEY environment variable is set
    main()


# ----------------------------------------------------------------------
# 15. COMMON PATTERNS FOR GBD USE CASES
# ----------------------------------------------------------------------


def categorize_food_item_structured(
    client: genai.Client, item_name: str, categories: list[str]
) -> dict[str, Any]:
    """Categorize a food item into one of the provided categories.

    Returns structured output with the category and confidence. This is a
    better approach than the current name-cleaning LLM calls in
    ``categorization/steps.py``.

    Args:
        client: The Gemini API client.
        item_name: The food item to categorize.
        categories: Allowed category labels.

    Returns:
        Parsed JSON response as a dict with original/cleaned name, category,
        and confidence.
    """

    class FoodCategory(BaseModel):
        original_name: str
        cleaned_name: str
        category: str
        confidence: str  # "high", "medium", "low"

    prompt = f"""Analyze this food item and categorize it.

Item: {item_name}

Available categories:
{", ".join(categories)}

If none match, use "No Matches Found".
"""

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=FoodCategory,
            temperature=0.0,
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        ),
    )

    import json

    return json.loads(_require_response_text(response))


def batch_categorize_food_items(
    client: genai.Client, items: list[str], categories: list[str]
) -> dict[str, Any]:
    """Categorize multiple food items in a single API call.

    Much more efficient than calling the API for each item individually.
    Can reduce API calls by 10x or more.

    Args:
        client: The Gemini API client.
        items: List of food item names to categorize.
        categories: Allowed category labels.

    Returns:
        Parsed JSON response as a dict containing the categorized items list.
    """

    class FoodItem(BaseModel):
        original_name: str
        cleaned_name: str
        category: str

    class FoodBatch(BaseModel):
        items: list[FoodItem]

    prompt = f"""Categorize each of these food items.

Items:
{chr(10).join(f"{i + 1}. {item}" for i, item in enumerate(items))}

Available categories:
{", ".join(categories)}

If none match, use "No Matches Found".
"""

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=FoodBatch,
            temperature=0.0,
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        ),
    )

    import json

    return json.loads(_require_response_text(response))


def extract_pdf_menu_items(client: genai.Client, pdf_path: str) -> dict[str, Any]:
    """Extract menu items from a PDF with structured output.

    Better than the current PDF extraction approach because it uses structured output.

    Args:
        client: The Gemini API client.
        pdf_path: Path to the PDF file to upload.

    Returns:
        Parsed JSON response as a dict with restaurant name and menu items.
    """

    class MenuItem(BaseModel):
        name: str
        description: str
        price: float
        category: str

    class MenuData(BaseModel):
        restaurant_name: str
        items: list[MenuItem]

    uploaded_file = client.files.upload(file=pdf_path)

    response = client.models.generate_content(
        model=EXAMPLE_FLASH_MODEL,
        contents=[
            (
                "Extract all menu items from this document with their names, descriptions, "
                "prices, and categories."
            ),
            uploaded_file,
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=MenuData,
        ),
    )

    import json

    return json.loads(_require_response_text(response))


# ----------------------------------------------------------------------
# NOTES FOR MIGRATION:
# ----------------------------------------------------------------------
"""
Key Changes to Make in Your Codebase:

1. Replace all OpenAI imports:
   FROM: from openai import OpenAI
   TO:   from google import genai
         from google.genai import types

2. Replace client initialization:
   FROM: client = OpenAI(api_key=...)
   TO:   client = genai.Client()  # Uses GEMINI_API_KEY env var

3. Replace API calls:
   FROM: client.chat.completions.create(
             model="gpt-4-mini",
             messages=[{"role": "user", "content": "..."}],
             temperature=0
         )
   TO:   client.models.generate_content(
             model='gemini-3-flash-preview',
             contents='...',
             config=types.GenerateContentConfig(
                 temperature=0,
                 thinking_config=types.ThinkingConfig(thinking_level="minimal")
             )
         )

4. In utils.py, update call_gemini_api to use proper client:
   - Change `gemini_client.models.generate_content(...)` (already correct!)
   - Make sure client is initialized as `genai.Client()`

5. In categorization/steps.py, replace OpenAI calls with Gemini:
   - Update the name-cleaning LLM calls to use Gemini
   - Update the categorization LLM calls to use Gemini
   - Consider using batch categorization for efficiency

6. Model names to use:
   - gemini-3-flash-preview (recommended Flash model for most tasks)
   - gemini-3.1-pro-preview (recommended Pro model for harder reasoning)
   - gemini-3.1-flash-lite-preview (recommended low-cost high-volume option)

7. Benefits of Gemini over OpenAI:
   - Often cheaper
   - Better structured output support
   - Native image understanding
   - Batch processing support
   - Thinking mode for complex reasoning
   - Better document analysis (PDFs, etc.)
"""
