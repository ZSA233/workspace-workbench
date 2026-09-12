from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/version.py"


class VersionManagementTests(unittest.TestCase):
    def make_fixture(self) -> Path:
        temporary = Path(tempfile.mkdtemp())
        (temporary / "paseo-plugin").mkdir()
        (temporary / "scripts").mkdir()
        for relative in ("VERSION", "pyproject.toml", "scripts/version.py", "src/workspace_workbench/__init__.py"):
            destination = temporary / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        for relative in ("paseo-plugin/package.json", "paseo-plugin/package-lock.json"):
            shutil.copy2(ROOT / relative, temporary / relative)
        return temporary

    def run_version(self, root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python", str(root / "scripts/version.py"), "--root", str(root), *arguments],
            capture_output=True,
            text=True,
        )

    def test_check_accepts_coordinated_metadata_and_matching_tag(self) -> None:
        root = self.make_fixture()
        try:
            version = (root / "VERSION").read_text().strip()
            result = self.run_version(root, "--check", "--tag", f"v{version}")
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            shutil.rmtree(root)

    def test_bumps_all_package_roots_without_touching_dependencies(self) -> None:
        root = self.make_fixture()
        try:
            major, minor, patch = (int(part) for part in (root / "VERSION").read_text().strip().split("."))
            expected = f"{major}.{minor}.{patch + 1}"
            original_lock = json.loads((root / "paseo-plugin/package-lock.json").read_text())
            result = self.run_version(root, "--bump", "patch")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "VERSION").read_text().strip(), expected)
            self.assertIn(f'__version__ = "{expected}"', (root / "src/workspace_workbench/__init__.py").read_text())
            package = json.loads((root / "paseo-plugin/package.json").read_text())
            lock = json.loads((root / "paseo-plugin/package-lock.json").read_text())
            self.assertEqual(package["version"], expected)
            self.assertEqual(lock["version"], expected)
            self.assertEqual(lock["packages"][""]["version"], expected)
            self.assertEqual(
                lock["packages"]["node_modules/@getpaseo/client"]["version"],
                original_lock["packages"]["node_modules/@getpaseo/client"]["version"],
            )
            self.assertEqual(self.run_version(root, "--check", "--tag", f"v{expected}").returncode, 0)
        finally:
            shutil.rmtree(root)

    def test_minor_major_and_explicit_set_follow_semver(self) -> None:
        root = self.make_fixture()
        try:
            for arguments, expected in [
                (("--bump", "minor"), "0.2.0"),
                (("--bump", "major"), "1.0.0"),
                (("--set", "2.3.4"), "2.3.4"),
            ]:
                result = self.run_version(root, *arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((root / "VERSION").read_text().strip(), expected)
        finally:
            shutil.rmtree(root)

    def test_check_rejects_mismatch_invalid_version_and_tag(self) -> None:
        root = self.make_fixture()
        try:
            package_path = root / "paseo-plugin/package.json"
            package = json.loads(package_path.read_text())
            package["version"] = "9.9.9"
            package_path.write_text(json.dumps(package, indent=2) + "\n")
            result = self.run_version(root, "--check")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("package.json", result.stderr)
            self.assertNotEqual(self.run_version(root, "--check", "--tag", "v9.9.9").returncode, 0)
        finally:
            shutil.rmtree(root)

        root = self.make_fixture()
        try:
            result = self.run_version(root, "--set", "v0.2.0")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid SemVer", result.stderr)
        finally:
            shutil.rmtree(root)
