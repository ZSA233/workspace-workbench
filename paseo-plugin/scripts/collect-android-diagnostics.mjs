/** Read-only Android/host capture. Never enables plugins, clears logcat, restarts
 * Paseo, launches the app or changes device settings. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const limit = 2 * 1024 * 1024;
export function summarizeHostLog(text) {
  const clients = [], transport = [];
  for (const line of text.split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.message?.startsWith("workbench_client_diagnostic ")) {
      try { const event = JSON.parse(row.message.slice("workbench_client_diagnostic ".length)); if (event.platform === "android") clients.push(event); } catch { /* partial tail */ }
    }
    if (row.msg === "ws_runtime_metrics") transport.push({ at: new Date(row.time).toISOString(), eventLoopDelay: row.eventLoopDelay, hostMemory: row.memory,
      inbound: row.inboundSessionRequestTypesTop, outbound: row.outboundSessionMessageTypesTop });
  }
  return { androidClientEvents: clients.slice(-150), recentHostTransport: transport.slice(-20),
    note: "Host memory is not Android memory. Missing client errors do not rule out an Android crash or ANR." };
}
async function tail(path) {
  const file = await open(path, "r");
  try { const size = (await file.stat()).size, buffer = Buffer.alloc(Math.min(size, 4 * limit)); await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return buffer.toString("utf8"); }
  finally { await file.close(); }
}
export async function collectAndroidDiagnostics(options, run = async (command, args) => {
  const { stdout } = await exec(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: limit }); return stdout;
}) {
  const directory = resolve(options.output), home = options.home || process.env.PASEO_HOME || join(homedir(), ".paseo");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const errors = [];
  const capture = async (name, command, args) => {
    try { const value = (await run(command, args)).slice(0, limit); await writeFile(join(directory, name), value, { mode: 0o600 }); return value; }
    catch (error) { errors.push({ file: name, error: String(error.message).slice(0, 1000) }); return ""; }
  };
  const report = { kind: "workbench-android-diagnostics", startedAt: new Date().toISOString(), output: directory, errors, android: { status: "not_collected" } };
  const host = await capture("host-status.json", "paseo", ["daemon", "status", "--json"]);
  const plugins = await capture("plugins.json", "paseo", ["plugin", "ls", "--json"]);
  try { report.host = JSON.parse(host); } catch { /* offline */ }
  try { report.plugin = JSON.parse(plugins).find(plugin => plugin.id === "workspace-workbench-paseo"); } catch { /* offline */ }
  try { report.hostLog = summarizeHostLog(await tail(join(home, "daemon.log"))); } catch (error) { errors.push({ file: "daemon.log", error: String(error.message) }); }
  if (!options.hostOnly) {
    const devices = await capture("adb-devices.txt", "adb", ["devices", "-l"]);
    const online = devices.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === "device").map(parts => parts[0]);
    const serial = options.serial || (online.length === 1 ? online[0] : null);
    if (!serial || !online.includes(serial)) report.android = { status: online.length > 1 ? "select_device_with_serial" : "not_connected" };
    else {
      const adb = (args) => ["-s", serial, ...args];
      const packages = await capture("paseo-packages.txt", "adb", adb(["shell", "pm", "list", "packages", "paseo"]));
      const candidates = packages.split("\n").filter(line => line.startsWith("package:")).map(line => line.slice(8).trim());
      const packageName = options.packageName || (candidates.length === 1 ? candidates[0] : null);
      if (!packageName || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) report.android = { status: "select_package_with_package", candidates };
      else {
        report.android = { status: "captured", serial, packageName };
        await capture("android-version.txt", "adb", adb(["shell", "getprop", "ro.build.version.release"]));
        await capture("android-model.txt", "adb", adb(["shell", "getprop", "ro.product.model"]));
        const before = (await capture("pid-before.txt", "adb", adb(["shell", "pidof", packageName]))).trim().split(/\s+/).find(id => /^\d+$/.test(id));
        const seconds = Math.max(0, Math.min(120, options.durationSeconds ?? 30));
        if (seconds) { console.log(`Capturing ${packageName} for ${seconds}s. Reproduce the freeze or crash on the device.`); await new Promise(resolve => setTimeout(resolve, seconds * 1000)); }
        const after = (await capture("pid-after.txt", "adb", adb(["shell", "pidof", packageName]))).trim().split(/\s+/).find(id => /^\d+$/.test(id));
        for (const pid of new Set([before, after].filter(Boolean))) {
          await capture(`app-logcat-${pid}.txt`, "adb", adb(["logcat", "-d", "-v", "threadtime", "-t", "1000", "--pid", pid]));
          await capture(`app-crash-${pid}.txt`, "adb", adb(["logcat", "-b", "crash", "-d", "-v", "threadtime", "-t", "500", "--pid", pid]));
        }
        await capture("app-exit-info.txt", "adb", adb(["shell", "dumpsys", "activity", "exit-info", packageName]));
        await capture("app-memory.txt", "adb", adb(["shell", "dumpsys", "meminfo", packageName]));
        await capture("app-frames.txt", "adb", adb(["shell", "dumpsys", "gfxinfo", packageName, "framestats"]));
        report.android.pidBefore = before || null; report.android.pidAfter = after || null;
        if (!before && !after) report.android.status = "exit_info_only";
      }
    }
  }
  // Include evidence emitted during the reproduction window, not just startup.
  try { report.hostLog = summarizeHostLog(await tail(join(home, "daemon.log"))); } catch { /* initial error is already retained */ }
  report.completedAt = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2), value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const duration = value("--duration");
  if (duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) < 0 || Number(duration) > 120)) throw new Error("duration_must_be_between_0_and_120_seconds");
  const report = await collectAndroidDiagnostics({ output: value("--output") || join(tmpdir(), `workbench-android-${Date.now()}`), serial: value("--serial"), packageName: value("--package"), durationSeconds: duration === undefined ? 30 : Number(duration), hostOnly: args.includes("--host-only") });
  console.log(JSON.stringify({ output: report.output, plugin: report.plugin?.status, android: report.android, errors: report.errors.length }, null, 2));
}
