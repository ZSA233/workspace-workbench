import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiffOverviewMarkers,
  buildTreeRows,
  defaultTreeMode,
  layoutGraph,
  matchesWorkspaceFilter,
  parseUnifiedPatch,
  pairDiffLines,
  resolveWorkspaceSelection,
  sortWorkspaces,
  type FileChange,
  type CommitNode as GraphNode,
  type WorkspaceSummary as Workspace,
} from "../client/model.ts";

function workspace(id: string, fields: Partial<Workspace> = {}): Workspace {
  return { id, displayName: id, description: "", dirty: false, unpushed: false, dirtyRepositoryCount: 0, blockerCount: 0, claim: null, kind: "managed", managed: true, state: "active", repositoryCount: 1, ...fields };
}

function file(path: string, status = "M"): FileChange {
  return { path, status, statusLabel: "Modified", additions: 1, deletions: 1 };
}

test("workspace sorting and filters preserve the main workspace and activity order", () => {
  const sorted = sortWorkspaces([
    workspace("old", { updatedAt: "2026-09-01T00:00:00Z" }),
    workspace("main", { kind: "live", managed: false }),
    workspace("new", { updatedAt: "2026-09-11T00:00:00Z" }),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["main", "new", "old"]);
  assert.equal(matchesWorkspaceFilter(workspace("dirty", { dirty: true }), "attention"), true);
  assert.equal(matchesWorkspaceFilter(workspace("gone", { state: "removed" }), "all"), false);
});

test("saved workspace selection wins over auto detection and falls back safely", () => {
  const workspaces = [workspace("saved"), workspace("identified"), workspace("other")];
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "saved", identifiedWorkspaceId: "identified", workspaces }), { workspaceId: "saved", source: "saved" });
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "gone", identifiedWorkspaceId: "identified", workspaces }), { workspaceId: "identified", source: "identified" });
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "gone", workspaces }), { workspaceId: "saved", source: "first" });
});

test("tree rows stay compact and expand only the selected directory", () => {
  const files = [file("src/one.ts"), file("src/two.ts"), file("docs/readme.md"), file("root.txt")];
  assert.equal(defaultTreeMode(files), "tree");
  assert.deepEqual(buildTreeRows(files, new Set()).filter((row) => row.kind === "directory").map((row) => row.path), ["docs", "src"]);
  assert.ok(buildTreeRows(files, new Set(["src"])).some((row) => row.kind === "file" && row.file.path === "src/one.ts"));
});

test("graph layout maintains parent lanes and colors merge parents differently", () => {
  const nodes: GraphNode[] = [
    { sha: "head", shortSha: "head", parents: ["merge"], subject: "head" },
    { sha: "merge", shortSha: "merge", parents: ["main", "side"], subject: "merge" },
    { sha: "main", shortSha: "main", parents: ["base"], subject: "main" },
    { sha: "side", shortSha: "side", parents: ["base"], subject: "side" },
    { sha: "base", shortSha: "base", parents: [], subject: "base", isBase: true },
  ].map((node) => ({ author: "", authoredAt: null, decorations: [], isBase: false, ...node }));
  const rows = layoutGraph(nodes);
  assert.equal(rows[0].node.sha, "head");
  assert.equal(rows.at(-1)?.node.isBase, true);
  assert.equal(rows[1].parentLanes.length, 2);
  assert.notEqual(rows[1].parentLanes[0].colorIndex, rows[1].parentLanes[1].colorIndex);
  for (let index = 0; index < rows.length - 1; index += 1) assert.deepEqual(rows[index].lanesAfter, rows[index + 1].lanesBefore);
});

test("diff parser creates split pairs and overview markers", () => {
  const parsed = parseUnifiedPatch("@@ -10,2 +10,3 @@\n-old\n+new\n+added\n@@ -40,1 +41,0 @@\n-removed\n");
  assert.equal(parsed.hunks.length, 2);
  assert.equal(pairDiffLines(parsed.hunks[0].lines)[0].left?.content, "old");
  assert.equal(pairDiffLines(parsed.hunks[0].lines)[0].right?.content, "new");
  assert.deepEqual(buildDiffOverviewMarkers(parsed).map((marker) => marker.kind), ["modified", "removed"]);
});
