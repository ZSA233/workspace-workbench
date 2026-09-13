import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Handoff } from "../shared/handoff.ts";
import type { AgentRelationship } from "../shared/agent-session.ts";
import { currentProject } from "./projects.ts";

export type AgentBinding = {
  workspaceId: string;
  agentId: string;
  relationship: AgentRelationship;
  parentAgentId?: string;
  requestedByAgentId?: string;
  paseoWorkspaceId: string;
  cwd: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  handoff?: Handoff;
  handoffHash?: string;
  delivery?: "pending" | "sent";
  status?: string;
  lastNotificationKey?: string;
  pendingNotifications?: Array<{ key: string; message: string }>;
};

type AgentBindingFile = {
  schemaVersion: "workspace.workbench.agent-bindings/v2";
  bindings: AgentBinding[];
};

const legacySchemaVersion = "workspace.workbench.agent-bindings/v1" as const;
const schemaVersion = "workspace.workbench.agent-bindings/v2" as const;

function filePath(): string {
  const project = currentProject();
  if (project) return join(project.stateRoot, "agent-bindings.json");
  return resolve(
    process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS
      || join(homedir(), ".config", "workspace-workbench", "agent-bindings.json"),
  );
}

function empty(): AgentBindingFile {
  return { schemaVersion, bindings: [] };
}

function normalizeBinding(item: Partial<AgentBinding> & { parentAgentId?: unknown }): AgentBinding | null {
  if (!item || typeof item.workspaceId !== "string" || typeof item.agentId !== "string"
    || typeof item.paseoWorkspaceId !== "string" || typeof item.cwd !== "string"
    || typeof item.provider !== "string" || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") return null;
  const relationship = item.relationship === "independent" || item.relationship === "child"
    ? item.relationship
    : "child";
  return {
    ...item,
    workspaceId: item.workspaceId,
    agentId: item.agentId,
    relationship,
    ...(typeof item.parentAgentId === "string" && item.parentAgentId ? { parentAgentId: item.parentAgentId } : {}),
    ...(typeof item.requestedByAgentId === "string" && item.requestedByAgentId ? { requestedByAgentId: item.requestedByAgentId } : {}),
    paseoWorkspaceId: item.paseoWorkspaceId,
    cwd: item.cwd,
    provider: item.provider,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function load(): AgentBindingFile {
  const path = filePath();
  if (!existsSync(path)) return empty();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentBindingFile>;
    if (value.schemaVersion !== schemaVersion && value.schemaVersion !== legacySchemaVersion) throw new Error("agent_bindings_invalid");
    if (!Array.isArray(value.bindings)) throw new Error("agent_bindings_invalid");
    const bindings = value.bindings.flatMap((item) => {
      const normalized = normalizeBinding(item as Partial<AgentBinding> & { parentAgentId?: unknown });
      return normalized ? [normalized] : [];
    });
    return {
      schemaVersion,
      bindings,
    };
  } catch {
    throw new Error("agent_bindings_unreadable");
  }
}

function save(value: AgentBindingFile): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function getAgentBinding(workspaceId: string): AgentBinding | null {
  return load().bindings.find((item) => item.workspaceId === workspaceId) || null;
}

export function allAgentBindings(): AgentBinding[] { return load().bindings; }

export function putAgentBinding(binding: AgentBinding): void {
  const value = load();
  value.bindings = value.bindings.filter((item) => item.workspaceId !== binding.workspaceId && item.agentId !== binding.agentId);
  value.bindings.push(binding);
  save(value);
}

export function removeAgentBinding(workspaceId: string): boolean {
  const path = filePath();
  if (!existsSync(path)) return false;
  const value = load();
  const previousLength = value.bindings.length;
  value.bindings = value.bindings.filter((item) => item.workspaceId !== workspaceId);
  if (value.bindings.length === previousLength) return false;
  save(value);
  return true;
}
