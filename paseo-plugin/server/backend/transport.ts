import { acquireProjectLease } from "./lease.ts";
import { createServer, createConnection, type Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { Service } from "./service.ts";
import {
  atomicJson,
  canonical,
  issue,
  optionalJson,
  WorkbenchError,
  type Json,
} from "./storage.ts";
export async function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      if (["ENOENT", "ECONNREFUSED"].includes(e.code || "")) resolve(false);
      else reject(e);
    });
    socket.setTimeout(800, () => {
      socket.destroy();
      reject(
        new WorkbenchError(
          "observer_busy",
          "existing socket did not answer; retained",
        ),
      );
    });
  });
}
export async function response(service: Service, raw: string): Promise<Json> {
  let id: unknown = null;
  try {
    const request = JSON.parse(raw);
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new WorkbenchError("request_invalid", "request must be an object");
    id = request.id ?? null;
    if (
      request.params != null &&
      (typeof request.params !== "object" || Array.isArray(request.params))
    )
      throw new WorkbenchError("request_invalid", "params must be an object");
    return {
      id,
      ok: true,
      result: await service.handle(
        String(request.method || ""),
        request.params || {},
      ),
    };
  } catch (error) {
    return { id, ok: false, error: issue(error) };
  }
}
export async function serveSocket(
  service: Service,
  token: string,
  instanceId = randomUUID(),
) {
  const path = service.config.socketPath,
    ownerPath = `${path}.owner.json`;
  if (Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107))
    throw new WorkbenchError(
      "socket_path_invalid",
      "Unix socket path is too long; configure socketPath:auto with a shorter home or an explicit short path",
    );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const before = lstatSync(path);
    if (!before.isSocket())
      throw new WorkbenchError(
        "socket_path_invalid",
        "socket path is not a Unix socket",
      );
    if (await socketAlive(path))
      throw new WorkbenchError(
        "observer_busy",
        "another backend owns this socket",
      );
    const after = lstatSync(path);
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw new WorkbenchError(
        "observer_busy",
        "socket owner changed during stale check",
      );
    unlinkSync(path);
  }
  const releaseLease = acquireProjectLease(service.config.recordsRoot);
  const sockets = new Set<Socket>(),
    tasks = new Set<Promise<unknown>>();
  let bound: { ino: number; dev: number } | null = null;
  let closing = false,
    closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closed) return closed;
    closing = true;
    closed = (async () => {
      await Promise.allSettled([...tasks]);
      try {
        await service.close();
      } finally {
        server.close();
        for (const socket of sockets) socket.destroy();
        releaseLease();
        try {
          const current = existsSync(path) ? lstatSync(path) : null;
          if (bound && current?.ino === bound.ino && current.dev === bound.dev)
            unlinkSync(path);
          if (optionalJson(ownerPath).instanceId === instanceId)
            unlinkSync(ownerPath);
        } catch {}
      }
    })();
    return closed;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "",
      pending = 0;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (++pending > 32) {
          socket.destroy();
          return;
        }
        let request: Json = {};
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            request = parsed;
        } catch {}
        if (request?.method === "observer.health") {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                ...service.health(),
                process: {
                  pid: process.pid,
                  configPath: canonical(service.config.configPath),
                  instanceId,
                  closing,
                  activeRequests: tasks.size,
                },
              },
            }) + "\n",
          );
          pending--;
          continue;
        }
        if (request?.method === "observer.shutdown") {
          const supplied = Buffer.from(String(request.params?.token || "")),
            expected = Buffer.from(token);
          if (
            !token ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
          ) {
            socket.write(
              JSON.stringify({
                id: request.id,
                ok: false,
                error: {
                  code: "process_identity_unverified",
                  message: "shutdown token mismatch",
                },
              }) + "\n",
            );
            pending--;
            continue;
          }
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: true,
              result: { stopping: true },
            }) + "\n",
          );
          pending--;
          void close();
          continue;
        }
        if (tasks.size >= 64) {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: "observer_busy",
                message: "backend request limit reached; retry",
              },
            }) + "\n",
          );
          pending--;
          continue;
        }
        if (closing) {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: "observer_closing",
                message: "backend is shutting down; retry",
              },
            }) + "\n",
          );
          pending--;
          continue;
        }
        const task = response(service, line)
          .then((value) => {
            if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
          })
          .finally(() => {
            pending--;
            tasks.delete(task);
          });
        tasks.add(task);
      }
    });
  });
  const previousUmask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        releaseLease();
        reject(error);
      };
      server.once("error", failed);
      server.listen(path, () => {
        server.off("error", failed);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  bound = lstatSync(path);
  try {
    chmodSync(path, 0o600);
    atomicJson(ownerPath, {
      version: 1,
      implementation: "node",
      configPath: canonical(service.config.configPath),
      socketPath: path,
      pid: process.pid,
      parentPid: process.ppid,
      instanceId,
      token,
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  server.on("error", () => {
    void close();
  });
  return { close, instanceId };
}
export async function serveStdio(service: Service) {
  const releaseLease = acquireProjectLease(service.config.recordsRoot);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines)
      if (line.trim())
        process.stdout.write(
          JSON.stringify(await response(service, line)) + "\n",
        );
  } finally {
    try {
      await service.close();
    } finally {
      releaseLease();
    }
  }
}
