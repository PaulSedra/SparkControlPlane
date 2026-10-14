"""Persist and supervise stock spark-pipelines CLI processes in the SCP runtime."""

from __future__ import annotations

import base64
import fcntl
import importlib.util
import json
import os
import pathlib
import signal
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

STATE_FILE_NAME = "state.json"
STATE_LOCK_FILE_NAME = ".state.lock"
STDOUT_LOG_NAME = "stdout.log"
STDERR_LOG_NAME = "stderr.log"


def utc_now() -> str:
    """Return the current UTC time as an ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def emit(value: object) -> None:
    """Write one compact JSON value to stdout for the Node supervisor."""
    print(json.dumps(value, separators=(",", ":")))


def decode_payload(value: str) -> dict:
    """Decode the supervisor's base64-encoded JSON payload."""
    return json.loads(base64.b64decode(value).decode("utf-8"))


def status_protocol() -> dict:
    """Load the shared CLI status map, raising when it is missing or invalid."""
    serialized = os.environ.get("SPARK_CONTROL_PLANE_CLI_STATUS_PROTOCOL")
    if serialized is None:
        raise RuntimeError("The shared CLI status protocol is unavailable.")
    protocol = json.loads(serialized)
    if not isinstance(protocol, dict) or not isinstance(protocol.get("states"), dict) or not isinstance(protocol.get("active"), list):
        raise RuntimeError("The shared CLI status protocol is invalid.")
    return protocol


def resolve_spark_home(environment: dict[str, str]) -> pathlib.Path:
    """Resolve Spark from `SPARK_HOME` or the configured PySpark interpreter."""
    configured_home = environment.get("SPARK_HOME", "").strip()
    if configured_home:
        return pathlib.Path(configured_home).resolve()

    python_executable = environment.get("PYSPARK_PYTHON", "").strip() or "python3"
    resolved_python = shutil.which(python_executable) or python_executable
    if os.path.realpath(resolved_python) == os.path.realpath(sys.executable):
        pyspark_spec = importlib.util.find_spec("pyspark")
        if pyspark_spec is not None and pyspark_spec.origin is not None:
            return pathlib.Path(pyspark_spec.origin).resolve().parent

    result = subprocess.run(
        [
            python_executable,
            "-c",
            "import pathlib, pyspark; print(pathlib.Path(pyspark.__file__).resolve().parent)",
        ],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
    )
    spark_home = result.stdout.strip().splitlines()
    if result.returncode != 0 or not spark_home:
        raise RuntimeError("Unable to resolve Spark home for the supervised Pipelines CLI.")
    return pathlib.Path(spark_home[-1]).resolve()


