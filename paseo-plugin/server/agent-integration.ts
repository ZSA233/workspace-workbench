import { sessionChanged } from "./session-observation.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registeredProjects, resolveProject, withProject } from "./projects.ts";
import { readState, writeState, digest } from "./orchestration-state.ts";
import { agentContextQuery } from "../shared/handoff.ts";
import { orchestrationRpc } from "../shared/orchestration.ts";
import { orchestrate } from "./orchestrator.ts";
import { allAgentBindings, getAgentBinding, putAgentBinding, type AgentBinding } from "./agent-store.ts";

type AgentIdentity = { agentId: string; cwd: string; revoked?: boolean };
function bridgeConfig(configPath: string) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const bridge = config.agent?.bridge;
  if (config.agent?.provider !== "paseo" || !bridge?.script || !bridge?.endpoint) return null;
  const record = bridge.endpoint === "auto" ? JSON.parse(readFileSync(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "paseo.pid"), "utf8")) : null;
  const target = String(record ? record.listen || record.sockPath || "" : bridge.endpoint).replace(/^unix:\/\//, "");
  const endpoint = target.startsWith("/") ? `ws+unix://${target}:/ws` : /^(127\.0\.0\.1|localhost):\d+$/.test(target) ? `ws://${target}/ws` : "";
  if (!endpoint) throw new Error("paseo_local_endpoint_required");
  return { script: resolve(dirname(configPath), bridge.script), endpoint };
}

