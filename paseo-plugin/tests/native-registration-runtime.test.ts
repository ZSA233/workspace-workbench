import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build, buildSync } from "esbuild";

const binary = process.env.HERMES_BINARY || new URL("../node_modules/react-native/sdks/hermesc/osx-bin/hermes", import.meta.url).pathname;
const available = existsSync(binary) && (process.platform === "darwin" || !!process.env.HERMES_BINARY);
const external = ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client/ui", "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"];

function evaluate(code: string, prefix = "") {
  const root = mkdtempSync(join(tmpdir(), "wb-native-registration-"));
  try {
    const path = join(root, "evaluate.js");
    writeFileSync(path, `${prefix}\neval(${JSON.stringify("/*" + " ".repeat(100000) + "*/\n" + code.replaceAll("get: () => from[key]", "value: from[key]"))});setTimeout(function(){},0);`);
    return execFileSync(binary, ["-w", "-lazy", "-Xes6-promise", "-Xmicrotask-queue", path], { encoding: "utf8", timeout: 15000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Host/schema substitutes isolate the source-evaluation defect. This is a real
// Hermes engine regression, not Android rendering or real RPC evidence.
const recoveryContract = `function setInterval(){return 1;}function clearInterval(){}function require(){return {recoveryPolicySchema:{parse:function(){return {enabled:true,method:'continue',continueMessage:'continue',intervalSeconds:10,maxDurationMinutes:60,enabledByAgent:{}};}},sessionRecoveryRpc:{name:'recovery'}};}`;

test("Hermes lazy source evaluation creates and closes recovery state without class prototype failures", { skip: !available && "Set HERMES_BINARY to verify the native engine" }, async () => {
  const entry = `import('./client/recovery-store.ts').then(function(m){
    var calls=0,store=m.createRecoveryClientStore({rpc:function(){calls++;return Promise.resolve({sessions:[],policy:{},available:true,nativeAvailable:false});}});
    var first=store.refresh();if(first!==store.refresh())throw Error('read not merged');
    first.then(function(){if(calls!==1||!store.getSnapshot().loaded)throw Error('read incomplete');store.close();store.start();return store.refresh();}).then(function(){if(calls!==1)throw Error('closed store dispatched');print('native-recovery-store-ok');}).catch(function(e){print('FAILED: '+e.stack);});
  }).catch(function(e){print('FAILED: '+e.stack);});`;
  const code = (await build({ stdin: { contents: entry, loader: "ts", resolveDir: new URL("..", import.meta.url).pathname }, bundle: true,
    format: "cjs", platform: "neutral", target: "es2020", supported: { "async-await": false }, tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
    plugins: [{ name: "schema-boundary", setup(build) { build.onResolve({ filter: /shared\/session-recovery/ }, () => ({ path: "recovery-contract", external: true })); } }], write: false })).outputFiles[0].text;
  const output = evaluate(code, recoveryContract);
  assert.match(output, /native-recovery-store-ok/); assert.doesNotMatch(output, /FAILED/);
  assert.doesNotMatch(readFileSync(new URL("../client/recovery-store.ts", import.meta.url), "utf8"), /export class|new RecoveryClientStore/);
});

test("Hermes evaluates the actual client entry, registers, unloads and reloads without DOM", { skip: !available && "Set HERMES_BINARY to verify the native engine" }, () => {
  const source = buildSync({ entryPoints: [new URL("../index.client.tsx", import.meta.url).pathname], bundle: true, format: "cjs", jsx: "automatic", platform: "neutral",
    mainFields: ["module", "main"], target: "es2020", supported: { "async-await": false }, external, write: false }).outputFiles[0].text;
  const prefix = `
    var window,document,Element,Worker;
    var logs=[],intervals=0,originalConsoleError=function(){};
    var console={error:originalConsoleError,info:function(){},warn:function(){}};
    function setInterval(){intervals++;return intervals;}function clearInterval(){intervals--;}
    function component(){}
    function schema(fields){var value,hasDefault=false;var s={parse:function(v){if(v===undefined&&hasDefault)return value;if(fields){var out={};Object.keys(fields).forEach(function(k){out[k]=fields[k].parse(v&&v[k]);});return out;}return v;}};
      ['min','max','int','nonnegative','trim','nullable','optional'].forEach(function(k){s[k]=function(){return s;};});s.default=function(v){value=v;hasDefault=true;return s;};return s;}
    var z={object:function(f){return schema(f);}};
    ['string','number','boolean','enum','record','discriminatedUnion','literal','array','json'].forEach(function(k){z[k]=function(){return schema();};});
    function require(name){
      if(name==='react')return {createContext:function(v){return {Provider:component,value:v};},createElement:component,memo:function(v){return v;}};
      if(name==='react/jsx-runtime')return {jsx:component,jsxs:component};
      if(name==='react-native')return {Platform:{OS:'android'},View:component,Text:component,StyleSheet:{create:function(v){return v;}}};
      if(name==='@getpaseo/plugin/client/react-native'||name==='@getpaseo/plugin/client')return {};
      if(name==='zod')return {z:z};
      if(name==='@getpaseo/plugin')return {defineRpc:function(v){return v;},defineSettings:function(v){return v;},settingsRpc:function(){return {};}};
      throw Error('unexpected eager import: '+name);
    }
  `;
  const probe = `
    var registrations={},removals=0;
    function add(id){if(registrations[id])throw Error('duplicate '+id);registrations[id]=true;return function(){delete registrations[id];removals++;};}
    var host={addSurface:function(id){return add(id);},addSidebarItem:function(v){return add('sidebar:'+v.id);},addSettingsScreen:function(v){return add(v.id);},addWorkspacePanel:function(v){return add(v.id);},addCommandCenterItem:function(v){return add(v.id);},
      rpc:function(r,input){if(r.name==='workspace.workbench.client-diagnostic-batch'){return Promise.resolve({ok:true});}if(r.name==='workspace.workbench.client-diagnostic'){logs.push(input);return Promise.resolve({ok:true});}if(input.action!=='list')throw Error('unexpected recovery write');return new Promise(function(){});}};
    for(var pass=0;pass<3;pass++){
      var cleanup=module.exports.default(host);
      if(!registrations.workbench||registrations['workbench-session-recovery']||intervals!==0||console.error!==originalConsoleError)throw Error('Android must keep recovery and global hooks disabled');
      cleanup();cleanup();if(Object.keys(registrations).length||intervals!==0||console.error!==originalConsoleError)throw Error('cleanup incomplete');
    }
    print('native-client-registration-ok');
  `;
  const output = evaluate(`(function(){var module={exports:{}};var exports=module.exports;\n${source}\n${probe}})();`, prefix);
  assert.match(output, /native-client-registration-ok/); assert.doesNotMatch(output, /FAILED/);
});
