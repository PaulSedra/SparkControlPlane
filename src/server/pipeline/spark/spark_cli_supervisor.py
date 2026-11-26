"""Persist and supervise stock spark-pipelines CLI processes in the SCP runtime."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import signal
import shutil
import socket
import subprocess
import sys
import time
import zipfile

from spark_cli_state import (
    STDERR_LOG_NAME,
    STDOUT_LOG_NAME,
    lock_run_state,
    mutate_state,
    read_log_chunk,
    read_run_snapshot,
    read_state,
    reconcile_run_state,
    run_paths,
    utc_now,
    write_state,
)

SPARK_CONNECT_PORT_TOKEN = "<SPARK_CONNECT_PORT>"
SPARK_CONNECT_SERVER_STARTUP_TIMEOUT_SECONDS = 120
SPARK_CONNECT_SERVER_PORT_PATTERN = re.compile(
    r"Successfully started service "
    r"'org\.apache\.spark\.sql\.connect\.service\.SparkConnectService' "
    r"on port (\d+)\."
)


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


def build_pipeline_cli_command(
    payload: dict, environment: dict[str, str], connect_port: int
) -> list[str]:
    """Build SparkPipelines argv and add its runtime roots to `environment`."""
    command = command_with_connect_port(payload["command"], connect_port)
    adapter_directory = pathlib.Path(payload["pipelineSpecAdapterDirectory"]).resolve()
    entrypoint = adapter_directory / "spark_pipeline_cli.py"
    if not entrypoint.is_file():
        raise RuntimeError("The control-plane Spark Pipelines CLI entrypoint is unavailable.")

    environment["PYSPARK_PYTHON"] = (
        environment.get("PYSPARK_PYTHON", "").strip() or "python3"
    )
    spark_home = resolve_spark_home(environment)
    spark_class = spark_home / "bin" / "spark-class"
    if command[0] == "spark-pipelines" and not spark_class.is_file():
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

    if command[0] != "spark-pipelines":
        return command
    return [
        str(spark_class),
        "org.apache.spark.deploy.SparkPipelines",
        str(entrypoint),
        *command[1:],
    ]


def package_pipeline_sources_for_run(payload: dict) -> None:
    """Package the run's source snapshot before its Connect server starts."""
    _, run_directory = run_paths(payload["stateDirectory"], payload["runId"])
    package_pipeline_sources(
        payload["sourceFiles"],
        pathlib.Path(payload["workingDirectory"]).resolve(),
        pathlib.Path(payload["pipelineSpecAdapterDirectory"]).resolve(),
        run_directory,
    )


def command_with_connect_port(command: list[str], connect_port: int) -> list[str]:
    """Replace the internal port token in one Spark command vector."""
    if not isinstance(command, list) or not all(isinstance(word, str) for word in command):
        raise RuntimeError("A Spark command argument vector is required.")
    return [word.replace(SPARK_CONNECT_PORT_TOKEN, str(connect_port)) for word in command]


def wait_for_connect_server(
    process: subprocess.Popen,
    host: str,
    log_paths: tuple[pathlib.Path, pathlib.Path],
    signal_state: dict,
) -> int:
    """Wait until the per-run Connect server accepts TCP connections."""
    offsets = dict.fromkeys(log_paths, 0)
    trailing = dict.fromkeys(log_paths, "")
    port = None
    deadline = time.monotonic() + SPARK_CONNECT_SERVER_STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if signal_state["kind"] is not None:
            raise InterruptedError("Spark Connect server startup was canceled.")
        if process.poll() is not None:
            raise RuntimeError(
                f"Spark Connect server exited during startup with code {process.returncode}."
            )
        for log_path in log_paths:
            chunk, offsets[log_path] = read_log_chunk(log_path, offsets[log_path])
            text = trailing[log_path] + chunk.decode("utf-8", errors="replace")
            matches = SPARK_CONNECT_SERVER_PORT_PATTERN.findall(text)
            if matches:
                port = int(matches[-1])
            # The readiness marker is ASCII and can span two reads.
            trailing[log_path] = text[-256:]
        if port is not None:
            try:
                with socket.create_connection((host, port), timeout=1):
                    return port
            except OSError:
                pass
        time.sleep(0.25)
    raise RuntimeError(
        "Spark Connect server did not become ready within "
        f"{SPARK_CONNECT_SERVER_STARTUP_TIMEOUT_SECONDS} seconds."
    )


