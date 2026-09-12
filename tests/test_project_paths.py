import json
from pathlib import Path
import tempfile
import unittest
import threading
import time
from unittest.mock import patch

from test_workbench import make_repository, write_config
from workspace_workbench.core.config import load_config
from workspace_workbench.core.errors import WorkbenchError
from workspace_workbench.providers.git_worktree import GitWorktreeProvider
from workspace_workbench.core.service import ObserverService
from workspace_workbench.providers.execution import execute


class ProjectPathTests(unittest.TestCase):
    def test_local_exec_refuses_unprepared_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            make_repository(root, "api")
            path = root / "project.json"
            write_config(path, root, [{"id": "api", "path": "api"}])
            value = json.loads(path.read_text())
            value["toolchain"] = {"manager": "mise", "repositories": {"api": {"go": "1.26"}}}
            path.write_text(json.dumps(value))
            service = ObserverService(load_config(path))
            try:
                workspace = service.handle("workspace.create", {"name": "task"})
                with self.assertRaises(WorkbenchError) as error:
                    execute(service, workspace["id"], "api", ["go", "version"])
                self.assertEqual(error.exception.code, "toolchain_not_ready")
            finally:
                service.close()

    def test_cold_roster_does_not_wait_for_git_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            make_repository(root, "api")
            path = root / "project.json"
            write_config(path, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(path))
            gate = threading.Event()
            original = service._observe_repository
            def delayed(*args, **kwargs):
                gate.wait(5)
                return original(*args, **kwargs)
            try:
                with patch.object(service, "_observe_repository", side_effect=delayed):
                    start = time.monotonic()
                    result = service.workspace_list({})
                    self.assertLess(time.monotonic() - start, 1)
                    self.assertEqual(result["workspaces"][0]["repositoryCount"], 1)
                    self.assertIsNone(result["workspaces"][0]["dirty"])
                    self.assertEqual(result["observation"]["state"], "partial")
                    self.assertIsNone(result["observation"]["lastSuccessfulAt"])
                    gate.set()
            finally:
                gate.set()
                service.close()

    def test_separate_records_preserve_tree_root_and_relative_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            make_repository(root, "api")
            path = root / "project.json"
            write_config(path, root, [{"id": "api", "path": "api"}])
            raw = json.loads(path.read_text())
            raw.update(sourceRoot=".", workspaceRoot="workspaces", recordsRoot="workspaces/.workbench/records", treesRoot="workspaces/trees", stateRoot="workspaces/.workbench", socketPath="auto")
            path.write_text(json.dumps(raw))
            config = load_config(path)
            provider = GitWorktreeProvider(config)
            self.assertEqual(provider.records_root, root / "workspaces/.workbench/records")
            self.assertEqual(provider.trees_root, root / "workspaces/trees")
            self.assertLess(len(str(config.socket_path).encode()), 104)
            other = root / "other.json"
            other.write_text(json.dumps(raw))
            self.assertNotEqual(load_config(other).socket_path, config.socket_path)
            raw["recordsRoot"] = "workspaces/trees"
            path.write_text(json.dumps(raw))
            with self.assertRaises(WorkbenchError):
                GitWorktreeProvider(load_config(path))
