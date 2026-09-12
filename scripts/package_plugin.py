#!/usr/bin/env python3
"""Create the self-contained, source-based Paseo plugin release archive."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tarfile


PLUGIN_FILES = (
    "client",
    "server",
    "shared",
    "index.client.tsx",
    "index.server.ts",
    "mcp.mjs",
    "paseo-plugin.json",
    "tsconfig.json",
    "README.md",
    "package.json",
    "package-lock.json",
)


def build_archive(root: Path, output_dir: Path) -> Path:
    plugin = root / "paseo-plugin"
    metadata = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
    version = metadata["version"]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"workspace-workbench-paseo-{version}.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        for entry in PLUGIN_FILES:
            source = plugin / entry
            if not source.exists():
                raise FileNotFoundError(source)
            bundle.add(source, arcname=entry, recursive=source.is_dir())
    return archive


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    archive = build_archive(root, args.output_dir)
    print(archive)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
