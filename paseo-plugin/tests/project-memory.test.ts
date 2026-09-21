import test from "node:test";
import assert from "node:assert/strict";
import { chooseProject } from "../client/project-memory.ts";
import { observerSettings } from "../shared/settings.ts";
import { readFileSync } from "node:fs";

test("context precedes global memory; unmatched contexts stay in setup", () => {
  const one = { configPath: "one" }, two = { configPath: "two" };
  assert.equal(chooseProject([one, two], one, "two", "two", true), one);
  assert.equal(chooseProject([one, two], undefined, "", "two", false), two);
  assert.equal(chooseProject([one], undefined, "removed", "removed", false), one);
  assert.equal(chooseProject([one, two], undefined, "", "removed", false), undefined);
  assert.equal(chooseProject([one, two], undefined, "two", "one", true), undefined);
  assert.equal(chooseProject([one, two], undefined, "", "two", false, true), undefined);
  assert.equal(chooseProject([one, two], undefined, "two", "one", false, true), two);
  assert.equal(chooseProject([one, two], undefined, "", "two", false, true), undefined);
  assert.equal(chooseProject([one, two], undefined, "two", "one", false, true), two);
  assert.deepEqual(observerSettings.schema.parse({}).lastProjectByHost, {});
  const source = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('const observerSurfaceId = "workbench"'));
  assert.ok(source.includes('title: "Workspace Workbench"'));
});
