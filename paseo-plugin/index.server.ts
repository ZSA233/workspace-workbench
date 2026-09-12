import type { PluginServerContext } from "@getpaseo/plugin/server";

import { handleAgentDelegate, handleAgentStatus, handleWorkspaceBinding, handleWorkspaceDelegate } from "./server/agent-provider";
import { closeObserverBridge, handleObserver, observerQuery } from "./server/observer";
import { agentDelegate, agentStatusQuery } from "./shared/agent";
import { workspaceBindingQuery, workspaceDelegate } from "./shared/handoff";
import { observerSettings } from "./shared/settings";
import { projectsQuery } from "./shared/projects";
import { projectBackendStart, projectBackendStatus, projectSetupSave, projectSetupScan, projectStorageQuery } from "./shared/setup";
import { registeredProjects, withProject } from "./server/projects";
import { closeBackends } from "./server/backend-manager";
import { handleProjectBackendStart, handleProjectBackendStatus, handleProjectSetupSave, handleProjectSetupScan, handleProjectStorage } from "./server/setup";
import { registerAgentIntegration } from "./server/agent-integration";
import { orchestrate } from "./server/orchestrator";
import { digest } from "./server/orchestration-state";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(observerSettings);
  const cleanupAgents = registerAgentIntegration(server);
  server.handle(projectsQuery, async (input) => registeredProjects({ directory: input.directory }));
  server.handle(projectSetupScan, handleProjectSetupScan);
  server.handle(projectSetupSave, handleProjectSetupSave);
  server.handle(projectStorageQuery, handleProjectStorage);
  server.handle(projectBackendStart, handleProjectBackendStart);
  server.handle(projectBackendStatus, handleProjectBackendStatus);
  server.handle(observerQuery, handleObserver);
  server.handle(agentStatusQuery, (input, context) => withProject(input, () => handleAgentStatus(input, context)));
  server.handle(agentDelegate, (input, context) => withProject(input, async () => {
    try { return agentDelegate.output.parse(await orchestrate("execute", { requestId: digest(input.handoff), workspaceId: input.workspaceId, baseRefs: {}, handoff: input.handoff }, input.parentAgentId, context)); }
    catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_blocked", message: (error as Error).message } }; }
  }));
  server.handle(workspaceBindingQuery, (input, context) => withProject(input, () => handleWorkspaceBinding(input, context)));
  server.handle(workspaceDelegate, (input, context) => withProject(input, async () => {
    try { return workspaceDelegate.output.parse(await orchestrate("execute", { requestId: digest(input.handoff), workspaceId: input.workspaceId, baseRefs: {}, handoff: input.handoff }, input.parentAgentId, context)); }
    catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_blocked", message: (error as Error).message } }; }
  }));
  return () => { cleanupAgents(); closeObserverBridge(); closeBackends(); };
}
