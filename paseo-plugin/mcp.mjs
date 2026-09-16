import { handle } from "./shared/mcp-router.mjs";
import { serveMcp } from "./shared/mcp-dispatcher.mjs";
import { buildId } from "./shared/build-id.mjs";
const build = buildId(["./mcp-router.mjs", "./mcp-dispatcher.mjs", "./mcp-connection.mjs"]);
const server = serveMcp(async (message, lifecycle) => {
  const result = await handle(message, lifecycle);
  return message.method === "ping" || message.method === "initialize"
    ? { ...result, _meta: { workbench: { buildId: build, ...server.health() } } } : result;
});
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
