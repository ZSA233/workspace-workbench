import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { HostConnection } from "./server/host-connection";
import { RpcMetrics } from "./server/rpc-metrics";
import { sessionOperation, coordinatorReview } from "./shared/session-tools";
import { handleSessionOperation } from "./server/session-tools";
import { handoffMaterials } from "./shared/handoff-materials";
import { handleHandoffMaterials } from "./server/handoff-access";

import { handleAgentDelegate, handleAgentStatus, handleWorkspaceBinding, handleWorkspaceDelegate } from "./server/agent-provider";
import { closeObserverBridge, handleObserver, observerQuery } from "./server/observer";
import { agentDelegate, agentStatusQuery } from "./shared/agent";
import { workspaceBindingQuery, workspaceDelegate, workspaceHandoffPreview } from "./shared/handoff";
import { observerSettings } from "./shared/settings";
import { projectsQuery } from "./shared/projects";
import { projectBackendStart, projectBackendStatus, projectRuntimeSettingsGet, projectRuntimeSettingsUpdate, projectSetupSave, projectSetupScan, projectStorageQuery } from "./shared/setup";
import { registeredProjects, withProject } from "./server/projects";
import { closeBackends } from "./server/backend-manager";
import { handleClientDiagnostic } from "./server/client-diagnostics";
import { handleProjectBackendStart, handleProjectBackendStatus, handleProjectRuntimeSettingsGet, handleProjectRuntimeSettingsUpdate, handleProjectSetupSave, handleProjectSetupScan, handleProjectStorage } from "./server/setup";
import { registerAgentIntegration } from "./server/agent-integration";
import { orchestrate } from "./server/orchestrator";
import { clientDiagnostic } from "./shared/client-diagnostics";
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
  handleCoordinatorReview,
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
  const host = new HostConnection();
  const metrics = new RpcMetrics();
  const measured: PluginServerContext = {
    ...server,
    handle: (contract, handler) => server.handle(contract, (input, context) => {
      const submethod = contract.name === "workspace.workbench.query" && typeof (input as { method?: unknown }).method === "string"
        ? `:${(input as { method: string }).method}` : "";
      return metrics.track(contract.name + submethod, () => handler(input, context));
    }),
  };
  const readOnlyHostMethods = new Set([
    "workspace.workbench.agent_context", "workspace.workbench.agent.status",
    "workspace.workbench.binding", "workspace.workbench.agent-review.models",
    "workspace.workbench.agent-review.preview", "workspace.workbench.agent-review.session",
    "workspace.workbench.agent-review.sessions", "workspace.workbench.agent-review.events",
    "workspace.workbench.handoff-materials", "workspace.workbench.agent-review.reviewer-read",
  ]);
  const withHost: PluginServerContext = {
    ...measured,
    handle: (contract, handler) => measured.handle(contract, (input, context) => host.run(
      paseo => handler(input, { ...context, paseo }),
      readOnlyHostMethods.has(contract.name)
        || contract.name === "workspace.workbench.orchestrate" && (input as { action?: string }).action === "status"
        || contract.name === "workspace.workbench.session" && ["status", "history", "wait"].includes(String((input as { action?: string }).action))
        || contract.name === "workspace.workbench.coordinator-review" && (input as { action?: string }).action === "read"
        || contract.name === "workspace.workbench.lifecycle" && (input as { action?: string }).action === "inspect",
    )),
    on: (name, handler) => measured.on(name, async (event, context) => {
      // Persist lifecycle facts even if the host connection is temporarily down.
      const paseo = await host.api().catch(() => context.paseo);
      return handler(event, { ...context, paseo });
    }),
  };
  measured.registerSettings(observerSettings);
  withHost.handle(workspaceHandoffPreview, (input, context) => withProject(input, () => orchestrate("preview", { requestId: digest(input.handoff), workspaceId: input.workspaceId, baseRefs: {}, handoff: input.handoff }, input.parentAgentId, context)));
  withHost.handle(handoffMaterials, (input, context) => withProject(input, () => handleHandoffMaterials(input, context)));
  withHost.handle(sessionOperation, (input, context) => withProject(input, () => handleSessionOperation(input, context)));
  withHost.handle(coordinatorReview, (input, context) => withProject(input, () => handleCoordinatorReview(input, context)));
  // Backends are started on demand by the active project request.  Warming all
  // registered projects here amplified cold-start Git work and made an idle
  // panel look unavailable while unrelated projects were still starting.
  withHost.handle(reviewSessionQuery, (input, context) => withProject(input, () => handleReviewSessionQuery(input, context)));
  measured.handle(reviewSessionList, (input) => withProject(input, () => handleReviewSessionList(input)));
  measured.handle(reviewSessionEvents, (input) => withProject(input, () => handleReviewSessionEvents(input)));
  measured.handle(reviewSettingsGet, (input) => withProject(input, () => handleReviewSettingsGet(input)));
  measured.handle(reviewSettingsUpdate, (input) => withProject(input, () => handleReviewSettingsUpdate(input)));
  measured.handle(agentSessionSettingsGet, (input) => withProject(input, () => handleAgentSessionSettingsGet()));
  measured.handle(agentSessionSettingsUpdate, (input) => withProject(input, () => handleAgentSessionSettingsUpdate(input)));
  withHost.handle(agentSessionProviders, (input, context) => withProject(input, () => handleAgentSessionProviders(context)));
  withHost.handle(artifactRegister, (input, context) => withProject(input, () => registerArtifact(input, context)));
  measured.handle(artifactList, (input) => withProject(input, () => listArtifacts()));
  withHost.handle(reviewModels, (input, context) => withProject(input, () => handleReviewModels(input, context)));
  withHost.handle(reviewPreview, (input, context) => withProject(input, () => handleReviewPreview(input, context)));
  withHost.handle(reviewSessionStart, (input, context) => withProject(input, () => handleReviewSessionStart(input, context)));
  withHost.handle(reviewSessionControl, (input, context) => withProject(input, () => handleReviewSessionControl(input, context)));
  withHost.handle(executionReport, (input, context) => withProject(input, () => handleExecutionReportRpc(input, context)));
  withHost.handle(reviewerRead, (input, context) => withProject(input, () => handleReviewerReadRpc(input, context)));
  withHost.handle(reviewerResult, (input, context) => withProject(input, () => handleReviewerResultRpc(input, context)));
  const cleanupAgents = registerAgentIntegration(withHost, () => host.api());
  const cleanupReviewLifecycle = registerReviewLifecycle(withHost);
  measured.handle(projectsQuery, async (input) => registeredProjects({ directory: input.directory }));
  measured.handle(projectSetupScan, handleProjectSetupScan);
  measured.handle(projectSetupSave, handleProjectSetupSave);
  measured.handle(projectStorageQuery, handleProjectStorage);
  measured.handle(clientDiagnostic, handleClientDiagnostic);
  measured.handle(projectRuntimeSettingsGet, (input) => withProject(input, () => handleProjectRuntimeSettingsGet(input)));
  measured.handle(projectRuntimeSettingsUpdate, (input) => withProject(input, () => handleProjectRuntimeSettingsUpdate(input)));
  measured.handle(projectBackendStart, async (input) => ({ ...await handleProjectBackendStart(input), hostTransport: host.status(), rpcMetrics: metrics.snapshot() }));
  measured.handle(projectBackendStatus, async (input) => ({ ...await handleProjectBackendStatus(input), hostTransport: host.status(), rpcMetrics: metrics.snapshot() }));
  if (process.env.WORKBENCH_TEST_HOST_DROP === "1") {
    const isolatedHostFault = defineRpc({ name: "workspace.workbench.test.host-fault",
      input: z.object({ action: z.enum(["drop", "probe", "gc"]) }),
      output: z.object({ ok: z.boolean(), state: z.string(), reconnects: z.number(), heapUsed: z.number().optional() }) });
    measured.handle(isolatedHostFault, async input => {
      if (input.action === "drop") await host.injectDisconnectForIsolatedTest();
      else if (input.action === "probe") await host.run(api => api.agents.list({ page: { limit: 1 } }), true);
      else {
        if (typeof global.gc !== "function") throw new Error("isolated_gc_unavailable");
        global.gc();
      }
      const status = host.status();
      return { ok: true, state: status.state, reconnects: status.reconnects,
        ...(input.action === "gc" ? { heapUsed: process.memoryUsage().heapUsed } : {}) };
    });
  }
  measured.handle(observerQuery, async (input, context) => {
    const response = await handleObserver(input, context);
    if (input.method !== "observer.versions" || !response.ok || !response.result || typeof response.result !== "object") return response;
    return { ...response, result: { ...response.result, hostTransport: host.status() } };
  });
  withHost.handle(agentStatusQuery, (input, context) => withProject(input, () => handleAgentStatus(input, context)));
  withHost.handle(agentDelegate, (input, context) => withProject(input, async () => {
    try { return agentDelegate.output.parse(await orchestrate("execute", { requestId: digest(input.handoff), workspaceId: input.workspaceId, baseRefs: {}, handoff: input.handoff }, input.parentAgentId, context)); }
    catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_blocked", message: (error as Error).message } }; }
  }));
  withHost.handle(workspaceBindingQuery, (input, context) => withProject(input, () => handleWorkspaceBinding(input, context)));
  withHost.handle(workspaceDelegate, (input, context) => withProject(input, async () => {
    try { return workspaceDelegate.output.parse(await orchestrate("execute", { requestId: digest(input.handoff), workspaceId: input.workspaceId, baseRefs: {}, handoff: input.handoff }, input.parentAgentId, context)); }
    catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_blocked", message: (error as Error).message } }; }
  }));
  withHost.handle(workspaceLifecycle, (input, context) => withProject(input, () => handleWorkspaceLifecycle(input, context)));
  return async () => { cleanupAgents(); cleanupReviewLifecycle(); closeObserverBridge(); await Promise.all([closeBackends(), host.close()]); };
}
