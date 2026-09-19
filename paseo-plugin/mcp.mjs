import { handle } from "./shared/mcp-router.mjs";
import { serveMcp } from "./shared/mcp-dispatcher.mjs";
import { buildId } from "./shared/build-id.mjs";
import { createRequire } from "node:module";
const packageMetadata = createRequire(import.meta.url)("./package.json");
const build = buildId(["./mcp-router.mjs", "./mcp-dispatcher.mjs", "./mcp-connection.mjs"]);
const server = serveMcp(async (message, lifecycle) => {
  const result = await handle(message, lifecycle);
  return message.method === "ping" || message.method === "initialize"
    ? { ...result, _meta: { workbench: { buildId: build, transport: "stdio", pluginGeneration: process.env.WORKBENCH_PLUGIN_GENERATION || null, gatewayGeneration: null, ...server.health() } } } : result;
});
process.stderr.write(JSON.stringify({
  component: "workbench-mcp",
  event: "started",
  version: packageMetadata.version,
  buildId: build,
  pid: process.pid,
  parentPid: process.ppid,
  transport: "stdio",
  role: process.env.WORKBENCH_ROLE || (process.env.WORKBENCH_REVIEW_ONLY === "1" ? "reviewer" : process.env.WORKBENCH_EXECUTION_REPORT_ONLY === "1" ? "execution-report" : process.env.WORKBENCH_EXECUTION_REPORT === "1" ? "worker" : "interactive"),
}) + "\n");
const close = (reason) => {
  process.stderr.write(JSON.stringify({ component: "workbench-mcp", event: "closing", reason, pid: process.pid, parentPid: process.ppid }) + "\n");
  server.close();
};
process.once("SIGTERM", () => close("SIGTERM"));
process.once("SIGINT", () => close("SIGINT"));
process.stdin.once("close", () => close("stdin_closed"));
