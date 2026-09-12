#!/usr/bin/env python3
"""Validate and update the coordinated Workspace Workbench version."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import tomllib


VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = "VERSION"
PYPROJECT_FILE = "pyproject.toml"
PACKAGE_FILE = Path("paseo-plugin/package.json")
LOCK_FILE = Path("paseo-plugin/package-lock.json")
PYTHON_VERSION_FILE = Path("src/workspace_workbench/__init__.py")


class VersionError(ValueError):
    """Raised when release metadata cannot be validated or updated."""


def parse_version(value: str) -> tuple[int, int, int]:
    match = VERSION_PATTERN.fullmatch(value.strip())
    if not match:
        raise VersionError(f"invalid SemVer (expected MAJOR.MINOR.PATCH): {value!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def read_version(root: Path) -> str:
    path = root / VERSION_FILE
    if not path.is_file():
        raise VersionError(f"missing {path}")
    value = path.read_text(encoding="utf-8").strip()
    parse_version(value)
    return value


def _read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VersionError(f"cannot read JSON metadata {path}: {error}") from error
    if not isinstance(value, dict):
        raise VersionError(f"JSON metadata must be an object: {path}")
    return value


def _validate_pyproject(root: Path, errors: list[str]) -> None:
    path = root / PYPROJECT_FILE
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        errors.append(f"{path}: cannot read TOML ({error})")
        return

    project = document.get("project")
    dynamic = project.get("dynamic") if isinstance(project, dict) else None
    if not isinstance(dynamic, list) or "version" not in dynamic:
        errors.append(f"{path}: project.version must be dynamic")
    setuptools = document.get("tool", {}).get("setuptools", {})
    configured = setuptools.get("dynamic", {}).get("version", {}).get("file", [])
    if configured != [VERSION_FILE]:
        errors.append(f"{path}: setuptools dynamic version must read {VERSION_FILE}")


def _version_line_pattern(indent: int, version: str) -> re.Pattern[str]:
    spaces = " " * indent
    return re.compile(
        rf'(?m)^({re.escape(spaces)}"version"\s*:\s*){re.escape(json.dumps(version))}([ \t]*,?[ \t]*)$'
    )


def _replace_version_line(text: str, indent: int, old: str, new: str, label: str) -> str:
    pattern = _version_line_pattern(indent, old)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise VersionError(f"{label}: expected one version field at indent {indent}, found {len(matches)}")
    match = matches[0]
    return f'{text[:match.start(1)]}{match.group(1)}{json.dumps(new)}{match.group(2)}{text[match.end(2):]}'


def _replace_python_version(text: str, old: str, new: str, label: str) -> str:
    pattern = re.compile(
        rf'(?m)^(__version__\s*=\s*){re.escape(json.dumps(old))}([ \t]*)$'
    )
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise VersionError(f"{label}: expected one __version__ field, found {len(matches)}")
    match = matches[0]
    return f'{text[:match.start(1)]}{match.group(1)}{json.dumps(new)}{match.group(2)}{text[match.end(2):]}'


def _replace_lock_versions(text: str, old: str, new: str, path: Path) -> str:
    result = _replace_version_line(text, 2, old, new, str(path))
    lines = result.splitlines(keepends=True)
    package_start = next(
        (index for index, line in enumerate(lines) if line.rstrip("\r\n") == '    "": {'),
        None,
    )
    if package_start is None:
        raise VersionError(f"{path}: missing packages root entry")
    package_end = next(
        (index for index in range(package_start + 1, len(lines)) if lines[index].rstrip("\r\n") == "    },"),
        None,
    )
    if package_end is None:
        raise VersionError(f"{path}: malformed packages root entry")
    version_pattern = _version_line_pattern(6, old)
    matches = [
        match
        for index in range(package_start + 1, package_end)
        for match in version_pattern.finditer(lines[index])
    ]
    if len(matches) != 1:
        raise VersionError(f"{path}: expected one packages root version, found {len(matches)}")
    index = next(index for index in range(package_start + 1, package_end) if version_pattern.search(lines[index]))
    lines[index] = version_pattern.sub(
        lambda match: f'{match.group(1)}{json.dumps(new)}{match.group(2)}',
        lines[index],
        count=1,
    )
    return "".join(lines)


def check(root: Path, tag: str | None = None) -> list[str]:
    errors: list[str] = []
    try:
        version = read_version(root)
    except VersionError as error:
        errors.append(str(error))
        return errors

    if tag is not None and tag != f"v{version}":
        errors.append(f"release tag {tag!r} does not match v{version}")

    _validate_pyproject(root, errors)

    package_path = root / PACKAGE_FILE
    lock_path = root / LOCK_FILE
    python_version_path = root / PYTHON_VERSION_FILE
    try:
        package = _read_json(package_path)
        lock = _read_json(lock_path)
    except VersionError as error:
        errors.append(str(error))
        return errors

    try:
        python_version_text = python_version_path.read_text(encoding="utf-8")
    except OSError as error:
        errors.append(f"{python_version_path}: cannot read ({error})")
        python_version_text = ""
    python_version_match = re.search(
        r'(?m)^__version__\s*=\s*("[^"]+")', python_version_text
    )
    if python_version_match is None:
        errors.append(f"{python_version_path}: missing __version__")
    elif json.loads(python_version_match.group(1)) != version:
        errors.append(f"{python_version_path}: __version__ does not match {version}")

    if package.get("name") != "workspace-workbench-paseo":
        errors.append(f"{package_path}: unexpected package name {package.get('name')!r}")
    if package.get("version") != version:
        errors.append(f"{package_path}: version {package.get('version')!r} does not match {version}")
    if lock.get("name") != package.get("name"):
        errors.append(f"{lock_path}: root package name does not match {package_path}")
    if lock.get("version") != version:
        errors.append(f"{lock_path}: top-level version {lock.get('version')!r} does not match {version}")
    packages = lock.get("packages")
    package_root = packages.get("") if isinstance(packages, dict) else None
    if not isinstance(package_root, dict):
        errors.append(f"{lock_path}: missing packages root entry")
    elif package_root.get("version") != version:
        errors.append(f"{lock_path}: packages root version {package_root.get('version')!r} does not match {version}")
    return errors


def _atomic_write(path: Path, content: str) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def set_version(root: Path, version: str) -> None:
    parse_version(version)
    errors = check(root)
    if errors:
        raise VersionError("cannot update inconsistent metadata:\n" + "\n".join(errors))
    current = read_version(root)
    package_path = root / PACKAGE_FILE
    lock_path = root / LOCK_FILE
    python_version_path = root / PYTHON_VERSION_FILE
    package_text = package_path.read_text(encoding="utf-8")
    lock_text = lock_path.read_text(encoding="utf-8")
    python_version_text = python_version_path.read_text(encoding="utf-8")
    package_text = _replace_version_line(package_text, 2, current, version, str(package_path))
    lock_text = _replace_lock_versions(lock_text, current, version, lock_path)
    python_version_text = _replace_python_version(python_version_text, current, version, str(python_version_path))
    _atomic_write(root / VERSION_FILE, f"{version}\n")
    _atomic_write(package_path, package_text)
    _atomic_write(lock_path, lock_text)
    _atomic_write(python_version_path, python_version_text)


def bumped_version(version: str, level: str) -> str:
    major, minor, patch = parse_version(version)
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    if level == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise VersionError(f"unknown bump level: {level}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="validate coordinated version metadata")
    action.add_argument("--set", dest="set_version", metavar="VERSION", help="set a stable SemVer")
    action.add_argument("--bump", choices=("patch", "minor", "major"), help="bump a stable SemVer")
    parser.add_argument("--tag", help="also require a release tag matching vVERSION")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        if args.check:
            errors = check(root, args.tag)
            if errors:
                for error in errors:
                    print(f"version check failed: {error}", file=sys.stderr)
                return 1
            print(f"version metadata is consistent: {read_version(root)}")
            return 0
        if args.tag is not None:
            parser.error("--tag can only be used with --check")
        if args.set_version is not None:
            target = args.set_version
        else:
            target = bumped_version(read_version(root), args.bump)
        set_version(root, target)
        print(f"updated version to {target}")
        return 0
    except (OSError, VersionError) as error:
        print(f"version update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
