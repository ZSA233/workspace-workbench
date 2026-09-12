from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence


@dataclass(frozen=True)
class GraphNode:
    sha: str
    parents: tuple[str, ...]
    subject: str
    is_base: bool = False


def lane_layout(nodes: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return stable lane positions for a newest-first commit sequence.

    A lane follows the first parent. Additional parents receive a new lane at
    the merge row, which gives renderers enough information to draw their own
    smooth curves without inventing commits or references.
    """

    lanes: list[str] = []
    output: list[dict[str, Any]] = []
    for node in nodes:
        sha = str(node.get("sha") or "")
        parents = [str(value) for value in node.get("parents", []) if value]
        try:
            lane = lanes.index(sha)
        except ValueError:
            lane = 0
            lanes.insert(0, sha)
        next_lanes = list(lanes)
        if parents:
            next_lanes[lane : lane + 1] = parents[:1]
            for parent in parents[1:]:
                if parent not in next_lanes:
                    next_lanes.insert(lane + 1, parent)
        else:
            next_lanes.pop(lane)
        output.append({
            "sha": sha,
            "lane": lane,
            "lanesBefore": list(lanes),
            "lanesAfter": next_lanes,
            "laneCount": max(1, len(lanes)),
            "merge": len(parents) > 1,
        })
        lanes = next_lanes
    return output


def ref_colors(refs: Sequence[Mapping[str, Any]], palette: Sequence[str]) -> dict[str, str]:
    """Assign deterministic colors to visible refs without adjacent repeats."""

    if not palette:
        return {}
    result: dict[str, str] = {}
    for index, ref in enumerate(sorted(refs, key=lambda item: str(item.get("name") or item.get("shortName") or ""))):
        name = str(ref.get("name") or ref.get("shortName") or "")
        if not name:
            continue
        color_index = index % len(palette)
        if index > 0 and len(palette) > 1 and palette[color_index] == result.get(name):
            color_index = (color_index + 1) % len(palette)
        result[name] = str(palette[color_index])
    return result
