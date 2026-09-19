import { readDiagnosticEvents } from "./diagnostics-runtime.mjs";
import type { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import type { diagnosticsQuery } from "../shared/diagnostics.ts";
import { mcpGatewayStatus } from "./mcp-gateway.ts";
import { clientDiagnosticsSnapshot } from "./client-diagnostics.ts";

export function handleMcpStatus() {
  return { ok: true, ...mcpGatewayStatus() };
}

export async function handleDiagnostics(input: z.input<typeof diagnosticsQuery.input>, metrics: { snapshot(): unknown }) {
  const events = await readDiagnosticEvents(undefinedPath(), input.limit || 200);
  return {
    ok: true,
    pluginGeneration: `server:${process.pid}`,
    gateway: mcpGatewayStatus(),
    rpcMetrics: metrics.snapshot(),
    clientEvents: clientDiagnosticsSnapshot().slice(-(input.limit || 200)),
    events,
  };
}

function undefinedPath(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "workspace-workbench", "diagnostics");
}
