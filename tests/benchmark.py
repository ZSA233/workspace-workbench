"""Isolated cache/refresh benchmark; never modifies the caller's repositories."""
from pathlib import Path
import json
import statistics
import tempfile
import time
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor

from test_workbench import make_repository, write_config
from workspace_workbench.core.config import load_config
from workspace_workbench.core.service import ObserverService


def run():
    with tempfile.TemporaryDirectory(prefix="workbench-benchmark-") as temporary:
        root = Path(temporary)
        repos = [make_repository(root, f"repo-{index}") for index in range(10)]
        config_path = root / "project.json"
        write_config(config_path, root, [{"id": repo.name, "path": repo.name} for repo in repos])
        config = replace(load_config(config_path), cache_ttl_seconds=0.5)
        service = ObserverService(config)
        def measured(method, params):
            started = time.monotonic()
            result = service.handle(method, params)
            return (time.monotonic() - started) * 1000, result
        cold_list, _ = measured("workspace.list", {})
        cold_detail, _ = measured("workspace.detail", {"workspaceId": "main"})
        warm = [measured("workspace.detail", {"workspaceId": "main"})[0] for _ in range(100)]
        params = {"workspaceId": "main", "repoPath": "repo-0", "scope": "working"}
        service.handle("repository.changes", params)
        (repos[0] / "new.txt").write_text("updated\n")
        changed_at = time.monotonic()
        while time.monotonic() - changed_at < 5:
            if service.handle("repository.changes", params)["files"]:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("working changes did not refresh")
        refresh_ms = (time.monotonic() - changed_at) * 1000
        with ThreadPoolExecutor(max_workers=5) as pool:
            concurrent = list(pool.map(lambda _: measured("workspace.detail", {"workspaceId": "main"})[0], range(5)))
        service.close()
        service = ObserverService(config)
        try:
            restart_ms, result = measured("workspace.detail", {"workspaceId": "main"})
            assert len(result["repositories"]) == 10
            print(json.dumps({"repositories": 10, "iterations": 100, "coldListMs": round(cold_list, 2), "coldDetailMs": round(cold_detail, 2), "warmMedianMs": round(statistics.median(warm), 2), "warmP95Ms": round(sorted(warm)[94], 2), "fileRefreshMs": round(refresh_ms, 2), "concurrentMaxMs": round(max(concurrent), 2), "restartSnapshotMs": round(restart_ms, 2), "cache": service.cache.status()}, indent=2))
        finally:
            service.close()


if __name__ == "__main__":
    run()
