#!/usr/bin/env python3
"""Legacy-only PyInstaller builder; the Paseo plugin now runs server/backend/main.ts."""

from __future__ import annotations

import argparse
import platform
from pathlib import Path
import shutil
import subprocess
import sys


def platform_key() -> str:
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    machine = {"AMD64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine())
    if not system or not machine:
        raise SystemExit(f"unsupported backend platform: {platform.system()}-{platform.machine()}")
    return f"{system}-{machine}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = (args.output_dir or root / "paseo-plugin" / "backend" / platform_key()).resolve()
    pyinstaller = shutil.which("pyinstaller")
    if not pyinstaller:
        raise SystemExit("pyinstaller is required; install it with `python -m pip install pyinstaller`")
    work = root / ".backend-build"
    if work.exists():
        shutil.rmtree(work)
    output.mkdir(parents=True, exist_ok=True)
    command = [
        pyinstaller,
        "--clean",
        "--onefile",
        "--name",
        "workspace-workbench",
        "--paths",
        str(root / "src"),
        "--distpath",
        str(output),
        "--workpath",
        str(work / "work"),
        "--specpath",
        str(work / "spec"),
        str(root / "src" / "workspace_workbench" / "__main__.py"),
    ]
    try:
        subprocess.run(command, check=True)
    finally:
        if work.exists():
            shutil.rmtree(work)
    binary = output / "workspace-workbench"
    if not binary.is_file():
        raise SystemExit(f"backend build did not produce {binary}")
    binary.chmod(0o755)
    print(binary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
