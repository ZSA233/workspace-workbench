import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearWorkbenchWorkspaceSnapshots, setWorkbenchWorkspaceSnapshot, workspaceSnapshotFromHost } from "../client/surface-context.ts";

test("Host workspace directories use both supported Paseo field names", () => {
  assert.deepEqual(workspaceSnapshotFromHost({ id: "current", workspaceDirectory: "/project", name: "Project" }), {
    id: "current", directory: "/project", name: "Project",
  });
  assert.deepEqual(workspaceSnapshotFromHost({ id: "legacy", directory: "/legacy" }), {
    id: "legacy", directory: "/legacy", name: "legacy",
  });
  assert.equal(workspaceSnapshotFromHost({ id: "empty" }), null);
});

test("Surface uses the plugin-owned workspace snapshot instead of host Surface hooks", () => {
  clearWorkbenchWorkspaceSnapshots();
  setWorkbenchWorkspaceSnapshot({ id: "host-workspace", directory: "/fixture/project", name: "Fixture" });
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  const surface = entry.slice(entry.indexOf("function ContextualSurface"), entry.indexOf("function openWorkbench"));
  assert.ok(surface.includes("<WorkbenchSurfacePanel"));
  assert.ok(!surface.includes("<WorkbenchPanel"));
  const panel = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  const implementation = panel.slice(panel.indexOf("export function WorkbenchSurfacePanel"), panel.indexOf("export function ObserverPanelContent"));
  assert.ok(!/useWorkspace\(|useAgent\(|usePaseo\(/.test(implementation));
  assert.ok(!panel.includes("usePaseo"));
  assert.ok(!/\buseWorkspace\s*\(/.test(panel));
  assert.ok(panel.includes("useWorkbenchWorkspaceSnapshot"));
  clearWorkbenchWorkspaceSnapshots();
});

test("Snapshot removal and empty directories stay local to the plugin store", () => {
  clearWorkbenchWorkspaceSnapshots();
  setWorkbenchWorkspaceSnapshot({ id: "host-workspace", directory: "/fixture/project", name: "Fixture" });
  setWorkbenchWorkspaceSnapshot({ id: "empty", directory: "", name: "Empty" });
  // The hook is intentionally not called outside React; the observable
  // contract is that an invalid/removed snapshot cannot be retained.
  clearWorkbenchWorkspaceSnapshots();
});