def start_connect_server(
    payload: dict,
    environment: dict[str, str],
    working_directory: pathlib.Path,
    stdout_stream,
    stderr_stream,
    log_paths: tuple[pathlib.Path, pathlib.Path],
    signal_state: dict,
    process_ref: dict,
) -> tuple[subprocess.Popen, int]:
    """Launch and await the per-run Spark Connect server application."""
    server_command = payload.get("connectServerCommand")
    if not isinstance(server_command, list) or not server_command:
        raise RuntimeError("A Standalone Spark Connect server command is required.")

    server_environment = environment.copy()
    server_environment["SPARK_CONNECT_MODE"] = "0"
    server_environment.pop("SPARK_REMOTE", None)
    process = subprocess.Popen(
        server_command,
        cwd=str(working_directory),
        env=server_environment,
        stdin=subprocess.DEVNULL,
        stdout=stdout_stream,
        stderr=stderr_stream,
        start_new_session=True,
        close_fds=True,
    )
    process_ref["process"] = process
    process_ref["group"] = group_identity(process.pid)
    mutate_state(
        pathlib.Path(payload["stateDirectory"]).resolve() / "runs" / payload["runId"],
        {"connectServerPid": process.pid, "connectServerGroup": process_ref["group"]},
    )
    port = wait_for_connect_server(process, "127.0.0.1", log_paths, signal_state)
    return process, port


