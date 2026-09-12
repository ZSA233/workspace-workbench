import test from "node:test";
import assert from "node:assert/strict";
import { allocateSections } from "../client/section-allocation.ts";
test("sections share a finite height; short panels have only an outer scroller", () => {
  for (const height of [200, 420, 720, 1100]) for (let mask = 0; mask < 8; mask++) {
    const layout = { repositories: { collapsed: Boolean(mask & 1), height: 600 }, graph: { collapsed: Boolean(mask & 2), height: 600 }, changes: { collapsed: Boolean(mask & 4), height: null } };
    const result = allocateSections(height, layout);
    if (!result.outerScroll) assert.ok(Object.values(result.sizes).reduce((a, b) => a + b, 0) <= Math.max(0, height - 132) + 0.01);
    for (const id of ["repositories", "graph", "changes"] as const) if (layout[id].collapsed) assert.equal(result.sizes[id], 0);
  }
});
test("dragging a separator preserves its requested height and reallocates lower sections", () => {
  const layout = { repositories: { collapsed: false, height: 180 }, graph: { collapsed: false, height: 280 }, changes: { collapsed: false, height: null } };
  const before = allocateSections(720, layout);
  const after = allocateSections(720, { ...layout, repositories: { collapsed: false, height: 240 } });
  assert.equal(after.sizes.repositories - before.sizes.repositories, 60);
  assert.ok(after.sizes.changes < before.sizes.changes);
});
