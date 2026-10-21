import type { PluginClientContext, PluginSurfaceProps, PluginButtonRegistration, PluginButtonContentProps } from "@getpaseo/plugin/client";
import { resolveWorkbenchLocale } from "../shared/copy";
import { recoveryStatusLabel } from "../shared/session-recovery";
import { createRecoveryClientStore, type RecoveryClientStore } from "./recovery-store";
import { DeferredPanel } from "./entry-panels";
import { createRegistrationScope } from "./initialization";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { createRegistrationQueue } from "./registration-queue";

const surfaceId = "workbench-session-recovery";
const loadRecoveryPanel = () => import("./session-recovery-panel");

function RecoveryPanelEntry({ store, props, agentId, openAll }: {
  store: RecoveryClientStore; props: PluginSurfaceProps | PluginButtonContentProps; agentId?: string; openAll(): void;
}) {
  useEffect(() => store.observe(), [store]);
  return <DeferredPanel name="RecoveryPanel" loader={loadRecoveryPanel} exportName="RecoveryPanel" props={{ ...props, store, agentId, openAll }} />;
}

/** Optional UI registration never owns or dispatches backend recovery attempts. */
export function registerRecoveryClient(client: PluginClientContext): () => void {
  if (Platform.OS === "android") return () => {};
  const scope = createRegistrationScope(reportNativeDiagnostic);
  try {
    const native = Platform.OS !== "web";
    const store = scope.step("recovery:state", () => createRecoveryClientStore(client, { demandOnly: native, idleIntervalMs: 5000, diagnostic: reportNativeDiagnostic }));
    scope.own("recovery:state", store.close);
    if (native && AppState?.addEventListener) {
      store.setForeground(!AppState.currentState || AppState.currentState === "active");
      const subscription = AppState.addEventListener("change", state => store.setForeground(state === "active"));
      scope.own("recovery:app-state", () => subscription.remove());
    }
    const queue = createRegistrationQueue({ deferred: native, report: reportNativeDiagnostic });
    const pills = new Map<string, { button: PluginButtonRegistration; label: string; workspaceId: string }>();
    function removePill(id: string) {
      const pill = pills.get(id);
      pills.delete(id);
      try { pill?.button.remove(); } catch (error) { scope.failure("recovery:pill:cleanup", error); }
    }
    scope.own("recovery:pills", () => { queue.close(); for (const id of pills.keys()) removePill(id); });
    const english = resolveWorkbenchLocale() === "en-US";
    const openAll = () => client.openSurface(surfaceId);
    scope.register("recovery:surface", () => client.addSurface(surfaceId, props => <RecoveryPanelEntry store={store} props={props} openAll={openAll} />));
    scope.register("recovery:sidebar", () => client.addSidebarItem({ id: surfaceId, title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", surface: surfaceId }));
    scope.register("recovery:settings", () => client.addSettingsScreen({ id: "workbench-session-recovery-settings", title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", Component: props => <RecoveryPanelEntry store={store} props={props} openAll={openAll} /> }));
    if (native) {
      // Per-session composer contributions share a host-wide registry. Keep
      // mobile recovery UI independent of every conversation's render path.
      let selectedAgentId: string | undefined;
      const listeners = new Set<() => void>(), agentSurfaceId = `${surfaceId}-agent`;
      const selected = () => selectedAgentId;
      const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
      function AgentRecoverySurface(props: PluginSurfaceProps) {
        const agentId = useSyncExternalStore(subscribe, selected, selected);
        return <RecoveryPanelEntry store={store} props={props} agentId={agentId} openAll={openAll} />;
      }
      scope.own("recovery:selection", () => { listeners.clear(); selectedAgentId = undefined; });
      scope.register("recovery:agent-surface", () => client.addSurface(agentSurfaceId, AgentRecoverySurface));
      scope.optional("recovery:agent-command", () => client.addCommandCenterItem({
        id: "workbench-session-recovery-agent", context: "agent", icon: "RotateCw",
        title: english ? "Current session auto recovery" : "当前会话自动恢复",
        keywords: ["recovery", "retry", "continue", "恢复", "继续"],
        onSelect(context) {
          selectedAgentId = context.agent.id;
          listeners.forEach(listener => listener());
          client.openSurface(agentSurfaceId);
        },
      }));
      scope.step("recovery:observation", store.start);
      return scope.close;
    }
    function updatePill(session: ReturnType<typeof store.getSnapshot>["sessions"][number]) {
      queue.enqueue(session.agentId, () => {
        // A queued snapshot may have been superseded or archived before its frame.
        if (!store.getSnapshot().sessions.some(s => s.agentId === session.agentId && s.workspaceId === session.workspaceId)) return;
        applyPill(session);
      });
    }
    function applyPill(session: ReturnType<typeof store.getSnapshot>["sessions"][number]) {
      if (!session.workspaceId) { removePill(session.agentId); return; }
      const label = recoveryStatusLabel(session, english), existing = pills.get(session.agentId);
      if (existing?.workspaceId === session.workspaceId && existing.label === label) return;
      try {
        if (existing?.workspaceId === session.workspaceId) {
          scope.step("recovery:pill:update", () => existing.button.update({ label, title: label }));
          existing.label = label;
        } else {
          removePill(session.agentId);
          const button = scope.step("recovery:pill", () => client.addComposerPill({ id: surfaceId, workspaceId: session.workspaceId!, agentId: session.agentId,
            button: { title: label, label, icon: "RotateCw", behavior: { kind: "popover", Content: props => <RecoveryPanelEntry store={store} props={props} agentId={session.agentId} openAll={openAll} /> } } }));
          pills.set(session.agentId, { label, workspaceId: session.workspaceId, button });
        }
      } catch { removePill(session.agentId); }
    }
    scope.register("recovery:subscription", () => store.subscribe(() => {
      const sessions = store.getSnapshot().sessions, current = new Set(sessions.map(s => s.agentId));
      for (const id of pills.keys()) if (!current.has(id)) { queue.cancel(id); removePill(id); }
      for (const session of sessions) {
        const existing = pills.get(session.agentId);
        if (!existing || existing.workspaceId !== session.workspaceId || existing.label !== recoveryStatusLabel(session, english)) updatePill(session);
        else queue.cancel(session.agentId);
      }
    }));
    scope.step("recovery:observation", store.start);
    return scope.close;
  } catch (error) { scope.close(); throw error; }
}