def package_pipeline_sources(
    source_files: list[str],
    source_directory: pathlib.Path,
    adapter_directory: pathlib.Path,
    run_directory: pathlib.Path,
) -> None:
    """Package the verified source snapshot and spec adapter for Spark executors."""
    source_archive = run_directory / "pipeline-source.zip"
    with zipfile.ZipFile(source_archive, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(set(source_files)):
            relative = pathlib.PurePosixPath(name)
            if relative.is_absolute() or not relative.parts or ".." in relative.parts:
                raise ValueError("Invalid staged pipeline source path.")
            source_file = source_directory.joinpath(*relative.parts)
            if source_file.resolve(strict=True) != source_file or not source_file.is_file():
                raise ValueError("Staged pipeline source must be a regular file without symlinks.")
            archive.write(source_file, relative.as_posix())

    with source_archive.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(262_144), b""):
            digest.update(chunk)
    mutate_state(run_directory, {"sourceArchiveSha256": digest.hexdigest()})

    adapter_file = adapter_directory / "spark_pipeline_spec.py"
    if not adapter_file.is_file():
        raise RuntimeError("The control-plane Spark Pipelines spec loader is unavailable.")
    adapter_archive = run_directory / "spark-pipeline-adapter.zip"
    with zipfile.ZipFile(adapter_archive, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(adapter_file, adapter_file.name)


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


def process_matches_run(pid: object, run_id: str) -> bool:
    """Confirm a child command line contains the run ID before signaling it."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as stream:
            return run_id.encode("ascii") in stream.read()
    except (OSError, ValueError):
        return False


def process_identity(pid: int) -> tuple[str, int, int, int] | None:
    """Read process state, group ID, session ID, and start ticks from procfs."""
    try:
        fields = pathlib.Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()
        return fields[0].decode("ascii"), int(fields[2]), int(fields[3]), int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def group_identity(pid: int) -> dict:
    """Capture the kernel identity of a newly launched session leader."""
    # Popen has created the session and has not reaped the leader, so a
    # short retry can recover a transient procfs read even after an early exit.
    for attempt in range(3):
        identity = process_identity(pid)
        if identity is not None and identity[1:3] == (pid, pid):
            return {"groupId": pid, "startTicks": identity[3]}
        if attempt < 2:
            time.sleep(0.01)
    return {}


def group_is_alive(identity: dict) -> bool:
    """Check for a live member of the recorded session without trusting a reused PID."""
    group = identity["groupId"]
    start = identity["startTicks"]
    leader = process_identity(group)
    if leader is not None:
        if leader[1:] != (group, group, start):
            return False
        if leader[0] != "Z":
            return True

    for entry in pathlib.Path("/proc").iterdir():
        if entry.name.isdecimal():
            member = process_identity(int(entry.name))
            if (
                member is not None
                and member[0] != "Z"
                and member[1:3] == (group, group)
                and member[3] >= start
            ):
                return True
    return False


def stop_group(group_id, is_alive, interrupt_wait: int) -> None:
    """Escalate signals while the recorded process group still has live members."""
    for signum, wait_seconds in (
        (signal.SIGINT, interrupt_wait),
        (signal.SIGTERM, 5),
        (signal.SIGKILL, 2),
    ):
        if not is_alive():
            return
        try:
            os.killpg(group_id, signum)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            if not is_alive():
                return
            time.sleep(0.1)


def stop_orphaned_children(state: dict, run_id: str) -> None:
    """Stop verified sessions and support older records that store only PIDs."""
    for name in ("cli", "connectServer"):
        identity = state.get(f"{name}Group")
        pid = state.get(f"{name}Pid")
        if identity:
            stop_group(identity["groupId"], lambda identity=identity: group_is_alive(identity), 5)
        elif process_matches_run(pid, run_id):
            stop_group(pid, lambda pid=pid: process_matches_run(pid, run_id), 5)


def inspect_run(run_directory, run_id, stdout_offset, stderr_offset, protocol):
    """Reconcile an abandoned supervisor and read its status and log cursors."""
    state = reconcile_run_state(
        run_directory, run_id, protocol, process_is_alive, stop_orphaned_children
    )
    return read_run_snapshot(
        run_directory, run_id, stdout_offset, stderr_offset, protocol["states"], state
    )


def start(payload: dict, protocol: dict) -> dict:
    """Start one detached supervisor, or acknowledge its existing run record.

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
    connect_server_command = payload.get("connectServerCommand")
    if (
        not isinstance(connect_server_command, list)
        or not connect_server_command
        or not all(isinstance(word, str) for word in connect_server_command)
    ):
        raise RuntimeError("A per-run Standalone Spark Connect server command is required.")
    adapter_value = payload.get("pipelineSpecAdapterDirectory")
    if not isinstance(adapter_value, str):
        raise RuntimeError("A control-plane Spark Pipelines spec adapter is required.")
    adapter_directory = pathlib.Path(adapter_value).resolve()
    if not (adapter_directory / "spark_pipeline_spec.py").is_file():
        raise RuntimeError("The control-plane Spark Pipelines spec loader is unavailable.")
    if not (adapter_directory / "spark_pipeline_cli.py").is_file():
        raise RuntimeError("The control-plane Spark Pipelines CLI entrypoint is unavailable.")
    source_files = payload.get("sourceFiles")
    if not isinstance(source_files, list) or not source_files or not all(
        isinstance(name, str) for name in source_files
    ):
        raise RuntimeError("A verified pipeline source file list is required.")
    payload["pipelineSpecAdapterDirectory"] = str(adapter_directory)

    with lock_run_state(run_directory) as state_file:
        existing = read_state(state_file)
        if existing is None:
            initial = {
                "cliPid": None,
                "createdAt": utc_now(),
                "connectServerPid": None,
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
    return {"runId": payload["runId"], "accepted": True}



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
    environment = os.environ.copy()
    python_path = environment.get("PYTHONPATH", "")
    roots = [payload["pipelineSpecAdapterDirectory"], payload["workingDirectory"]]
    roots.extend(entry for entry in python_path.split(os.pathsep) if entry)
    environment["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(roots))
    environment["PYTHONUNBUFFERED"] = "1"
    environment["SPARK_CONTROL_PLANE_RUN_ID"] = run_id

    stdout_stream = stdout_path.open("ab", buffering=0)
    stderr_stream = stderr_path.open("ab", buffering=0)
    signal_state = {"kind": None}
    process_ref = {"process": None}
    server_ref = {"process": None}
    client_process = None
    server_process = None
    final_state = states["FAILED"]
    exit_code = 1
    reason = None
    server_start_attempted = False

    def forward_signal(signum: int, _frame: object) -> None:
        signal_state["kind"] = states["CANCELED"]
        signal_process_group(process_ref["process"], signum)
        signal_process_group(server_ref["process"], signum)

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)
    try:
        state = mutate_state(run_directory, {"state": states["RUNNING"], "startedAt": utc_now()})
        if state is None:
            return
        if state.get("cancelRequested") or signal_state["kind"] is not None:
            final_state = states["CANCELED"]
            exit_code = 130
        else:
            package_pipeline_sources_for_run(payload)
            server_start_attempted = True
            server_process, connect_port = start_connect_server(
                payload,
                environment,
                pathlib.Path(payload["workingDirectory"]).resolve(),
                stdout_stream,
                stderr_stream,
                (stdout_path, stderr_path),
                signal_state,
                server_ref,
            )
            command = build_pipeline_cli_command(payload, environment, connect_port)
            if signal_state["kind"] is not None or state.get("cancelRequested"):
                signal_state["kind"] = states["CANCELED"]
                final_state = states["CANCELED"]
                exit_code = 130
            else:
                client_process = subprocess.Popen(
                    command,
                    cwd=payload["workingDirectory"],
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_stream,
                    stderr=stderr_stream,
                    start_new_session=True,
                    close_fds=True,
                )
                process_ref["process"] = client_process
                process_ref["group"] = group_identity(client_process.pid)
                mutate_state(run_directory, {
                    "cliPid": client_process.pid,
                    "cliGroup": process_ref["group"],
                })
                if signal_state["kind"] is not None or state.get("cancelRequested"):
                    signal_state["kind"] = states["CANCELED"]
                    signal_process_group(client_process, signal.SIGINT)

                exit_code, timed_out = wait_for_cli_process(
                    client_process,
                    payload.get("timeoutSeconds"),
                    signal_state,
                    states,
                )
                final_state = final_execution_state(
                    signal_state["kind"], exit_code, timed_out, states
                )
    except InterruptedError as error:
        final_state = states["CANCELED"]
        exit_code = 130
        reason = str(error)
    except OSError as error:
        final_state = states["FAILED"]
        exit_code = 127
        failure_stage = (
            "SPARK_CONNECT_SERVER_START_FAILED" if server_start_attempted
            else "CLI_START_FAILED"
        )
        reason = f"{failure_stage}:{type(error).__name__}"
        stderr_stream.write(f"{error}\n".encode("utf-8", errors="replace"))
    except (RuntimeError, ValueError) as error:
        final_state = states["FAILED"]
        exit_code = 1
        failure_stage = (
            "SPARK_CONNECT_SERVER_START_FAILED" if server_start_attempted
            else "CLI_START_FAILED"
        )
        reason = f"{failure_stage}:{type(error).__name__}"
        stderr_stream.write(f"{error}\n".encode("utf-8", errors="replace"))
    except BaseException as error:
        final_state = states["UNKNOWN"]
        reason = f"CLI_SUPERVISOR_ERROR:{type(error).__name__}"
        raise
    finally:
        client_process = process_ref["process"]
        server_process = server_ref["process"]
        stop_process_group(client_process, process_ref.get("group"))
        stop_process_group(server_process, server_ref.get("group"))
        changes = {
            "connectServerPid": None,
            "connectServerGroup": None,
            "endedAt": utc_now(),
            "exitCode": exit_code,
            "state": final_state,
        }
        if reason is not None:
            changes["reason"] = reason
        mutate_state(run_directory, changes)
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


def signal_process_group(process: subprocess.Popen | None, signum: int) -> None:
    """Send a signal to a child process group if it is still running."""
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def stop_process_group(process: subprocess.Popen | None, identity: dict | None) -> None:
    """Reap the launcher and stop any remaining members of its recorded group."""
    if process is None:
        return

    def is_alive() -> bool:
        launcher_alive = process.poll() is None
        return group_is_alive(identity) if identity else launcher_alive

    stop_group(process.pid, is_alive, 10)
    process.poll()


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
    """Request cancellation for active work and acknowledge the durable request."""
    _, run_directory = run_paths(state_directory, run_id)
    with lock_run_state(run_directory) as state_file:
        state = read_state(state_file)
        if state is None or state.get("state") not in protocol["active"]:
            return {"runId": run_id, "accepted": True}
        state["cancelRequested"] = True
        write_state(state_file, state)
        if state["state"] != protocol["states"]["STARTING"] and process_is_alive(
            state.get("supervisorPid"), run_id
        ):
            try:
                os.kill(state["supervisorPid"], signal.SIGINT)
            except ProcessLookupError:
                pass
    return {"runId": run_id, "accepted": True}



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
        emit(inspect_run(run_directory, run_id, stdout_offset, stderr_offset, protocol))
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
