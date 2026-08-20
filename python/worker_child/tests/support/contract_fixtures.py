"""Access to `contract/` — the golden documents both stacks parse, and the invalid ones both
stacks must reject. One definition of where the repo root is, so no test file counts `parents`
for itself.
"""

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT_DIRECTORY = REPO_ROOT / "contract"
FIXTURES = CONTRACT_DIRECTORY / "fixtures"


def read(directory: str, name: str) -> str:
    return (FIXTURES / directory / name).read_text(encoding="utf-8")


def load(directory: str, name: str) -> Any:
    return json.loads(read(directory, name))


def names_in(directory: str) -> list[str]:
    return sorted(path.name for path in (FIXTURES / directory).glob("*.json"))


CONTRACT: dict[str, Any] = json.loads(
    (CONTRACT_DIRECTORY / "contract.json").read_text(encoding="utf-8")
)

VALID_MANIFEST = read("valid", "run.json")
VALID_ANALYSIS_ATTEMPT_ID = json.loads(VALID_MANIFEST)["analysisAttemptId"]

# `run.json` is the only document the child parses — it writes the other three — so these are
# the only invalid fixtures this stack is responsible for rejecting.
INVALID_RUN_FIXTURE_NAMES = [name for name in names_in("invalid") if name.startswith("run.")]
