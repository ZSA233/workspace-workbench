import test from "node:test";
import assert from "node:assert/strict";
import { beginResize } from "../client/resize-session.ts";
import { allocateSections } from "../client/section-allocation.ts";

test("frozen drag is monotonic, stationary and clamps while retaining lower panels", () => {
  const layout = { repositories: { height: null, collapsed: false }, graph: { height: null, collapsed: false }, changes: { height: null, collapsed: false } };
  for (const id of ["repositories", "graph"] as const) {
    const session = beginResize(id, 800, 150, layout, { repositories: 160, graph: 1600 })!;
    let previous = 0;
    for (let dy = -500; dy < 1000; dy++) {
      const result = session.update(dy);
      assert.ok(result.value >= previous);
      assert.ok(result.value >= 72 && result.value <= 600);
      assert.ok(result.allocation.sizes.changes >= 72);
      assert.deepEqual(session.update(dy), result);
      previous = result.value;
    }
    const result = session.update(50);
    const saved = { ...layout, repositories: { ...layout.repositories, height: result.allocation.sizes.repositories }, graph: { ...layout.graph, height: result.allocation.sizes.graph } };
    assert.deepEqual(allocateSections(800, saved, 150).sizes, result.allocation.sizes);
  }
  assert.equal(beginResize("changes", 800, 150, layout, {}), null);
  assert.equal(beginResize("repositories", 200, 150, layout, {}), null);
});
