import type { PluginServerContext } from "@getpaseo/plugin/server";

import { handleAgentDelegate, handleAgentStatus, handleWorkspaceBinding, handleWorkspaceDelegate } from "./server/agent-provider";
import { closeObserverBridge, handleObserver, observerQuery } from "./server/observer";
import { agentDelegate, agentStatusQuery } from "./shared/agent";
import { workspaceBindingQuery, workspaceDelegate } from "./shared/handoff";
import { observerSettings } from "./shared/settings";
import { projectsQuery } from "./shared/projects";
import { projectBackendStart, projectBackendStatus, projectRuntimeSettingsGet, projectRuntimeSettingsUpdate, projectSetupSave, projectSetupScan, projectStorageQuery } from "./shared/setup";
import { registeredProjects, withProject } from "./server/projects";
import { closeBackends } from "./server/backend-manager";
import { handleProjectBackendStart, handleProjectBackendStatus, handleProjectRuntimeSettingsGet, handleProjectRuntimeSettingsUpdate, handleProjectSetupSave, handleProjectSetupScan, handleProjectStorage } from "./server/setup";
import { registerAgentIntegration } from "./server/agent-integration";
import { orchestrate } from "./server/orchestrator";
import { digest } from "./server/orchestration-state";
import { agentSessionProviders, agentSessionSettingsGet, agentSessionSettingsUpdate } from "./shared/agent-session";
import { handleAgentSessionProviders, handleAgentSessionSettingsGet, handleAgentSessionSettingsUpdate } from "./server/agent-session";
import { artifactList, artifactRegister } from "./shared/artifacts";
import { listArtifacts, registerArtifact } from "./server/artifacts";
import { handleWorkspaceLifecycle } from "./server/workspace-lifecycle";
import { workspaceLifecycle } from "./shared/workspace-lifecycle";
import {
  executionReport,
  reviewModels,
  reviewerRead,
  reviewerResult,
  reviewSessionControl,
  reviewSessionEvents,
  reviewSessionList,
  reviewSessionQuery,
  reviewSessionStart,
  reviewPreview,
  reviewSettingsGet,
  reviewSettingsUpdate,
} from "./shared/agent-review";
import {
  handleExecutionReportRpc,
  handleReviewModels,
  handleReviewPreview,
  handleReviewSessionControl,
  handleReviewSessionEvents,
  handleReviewSessionList,
  handleReviewSessionQuery,
  handleReviewSessionStart,
  handleReviewSettingsGet,
  handleReviewSettingsUpdate,
  handleReviewerReadRpc,
  handleReviewerResultRpc,
  registerReviewLifecycle,
} from "./server/agent-review";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(observerSettings);
  server.handle(reviewSessionQuery, (input, context) => withProject(input, () => handleReviewSessionQuery(input, context)));
  server.handle(reviewSessionList, (input) => withProject(input, () => handleReviewSessionList(input)));
  server.handle(reviewSessionEvents, (input) => withProject(input, () => handleReviewSessionEvents(input)));
  server.handle(reviewSettingsGet, (input) => withProject(input, () => handleReviewSettingsGet(input)));
  server.handle(reviewSettingsUpdate, (input) => withProject(input, () => handleReviewSettingsUpdate(input)));
  server.handle(agentSessionSettingsGet, (input) => withProject(input, () => handleAgentSessionSettingsGet()));
  server.handle(agentSessionSettingsUpdate, (input) => withProject(input, () => handleAgentSessionSettingsUpdate(input)));
  server.handle(agentSessionProviders, (input, context) => withProject(input, () => handleAgentSessionProviders(context)));
  server.handle(artifactRegister, (input, context) => withProject(input, () => registerArtifact(input, context)));
  server.handle(artifactList, (input) => withProject(input, () => listArtifacts()));
  server.handle(reviewModels, (input, context) => withProject(input, () => handleReviewModels(input, context)));
  server.handle(reviewPreview, (input, context) => withProject(input, () => handleReviewPreview(input, context)));
  server.handle(reviewSessionStart, (input, context) => withProject(input, () => handleReviewSessionStart(input, context)));
  server.handle(reviewSessionControl, (input, context) => withProject(input, () => handleReviewSessionControl(input, context)));
  server.handle(executionReport, (input, context) => withProject(input, () => handleExecutionReportRpc(input, context)));
  server.handle(reviewerRead, (input, context) => withProject(input, () => handleReviewerReadRpc(input, context)));
  server.handle(reviewerResult, (input, context) => withProject(input, () => handleReviewerResultRpc(input, context)));
  const cleanupAgents = registerAgentIntegration(server);
  const cleanupReviewLifecycle = registerReviewLifecycle(server);
  server.handle(projectsQuery, async (input) => registeredProjects({ directory: input.directory }));
  server.handle(projectSetupScan, handleProjectSetupScan);
  server.handle(projectSetupSave, handleProjectSetupSave);
  server.handle(projectStorageQuery, handleProjectStorage);
  server.handle(projectRuntimeSettingsGet, (input) => withProject(input, () => handleProjectRuntimeSettingsGet(input)));
  server.handle(projectRuntimeSettingsUpdate, (input) => withProject(input, () => handleProjectRuntimeSettingsUpdate(input)));
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
  server.handle(workspaceLifecycle, (input, context) => withProject(input, () => handleWorkspaceLifecycle(input, context)));
  return () => { cleanupAgents(); cleanupReviewLifecycle(); closeObserverBridge(); closeBackends(); };
}
