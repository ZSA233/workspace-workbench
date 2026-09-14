import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiffDisplayRows,
  buildDiffOverviewMarkers,
  buildTreeRows,
  defaultTreeMode,
  diffDisplayRowMetrics,
  formatDiffReferences,
  layoutGraph,
  languageForPath,
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
  assert.equal(matchesWorkspaceFilter(workspace("pending", { state: "deletion_pending" }), "attention"), true);
  assert.equal(matchesWorkspaceFilter(workspace("gone", { state: "removed" }), "all"), false);
});

test("saved workspace selection wins over auto detection and falls back safely", () => {
  const workspaces = [workspace("saved"), workspace("identified"), workspace("other")];
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "saved", identifiedWorkspaceId: "identified", workspaces }), { workspaceId: "saved", source: "saved" });
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "gone", identifiedWorkspaceId: "identified", workspaces }), { workspaceId: "identified", source: "identified" });
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "gone", workspaces }), { workspaceId: "saved", source: "first" });
  assert.deepEqual(resolveWorkspaceSelection({ savedWorkspaceId: "removed", workspaces: [workspace("removed", { state: "removed" }), workspace("live")] }), { workspaceId: "live", source: "first" });
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
  assert.deepEqual(buildDiffOverviewMarkers(buildDiffDisplayRows(parsed, "split")).map((marker) => marker.kind), ["modified", "removed"]);
});

test("diff overview markers use the rendered row coordinate instead of source line numbers", () => {
  const parsed = parseUnifiedPatch([
    "@@ -100,4 +100,4 @@",
    " context before",
    "-old",
    "+new",
    " context after",
    "@@ -500,4 +500,4 @@",
    " context before",
    "-old later",
    "+new later",
    " context after",
  ].join("\n"));
  const rows = buildDiffDisplayRows(parsed, "unified");
  const metrics = diffDisplayRowMetrics(rows);
  const markers = buildDiffOverviewMarkers(rows);
  const changedRows = rows.flatMap((row, index) => row.kind === "unified" && row.line.kind !== "context" ? [index] : []);

  assert.equal(markers.length, 2);
  assert.equal(markers[0].position, metrics.offsets[changedRows[0]] / metrics.contentHeight);
  assert.equal(markers[1].position, metrics.offsets[changedRows[2]] / metrics.contentHeight);
  assert.equal(
    markers[0].extent,
    (metrics.lengths[changedRows[0]] + metrics.lengths[changedRows[0] + 1]) / metrics.contentHeight,
  );
  assert.equal(markers[0].startLine, 101);
  assert.equal(markers[0].endLine, 101);
  assert.ok(markers[1].position < 1);
  assert.ok(markers.every((marker) => marker.position >= 0 && marker.position <= 1 && marker.extent > 0 && marker.extent <= 1));
});

test("diff overview markers follow unified and split row compression", () => {
  const parsed = parseUnifiedPatch([
    "@@ -10,3 +10,1 @@",
    "-old one",
    "-old two",
    "-old three",
    "+new one",
    "@@ -50,1 +50,2 @@",
    "-old later",
    "+new later one",
    "+new later two",
  ].join("\n"));
  const unifiedRows = buildDiffDisplayRows(parsed, "unified");
  const splitRows = buildDiffDisplayRows(parsed, "split");
  const unifiedMarkers = buildDiffOverviewMarkers(unifiedRows);
  const splitMarkers = buildDiffOverviewMarkers(splitRows);

  assert.deepEqual(unifiedMarkers.map((marker) => marker.kind), ["modified", "modified"]);
  assert.deepEqual(splitMarkers.map((marker) => marker.kind), ["modified", "modified"]);
  assert.notEqual(
    unifiedMarkers[1].position,
    splitMarkers[1].position,
    "split rows must be mapped independently from unified rows",
  );
  assert.ok(diffDisplayRowMetrics(unifiedRows).contentHeight > diffDisplayRowMetrics(splitRows).contentHeight);
});

test("language mapping covers the bundled editor grammars and keeps unknown files plain", () => {
  const cases = [
    ["component.tsx", "tsx"],
    ["component.jsx", "jsx"],
    ["module.mts", "typescript"],
    ["module.mjs", "javascript"],
    ["config.jsonc", "json5"],
    ["config.toml", "toml"],
    ["page.html", "markup"],
    ["styles.css", "css"],
    ["notes.txt", "plain"],
  ] as const;
  for (const [path, language] of cases) assert.equal(languageForPath(path), language);
});

test("diff parser hides standard Git file headers from the compact viewer", () => {
  const parsed = parseUnifiedPatch([
    "diff --git a/app.tsx b/app.tsx",
    "index 123..456 100644",
    "--- a/app.tsx",
    "+++ b/app.tsx",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"));
  assert.deepEqual(parsed.prelude, []);
});

test("diff references stay compact and describe the actual comparison", () => {
  assert.deepEqual(
    formatDiffReferences({ scope: "working", head: "1234567890abcdef" }),
    { from: "HEAD 12345678", to: "working tree" },
  );
  assert.deepEqual(
    formatDiffReferences({ scope: "branch", baseSha: "abcdef123456", branch: "feature" }),
    { from: "base abcdef12", to: "branch feature" },
  );
  assert.deepEqual(
    formatDiffReferences({ scope: "commit", baseSha: "111111111111", commitSha: "222222222222" }),
    { from: "parent 11111111", to: "commit 22222222" },
  );
});
