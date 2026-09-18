import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { observationTimingSchema } from "./observation-timing.ts";

const setupRepository = z.object({
  id: z.string(),
  name: z.string(),
  repoPath: z.string(),
  kind: z.enum(["root", "nested"]),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  dirty: z.boolean().nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  valid: z.boolean(),
  selectedByDefault: z.boolean(),
  issue: z.string().optional(),
});

export type SetupRepository = z.infer<typeof setupRepository>;

export const projectSetupScan = defineRpc({
  name: "workspace.workbench.setup.scan",
  input: z.object({ directory: z.string().trim().min(1) }),
  output: z.object({
    projectRoot: z.string(),
    displayName: z.string(),
    configPath: z.string(),
    configRelativePath: z.string(),
    gitAvailable: z.boolean(),
    gitRoot: z.string().nullable(),
    repositories: z.array(setupRepository),
    defaultRepositoryPaths: z.array(z.string()),
    configExists: z.boolean(),
    scan: z.object({ incomplete: z.boolean(), reason: z.enum(["directory_limit", "entry_limit", "time_limit"]).optional(), scannedDirectories: z.number().int().nonnegative() }).optional(),
  }),
});

export const projectSetupSave = defineRpc({
  name: "workspace.workbench.setup.save",
  input: z.object({
    directory: z.string().trim().min(1),
    repositories: z.array(z.string().trim().min(1)).min(1),
    shareConfig: z.boolean().default(false),
  }),
  output: z.object({
    project: z.object({
      configPath: z.string(),
      sourceRoot: z.string(),
      workspaceRoot: z.string(),
      displayName: z.string(),
    }),
    backend: z.object({
      state: z.enum(["ready", "starting", "recovering", "unavailable", "missing", "failed", "unsupported"]),
      message: z.string().optional(),
      socketPath: z.string().optional(),
      timing: observationTimingSchema.optional(),
      instanceId: z.string().optional(),
      lastSuccessfulAt: z.string().optional(),
      failureSince: z.string().optional(),
    }),
  }),
});

const storagePath = z.object({
  path: z.string(),
  relativePath: z.string().nullable(),
  location: z.enum(["project", "external", "user"]),
});

export const projectStorageQuery = defineRpc({
  name: "workspace.workbench.project.storage",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    projectRoot: z.string(),
    config: storagePath,
    workspaces: storagePath,
    worktrees: storagePath,
    records: storagePath,
    state: storagePath,
    socket: storagePath,
    ignoreMode: z.enum(["local", "shared", "ignored", "external", "unavailable"]),
  }),
});

export const projectBackendStart = defineRpc({
  name: "workspace.workbench.backend.start",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    state: z.enum(["ready", "starting", "recovering", "unavailable", "missing", "failed", "unsupported"]),
    message: z.string().optional(),
    socketPath: z.string().optional(),
    timing: observationTimingSchema.optional(),
    instanceId: z.string().optional(),
    lastSuccessfulAt: z.string().optional(),
    failureSince: z.string().optional(),
    hostTransport: z.object({ state: z.string(), active: z.number(), reconnects: z.number(), failures: z.number(), lastSuccessfulAt: z.string().nullable(), lastFailure: z.string().nullable() }).optional(),
    rpcMetrics: z.object({ windowStartedAt: z.string(), active: z.number(), peak: z.number(), methods: z.record(z.string(), z.object({ count: z.number(), failures: z.number(), maxMs: z.number() })), memory: z.object({ rss: z.number(), heapUsed: z.number(), external: z.number() }) }).optional(),
  }),
});

export const projectBackendStatus = defineRpc({
  name: "workspace.workbench.backend.status",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    state: z.enum(["ready", "starting", "recovering", "unavailable", "missing", "failed", "unsupported"]),
    message: z.string().optional(),
    socketPath: z.string().optional(),
    timing: observationTimingSchema.optional(),
    instanceId: z.string().optional(),
    lastSuccessfulAt: z.string().optional(),
    failureSince: z.string().optional(),
    hostTransport: z.object({ state: z.string(), active: z.number(), reconnects: z.number(), failures: z.number(), lastSuccessfulAt: z.string().nullable(), lastFailure: z.string().nullable() }).optional(),
    rpcMetrics: z.object({ windowStartedAt: z.string(), active: z.number(), peak: z.number(), methods: z.record(z.string(), z.object({ count: z.number(), failures: z.number(), maxMs: z.number() })), memory: z.object({ rss: z.number(), heapUsed: z.number(), external: z.number() }) }).optional(),
  }),
});

const runtimeMode = z.enum(["auto", "system", "mise"]);
const runtimeManager = z.enum(["mise", "system"]);
const runtimeRequirements = z.record(
  z.string().trim().min(1),
  z.record(z.string().trim().min(1), z.string().trim().min(1)),
);

const projectRuntimeSettingsOutput = z.object({
  ok: z.boolean(),
  configured: z.boolean(),
  mode: runtimeMode,
  manager: runtimeManager,
  managerPath: z.string().nullable(),
  runtimePaths: z.array(z.string()),
  requirements: runtimeRequirements,
  cache: z.object({ enabled: z.boolean(), root: z.string().nullable() }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const projectRuntimeSettingsGet = defineRpc({
  name: "workspace.workbench.project.runtime.settings.get",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: projectRuntimeSettingsOutput,
});

export const projectRuntimeSettingsUpdate = defineRpc({
  name: "workspace.workbench.project.runtime.settings.update",
  input: z.object({
    projectConfig: z.string().trim().min(1),
    mode: runtimeMode,
    managerPath: z.string().trim().min(1).nullable(),
    runtimePaths: z.array(z.string().trim().min(1)).max(32),
    requirements: runtimeRequirements,
    cacheEnabled: z.boolean(),
    cacheRoot: z.string().trim().min(1).nullable(),
  }),
  output: projectRuntimeSettingsOutput,
});

export type ProjectSetupScan = z.infer<typeof projectSetupScan.output>;
export type ProjectSetupSave = z.infer<typeof projectSetupSave.output>;
export type ProjectStorageInfo = z.infer<typeof projectStorageQuery.output>;
export type ProjectBackendStatus = z.infer<typeof projectBackendStatus.output>;
export type ProjectRuntimeSettings = z.infer<typeof projectRuntimeSettingsGet.output>;
export type ProjectRuntimeSettingsUpdateInput = z.infer<typeof projectRuntimeSettingsUpdate.input>;
