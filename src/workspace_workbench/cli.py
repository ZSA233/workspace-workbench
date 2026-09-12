from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .core.config import discover_git_repositories, load_config
from .core.errors import WorkbenchError
from .core.service import ObserverService, serve_socket, serve_stdio


def _print(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="workspace-workbench", description="Observe and manage configurable multi-repository workspaces")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="serve JSONL requests")
    serve.add_argument("--config", required=True, help="project JSON configuration")
    serve.add_argument("--stdio", action="store_true", help="use stdin/stdout instead of a Unix Socket")
    serve.add_argument("--socket", help="override the configured Unix Socket path")
    discover = subparsers.add_parser("discover", help="print Git repository candidates without changing config")
    discover.add_argument("--config", required=True)
    accept = subparsers.add_parser("accept", help="accept one discovered repository into the config")
    accept.add_argument("--config", required=True)
    accept.add_argument("--repository", required=True, help="candidate id or path")
    health = subparsers.add_parser("health", help="print service health for a project")
    health.add_argument("--config", required=True)
    execute = subparsers.add_parser("exec", help="explicit local command using prepared repository runtimes")
    execute.add_argument("--config", required=True)
    execute.add_argument("--workspace", required=True)
    execute.add_argument("--repo", required=True)
    execute.add_argument("argv", nargs=argparse.REMAINDER)
    init = subparsers.add_parser("init", help="write a starter project configuration")
    init.add_argument("--root", required=True)
    init.add_argument("--output", required=True)
    init.add_argument("--project-id", default=None)
    init.add_argument("--display-name", default=None)
    return parser


def _init(args: argparse.Namespace) -> int:
    root = Path(args.root).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    project_id = args.project_id or root.name or "project"
    display_name = args.display_name or project_id
    value = {
        "schemaVersion": 1,
        "project": {"id": project_id, "displayName": display_name},
        "sourceRoot": os.path.relpath(root, output.parent),
        "workspaceRoot": os.path.relpath(root / ".workspace-workbench" / "workspaces", output.parent),
        "stateRoot": os.path.relpath(root / ".workspace-workbench", output.parent),
        "socketPath": "auto",
        "discovery": {
            "mode": "hybrid",
            "roots": ["."],
            "maxDepth": 3,
            "exclude": [".git", "node_modules", "vendor", ".venv", "dist", "build"],
            "followSymlinks": False,
        },
        "repositories": [],
        "mainWorkspace": {"displayName": "Main workspace"},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f".{output.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    _print({"config": str(output), "next": f"workspace-workbench discover --config {output}"})
    return 0


def _accept(args: argparse.Namespace, config_path: Path) -> int:
    config = load_config(config_path)
    candidates = discover_git_repositories(config)
    requested = str(args.repository).strip()
    candidate = next((item for item in candidates if requested in {item.id, item.path, item.name}), None)
    if candidate is None:
        raise WorkbenchError("repository is not a discovered candidate", code="candidate_missing")
    candidate_path = Path(candidate.path).resolve()
    try:
        relative_path = candidate_path.relative_to(config.source_root)
    except ValueError as exc:
        raise WorkbenchError("candidate is outside the source root", code="path_outside_root") from exc
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    repositories = raw.setdefault("repositories", [])
    repositories.append({
        "id": candidate.id,
        "path": str(relative_path),
        "displayName": candidate.display_name,
        "enabled": True,
    })
    temporary = config_path.with_suffix(f".{config_path.name}.tmp")
    temporary.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(config_path)
    _print({"accepted": candidate.__dict__, "config": str(config_path)})
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "init":
            return _init(args)
        if args.command == "accept":
            return _accept(args, Path(args.config).expanduser().resolve())
        config = load_config(args.config)
        if args.command == "discover":
            _print({"project": config.project_id, "candidates": [repository.__dict__ for repository in discover_git_repositories(config)]})
            return 0
        service = ObserverService(config)
        if args.command == "exec":
            from .providers.execution import execute
            try:
                command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
                return execute(service, args.workspace, args.repo, command)
            finally:
                service.close()
        if args.command == "health":
            _print(service.health())
            service.close()
            return 0
        if args.command == "serve":
            if args.stdio:
                serve_stdio(service, sys.stdin, sys.stdout)
            else:
                socket_path = Path(args.socket).expanduser().resolve() if args.socket else config.socket_path
                serve_socket(service, socket_path)
            return 0
        return 2
    except WorkbenchError as exc:
        print(json.dumps({"ok": False, "error": exc.as_dict()}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
