/** Focused routing smoke test against a real Paseo UI with an isolated home. */
import assert from "node:assert/strict";
import { execFileSync, spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { selectGlobalWorkbenchProject } from "./ui-project-selection.mjs";

const plugin = resolve(import.meta.dirname, "..");
// Unix-domain sockets have a short path limit; macOS TMPDIR is often too long.
const tempRoot = existsSync("/tmp") ? "/tmp" : tmpdir();
const root = realpathSync(mkdtempSync(join(tempRoot, "wb-routing-")));
const paseoHome = join(root, "paseo"), registry = join(root, "projects.json");
const registered = join(root, "registered"), unregistered = join(root, "unregistered");
mkdirSync(paseoHome); mkdirSync(registered); mkdirSync(unregistered);
for (const [parent, names] of [[registered, ["existing"]], [unregistered, ["alpha", "beta"]]]) {
  for (const name of names) {
    const repo = join(parent, name); mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
  }
}
const config = join(registered, "project.json");
writeFileSync(config, JSON.stringify({ schemaVersion: 1, project: { id: "registered", displayName: "Registered fixture" }, sourceRoot: registered,
  stateRoot: join(registered, "state"), workspaceRoot: join(registered, "workspaces"), socketPath: join(registered, "observer.sock"),
  repositories: [{ id: "existing", path: "existing" }], discovery: { mode: "manual" }, management: { enabled: true } }));
writeFileSync(registry, JSON.stringify({ configs: [config] }));
const listener = createServer();
await new Promise(resolveListen => listener.listen(0, "127.0.0.1", resolveListen));
const port = listener.address().port;
await new Promise(resolveClose => listener.close(resolveClose));
writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ version: 1, pluginsEnabled: true,
  daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false } },
  features: { webUi: { enabled: true } }, plugins: { "workspace-workbench-paseo": { source: "directory", path: plugin, enabled: true } } }));
const env = { ...process.env, PASEO_HOME: paseoHome, WORKSPACE_WORKBENCH_PROJECT_REGISTRY: registry,
  WORKSPACE_WORKBENCH_PLUGIN_ROOT: plugin, WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD: "1", PASEO_DICTATION_ENABLED: "false", PASEO_VOICE_MODE_ENABLED: "false" };
delete env.WORKSPACE_WORKBENCH_CONFIG;
const cli = process.env.PASEO_CLI || "paseo", exec = promisify(execFile);
const daemon = spawn(cli, ["daemon", "run", "--home", paseoHome], { env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, page;
for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", data => { logs = (logs + data).slice(-30000); });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
try {
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (daemon.exitCode !== null) throw Error(`isolated Paseo exited: ${logs}`);
    if (await fetch(`http://127.0.0.1:${port}`).then(response => response.ok).catch(() => false)) { ready = true; break; }
    await delay(250);
  }
  assert.ok(ready, "isolated Paseo did not start");
  let connected = false;
  for (let n = 0; n < 20 && !connected; n++) {
    try { await exec(cli, ["workspace", "ls", "--home", paseoHome, "--json"], { env, timeout: 10000 }); connected = true; }
    catch { await delay(250); }
  }
  assert.ok(connected, "isolated Paseo API did not become ready");
  for (const [path, title] of [[registered, "Registered workspace"], [unregistered, "Multi-repo workspace"]])
    await exec(cli, ["workspace", "create", "--isolation", "local", "--path", path, "--title", title, "--home", paseoHome, "--json"], { env, timeout: 10000 });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await Promise.race([
    page.getByText("Direct connection", { exact: true }).waitFor({ timeout: 10000 }),
    page.getByRole("button", { name: "Workspace Workbench", exact: true }).waitFor({ timeout: 10000 }),
  ]);
  if (await page.getByText("Direct connection", { exact: true }).isVisible()) {
    await page.getByText("Direct connection", { exact: true }).click();
    await page.getByPlaceholder("localhost").fill("127.0.0.1");
    await page.getByPlaceholder("6767").fill(String(port));
    await page.getByText("Connect", { exact: true }).click();
  }
  await page.getByRole("button", { name: "Workspace Workbench", exact: true }).first().click();
  await page.getByText(/The global entry cannot identify the current workspace/).waitFor();
  await page.getByText("Registered fixture", { exact: true }).waitFor();
  assert.equal(await page.getByText("Repositories", { exact: true }).filter({ visible: true }).count(), 0);
  await selectGlobalWorkbenchProject(page, "Registered fixture");
  await page.getByText("existing", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });

  await page.getByRole("button", { name: "Multi-repo workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open Workspace Workbench", exact: true }).click();
  await page.getByText("Discovered repositories (2)", { exact: true }).waitFor({ timeout: 20000 });
  const alpha = page.getByRole("checkbox").filter({ hasText: "alpha" });
  const beta = page.getByRole("checkbox").filter({ hasText: "beta" });
  assert.match(await alpha.innerText(), /☑/);
  assert.match(await beta.innerText(), /☑/);
  await beta.click(); await beta.getByText("☐", { exact: true }).waitFor();
  await beta.click(); await beta.getByText("☑", { exact: true }).waitFor();
  assert.equal(await page.getByText("existing", { exact: true }).filter({ visible: true }).count(), 0);
  await page.getByText("Save and start", { exact: true }).click();
  await page.getByText("Discovered repositories (2)", { exact: true }).waitFor({ state: "detached", timeout: 30000 });
  await page.getByText("alpha", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  const saved = JSON.parse(readFileSync(join(unregistered, ".workspace-workbench", "project.json"), "utf8"));
  assert.deepEqual(saved.repositories.map(repo => repo.path).sort(), ["alpha", "beta"]);

  await page.getByRole("button", { name: "Registered workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open Workspace Workbench", exact: true }).click();
  await page.getByText("existing", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.getByText("alpha", { exact: true }).filter({ visible: true }).count(), 0);
  await page.getByRole("button", { name: "Multi-repo workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open Workspace Workbench", exact: true }).click();
  await page.getByText("alpha", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.getByText("existing", { exact: true }).filter({ visible: true }).count(), 0);
  console.log(JSON.stringify({ ok: true, checks: ["global selection requires explicit choice", "non-Git workspace discovers and saves two repositories", "switching workspaces selects only their own project"] }));
} catch (error) {
  console.error(error.stack);
  if (page) console.error("BODY", (await page.locator("body").innerText().catch(() => "")).slice(0, 5000));
  console.error("DAEMON", logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  try { await exec(cli, ["daemon", "stop", "--home", paseoHome, "--timeout", "5", "--json"], { env, timeout: 10000 }); } catch {}
  daemon.kill("SIGTERM");
  await Promise.race([new Promise(resolveExit => daemon.once("exit", resolveExit)), delay(3000)]);
  if (daemon.exitCode === null && !daemon.signalCode) daemon.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
