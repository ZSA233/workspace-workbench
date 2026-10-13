/** Test only: load the original host handler in an isolated daemon, without
 * changing any installed files. Child Node processes inherit this import. */
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (isMainThread) register(import.meta.url);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith("file:") || !url.endsWith("/@getpaseo/server/dist/server/server/session.js")) return result;
  if (!String(result.source).includes("// workspace-workbench native recovery v1")) return result;
  const original = readFileSync(fileURLToPath(url) + ".workbench-native-recovery.original", "utf8");
  if (original.includes("workspace-workbench native recovery v1") || !original.includes(".invokePluginRpc(msg.pluginId, msg.method, msg.input)")) throw new Error("original_paseo_handler_unverified");
  console.error("[workbench-test] isolated host loaded original Paseo session handler without native recovery");
  return { ...result, source: original };
}
