import type { PluginServerContext } from "@getpaseo/plugin/server";

import { handleAgentDelegate, handleAgentStatus, handleWorkspaceBinding, handleWorkspaceDelegate } from "./server/agent-provider";
import { closeObserverBridge, handleObserver, observerQuery } from "./server/observer";
import { agentDelegate, agentStatusQuery } from "./shared/agent";
import { workspaceBindingQuery, workspaceDelegate } from "./shared/handoff";
import { observerSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(observerSettings);
  server.handle(observerQuery, handleObserver);
  server.handle(agentStatusQuery, handleAgentStatus);
  server.handle(agentDelegate, handleAgentDelegate);
  server.handle(workspaceBindingQuery, handleWorkspaceBinding);
  server.handle(workspaceDelegate, handleWorkspaceDelegate);
  return () => closeObserverBridge();
}