def build_pipeline_cli_command(payload: dict, environment: dict[str, str]) -> list[str]:
    """Build SparkPipelines argv and add its runtime roots to `environment`."""
    command = payload["command"]
    adapter_directory = pathlib.Path(payload["pipelineSpecAdapterDirectory"]).resolve()
    entrypoint = adapter_directory / "spark_pipeline_cli.py"
    if not entrypoint.is_file():
        raise RuntimeError("The control-plane Spark Pipelines CLI entrypoint is unavailable.")

    environment["PYSPARK_PYTHON"] = (
        environment.get("PYSPARK_PYTHON", "").strip() or "python3"
    )
    spark_home = resolve_spark_home(environment)
    spark_class = spark_home / "bin" / "spark-class"
    if not spark_class.is_file():
        raise RuntimeError("The SparkPipelines launcher is unavailable in the configured Spark home.")
    environment["SPARK_HOME"] = str(spark_home)

    python_roots = sorted(
        str(archive)
        for archive in (spark_home / "python" / "lib").glob("py4j-*.zip")
    )
    python_roots.extend(
        [
            str(spark_home / "python"),
            str(adapter_directory),
            payload["workingDirectory"],
        ]
    )
    python_roots.extend(
        entry for entry in environment.get("PYTHONPATH", "").split(os.pathsep) if entry
    )
    environment["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(python_roots))

    return [
        str(spark_class),
        "org.apache.spark.deploy.SparkPipelines",
        str(entrypoint),
        *command[1:],
    ]


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


def mutate_state(run_directory: pathlib.Path, changes: dict) -> dict | None:
    """Update run state under its file lock, or return `None` if it is absent."""
    state_file = run_directory / STATE_FILE_NAME
    lock_file = run_directory / STATE_LOCK_FILE_NAME
    run_directory.mkdir(parents=True, exist_ok=True)
    with lock_file.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = read_state(state_file)
        if state is None:
            return None
        state.update(changes)
        write_state(state_file, state)
        return state


def process_is_alive(pid: object, run_id: str) -> bool:
    """Confirm that a PID exists and its command line carries this run's ID."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        with open(f"/proc/{pid}/cmdline", "rb") as stream:
            command_line = stream.read()
        return f"SCP_CLI_RUN:{run_id}".encode("ascii") in command_line
    except (OSError, ValueError):
        return False


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


def snapshot(
    run_directory: pathlib.Path,
    run_id: str,
    stdout_offset: int,
    stderr_offset: int,
    protocol: dict,
) -> dict:
    """Build run state and bounded stdout/stderr chunks for reattachment.

    An active record without its matching supervisor is persisted as UNKNOWN.
    """
    states = protocol["states"]
    state_file = run_directory / STATE_FILE_NAME
    state = read_state(state_file)
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

    if state.get("state") in protocol["active"]:
        if not process_is_alive(state.get("supervisorPid"), run_id):
            state = mutate_state(run_directory, {
                "state": states["UNKNOWN"],
                "endedAt": utc_now(),
                "reason": "CLI_SUPERVISOR_NOT_RUNNING",
            }) or state

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


def start(payload: dict, protocol: dict) -> dict:
    """Start one detached supervisor, or inspect its existing run record.

    A per-run lock prevents duplicate supervisors; the working directory,
    command, and control-plane adapter files must be available in the runtime.
    """
    states = protocol["states"]
    _, run_directory = run_paths(payload["stateDirectory"], payload["runId"])
    working_directory = pathlib.Path(payload["workingDirectory"]).resolve()
    if not working_directory.is_dir():
        raise RuntimeError("Pipeline working directory is unavailable in the SCP runtime.")
    command = payload.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(word, str) for word in command):
        raise RuntimeError("A stock Spark Pipelines CLI argument vector is required.")
    adapter_value = payload.get("pipelineSpecAdapterDirectory")
    if not isinstance(adapter_value, str):
        raise RuntimeError("A control-plane Spark Pipelines spec adapter is required.")
    adapter_directory = pathlib.Path(adapter_value).resolve()
    if not (adapter_directory / "spark_pipeline_spec.py").is_file():
        raise RuntimeError("The control-plane Spark Pipelines spec loader is unavailable.")
    if not (adapter_directory / "spark_pipeline_cli.py").is_file():
        raise RuntimeError("The control-plane Spark Pipelines CLI entrypoint is unavailable.")
    payload["pipelineSpecAdapterDirectory"] = str(adapter_directory)

    run_directory.mkdir(parents=True, exist_ok=True)
    state_file = run_directory / STATE_FILE_NAME
    lock_file = run_directory / STATE_LOCK_FILE_NAME
    with lock_file.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        existing = read_state(state_file)
        if existing is None:
            initial = {
                "cliPid": None,
                "createdAt": utc_now(),
                "runId": payload["runId"],
                "sourceHash": payload.get("sourceHash", ""),
                "state": states["STARTING"],
                "supervisorPid": None,
            }
            write_state(state_file, initial)
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
            supervisor = subprocess.Popen(
                [
                    payload["pythonPath"],
                    str(pathlib.Path(__file__).resolve()),
                    "execute",
                    payload["runId"],
                    encoded,
                    f"SCP_CLI_RUN:{payload['runId']}",
                ],
                cwd=str(working_directory),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
            )
            # The child waits for this same file lock before changing STARTING
            # to RUNNING, so record its PID before releasing the lock.
            state = read_state(state_file) or initial
            state["supervisorPid"] = supervisor.pid
            write_state(state_file, state)
        return snapshot(
            run_directory,
            payload["runId"],
            payload.get("stdoutOffset", 0),
            payload.get("stderrOffset", 0),
            protocol,
        )


def execute(run_id: str, payload: dict, protocol: dict) -> None:
    """Run the Spark CLI and persist its output, cancellation, and final state.

    Timeout sends SIGINT first and escalates to SIGKILL if the CLI stays alive.
    """
    states = protocol["states"]
    _, run_directory = run_paths(payload["stateDirectory"], run_id)
    stdout_path = run_directory / STDOUT_LOG_NAME
    stderr_path = run_directory / STDERR_LOG_NAME
    stdout_path.touch(exist_ok=True)
    stderr_path.touch(exist_ok=True)
    state = mutate_state(run_directory, {"state": states["RUNNING"], "startedAt": utc_now()})
    if state is None:
        return

    environment = os.environ.copy()
    python_path = environment.get("PYTHONPATH", "")
    roots = [payload["pipelineSpecAdapterDirectory"], payload["workingDirectory"]]
    roots.extend(entry for entry in python_path.split(os.pathsep) if entry)
    environment["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(roots))
    environment["PYTHONUNBUFFERED"] = "1"
    environment["SPARK_CONTROL_PLANE_RUN_ID"] = run_id
    command = build_pipeline_cli_command(payload, environment)

    stdout_stream = stdout_path.open("ab", buffering=0)
    stderr_stream = stderr_path.open("ab", buffering=0)
    signal_state = {"kind": None}
    process_ref = {"process": None}

    def forward_signal(signum: int, _frame: object) -> None:
        signal_state["kind"] = states["CANCELED"]
        process = process_ref["process"]
        if process is not None:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)
    try:
        if state.get("cancelRequested"):
            mutate_state(run_directory, {
                "endedAt": utc_now(),
                "exitCode": 130,
                "state": states["CANCELED"],
            })
            return
        process = subprocess.Popen(
            command,
            cwd=payload["workingDirectory"],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout_stream,
            stderr=stderr_stream,
            start_new_session=True,
            close_fds=True,
        )
        process_ref["process"] = process
        mutate_state(run_directory, {"cliPid": process.pid})
        if signal_state["kind"] is not None or state.get("cancelRequested"):
            signal_state["kind"] = states["CANCELED"]
            try:
                os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass

        exit_code, timed_out = wait_for_cli_process(
            process,
            payload.get("timeoutSeconds"),
            signal_state,
            states,
        )
        final_state = final_execution_state(signal_state["kind"], exit_code, timed_out, states)
        mutate_state(run_directory, {
            "endedAt": utc_now(),
            "exitCode": exit_code,
            "state": final_state,
        })
    except OSError as error:
        mutate_state(run_directory, {
            "endedAt": utc_now(),
            "exitCode": 127,
            "reason": f"CLI_START_FAILED:{type(error).__name__}",
            "state": states["FAILED"],
        })
    except BaseException as error:
        mutate_state(run_directory, {
            "endedAt": utc_now(),
            "reason": f"CLI_SUPERVISOR_ERROR:{type(error).__name__}",
            "state": states["UNKNOWN"],
        })
        raise
    finally:
        stdout_stream.close()
        stderr_stream.close()


def wait_for_cli_process(
    process: subprocess.Popen,
    timeout_seconds: object,
    signal_state: dict,
    states: dict,
) -> tuple[int, bool]:
    """Wait without a deadline unless one was configured for this pipeline."""
    if timeout_seconds is None:
        return process.wait(), False
    try:
        return process.wait(timeout=max(1, int(timeout_seconds))), False
    except subprocess.TimeoutExpired:
        signal_state["kind"] = states["TIMED_OUT"]
        signal_process_group(process, signal.SIGINT)
        try:
            return process.wait(timeout=10), True
        except subprocess.TimeoutExpired:
            signal_process_group(process, signal.SIGKILL)
            return process.wait(), True


def signal_process_group(process: subprocess.Popen, signum: int) -> None:
    """Send a signal to the CLI process group if it is still present."""
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def final_execution_state(
    signal_kind: str | None,
    exit_code: int,
    timed_out: bool,
    states: dict,
) -> str:
    """Resolve cancellation, timeout, and the CLI exit code into one state."""
    if timed_out:
        return states["TIMED_OUT"]
    if signal_kind is not None:
        return signal_kind
    return states["COMPLETED"] if exit_code == 0 else states["FAILED"]


def cancel(state_directory: str, run_id: str, protocol: dict) -> dict:
    """Request cancellation for active work and return its current snapshot."""
    _, run_directory = run_paths(state_directory, run_id)
    state = read_state(run_directory / STATE_FILE_NAME)
    if state is not None and state.get("state") in protocol["active"]:
        state = mutate_state(run_directory, {"cancelRequested": True}) or state
        if process_is_alive(state.get("supervisorPid"), run_id):
            try:
                os.kill(state["supervisorPid"], signal.SIGINT)
            except ProcessLookupError:
                pass
    return snapshot(run_directory, run_id, 0, 0, protocol)


def main() -> None:
    """Dispatch the operation from argv; snapshot actions emit one JSON line."""
    protocol = status_protocol()
    action = sys.argv[1]
    if action == "start":
        emit(start(decode_payload(sys.argv[2]), protocol))
    elif action == "inspect":
        state_directory, run_id = sys.argv[2:4]
        stdout_offset, stderr_offset = int(sys.argv[4]), int(sys.argv[5])
        _, run_directory = run_paths(state_directory, run_id)
        emit(snapshot(run_directory, run_id, stdout_offset, stderr_offset, protocol))
    elif action == "cancel":
        emit(cancel(sys.argv[2], sys.argv[3], protocol))
    elif action == "execute":
        execute(sys.argv[2], decode_payload(sys.argv[3]), protocol)
    else:
        raise ValueError("Unsupported local CLI supervision operation.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"local spark-pipelines supervisor: {error}", file=sys.stderr)
        sys.exit(1)
