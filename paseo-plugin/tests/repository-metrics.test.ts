import assert from "node:assert/strict";
import test from "node:test";

import { selectedChangeSummary } from "../client/repository-metrics.ts";
import type { ChangesResult, RepositorySummary } from "../client/model.ts";

const repository = {
  repoPath: "halh",
  status: "dirty",
  head: "head-1",
  baseSha: "base-1",
  issues: [],
  changeIssues: [],
} as unknown as RepositorySummary;
const changes = {
  workspaceId: "workspace-1",
  repoPath: "halh",
  scope: "branch",
  head: "head-1",
  baseSha: "base-1",
  summary: { files: 2, additions: 5, deletions: 3, binaryFiles: 0 },
  issues: [],
  files: [],
} as ChangesResult;

test("only the selected checkout's current diff can populate row statistics", () => {
  assert.deepEqual(selectedChangeSummary(repository, changes, "workspace-1", "branch", true), changes.summary);
  assert.equal(selectedChangeSummary(repository, changes, "workspace-1", "branch", false), null);
  assert.equal(selectedChangeSummary(repository, changes, "workspace-2", "branch", true), null);
  assert.equal(selectedChangeSummary(repository, changes, "workspace-1", "working", true), null);
  assert.equal(selectedChangeSummary(repository, changes, "workspace-1", "commit", true), null);
  assert.equal(selectedChangeSummary({ ...repository, repoPath: "compose" }, changes, "workspace-1", "branch", true), null);
  assert.equal(selectedChangeSummary({ ...repository, head: "head-2" }, changes, "workspace-1", "branch", true), null);
  assert.equal(selectedChangeSummary({ ...repository, baseSha: "base-2" }, changes, "workspace-1", "branch", true), null);
});

test("zero-change, failed and stale data never become visible statistics", () => {
  assert.equal(selectedChangeSummary(repository, { ...changes, summary: { ...changes.summary, files: 0 } }, "workspace-1", "branch", true), null);
  assert.equal(selectedChangeSummary(repository, { ...changes, issues: [{ code: "git_timeout", message: "timed out" }] }, "workspace-1", "branch", true), null);
  assert.equal(selectedChangeSummary({ ...repository, observationStale: true }, changes, "workspace-1", "branch", true), null);
  assert.equal(selectedChangeSummary({ ...repository, status: "error" }, changes, "workspace-1", "branch", true), null);
});
