import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentRelationshipSchema = z.enum(["independent", "child"]);
export type AgentRelationship = z.infer<typeof agentRelationshipSchema>;

/** Permission preset used when creating a new execution Agent. */
export const agentPermissionModeSchema = z.enum(["inherit", "auto", "auto-review", "full-access"]);
export type AgentPermissionMode = z.infer<typeof agentPermissionModeSchema>;

const providerRelationshipsSchema = z.record(z.string().trim().min(1), agentRelationshipSchema);

export const agentSessionPatchSchema = z.object({
  defaultRelationship: agentRelationshipSchema.optional(),
  permissionMode: agentPermissionModeSchema.optional(),
  providerRelationships: providerRelationshipsSchema.optional(),
});
export type AgentSessionPatch = z.infer<typeof agentSessionPatchSchema>;

export const agentSessionSettingsSchema = z.object({
  defaultRelationship: agentRelationshipSchema.default("independent"),
  permissionMode: agentPermissionModeSchema.default("inherit"),
  providerRelationships: providerRelationshipsSchema.default({}),
});
export type AgentSessionSettings = z.infer<typeof agentSessionSettingsSchema>;

const sourceSchema = z.enum(["project", "global", "default"]);

export const agentSessionSettingsGet = defineRpc({
  name: "workspace.workbench.agent-session.settings.get",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    effective: agentSessionSettingsSchema,
    project: agentSessionPatchSchema,
    global: agentSessionPatchSchema,
    sources: z.object({
      defaultRelationship: sourceSchema,
      permissionMode: sourceSchema,
      providerRelationships: z.record(z.string(), sourceSchema),
    }),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export const agentSessionSettingsUpdate = defineRpc({
  name: "workspace.workbench.agent-session.settings.update",
  input: z.object({
    projectConfig: z.string().trim().min(1),
    scope: z.enum(["project", "global"]),
    patch: agentSessionPatchSchema,
    resetFields: z.array(z.enum(["defaultRelationship", "permissionMode", "providerRelationships"])).default([]),
  }),
  output: agentSessionSettingsGet.output,
});

export const agentSessionProviders = defineRpc({
  name: "workspace.workbench.agent-session.providers",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    providers: z.array(z.object({ provider: z.string(), available: z.boolean(), error: z.string().nullable().optional() })),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export type AgentSessionSettingsResponse = z.infer<typeof agentSessionSettingsGet.output>;
export type AgentSessionSettingsUpdateInput = z.infer<typeof agentSessionSettingsUpdate.input>;
