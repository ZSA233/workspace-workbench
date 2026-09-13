import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  canonical,
  optionalJson,
  WorkbenchError,
  type Json,
} from "./backend/storage.ts";
import { which } from "./backend/runtime.ts";
import { command } from "./backend/process.ts";
import type { ProjectRoute } from "./projects.ts";

export async function backendRequest(
  path: string,
  method: string,
  params: Json = {},
  timeout = 1500,
): Promise<Json | null> {
  if (Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107))
    throw new WorkbenchError(
      "socket_path_invalid",
      "Unix socket path is too long; configure a shorter socketPath",
    );
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "",
      settled = false;
    const finish = (value: Json | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          null,
          new WorkbenchError(
            "observer_busy",
            "socket owner did not answer; retained",
          ),
        ),
      timeout,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(JSON.stringify({ id: randomUUID(), method, params }) + "\n"),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024)
        finish(null, new Error("backend response too large"));
      const index = buffer.indexOf("\n");
      if (index >= 0)
        try {
          finish(JSON.parse(buffer.slice(0, index)));
        } catch (error) {
          finish(null, error);
        }
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      if (["ENOENT", "ECONNREFUSED"].includes(e.code || "")) finish(null);
      else finish(null, e);
    });
    socket.once("close", () => {
      if (!settled)
        finish(null, new Error("backend closed without a response"));
    });
  });
}
async function waitGone(route: ProjectRoute, instanceId?: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await backendRequest(
      route.socketPath,
      "observer.health",
    ).catch(() => null);
    if (!existsSync(route.socketPath)) return;
    if (
      response?.result?.process?.instanceId &&
      response.result.process.instanceId !== instanceId
    )
      throw new WorkbenchError(
        "process_identity_changed",
        "socket owner changed during shutdown",
      );
    if (!response) {
      try {
        process.kill(optionalJson(`${route.socketPath}.owner.json`).pid, 0);
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new WorkbenchError(
    "backend_stopping",
    "backend is draining active operations; retry shortly",
  );
}
export class BackendSupervisor {
  private children = new Map<
    string,
    { child: ChildProcess; token: string; error: string }
  >();
  private flights = new Map<string, Promise<void>>();
  private closed = false;
  entryPath: string;
  constructor(entryPath: string) {
    this.entryPath = entryPath;
  }
  async ensure(route: ProjectRoute, version: string): Promise<void> {
    if (this.closed)
      throw new WorkbenchError(
        "plugin_unloaded",
        "plugin generation has unloaded",
      );
    const pending = this.flights.get(route.configPath);
    if (pending) return pending;
    const flight = this.start(route, version).finally(() => {
      if (this.flights.get(route.configPath) === flight)
        this.flights.delete(route.configPath);
    });
    this.flights.set(route.configPath, flight);
    return flight;
  }
  private async retire(route: ProjectRoute, health: Json) {
    const ownerPath = `${route.socketPath}.owner.json`;
    if (health.implementation !== "node" || !health.process)
      return this.retireLegacy(route, health);
    if (
      !existsSync(ownerPath) ||
      lstatSync(ownerPath).isSymbolicLink() ||
      (lstatSync(ownerPath).mode & 0o077) !== 0 ||
      lstatSync(ownerPath).uid !== process.getuid?.()
    )
      throw new WorkbenchError(
        "process_identity_unverified",
        "backend ownership record is unavailable or insecure",
      );
    const owner = optionalJson(ownerPath),
      remote = health.process;
    if (
      owner.implementation !== "node" ||
      owner.configPath !== canonical(route.configPath) ||
      remote.configPath !== owner.configPath ||
      owner.pid !== remote.pid ||
      owner.instanceId !== remote.instanceId ||
      !owner.token
    )
      throw new WorkbenchError(
        "process_identity_unverified",
        "backend ownership does not match this project",
      );
    const response = await backendRequest(
      route.socketPath,
      "observer.shutdown",
      { token: owner.token },
    );
    if (!response?.ok)
      throw new WorkbenchError(
        "backend_stop_failed",
        "backend refused authenticated shutdown",
      );
    await waitGone(route, owner.instanceId);
  }
  private async retireLegacy(route: ProjectRoute, health: Json) {
    // Older Python backends have no control token. Only an exact, local CLI
    // identity owning this Unix socket can be retired, never a PID-file guess.
    if (health.service !== "workspace-workbench")
      throw new WorkbenchError(
        "process_identity_unverified",
        "unrelated service owns socket",
      );
    const lsof = await command(
      which("lsof") || "/usr/sbin/lsof",
      ["-nP", "-Fpc", route.socketPath],
      { cwd: route.sourceRoot, timeout: 2000 },
    );
    const pids = [
      ...new Set(
        lsof.stdout
          .split("\n")
          .filter((line) => /^p\d+$/.test(line))
          .map((line) => Number(line.slice(1))),
      ),
    ];
    if (pids.length !== 1)
      throw new WorkbenchError(
        "process_identity_unverified",
        "legacy socket process is ambiguous; retained",
      );
    const pid = pids[0],
      args = [
        "-p",
        String(pid),
        "-o",
        "uid=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ];
    const first = await command("ps", args, {
      cwd: route.sourceRoot,
      timeout: 2000,
    });
    const signature = first.stdout.trim();
    // Paths with whitespace cannot be unambiguously verified via ps text.
    if (
      /\s/.test(route.configPath) ||
      !signature.startsWith(String(process.getuid?.()) + " ") ||
      !signature.includes(
        " -m workspace_workbench serve --config " + route.configPath,
      ) ||
      !signature.endsWith(route.configPath)
    )
      throw new WorkbenchError(
        "process_identity_unverified",
        "legacy backend command could not be verified; retained",
      );
    const second = await command("ps", args, {
      cwd: route.sourceRoot,
      timeout: 2000,
    });
    if (second.stdout.trim() !== signature)
      throw new WorkbenchError(
        "process_identity_changed",
        "legacy process changed; retained",
      );
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new WorkbenchError(
      "backend_stopping",
      "legacy backend has not exited; retained",
    );
  }
  private async start(route: ProjectRoute, version: string) {
    const probe = await backendRequest(route.socketPath, "observer.health");
    const current = this.children.get(route.configPath);
    if (
      probe?.ok &&
      probe.result?.implementation === "node" &&
      probe.result?.version === version &&
      probe.result?.process?.pid === current?.child.pid &&
      !probe.result.process.closing
    )
      return;
    if (probe) await this.retire(route, probe.result || {});
    if (this.closed)
      throw new WorkbenchError(
        "plugin_unloaded",
        "plugin unloaded while starting backend",
      );
    if (
      current &&
      current.child.exitCode === null &&
      !current.child.signalCode
    ) {
      if (current.child.connected) current.child.send("shutdown");
      await waitGone(route);
    }
    const token = randomUUID();
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        this.entryPath,
        "serve",
        "--config",
        route.configPath,
      ],
      {
        cwd: route.sourceRoot,
        env: {
          ...process.env,
          WORKBENCH_BACKEND_TOKEN: token,
          WORKBENCH_BACKEND_PARENT_PID: String(process.pid),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const entry = { child, token, error: "" };
    this.children.set(route.configPath, entry);
    child.stderr?.on("data", (chunk) => {
      entry.error = (entry.error + String(chunk)).slice(-8000);
    });
    child.once("error", (error) => {
      entry.error = error.message;
    });
    child.once("exit", () => {
      if (this.children.get(route.configPath) === entry)
        this.children.delete(route.configPath);
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !this.closed) {
      if (child.exitCode !== null || child.signalCode)
        throw new WorkbenchError(
          "backend_start_failed",
          entry.error || "backend exited during startup",
        );
      const health = await backendRequest(route.socketPath, "observer.health");
      if (
        health?.ok &&
        health.result?.implementation === "node" &&
        health.result?.version === version &&
        health.result?.process?.pid === child.pid &&
        health.result.process.configPath === canonical(route.configPath) &&
        !health.result.process.closing
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    if (child.connected) child.send("shutdown");
    else child.kill("SIGTERM");
    throw new WorkbenchError(
      "backend_start_failed",
      entry.error || "backend startup timed out",
    );
  }
  async close() {
    this.closed = true;
    for (const { child } of this.children.values()) {
      if (child.connected) {
        child.send("shutdown", () => {});
        child.disconnect();
      } else if (child.exitCode === null && !child.signalCode)
        child.kill("SIGTERM");
    }
    await Promise.allSettled(this.flights.values());
    await Promise.all(
      [...this.children.values()].map(({ child }) =>
        child.exitCode !== null || child.signalCode
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 8000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
            }),
      ),
    );
    this.children.clear();
  }
}
