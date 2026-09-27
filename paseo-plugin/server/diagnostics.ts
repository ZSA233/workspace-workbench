import { readerGeneration } from "./reader-identity.ts";
import { DIFF_READ_BUILD, DIFF_READ_PROTOCOL } from "../shared/diff-read.ts";
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
  const gateway = mcpGatewayStatus();
  const currentEvents = events.filter(event => event.pluginGeneration === gateway.pluginGeneration || event.pluginGeneration === gateway.generation);
  return {
    ok: true,
    reader: { protocol: DIFF_READ_PROTOCOL, pluginBuild: DIFF_READ_BUILD, generation: readerGeneration },
    currentEvents,
    historicalEventCount: events.length - currentEvents.length,
    pluginGeneration: readerGeneration,
    gateway,
    rpcMetrics: metrics.snapshot(),
    clientEvents: clientDiagnosticsSnapshot().slice(-(input.limit || 200)),
    events,
  };
}

function undefinedPath(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "workspace-workbench", "diagnostics");
}
