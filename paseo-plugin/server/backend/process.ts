import { spawn } from "node:child_process";
import { WorkbenchError } from "./storage.ts";
export async function command(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
  },
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0,
        failure: WorkbenchError | null = null;
      const timer = setTimeout(() => {
        failure = new WorkbenchError(
          "process_timeout",
          `${executable} timed out`,
        );
        kill();
      }, options.timeout || 10000);
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes || 32 * 1024 * 1024)) {
          failure = new WorkbenchError(
            "output_limit",
            `${executable} output exceeded limit`,
          );
          kill();
        } else chunks.push(chunk);
      };
      child.stdout.on("data", (chunk) => collect(stdout, chunk));
      child.stderr.on("data", (chunk) => collect(stderr, chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new WorkbenchError("process_unavailable", error.message));
      });
      // Resolve only on close: no caller starts a replacement while a timed-out
      // mutation is still writing files.
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code: code ?? -1,
          });
      });
    },
  );
}
