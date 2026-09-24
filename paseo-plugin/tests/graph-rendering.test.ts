import assert from "node:assert/strict";
import test from "node:test";
import { sampleCurve, curvePath } from "../client/graph/geometry.ts";
import { createHistoryLoadGate } from "../client/graph/pagination.ts";
import { commitReferenceNames, formatCommitTime } from "../client/graph/commit-details.ts";
import { getWorkbenchCopy } from "../shared/copy.ts";
import { readFileSync } from "node:fs";

test("history gates are independent closures and graph render does not construct a class", () => {
  const first = createHistoryLoadGate().allow;
  const second = createHistoryLoadGate().allow;
  const request = (allow: typeof first, offset: number) => allow("same", 50, offset, 300, 1500, false, true);
  assert.equal(request(first, 0), false);
  assert.equal(request(first, 1150), true);
  assert.equal(request(first, 1151), false);
  assert.equal(request(second, 0), false);
  assert.equal(request(second, 1150), true);
  const source = readFileSync(new URL("../client/components/graph.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("new HistoryLoadGate"));
  assert.ok(source.includes("historyGate.current === null"));
});

test("native curves share exact endpoints with web and remain monotonic at every pixel density", () => {
  for (const scale of [1, 1.5, 2, 2.625, 3, 4]) {
    for (const x of [8, 24, 40, 72]) {
      const a = { x: 8, y: 15 }, b = { x, y: 30 };
      const samples = sampleCurve(a, b);
      assert.deepEqual(samples[0], a);
      assert.deepEqual(samples.at(-1), b);
      assert.ok(curvePath(a, b).endsWith(`${b.x} ${b.y}`));
      for (let i = 1; i < samples.length; i++) {
        assert.ok(samples[i].y >= samples[i - 1].y);
        assert.ok(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) * scale < 20);
      }
    }
  }
});

test("history gate rejects layout events, concurrent requests, failed-page repeats and limits", () => {
  const gate = createHistoryLoadGate();
  const attempt = (count: number, offset: number, busy = false, identity = "project/repo/head") => gate.allow(identity, count, offset, 300, 1500, busy, true);
  assert.equal(attempt(50, 0), false);
  assert.equal(attempt(50, 1150), true);
  assert.equal(attempt(50, 1151), false);
  assert.equal(attempt(100, 1152, true), false);
  assert.equal(attempt(100, 1152), false); // layout-only repeat
  assert.equal(attempt(100, 1153), true);
  assert.equal(attempt(200, 1200), false);
  assert.equal(attempt(50, 1150, false, "other/repo"), false);
  assert.equal(attempt(50, 1151, false, "other/repo"), true);
});

test("commit details format localized timestamps and omit HEAD from branch references", () => {
  const zh = getWorkbenchCopy("zh-CN");
  const en = getWorkbenchCopy("en-US");
  const now = Date.parse("2026-09-12T15:44:00Z");
  const zhTime = formatCommitTime("2026-09-11T15:44:00Z", "zh-CN", zh, now);
  const enTime = formatCommitTime("2026-09-11T15:44:00Z", "en-US", en, now);
  assert.match(zhTime.absolute, /2026/);
  assert.match(enTime.absolute, /2026/);
  assert.notEqual(zhTime.relative, zh.commitTimeUnknown);
  assert.notEqual(enTime.relative, en.commitTimeUnknown);
  assert.deepEqual(formatCommitTime(null, "zh-CN", zh, now), { absolute: zh.commitTimeUnknown, relative: "" });
  assert.deepEqual(commitReferenceNames({
    decorations: ["HEAD -> feature/demo", "origin/feature/demo"],
    refs: [
      { name: "refs/heads/feature/demo", shortName: "feature/demo", kind: "local", sha: "abc", isHead: true },
      { name: "refs/remotes/origin/feature/demo", shortName: "origin/feature/demo", kind: "remote", sha: "abc" },
    ],
  }), ["origin/feature/demo", "feature/demo"]);
});

test("commit graph keeps details in a bounded bottom panel without changing the backend graph contract", () => {
  const source = readFileSync(new URL("../client/components/graph.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../client/components/ui.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("onHoverIn"));
  assert.ok(source.includes("onHoverOut"));
  assert.ok(source.includes("graphRowHover"));
  assert.ok(source.includes("CommitDetailCard"));
  assert.ok(source.includes("authoredAt"));
  assert.ok(source.includes("graphDetailsPanel"));
  assert.ok(source.includes("graphDetailsScroll"));
  assert.ok(source.includes("selectedRow"));
  assert.ok(!source.includes("graphCommitHoverOverlay"));
  assert.ok(!styles.includes("graphCommitHoverOverlay"));
  assert.ok(styles.includes("graphSurface: { backgroundColor: theme.colors.surface1"));
  assert.ok(styles.includes("graphRowHover: { backgroundColor: theme.colors.surface2"));
  assert.ok(styles.includes("graphRowActive: { backgroundColor: `${accent}18` }"));
  assert.ok(source.includes("graphReferenceTags(row, theme, false)"));
  assert.ok(!styles.includes("graphRow: { alignItems: \"center\", borderBottomColor: theme.colors.border, borderBottomWidth: 1, borderLeftColor: \"transparent\""));
});

test("commit selection keeps the dirty worktree visible and lets it restore the current scope", () => {
  const source = readFileSync(new URL("../client/components/graph.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("const showWorktree = Boolean(repository.dirty || workingFileCount > 0);"));
  assert.ok(!source.includes("const showWorktree = !selectedCommit"));
  assert.ok(source.includes('icon="ArrowLeft"'));
  assert.ok(source.includes('onCommit("");\n                      onScope("working");'));
});

test("repository rows stay flat until selection opens the animated details drawer", () => {
  const rows = readFileSync(new URL("../client/components/repositories.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  const graph = readFileSync(new URL("../client/components/graph.tsx", import.meta.url), "utf8");
  assert.ok(rows.includes("repositoryDot"));
  assert.ok(rows.includes("repositoryBranch"));
  assert.ok(!rows.includes("{metaStatus}"));
  assert.ok(panel.includes("const changingRepository = selectedRepoPath !== repoPath;"));
  assert.ok(panel.includes("setRepositoryDetailsOpen(changingRepository ? true : (current) => !current);"));
  assert.ok(panel.includes("animateSectionLayout();\n    setRepositoryDetailsOpen"));
  assert.ok(graph.includes("repositoryCurrentRefDetail(repository, copy)"));
});
