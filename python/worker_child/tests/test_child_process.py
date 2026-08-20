"""Three files split `worker_child`'s test coverage:

- `test_run.py` drives `run()` in-process with `stub_analysis` — no subprocess, cheaply
  covering the success path and every failure reason `run()` maps.
- `test_main.py` spawns the real entrypoint too, but only for paths that never reach
  `analyze()` (usage errors, manifest problems) — proving argv and exit-code wiring.
- This file also spawns the real entrypoint, past a stubbed `analyze()` — see
  `tests/support/child.py` for why. It covers only what a real OS process proves that an
  in-process call cannot: a successful and a failing run surviving the process boundary at
  all, that nothing installs a SIGTERM handler, and that killing the child's process group
  reaches a grandchild it spawned. `cwd`, the environment allowlist, and progress under
  concurrent load are Python/OS guarantees or already covered in-process (`test_writer.py`),
  and don't belong here just because they can be dressed up as a subprocess test.

No test waits on wall-clock time to synchronize with the child. `wait_until` polls for a file
the child itself writes at a known point (`progress.json`, `grandchild.pid`) — the same
technique `apps/worker/src/child/spawn.test.ts` uses against `fake-child.ts`. The SIGTERM test
is deterministic by construction: a child with no handler can only die by SIGTERM.
"""

import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest
from worker_child.contract import layout, names

REPO_ROOT = Path(__file__).resolve().parents[3]
VALID_MANIFEST = (REPO_ROOT / "contract" / "fixtures" / "valid" / "run.json").read_text(
    encoding="utf-8"
)
VALID_ANALYSIS_ATTEMPT_ID = json.loads(VALID_MANIFEST)["analysisAttemptId"]

CHILD_SCRIPT = Path(__file__).resolve().parent / "support" / "child.py"

pytestmark = pytest.mark.slow


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it, with a valid manifest already in place."""
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    (tmp_path / layout.MANIFEST).write_text(VALID_MANIFEST, encoding="utf-8")
    return tmp_path


def spawn_child(scenario: Mapping[str, Any], run_directory: Path) -> subprocess.Popen[bytes]:
    """Spawns the real child exactly as the parent will: `cwd=work/`, only the environment
    allowlist, and as the leader of its own process group so a kill can reach a grandchild.
    """
    allowlisted_environment = {
        name: os.environ[name] for name in names.ENVIRONMENT_VARIABLES if name in os.environ
    }
    return subprocess.Popen(
        [sys.executable, str(CHILD_SCRIPT), json.dumps(scenario), str(run_directory)],
        cwd=run_directory / layout.WORK_DIRECTORY,
        env=allowlisted_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )


def wait_until(predicate: Callable[[], bool], description: str, *, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for: {description}")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def kill_group_if_alive(process: subprocess.Popen[bytes]) -> None:
    """However a test ends, leave no process behind holding `run_directory` open."""
    if process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=5)


def test_a_successful_analysis_exits_zero_and_writes_the_contracts_result(
    run_directory: Path,
) -> None:
    process = spawn_child({}, run_directory)

    stdout, _ = process.communicate(timeout=30)

    assert process.returncode == names.EXIT_WROTE_RESULT
    assert stdout == b""
    assert read_json(run_directory / layout.RESULT)["analysisAttemptId"] == (
        VALID_ANALYSIS_ATTEMPT_ID
    )
    assert (run_directory / layout.RESULT_FILES_DIRECTORY / layout.PDF_FILE_NAME).is_file()


def test_an_analysis_error_reaches_failure_json_through_a_real_process(
    run_directory: Path,
) -> None:
    process = spawn_child({"raises": "unusable_data"}, run_directory)

    process.communicate(timeout=30)

    assert process.returncode == names.EXIT_WROTE_FAILURE
    assert read_json(run_directory / layout.FAILURE)["reason"] == "unusable_data"


def test_a_child_with_no_handler_dies_of_sigterm(run_directory: Path) -> None:
    process = spawn_child({"hang": True}, run_directory)
    try:
        wait_until(
            lambda: (run_directory / layout.PROGRESS).exists(),
            "the child has entered its scenario",
        )

        os.killpg(process.pid, signal.SIGTERM)

        process.wait(timeout=5)
        assert process.returncode == -signal.SIGTERM
    finally:
        kill_group_if_alive(process)


def test_everything_the_child_spawned_dies_with_it(run_directory: Path) -> None:
    process = spawn_child({"spawnGrandchild": True, "hang": True}, run_directory)
    try:
        pid_file = run_directory / layout.WORK_DIRECTORY / "grandchild.pid"
        wait_until(pid_file.exists, "the child has spawned a subprocess of its own")
        grandchild_pid = int(pid_file.read_text(encoding="utf-8"))
        assert is_running(grandchild_pid)

        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)

        wait_until(lambda: not is_running(grandchild_pid), "the grandchild has gone too")
    finally:
        kill_group_if_alive(process)
