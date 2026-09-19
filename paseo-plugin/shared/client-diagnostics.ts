import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const diagnosticValue = z.string().max(4000);

export const clientDiagnostic = defineRpc({
  name: "workspace.workbench.client-diagnostic",
  input: z.object({
    phase: z.string().min(1).max(120),
    platform: z.string().min(1).max(32),
    details: z.record(z.string().max(120), diagnosticValue).default({}),
  }),
  output: z.object({ ok: z.boolean(), retained: z.number().int().nonnegative() }),
});
