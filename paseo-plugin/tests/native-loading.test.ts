import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createOpenGuard, workbenchDestination } from "../client/open-workbench.ts";
import { atInitializationStage } from "../client/initialization.ts";

const require = createRequire(import.meta.url);
const read = (name: string) => readFileSync(require.resolve(name), "utf8");

test("initialization isolates UI imports, uses a built-in icon and preserves failure phase", () => {
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  assert.ok(entry.includes('from "./client/entry-panels"'));
  assert.ok(!entry.includes('from "./client/panel"'));
  assert.ok(!entry.includes('from "./client/file-review"'));
  assert.ok(!entry.includes('icon: HeaderIcon'));
  for (const file of ["../client/file-review.tsx", "../client/graph/canvas-web.tsx"]) {
    assert.ok(!readFileSync(new URL(file, import.meta.url), "utf8").includes('require("react-native-svg'));
  }
  let calls = 0;
  const previous = console.error;
  console.error = () => {};
  try {
    assert.throws(() => atInitializationStage("panel-module", () => { calls++; throw new TypeError("prototype unavailable"); }), /init-v4\/panel-module.*prototype/);
    assert.equal(atInitializationStage("panel-module", () => { calls++; return "recovered"; }), "recovered");
    assert.equal(calls, 2);
  } finally { console.error = previous; }
});
function nativeGlobals() {
  return { window: { Prism: { manual: true } }, document: { currentScript: null, getElementsByTagName: () => [], addEventListener() {} }, Element: undefined, setTimeout() {}, module: { exports: {} } };
}

test("full Prism reproduces native prototype crash; core and grammars load without Element", () => {
  assert.throws(() => vm.runInNewContext(read("prismjs/prism.js"), nativeGlobals()), /prototype/);
  const context = vm.createContext(nativeGlobals());
  vm.runInContext(read("prismjs/components/prism-core.js"), context);
  for (const language of ["markup", "clike", "javascript", "bash", "go", "json", "markdown", "python", "sql", "typescript", "yaml"]) {
    vm.runInContext(read(`prismjs/components/prism-${language}.js`), context);
  }
  assert.equal(vm.runInContext('Prism.tokenize("const x = 1", Prism.languages.javascript)[0].type', context), "keyword");
  const source = readFileSync(new URL("../client/syntax.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes('from "prismjs/prism.js"'));
});

test("desktop opens Explorer; native surfaces keep workspace and Agent identities", () => {
  const desktop = workbenchDestination("web", "one", "worker");
  assert.equal(desktop.kind, "panel");
  if (desktop.kind === "panel") assert.deepEqual(desktop.options, { workspaceId: "one", agentId: "worker", location: "explorer" });
  assert.equal(workbenchDestination("android", "one").kind, "surface");
  assert.notEqual(workbenchDestination("android", "one").id, workbenchDestination("android", "two").id);
  assert.equal(workbenchDestination("ios", "one").kind, "surface");
  for (const workspace of ["one", "a:b", "a-b", "项目", "🛠"]) {
    assert.match(workbenchDestination("android", workspace, "agent:1").id, /^[a-z][a-z0-9-]*$/);
  }
  assert.notEqual(workbenchDestination("android", "a:b").id, workbenchDestination("android", "a-b").id);
  const guard = createOpenGuard();
  assert.equal(guard.allow("one", 1000), true);
  assert.equal(guard.allow("one", 1100), false);
  assert.equal(guard.allow("two", 1200), true);
  assert.equal(guard.allow("two", 1800), true);
});
