"""Manage locked supervisor records and bounded log snapshots."""

from __future__ import annotations

import base64
import fcntl
import json
import os
import pathlib
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone

STATE_FILE_NAME = "state.json"
STATE_LOCK_FILE_NAME = ".state.lock"
RECOVERY_LOCK_FILE_NAME = ".recovery.lock"
STDOUT_LOG_NAME = "stdout.log"
STDERR_LOG_NAME = "stderr.log"


def utc_now() -> str:
    """Return the current UTC time as an ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def run_paths(state_directory: str, run_id: str) -> tuple[pathlib.Path, pathlib.Path]:
    """Return the state root and contained run directory for a valid run ID."""
    if not run_id or any(character not in "0123456789abcdefABCDEF-" for character in run_id):
        raise ValueError("Run identity contains unsupported characters.")
    state_root = pathlib.Path(state_directory).resolve()
    run_directory = (state_root / "runs" / run_id).resolve()
    if not run_directory.is_relative_to(state_root):
        raise ValueError("Run state path escapes the configured state directory.")
    return state_root, run_directory


def read_state(state_file: pathlib.Path) -> dict | None:
    """Read a JSON state file, returning `None` only when it is absent."""
    try:
        with state_file.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except FileNotFoundError:
        return None


def write_state(state_file: pathlib.Path, state: dict) -> None:
    """Atomically replace a state file with the supplied JSON object."""
    state_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".state-", suffix=".tmp", dir=state_file.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(state, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, state_file)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


@contextmanager
def lock_run_state(run_directory: pathlib.Path):
    """Serialize writers to this run and yield its state file path."""
    run_directory.mkdir(parents=True, exist_ok=True)
    with (run_directory / STATE_LOCK_FILE_NAME).open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield run_directory / STATE_FILE_NAME


def mutate_state(run_directory: pathlib.Path, changes: dict) -> dict | None:
    """Update run state under its lock, returning None for a missing record."""
    with lock_run_state(run_directory) as state_file:
        state = read_state(state_file)
        if state is None:
            return None
        state.update(changes)
        write_state(state_file, state)
        return state


def reconcile_run_state(run_directory, run_id, protocol, supervisor_alive, stop_children):
    """Claim recovery separately from state writes and retry if the claimant dies."""
    state_file = run_directory / STATE_FILE_NAME

    def abandoned(record):
        return (
            record is not None
            and record.get("state") in protocol["active"]
            and not supervisor_alive(record.get("supervisorPid"), run_id)
        )

    state = read_state(state_file)
    if not abandoned(state):
        return state

    with (run_directory / RECOVERY_LOCK_FILE_NAME).open("a+b") as recovery:
        try:
            fcntl.flock(recovery.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return read_state(state_file)
        with lock_run_state(run_directory):
            state = read_state(state_file)
            if not abandoned(state):
                return state

        stop_children(state, run_id)

        with lock_run_state(run_directory):
            current = read_state(state_file)
            if not abandoned(current) or current.get("supervisorPid") != state.get("supervisorPid"):
                return current
            current.update(
                state=protocol["states"]["UNKNOWN"],
                endedAt=utc_now(),
                reason="CLI_SUPERVISOR_NOT_RUNNING",
            )
            write_state(state_file, current)
            return current


def read_log_chunk(log_file: pathlib.Path, offset: int, maximum_bytes: int = 262_144) -> tuple[bytes, int]:
    """Read at most `maximum_bytes` after `offset` and return the next offset."""
    try:
        with log_file.open("rb") as stream:
            stream.seek(max(0, offset))
            chunk = stream.read(maximum_bytes)
    except FileNotFoundError:
        return b"", max(0, offset)
    return chunk, max(0, offset) + len(chunk)


def log_has_remaining_bytes(log_file: pathlib.Path, offset: int) -> bool:
    """Reports whether an inspected log has bytes after the returned chunk."""
    try:
        return log_file.stat().st_size > max(0, offset)
    except FileNotFoundError:
        return False


def read_run_snapshot(
    run_directory: pathlib.Path,
    run_id: str,
    stdout_offset: int,
    stderr_offset: int,
    states: dict,
    state: dict | None,
) -> dict:
    """Combine reconciled state with bounded stdout and stderr chunks."""
    stdout_chunk, next_stdout_offset = read_log_chunk(
        run_directory / STDOUT_LOG_NAME, stdout_offset
    )
    stderr_chunk, next_stderr_offset = read_log_chunk(
        run_directory / STDERR_LOG_NAME, stderr_offset
    )
    output_state = {
        "stderrChunk": base64.b64encode(stderr_chunk).decode("ascii"),
        "stderrOffset": next_stderr_offset,
        "stderrRemaining": log_has_remaining_bytes(
            run_directory / STDERR_LOG_NAME, next_stderr_offset
        ),
        "stdoutChunk": base64.b64encode(stdout_chunk).decode("ascii"),
        "stdoutOffset": next_stdout_offset,
        "stdoutRemaining": log_has_remaining_bytes(
            run_directory / STDOUT_LOG_NAME, next_stdout_offset
        ),
    }
    if state is None:
        return {
            "reason": "CLI_RECORD_MISSING",
            "runId": run_id,
            "state": states["UNKNOWN"],
            "runDirectory": str(run_directory),
            **output_state,
        }

    return {
        "endedAt": state.get("endedAt"),
        "exitCode": state.get("exitCode"),
        "processId": state.get("cliPid"),
        "reason": state.get("reason"),
        "runDirectory": str(run_directory),
        "runId": run_id,
        "startedAt": state.get("startedAt"),
        "state": state.get("state", states["UNKNOWN"]),
        **output_state,
    }
