import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { executeLocal } from "./local-execution.ts";
import { loadConfig, discover } from "./config.ts";
import { Service } from "./service.ts";
import { serveSocket, serveStdio } from "./transport.ts";
import { issue, readJson, atomicJson, canonical, slug } from "./storage.ts";
import { fileURLToPath } from "node:url";
import { join, dirname, basename, relative } from "node:path";

const args = process.argv.slice(2),
  configIndex = args.indexOf("--config");
try {
  if (args[0] === "init") {
    const root = args[args.indexOf("--root") + 1],
      output = args[args.indexOf("--output") + 1];
    if (
      !args.includes("--root") ||
      !args.includes("--output") ||
      !root ||
      !output
    )
      throw new Error("init requires --root and --output");
    if (existsSync(output)) throw new Error("config already exists; preserved");
    atomicJson(output, {
      schemaVersion: 1,
      project: { id: slug(basename(root)), displayName: basename(root) },
      sourceRoot: canonical(root),
      workspaceRoot: join(canonical(root), ".workspace-workbench/workspaces"),
      stateRoot: join(canonical(root), ".workspace-workbench"),
      repositories: [],
      management: { enabled: true },
      discovery: { mode: "hybrid" },
    });
    process.exit(0);
  }
  if (configIndex < 0 || !args[configIndex + 1])
    throw new Error("usage: node main.ts serve|stdio --config PROJECT_JSON");
  const config = loadConfig(args[configIndex + 1]);
  const version = readJson(
    join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
  ).version;
  const service = new Service(config, version);
  if (args[0] === "health") {
    process.stdout.write(JSON.stringify(service.health()) + "\n");
    await service.close();
  } else if (args[0] === "discover") {
    process.stdout.write(JSON.stringify(discover(config)) + "\n");
    await service.close();
  } else if (args[0] === "accept") {
    const ref = args[args.indexOf("--repository") + 1];
    if (!args.includes("--repository") || !ref)
      throw new Error("accept requires --repository");
    const candidates = discover(config).filter(
      (repo) =>
        repo.id === ref ||
        repo.path === canonical(ref || ".") ||
        relative(config.sourceRoot, repo.path) === ref,
    );
    if (candidates.length !== 1)
      throw new Error("repository candidate is unavailable or ambiguous");
    const raw = readJson(config.configPath),
      repo = candidates[0];
    raw.repositories = [
      ...(raw.repositories || []),
      {
        id: repo.id,
        path: relative(config.sourceRoot, repo.path) || ".",
        displayName: repo.display_name,
        enabled: true,
      },
    ];
    atomicJson(config.configPath, raw);
    await service.close();
  } else if (args[0] === "exec") {
    process.exitCode = await executeLocal(
      service,
      args[args.indexOf("--workspace") + 1] || "",
      args[args.indexOf("--repo") + 1] || "",
      args.includes("--") ? args.slice(args.indexOf("--") + 1) : [],
    );
    await service.close();
  } else if (
    args[0] === "stdio" ||
    (args[0] === "serve" && args.includes("--stdio"))
  )
    await serveStdio(service);
  else {
    if (args[0] !== "serve") throw new Error("unknown command");
    if (args.includes("--socket"))
      config.socketPath = canonical(args[args.indexOf("--socket") + 1]);
    const server = await serveSocket(
      service,
      process.env.WORKBENCH_BACKEND_TOKEN || randomUUID(),
    );
    const parentPid = Number(process.env.WORKBENCH_BACKEND_PARENT_PID || 0);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(parentCheck);
      await server.close();
      process.exit(0);
    };
    // IPC disconnect covers plugin unload; parent identity covers abrupt daemon exit.
    const parentCheck = setInterval(() => {
      if (parentPid && !process.connected) void stop();
    }, 1000);
    parentCheck.unref();
    // Disconnect may precede module initialization. process.ppid is not a
    // reliable live-parent probe after reparenting; IPC is the ownership lease.
    if (parentPid && !process.connected) void stop();
    process.once("SIGTERM", () => {
      void stop();
    });
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("disconnect", () => {
      void stop();
    });
    process.on("message", (message) => {
      if (message === "shutdown") void stop();
    });
  }
} catch (error) {
  process.stderr.write(JSON.stringify(issue(error)) + "\n");
  process.exitCode = 1;
}
