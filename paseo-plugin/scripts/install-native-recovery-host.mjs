/** Explicit compatibility bridge for the currently installed Paseo 0.11.0.
 * No daemon restart, plugin reload, user settings changes or process signals. */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export async function installNativeRecoveryHost(serverRoot, apply = false) {
  const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
  if (pkg.name !== "@getpaseo/server" || pkg.version !== "0.11.0") throw new Error("native_recovery_unsupported_paseo_version");
  const file = join(serverRoot, "dist/server/server/session.js"), module = join(dirname(file), "workbench-native-recovery.mjs");
  const original = readFileSync(file, "utf8"), marker = "// workspace-workbench native recovery v1";
  const anchor = '            return this.pluginRuntime\n                .invokePluginRpc(msg.pluginId, msg.method, msg.input)';
  const replacement = '            return (msg.pluginId === "workspace-workbench-paseo" && msg.method === "workspace.workbench.nativeRecovery.v1"\n                ? invokeWorkbenchNativeRecovery(this, msg.input, ensureAgentLoaded)\n                : this.pluginRuntime.invokePluginRpc(msg.pluginId, msg.method, msg.input))';
  const patched = original.includes(marker) ? original : `${marker}\nimport { invokeWorkbenchNativeRecovery } from "./workbench-native-recovery.mjs";\n${original.replace(anchor, replacement)}`;
  if (!original.includes(marker) && original.split(anchor).length !== 2) throw new Error("native_recovery_host_source_unrecognized");
  if (!original.includes('import { ensureAgentLoaded,')) throw new Error("native_recovery_host_loader_unrecognized");
  const bundle = await build({ entryPoints: [resolve(import.meta.dirname, "../server/session-recovery/native-host.ts")], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  const code = bundle.outputFiles[0].text;
  const changed = patched !== original || !existsSync(module) || readFileSync(module, "utf8") !== code;
  if (apply && changed) {
    const backup = file + ".workbench-native-recovery.original";
    if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600 });
    else if (!original.includes(marker) && readFileSync(backup, "utf8") !== original) throw new Error("native_recovery_host_backup_conflict");
    writeFileSync(module + ".tmp", code); renameSync(module + ".tmp", module);
    writeFileSync(file + ".workbench.tmp", patched); renameSync(file + ".workbench.tmp", file);
  }
  return { serverRoot, version: pkg.version, changed, applied: apply, sourceHash: createHash("sha256").update(patched).digest("hex"), restartRequired: changed };
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const at = process.argv.indexOf("--server-root");
  let root = at >= 0 ? resolve(process.argv[at + 1]) : null;
  if (!root) {
    const cli = realpathSync(execFileSync("/usr/bin/which", ["paseo"], { encoding: "utf8" }).trim());
    const require = createRequire(cli);
    let directory = dirname(require.resolve("@getpaseo/server"));
    while (!existsSync(join(directory, "package.json"))) { const parent = dirname(directory); if (parent === directory) throw new Error("native_recovery_server_not_found"); directory = parent; }
    root = directory;
  }
  console.log(JSON.stringify(await installNativeRecoveryHost(root, process.argv.includes("--apply")), null, 2));
}
