import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
      state: z.enum(["ready", "starting", "missing", "failed", "unsupported"]),
      message: z.string().optional(),
      socketPath: z.string().optional(),
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
    state: z.enum(["ready", "starting", "missing", "failed", "unsupported"]),
    message: z.string().optional(),
    socketPath: z.string().optional(),
  }),
});

export const projectBackendStatus = defineRpc({
  name: "workspace.workbench.backend.status",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    state: z.enum(["ready", "starting", "missing", "failed", "unsupported"]),
    message: z.string().optional(),
    socketPath: z.string().optional(),
  }),
});

export type ProjectSetupScan = z.infer<typeof projectSetupScan.output>;
export type ProjectSetupSave = z.infer<typeof projectSetupSave.output>;
export type ProjectStorageInfo = z.infer<typeof projectStorageQuery.output>;
export type ProjectBackendStatus = z.infer<typeof projectBackendStatus.output>;
