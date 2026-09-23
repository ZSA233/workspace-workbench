import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";
import { withMcpConnection } from "./mcp-connection.mjs";
import { localPaseoEndpoint } from "./paseo-endpoint.mjs";

export async function probePaseo() {
  const endpoint = localPaseoEndpoint();
  if (!endpoint) return { ok: false, stage: "endpoint", code: "workbench_paseo_endpoint_unavailable" };
  const sockets = new Set();
  const client = new DaemonClient({ url: endpoint, clientId: `workbench-probe-${randomUUID()}`,
    clientType: "mcp", reconnect: { enabled: false },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      return socket;
    },
  });
  let stage = "paseo";
  try {
    const result = await withMcpConnection(client, async () => {
      stage = "plugin_rpc";
      return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.mcp.status", {});
    }, { deadline: Date.now() + 3_000, connectMs: 1_500, closeMs: 250,
      forceClose: () => { for (const socket of sockets) socket.terminate(); sockets.clear(); } });
    return result?.ok === true ? { ok: true, stage: "ready" }
      : { ok: false, stage: "plugin_rpc", code: "workbench_plugin_rpc_unavailable" };
  } catch {
    return { ok: false, stage, code: stage === "paseo" ? "workbench_paseo_unavailable" : "workbench_plugin_rpc_unavailable" };
  }
}
