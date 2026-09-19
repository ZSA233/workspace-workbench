import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const diagnosticsQuery = defineRpc({
  name: "workspace.workbench.diagnostics",
  input: z.object({ projectConfig: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }),
  output: z.object({ ok: z.boolean() }).passthrough(),
});

export const mcpStatusQuery = defineRpc({
  name: "workspace.workbench.mcp.status",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }).passthrough(),
});
