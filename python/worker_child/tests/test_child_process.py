"""Nothing here is mocked beyond `analyze()` — see `tests/support/child.py` for why: this is
the only place `worker_child` is proven to behave correctly as a real OS process, under the
exact conditions the parent imposes on it.

No test waits on wall-clock time to synchronize with the child. `wait_until` polls for a file
the child itself writes at a known point (`progress.json`, `grandchild.pid`) — the same
technique `apps/worker/src/child/spawn.test.ts` uses against `fake-child.ts`. The two SIGTERM
tests are deterministic by construction: a child with no handler can only die by SIGTERM, and
one that ignores it can only die by SIGKILL once escalated.
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

# Everything `spawnChild` grants the real child, mirrored exactly so a test invokes the process
# the way production will.
ALLOWED_ENVIRONMENT_VARIABLES = ("PATH", "HOME", "LANG", "TZ", *names.SECRET_ENVIRONMENT_VARIABLES)

pytestmark = pytest.mark.slow


@pytest.fixture
def run_directory(tmp_path: Path) -> Path:
    """A run directory as the parent builds it, with a valid manifest already in place."""
    for relative in layout.DIRECTORIES_CREATED_BY_PARENT:
        (tmp_path / relative).mkdir(parents=True)
    (tmp_path / layout.MANIFEST).write_text(VALID_MANIFEST, encoding="utf-8")
    return tmp_path


def _filtered_environment(source: Mapping[str, str]) -> dict[str, str]:
    return {name: source[name] for name in ALLOWED_ENVIRONMENT_VARIABLES if name in source}


def spawn_child(
    scenario: Mapping[str, Any],
    run_directory: Path,
    *,
    environment: Mapping[str, str] | None = None,
) -> subprocess.Popen[bytes]:
    """Spawns the real child exactly as the parent will: `cwd=work/`, only the environment
    allowlist, and as the leader of its own process group so a kill can reach a grandchild.
    """
    return subprocess.Popen(
        [sys.executable, str(CHILD_SCRIPT), json.dumps(scenario), str(run_directory)],
        cwd=run_directory / layout.WORK_DIRECTORY,
        env=_filtered_environment(environment if environment is not None else os.environ),
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


def test_stdout_stays_silent_no_matter_what_the_analysis_does(run_directory: Path) -> None:
    process = spawn_child({"charts": ["category_breakdown", "waste_by_site"]}, run_directory)

    stdout, _ = process.communicate(timeout=30)

    assert stdout == b""


def test_the_child_runs_in_work_so_a_stray_relative_write_lands_in_scratch(
    run_directory: Path,
) -> None:
    process = spawn_child({}, run_directory)
    process.communicate(timeout=30)

    work_directory = run_directory / layout.WORK_DIRECTORY
    assert (work_directory / "cwd.txt").read_text(encoding="utf-8") == str(work_directory)


def test_the_child_only_sees_the_env_var_allowlist(run_directory: Path) -> None:
    parent_environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": "/home/analysis",
        "LANG": "en_US.UTF-8",
        "TZ": "UTC",
        "GEMINI_API_KEY": "gemini-key",
        "LLM_WHISPERER_API_KEY": "whisperer-key",
        "OPENAI_API_KEY": "openai-key",
        # Held by the parent for its own use; must never cross.
        "DB_CONNECTION_STRING": "postgres://parent-only",
        "S3_BUCKET": "parent-only",
    }

    process = spawn_child({}, run_directory, environment=parent_environment)
    process.communicate(timeout=30)

    assert process.returncode == names.EXIT_WROTE_RESULT
    environment = read_json(run_directory / layout.WORK_DIRECTORY / "environment.json")
    # Narrowed to the parent's own variables, because the real interpreter adds some of its own
    # to every process it starts.
    crossed = {name: value for name, value in environment.items() if name in parent_environment}
    assert crossed == _filtered_environment(parent_environment)


def test_progress_advances_under_concurrent_load(run_directory: Path) -> None:
    process = spawn_child({"progressCalls": 50}, run_directory)

    process.communicate(timeout=30)

    assert process.returncode == names.EXIT_WROTE_RESULT
    assert read_json(run_directory / layout.PROGRESS) == {"sequence": 50}


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


def test_a_child_that_ignores_sigterm_is_escalated_to_sigkill(run_directory: Path) -> None:
    process = spawn_child({"hang": True, "ignoreSigterm": True}, run_directory)
    try:
        wait_until(
            lambda: (run_directory / layout.PROGRESS).exists(),
            "the child has installed its SIGTERM handler",
        )

        os.killpg(process.pid, signal.SIGTERM)
        time.sleep(0.2)
        assert process.poll() is None, "a child that ignores SIGTERM should not have exited yet"

        os.killpg(process.pid, signal.SIGKILL)

        process.wait(timeout=5)
        assert process.returncode == -signal.SIGKILL
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
