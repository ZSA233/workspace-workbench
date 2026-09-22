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
  const panelEntry = readFileSync(new URL("../client/entry-panels.tsx", import.meta.url), "utf8");
  assert.ok(panelEntry.includes('import("./panel")'));
  assert.ok(panelEntry.includes('import("./file-review")'));
  assert.ok(!panelEntry.includes('from "./panel"'));
  assert.ok(!panelEntry.includes('from "./file-review"'));
  assert.ok(!entry.includes('icon: HeaderIcon'));
  assert.ok(!entry.includes('icon: "FileDiff"'));
  assert.ok(entry.includes("registerOptionalPanel"));
  // React error boundaries are not compatible with the Android host renderer;
  // native entries must render the checked function component directly.
  assert.ok(!readFileSync(new URL("../client/entry-panels.tsx", import.meta.url), "utf8").includes("PanelErrorBoundary"));
  for (const file of ["../client/file-review.tsx", "../client/graph/canvas-web.tsx"]) {
    assert.ok(!readFileSync(new URL(file, import.meta.url), "utf8").includes('require("react-native-svg'));
  }
  let calls = 0;
  const previous = console.error;
  console.error = () => {};
  try {
    assert.throws(() => atInitializationStage("panel-module", () => { calls++; throw new TypeError("prototype unavailable"); }), /init-v14-native-file-review-no-versions\/panel-module.*prototype/);
    assert.equal(atInitializationStage("panel-module", () => { calls++; return "recovered"; }), "recovered");
    assert.equal(calls, 2);
  } finally { console.error = previous; }
});

test("Git-managed checkouts install locked dependencies before activation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8")) as {
    build?: string[][];
  };
  assert.deepEqual(manifest.build, [
    ["npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    ["npm", "run", "typecheck"],
  ]);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
  };
  assert.ok(packageJson.files?.includes("package-lock.json"));
  assert.ok(packageJson.files?.includes("backend"));
});

function nativeGlobals() {
  return { window: { Prism: { manual: true } }, document: { currentScript: null, getElementsByTagName: () => [], addEventListener() {} }, Element: undefined, setTimeout() {}, module: { exports: {} } };
}

test("full Prism reproduces native prototype crash; core and grammars load without Element", () => {
  assert.throws(() => vm.runInNewContext(read("prismjs/prism.js"), nativeGlobals()), /prototype/);
  const context = vm.createContext(nativeGlobals());
  vm.runInContext(read("prismjs/components/prism-core.js"), context);
  for (const language of ["markup", "clike", "javascript", "typescript", "jsx", "tsx", "bash", "go", "json", "json5", "markdown", "python", "sql", "yaml", "toml", "css"]) {
    vm.runInContext(read(`prismjs/components/prism-${language}.js`), context);
  }
  assert.equal(vm.runInContext('Prism.tokenize("const x = 1", Prism.languages.javascript)[0].type', context), "keyword");
  assert.equal(vm.runInContext('Prism.tokenize("const view = <Button />", Prism.languages.tsx)[0].type', context), "keyword");
  assert.equal(vm.runInContext('Prism.tokenize("name = \\\"fixture\\\"", Prism.languages.toml)[0].type', context), "key");
  const nativeSyntax = readFileSync(new URL("../client/syntax.tsx", import.meta.url), "utf8");
  const webSyntax = readFileSync(new URL("../client/syntax-web.tsx", import.meta.url), "utf8");
  // The native entry must not statically load Prism or any grammar. A
  // platform check around a static import is too late for Android's partial
  // DOM shim; only the web-only module may contain these imports.
  assert.ok(!nativeSyntax.includes("prismjs"));
  assert.ok(!nativeSyntax.includes("prism-react-renderer"));
  assert.ok(nativeSyntax.includes('import("./syntax-web")'));
  assert.ok(nativeSyntax.includes("PlainCode"));
  assert.ok(!webSyntax.includes('from "prismjs/prism.js"'));
  assert.ok(!webSyntax.includes("prism-react-renderer"));
  assert.ok(readFileSync(new URL("../client/prism-normalize.ts", import.meta.url), "utf8").includes("normalizePrismTokens"));
  for (const language of ["jsx", "tsx", "json5", "toml", "css"]) {
    assert.ok(webSyntax.includes(`prismjs/components/prism-${language}`));
  }
});

test("native diff controls do not mount injected web host lists", () => {
  const source = readFileSync(new URL("../client/native-components.tsx", import.meta.url), "utf8");
  assert.match(source, /Platform\.OS === "web"[\s\S]*renderComponent\(hostScrollView/);
  assert.match(source, /Platform\.OS === "web"[\s\S]*renderComponent\(hostFlatList/);
  assert.match(source, /Platform\.OS === "web"[\s\S]*renderComponent\(hostTextInput/);
  assert.match(source, /Platform\.OS === "web" && isRenderable\(hostModal\)/);
  const nativeSyntax = readFileSync(new URL("../client/syntax.tsx", import.meta.url), "utf8");
  assert.match(nativeSyntax, /Platform\.OS === "web"[\s\S]*import\("\.\/syntax-web"\)/);
  assert.ok(source.includes('Ellipsis: "⋯"'));
  assert.ok(source.includes('Info: "ⓘ"'));
  assert.ok(source.includes('GitBranch: "⑂"'));
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
