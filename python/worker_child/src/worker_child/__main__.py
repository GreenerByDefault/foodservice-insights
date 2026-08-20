import logging
import sys
from pathlib import Path

from worker_child.contract import names
from worker_child.run import run

USAGE = f"usage: python -m {names.MODULE} <{'> <'.join(names.POSITIONAL_ARGUMENTS)}>"


def main(argv: list[str]) -> int:
    """`python -m worker_child <runDirectory>`. Argv, stderr logging, and nothing else —
    `run.py` chooses everything else, including the exit codes.
    """
    # The parent captures only stderr, so anything the library logs must land there.
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return names.EXIT_USAGE_ERROR
    return run(Path(argv[1]))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
