"""Regression tests for supervisor state, startup, and source packaging."""

import concurrent.futures
import hashlib
import pathlib
import sys
import tempfile
import threading
import unittest
import zipfile
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[4] / "src/server/pipeline/spark"))

import spark_cli_state as state
import spark_cli_supervisor as supervisor

PROTOCOL = {
    "active": ["STARTING", "RUNNING"],
    "states": {"STARTING": "STARTING", "UNKNOWN": "UNKNOWN"},
}
RUN_ID = "ab-cd"


class SupervisorTest(unittest.TestCase):
    """Exercise externally visible state and archive behavior without starting Spark."""

    def test_concurrent_start_acknowledges_one_durable_submission(self):
        with tempfile.TemporaryDirectory() as working:
            root = pathlib.Path(working)
            for name in ("spark_pipeline_spec.py", "spark_pipeline_cli.py"):
                (root / name).touch()
            payload = {
                "command": ["spark-pipelines"],
                "connectServerCommand": ["spark-submit"],
                "pipelineSpecAdapterDirectory": working,
                "pythonPath": sys.executable,
                "runId": RUN_ID,
                "sourceFiles": ["pipeline.yml"],
                "stateDirectory": working,
                "workingDirectory": working,
            }
            with mock.patch.object(supervisor.subprocess, "Popen", return_value=mock.Mock(pid=123)), \
                    concurrent.futures.ThreadPoolExecutor(2) as executor:
                replies = list(executor.map(lambda _: supervisor.start(payload.copy(), PROTOCOL), range(2)))
                supervisor.subprocess.Popen.assert_called_once()
            self.assertTrue(all(reply["accepted"] for reply in replies))
            record = state.read_state(root / "runs" / RUN_ID / state.STATE_FILE_NAME)
            self.assertEqual(record["state"], "STARTING")
            self.assertEqual(record["supervisorPid"], 123)

    def test_concurrent_inspections_reconcile_an_orphan_once(self):
        with tempfile.TemporaryDirectory() as working:
            root = pathlib.Path(working)
            state.write_state(root / state.STATE_FILE_NAME, {"state": "RUNNING"})
            cleanup_started = threading.Event()
            release_cleanup = threading.Event()

            def cleanup(_record, _run_id):
                cleanup_started.set()
                self.assertTrue(release_cleanup.wait(5))

            with mock.patch.object(supervisor, "stop_orphaned_children", side_effect=cleanup) as stop, \
                    concurrent.futures.ThreadPoolExecutor(2) as executor:
                first = executor.submit(supervisor.inspect_run, root, RUN_ID, 0, 0, PROTOCOL)
                try:
                    self.assertTrue(cleanup_started.wait(2))
                    second = executor.submit(supervisor.inspect_run, root, RUN_ID, 0, 0, PROTOCOL)
                    self.assertEqual(second.result(timeout=2)["state"], "RUNNING")
                    write = executor.submit(state.mutate_state, root, {"cancelRequested": True})
                    self.assertTrue(write.result(timeout=2)["cancelRequested"])
                finally:
                    release_cleanup.set()
                self.assertEqual(first.result(timeout=2)["state"], "UNKNOWN")
                stop.assert_called_once()
            self.assertTrue(state.read_state(root / state.STATE_FILE_NAME)["cancelRequested"])

    def test_records_group_identity_after_a_transient_procfs_read_failure(self):
        with mock.patch.object(
            supervisor, "process_identity", side_effect=[None, ("Z", 123, 123, 456)]
        ):
            self.assertEqual(supervisor.group_identity(123), {"groupId": 123, "startTicks": 456})

    def test_reconciliation_preserves_a_terminal_write_between_reads(self):
        with tempfile.TemporaryDirectory() as working:
            root = pathlib.Path(working)
            record_path = root / state.STATE_FILE_NAME
            state.write_state(record_path, {"state": "RUNNING", "supervisorPid": 123})

            def finish_run(_pid, _run_id):
                state.mutate_state(root, {"state": "COMPLETED", "exitCode": 0})
                return False

            cleanup = mock.Mock()
            record = state.reconcile_run_state(root, RUN_ID, PROTOCOL, finish_run, cleanup)
            self.assertEqual(record["state"], "COMPLETED")
            self.assertEqual(record["exitCode"], 0)
            cleanup.assert_not_called()

    def test_cancel_during_starting_sets_a_flag_without_signaling_an_unready_supervisor(self):
        with tempfile.TemporaryDirectory() as working:
            _, run_directory = state.run_paths(working, RUN_ID)
            record_path = run_directory / state.STATE_FILE_NAME
            state.write_state(record_path, {"state": "STARTING", "supervisorPid": 123})
            with mock.patch.object(supervisor.os, "kill") as signal_process:
                self.assertEqual(
                    supervisor.cancel(working, RUN_ID, PROTOCOL),
                    {"runId": RUN_ID, "accepted": True},
                )
                signal_process.assert_not_called()
            self.assertTrue(state.read_state(record_path)["cancelRequested"])

    def test_connect_readiness_wait_observes_cancellation(self):
        process = mock.Mock()
        process.poll.return_value = None
        signal_state = {"kind": None}

        def request_cancel(_seconds):
            signal_state["kind"] = "CANCELED"

        with mock.patch.object(supervisor, "read_log_chunk", return_value=(b"", 0)), \
                mock.patch.object(supervisor.time, "sleep", side_effect=request_cancel):
            with self.assertRaises(InterruptedError):
                supervisor.wait_for_connect_server(
                    process, "127.0.0.1", (pathlib.Path("stdout"), pathlib.Path("stderr")), signal_state
                )

    def test_archive_contains_only_manifest_files_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as working:
            root = pathlib.Path(working)
            for name in ("pipeline.yml", "logic.py", ".env", "spark_pipeline_spec.py"):
                (root / name).write_text(name, encoding="utf-8")
            record_path = root / state.STATE_FILE_NAME
            state.write_state(record_path, {"sourceHash": "deployment-hash"})
            supervisor.package_pipeline_sources(["pipeline.yml", "logic.py"], root.resolve(), root, root)
            archive_path = root / "pipeline-source.zip"
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(archive.namelist(), ["logic.py", "pipeline.yml"])
            record = state.read_state(record_path)
            self.assertEqual(record["sourceHash"], "deployment-hash")
            self.assertEqual(record["sourceArchiveSha256"], hashlib.sha256(archive_path.read_bytes()).hexdigest())
            (root / "link.py").symlink_to(root / "logic.py")
            source_root = root.resolve()
            with self.assertRaisesRegex(ValueError, "without symlinks"):
                supervisor.package_pipeline_sources(["link.py"], source_root, root, root)


if __name__ == "__main__":
    unittest.main()
