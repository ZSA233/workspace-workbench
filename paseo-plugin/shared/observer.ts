import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const observerMethods = [
  "observer.health",
  "observer.versions",
  "observer.reload",
  "workspace.list",
  "workspace.detail",
  "workspace.identify",
  "workspace.runtime",
  "workspace.create",
  "workspace.addRepositories",
  "workspace.prepare",
  "workspace.cleanup",
  "workspace.remove",
  "workspace.restore",
  "workspace.delete",
  "repository.graph",
  "repository.changes",
  "repository.diff",
  "review-set.compare",
  "review-set.brief",
] as const;

export const observerMethod = z.enum(observerMethods);
export const observerResponse = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
});

export const observerQuery = defineRpc({
  name: "workspace.workbench.query",
  input: z.object({ method: observerMethod, params: z.record(z.string(), z.unknown()).default({}), projectConfig: z.string().optional(), directory: z.string().optional() }),
  output: observerResponse,
});

export type ObserverMethod = z.infer<typeof observerMethod>;
export type ObserverResponse = z.infer<typeof observerResponse>;
