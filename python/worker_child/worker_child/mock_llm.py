"""`WORKER_MODE=mock-llm`'s entrypoint: the real `analyze()`, with `KeywordLlmClient` in place
of OpenAI, so a whole report runs with no network and no API key.

Imports `gbd_foodservice_insights.testing`, which product code may not, so the root
`pyproject.toml` exempts this file the way it exempts `testing.py`.

    python -m worker_child.mock_llm <runDirectory>
"""

import functools
import logging
import sys
from pathlib import Path
from typing import Final

from gbd_foodservice_insights.analysis import analyze
from gbd_foodservice_insights.testing import KeywordLlmClient

from worker_child.contract import names
from worker_child.run import run

USAGE: Final = f"usage: python -m worker_child.mock_llm <{'> <'.join(names.POSITIONAL_ARGUMENTS)}>"


def main(argv: list[str]) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return names.EXIT_USAGE_ERROR
    return run(Path(argv[1]), analyze=functools.partial(analyze, llm=KeywordLlmClient()))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
