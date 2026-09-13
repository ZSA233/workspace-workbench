import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { currentProject } from "./projects.ts";
import {
  agentRelationshipSchema,
  agentSessionPatchSchema,
  agentSessionProviders,
  agentSessionSettingsGet,
  agentSessionSettingsSchema,
  agentSessionSettingsUpdate,
  type AgentRelationship,
  type AgentPermissionMode,
  type AgentSessionPatch,
  type AgentSessionSettings,
  type AgentSessionSettingsResponse,
} from "../shared/agent-session.ts";

const settingsVersion = 1;
const defaultSettingsPath = () => process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS?.trim()
  || join(homedir(), ".config", "workspace-workbench", "review-settings.json");

type StoredFile = {
  version?: number;
  agentSession?: {
    defaults?: unknown;
    projects?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

function readJson(path: string): StoredFile {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as StoredFile : {};
  } catch {
    return {};
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.agent-session.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function currentProjectConfig(): string {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  return project.configPath;
}

function readProjectRaw(): Record<string, unknown> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  try {
    const value = JSON.parse(readFileSync(project.configPath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`project_config_unavailable: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function readProjectPatch(): AgentSessionPatch {
  const raw = readProjectRaw();
  const agent = raw.agent && typeof raw.agent === "object" && !Array.isArray(raw.agent) ? raw.agent as Record<string, unknown> : {};
  const session = agent.session && typeof agent.session === "object" && !Array.isArray(agent.session) ? agent.session : {};
  const parsed = agentSessionPatchSchema.safeParse(session);
  return parsed.success ? parsed.data : {};
}

function readGlobalPatch(): AgentSessionPatch {
  const raw = readJson(defaultSettingsPath());
  const section = raw.agentSession && typeof raw.agentSession === "object" ? raw.agentSession : {};
  const defaults = section.defaults && typeof section.defaults === "object" ? section.defaults : {};
  const parsed = agentSessionPatchSchema.safeParse(defaults);
  return parsed.success ? parsed.data : {};
}

function readGlobalProjectPatch(configPath: string): AgentSessionPatch {
  const raw = readJson(defaultSettingsPath());
  const section = raw.agentSession && typeof raw.agentSession === "object" ? raw.agentSession : {};
  const projects = section.projects && typeof section.projects === "object" ? section.projects : {};
  const value = projects[configPath];
  const parsed = agentSessionPatchSchema.safeParse(value && typeof value === "object" ? value : {});
  return parsed.success ? parsed.data : {};
}

function mergeProviderRelationships(...patches: AgentSessionPatch[]): Record<string, AgentRelationship> {
  const result: Record<string, AgentRelationship> = {};
  for (const patch of patches) {
    for (const [provider, relationship] of Object.entries(patch.providerRelationships || {})) {
      const parsed = agentRelationshipSchema.safeParse(relationship);
      if (parsed.success) result[provider] = parsed.data;
    }
  }
  return result;
}

function effectiveSettings(project: AgentSessionPatch, global: AgentSessionPatch, globalProject: AgentSessionPatch): AgentSessionSettings {
  return agentSessionSettingsSchema.parse({
    defaultRelationship: project.defaultRelationship ?? globalProject.defaultRelationship ?? global.defaultRelationship ?? "independent",
    permissionMode: project.permissionMode ?? globalProject.permissionMode ?? global.permissionMode ?? "inherit",
    providerRelationships: mergeProviderRelationships(global, globalProject, project),
  });
}

export function providerKey(provider: string | null | undefined): string {
  return String(provider || "").trim().split("/", 1)[0] || "unknown";
}

export function resolveAgentRelationship(provider: string | null | undefined, override?: AgentRelationship): AgentRelationship {
  if (override) return override;
  try {
    const project = readProjectPatch();
    const global = readGlobalPatch();
    const globalProject = readGlobalProjectPatch(currentProjectConfig());
    const effective = effectiveSettings(project, global, globalProject);
    return effective.providerRelationships[providerKey(provider)] || effective.defaultRelationship;
  } catch {
    return "independent";
  }
}

function settingsResponse(): AgentSessionSettingsResponse {
  const project = readProjectPatch();
  const global = { ...readGlobalPatch(), ...readGlobalProjectPatch(currentProjectConfig()) };
  const effective = effectiveSettings(project, global, {});
  const providerRelationships: Record<string, "project" | "global" | "default"> = {};
  for (const provider of new Set([...Object.keys(global.providerRelationships || {}), ...Object.keys(project.providerRelationships || {})])) {
    providerRelationships[provider] = project.providerRelationships?.[provider] ? "project" : "global";
  }
  return {
    ok: true,
    effective,
    project,
    global,
    sources: {
      defaultRelationship: project.defaultRelationship ? "project" : global.defaultRelationship ? "global" : "default",
      permissionMode: project.permissionMode ? "project" : global.permissionMode ? "global" : "default",
      providerRelationships,
    },
  };
}

function writeProjectPatch(patch: AgentSessionPatch, resetFields: string[]): void {
  const raw = readProjectRaw();
  const agent = raw.agent && typeof raw.agent === "object" && !Array.isArray(raw.agent) ? raw.agent as Record<string, unknown> : {};
  const previous = agent.session && typeof agent.session === "object" && !Array.isArray(agent.session) ? agent.session as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...previous, ...patch };
  for (const field of resetFields) delete next[field];
  if (Object.keys(next).length) agent.session = next;
  else delete agent.session;
  raw.agent = agent;
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  atomicJson(project.configPath, raw);
}

function writeGlobalPatch(patch: AgentSessionPatch, resetFields: string[]): void {
  const path = defaultSettingsPath();
  const raw = readJson(path);
  const current = raw.agentSession && typeof raw.agentSession === "object" ? raw.agentSession : {};
  const defaults = current.defaults && typeof current.defaults === "object" ? current.defaults as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...defaults, ...patch };
  for (const field of resetFields) delete next[field];
  const projects = current.projects && typeof current.projects === "object" ? current.projects : {};
  if (Object.keys(next).length) raw.agentSession = { ...current, defaults: next, projects };
  else raw.agentSession = { ...current, projects };
  raw.version = typeof raw.version === "number" ? raw.version : settingsVersion;
  atomicJson(path, raw);
}

export async function handleAgentSessionSettingsGet(): Promise<AgentSessionSettingsResponse> {
  try { return settingsResponse(); }
  catch (error) { return { ok: false, ...settingsResponseFallback(), error: { code: "agent_session_settings_unavailable", message: error instanceof Error ? error.message : "会话设置不可用" } }; }
}

function settingsResponseFallback(): Omit<AgentSessionSettingsResponse, "ok" | "error"> {
  return {
    effective: { defaultRelationship: "independent", permissionMode: "inherit", providerRelationships: {} },
    project: {},
    global: {},
    sources: { defaultRelationship: "default", permissionMode: "default", providerRelationships: {} },
  };
}

/** Resolve the permission preset for a newly created execution Agent. */
export function resolveAgentPermissionMode(): AgentPermissionMode {
  try {
    const project = readProjectPatch();
    const global = readGlobalPatch();
    const globalProject = readGlobalProjectPatch(currentProjectConfig());
    return effectiveSettings(project, global, globalProject).permissionMode;
  } catch {
    return "inherit";
  }
}

export async function handleAgentSessionSettingsUpdate(input: { scope: "project" | "global"; patch: AgentSessionPatch; resetFields: string[] }): Promise<AgentSessionSettingsResponse> {
  try {
    const patch = agentSessionPatchSchema.parse(input.patch);
    if (input.scope === "project") writeProjectPatch(patch, input.resetFields);
    else writeGlobalPatch(patch, input.resetFields);
    return settingsResponse();
  } catch (error) {
    return { ok: false, ...settingsResponseFallback(), error: { code: "agent_session_settings_update_failed", message: error instanceof Error ? error.message : "会话设置保存失败" } };
  }
}

export async function handleAgentSessionProviders(context: { paseo: PaseoApi }): Promise<ReturnType<typeof agentSessionProviders.output.parse>> {
  try {
    const result = await context.paseo.providers.listAvailable();
    return { ok: true, providers: result.providers || [] };
  } catch (error) {
    return { ok: false, providers: [], error: { code: "agent_session_providers_unavailable", message: error instanceof Error ? error.message : "Provider 列表不可用" } };
  }
}
