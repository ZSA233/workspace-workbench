import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("workbench tab track fills the panel instead of ending after the last tab", () => {
  const source = readFileSync(new URL("../client/components/ui.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('tabsScroll: { alignSelf: "stretch", backgroundColor: theme.colors.surface1'));
  assert.ok(source.includes('tabs: { flexDirection: "row", flexGrow: 0, flexShrink: 0'));
  assert.ok(!source.includes('tabs: { backgroundColor: theme.colors.surface1'));
});
