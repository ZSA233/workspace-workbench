import type { WorkspaceSummary } from "../client/model.ts";

export type ProviderCapabilities = {
  observe: boolean;
  create: boolean;
  prepare: boolean;
  cleanup: boolean;
};

export type AgentSnapshot = {
  id: string;
  workspaceId: string | null;
  cwd: string | null;
  provider: string;
  model: string | null;
  status: string | null;
  parentAgentId: string | null;
};

export interface WorkspaceProvider {
  list(): Promise<WorkspaceSummary[]>;
  detail(workspaceId: string): Promise<unknown>;
  identify(directory: string): Promise<{ matched: boolean; workspaceId: string | null }>;
  create(request: { name: string }): Promise<unknown>;
  capabilities(): ProviderCapabilities;
}

export interface AgentProvider {
  status(workspaceId: string): Promise<AgentSnapshot | null>;
  createOrReuse(request: { workspaceId: string; parentAgentId: string; prompt: string }): Promise<AgentSnapshot>;
  open(agentId: string): Promise<void>;
}
