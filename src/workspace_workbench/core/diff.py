from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable


@dataclass(frozen=True)
class DiffRow:
    kind: str
    text: str
    old_line: int | None = None
    new_line: int | None = None


@dataclass(frozen=True)
class DiffHunk:
    header: str
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    rows: tuple[DiffRow, ...]


HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_patch(patch: str) -> tuple[DiffHunk, ...]:
    """Parse a unified patch into rows suitable for a terminal or RN view."""

    hunks: list[DiffHunk] = []
    current: dict[str, object] | None = None
    old_line = new_line = 0
    for line in patch.splitlines():
        match = HUNK_HEADER.match(line)
        if match:
            if current is not None:
                hunks.append(DiffHunk(**current))
            old_line = int(match.group(1))
            new_line = int(match.group(3))
            current = {
                "header": line,
                "old_start": old_line,
                "old_count": int(match.group(2) or 1),
                "new_start": new_line,
                "new_count": int(match.group(4) or 1),
                "rows": [],
            }
            continue
        if current is None:
            continue
        rows = current["rows"]
        assert isinstance(rows, list)
        kind = line[:1] if line[:1] in {"+", "-", " "} else "context"
        if kind == "+":
            rows.append(DiffRow("added", line[1:], None, new_line))
            new_line += 1
        elif kind == "-":
            rows.append(DiffRow("removed", line[1:], old_line, None))
            old_line += 1
        else:
            rows.append(DiffRow("context", line[1:] if kind == " " else line, old_line, new_line))
            old_line += 1
            new_line += 1
    if current is not None:
        hunks.append(DiffHunk(**current))
    return tuple(hunks)


def changed_line_ranges(hunks: Iterable[DiffHunk]) -> list[tuple[int, int, str]]:
    markers: list[tuple[int, int, str]] = []
    for hunk in hunks:
        changed = [row.new_line or row.old_line for row in hunk.rows if row.kind in {"added", "removed"}]
        if not changed:
            continue
        start, end = min(changed), max(changed)
        has_add = any(row.kind == "added" for row in hunk.rows)
        has_remove = any(row.kind == "removed" for row in hunk.rows)
        markers.append((start, end, "modified" if has_add and has_remove else "added" if has_add else "removed"))
    return markers