export function registerAgentIntegration(server: PluginServerContext): () => void {
  let api: import("@getpaseo/client").PaseoApi | null = null;
  const cleanups = [server.before("agent.create", ({ request }) => {
    if (request.env?.WORKBENCH_WORKER_WORKSPACE || request.env?.WORKBENCH_REVIEW_ONLY) return request;
    let project;
    try { project = resolveProject({ directory: request.config.cwd }); } catch { return request; }
    const bridge = bridgeConfig(project.configPath);
    if (!bridge) return request;
    const token = randomUUID();
    const environment = { WORKBENCH_AGENT_TOKEN: token, WORKBENCH_PROJECT_CONFIG: project.configPath, WORKBENCH_PASEO_ENDPOINT: bridge.endpoint };
    withProject({ projectConfig: project.configPath }, () => writeState(`context:${token}`, { agentId: "", cwd: request.config.cwd }));
    // Paseo also copies systemPrompt into mode overrides; keep tool guidance in MCP.
    return { ...request, env: { ...request.env, ...environment }, config: { ...request.config,
      mcpServers: { ...request.config.mcpServers, "workspace-workbench": { type: "stdio" as const, command: process.execPath, args: [bridge.script], env: environment, alwaysLoad: true } },
    } };
  }), server.before("agent.session_open", ({ request }) => {
    if (request.env.WORKBENCH_WORKER_WORKSPACE || request.env.WORKBENCH_REVIEW_ONLY) return request;
    if (request.purpose !== "interactive") return request;
    let project;
    try { project = resolveProject({ directory: request.cwd }); } catch { return request; }
    const bridge = bridgeConfig(project.configPath);
    if (!bridge) return request;
    return withProject({ projectConfig: project.configPath }, () => {
      const token = request.env.WORKBENCH_AGENT_TOKEN;
      // Bind the exact create-time token, never match concurrent creations by cwd.
      if (!token) return request;
      const pending = readState<AgentIdentity>(`context:${token}`);
      if (!pending || pending.revoked || pending.cwd !== request.cwd || pending.agentId && pending.agentId !== request.agentId) throw new Error("agent_context_changed");
      const prior = readState<{ token: string }>(`session:${request.agentId}`);
      if (prior && prior.token !== token) writeState(`context:${prior.token}`, { agentId: request.agentId, cwd: request.cwd, revoked: true });
      writeState(`context:${token}`, { agentId: request.agentId, cwd: request.cwd });
      writeState(`session:${request.agentId}`, { token });
      return { ...request, env: { ...request.env, WORKBENCH_AGENT_ID: request.agentId, WORKBENCH_AGENT_TOKEN: token, WORKBENCH_PROJECT_CONFIG: project.configPath, WORKBENCH_PASEO_ENDPOINT: bridge.endpoint } };
    });
  })];
  server.handle(orchestrationRpc, (input, context) => withProject(input, async () => {
    api = context.paseo;
    const identity = readState<AgentIdentity>(`context:${input.token}`);
    if (!identity || identity.revoked) throw new Error("agent_context_invalid");
    const parent = (await context.paseo.agents.ref(identity.agentId).refresh())?.agent;
    if (!parent || parent.archivedAt || parent.cwd !== identity.cwd) throw new Error("agent_context_changed");
    return orchestrate(input.action, input.request, identity.agentId, context);
  }));
  server.handle(agentContextQuery, (input) => withProject(input, () => {
    const session = readState<{ token: string }>(`session:${input.agentId}`);
    if (!session) return { ok: true, available: false as const, reason: "not_injected" as const };
    const identity = readState<AgentIdentity>(`context:${session.token}`);
    if (!identity) return { ok: true, available: false as const, reason: "mismatched" as const };
    if (identity.revoked) return { ok: true, available: false as const, reason: "revoked" as const };
    if (identity.agentId !== input.agentId) return { ok: true, available: false as const, reason: "mismatched" as const };
    return { ok: true, available: true as const, reason: "ready" as const };
  }));
  // Persist state before notification, and acknowledge only after send succeeds.
  const notificationFlights = new Set<string>();
  async function flush(saved: AgentBinding, context: { paseo: import("@getpaseo/client").PaseoApi }) {
    if (saved.relationship !== "child" || !saved.parentAgentId) return;
    if (notificationFlights.has(saved.agentId)) return;
    notificationFlights.add(saved.agentId);
    try {
      for (const notification of saved.pendingNotifications || []) {
        // Paseo's default send interrupts the current turn. The transport
        // supports steer, although the facade's options type is narrower.
        const options = { messageId: notification.key, activeTurnBehavior: "steer" as const };
        await context.paseo.agents.ref(saved.parentAgentId).send(notification.message, options);
        const latest = getAgentBinding(saved.workspaceId);
        if (latest?.agentId === saved.agentId) putAgentBinding({ ...latest, lastNotificationKey: notification.key, pendingNotifications: latest.pendingNotifications?.filter((item) => item.key !== notification.key) });
      }
    } finally { notificationFlights.delete(saved.agentId); }
  }
  async function notify(agentId: string, status: string, eventId: string, context: { paseo: import("@getpaseo/client").PaseoApi }) {
    api = context.paseo;
    for (const project of registeredProjects()) await withProject({ projectConfig: project.configPath }, async () => {
      const saved = allAgentBindings().find((binding) => binding.agentId === agentId);
      if (!saved) return;
      sessionChanged();
      if (saved.relationship !== "child" || !saved.parentAgentId) {
        putAgentBinding({ ...saved, status, updatedAt: new Date().toISOString(), pendingNotifications: [] });
        return;
      }
      const key = digest({ agentId, eventId, status });
      if (saved.lastNotificationKey === key) return;
      const pending = saved.pendingNotifications || [];
      const next = { ...saved, status, updatedAt: new Date().toISOString(), pendingNotifications: pending.some((item) => item.key === key) ? pending : [...pending, { key, message: `[Workspace Workbench] ${saved.workspaceId}: ${status}. Agent ${agentId}. A turn ending does not certify acceptance.` }] };
      putAgentBinding(next);
      await flush(next, context);
    });
  }
  cleanups.push(server.on("agent.turn_started", (event, context) => notify(event.agent.id, "running", event.turnId || "started", context)));
  cleanups.push(server.on("agent.turn_ended", (event, context) => notify(event.agent.id, event.outcome.kind === "completed" ? "turn-ended" : event.outcome.kind, event.turnId || "ended", context)));
  cleanups.push(server.on("agent.permission_requested", (event, context) => notify(event.agent.id, "permission", digest(event.request), context)));
  cleanups.push(server.on("agent.permission_resolved", (event, context) => notify(event.agent.id, "running", event.requestId, context)));
  // Any next lifecycle event retries pending notifications from the same worker.
  cleanups.push(server.on("agent.archived", async (event, context) => {
    for (const project of registeredProjects()) withProject({ projectConfig: project.configPath }, () => {
      const session = readState<{ token: string }>(`session:${event.agent.id}`);
      if (session) writeState(`context:${session.token}`, { agentId: event.agent.id, cwd: event.agent.cwd, revoked: true });
    });
    await notify(event.agent.id, "archived", event.archivedAt, context);
  }));
  let retrying = false;
  const retryTimer = setInterval(() => {
    if (!api || retrying) return;
    retrying = true;
    const paseo = api;
    void (async () => {
      for (const project of registeredProjects()) {
        try { await withProject({ projectConfig: project.configPath }, async () => {
          for (const binding of allAgentBindings()) if (binding.pendingNotifications?.length) await flush(binding, { paseo });
        }); } catch { console.warn("workbench_notification_retry_pending"); }
      }
    })().finally(() => { retrying = false; });
  }, 20_000);
  retryTimer.unref();
  return () => { clearInterval(retryTimer); cleanups.forEach((cleanup) => cleanup()); };
}
