import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Handoff } from "../shared/handoff.ts";
import { currentProject } from "./projects.ts";

export type AgentBinding = {
  workspaceId: string;
  agentId: string;
  parentAgentId: string;
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
  schemaVersion: "workspace.workbench.agent-bindings/v1";
  bindings: AgentBinding[];
};

const schemaVersion = "workspace.workbench.agent-bindings/v1" as const;

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

function load(): AgentBindingFile {
  const path = filePath();
  if (!existsSync(path)) return empty();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentBindingFile>;
    if (value.schemaVersion !== schemaVersion || !Array.isArray(value.bindings)) throw new Error("agent_bindings_invalid");
    if (value.bindings.some((item) => !item || typeof item.workspaceId !== "string" || typeof item.agentId !== "string" || typeof item.parentAgentId !== "string" || typeof item.cwd !== "string")) throw new Error("agent_bindings_invalid");
    return {
      schemaVersion,
      bindings: value.bindings.filter((item): item is AgentBinding => Boolean(item)
        && typeof item.workspaceId === "string"
        && typeof item.agentId === "string"
        && typeof item.parentAgentId === "string"
        && typeof item.paseoWorkspaceId === "string"
        && typeof item.cwd === "string"
        && typeof item.provider === "string"
        && typeof item.createdAt === "string"
        && typeof item.updatedAt === "string"),
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
