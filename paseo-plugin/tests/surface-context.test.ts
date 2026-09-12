import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PaseoApi } from "@getpaseo/client";
import { readSurfaceWorkspace } from "../client/surface-context.ts";

test("Surface resolves the requested workspace using the API, not panel state hooks", async () => {
  const ids: string[] = [];
  const paseo = { workspaces: { ref: (id: string) => {
    ids.push(id);
    return { directory: "/fixture/project", name: "Fixture", refresh: async () => ({ id }) };
  } } } as unknown as PaseoApi;
  assert.deepEqual(await readSurfaceWorkspace(paseo, "host-workspace"), { directory: "/fixture/project", name: "Fixture" });
  assert.deepEqual(ids, ["host-workspace"]);
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  const surface = entry.slice(entry.indexOf("function ContextualSurface"), entry.indexOf("function openWorkbench"));
  assert.ok(surface.includes("<WorkbenchSurfacePanel"));
  assert.ok(!surface.includes("<WorkbenchPanel"));
  const panel = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  const implementation = panel.slice(panel.indexOf("export function WorkbenchSurfacePanel"), panel.indexOf("export function ObserverPanelContent"));
  assert.ok(!/useWorkspace\(|useAgent\(/.test(implementation));
});

test("Missing workspace and connection failures do not fall back to another project", async () => {
  for (const handle of [
    { directory: null, refresh: async () => null },
    { directory: "/stale", refresh: async () => { throw new Error("disconnected"); } },
  ]) {
    const paseo = { workspaces: { ref: () => handle } } as unknown as PaseoApi;
    await assert.rejects(readSurfaceWorkspace(paseo, "missing"));
  }
});
