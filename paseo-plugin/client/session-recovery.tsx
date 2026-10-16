import type { PluginClientContext, PluginSurfaceProps, PluginButtonRegistration, PluginButtonContentProps } from "@getpaseo/plugin/client";
import { resolveWorkbenchLocale } from "../shared/copy";
import { recoveryStatusLabel } from "../shared/session-recovery";
import { createRecoveryClientStore, type RecoveryClientStore } from "./recovery-store";
import { DeferredPanel } from "./entry-panels";
import { createRegistrationScope } from "./initialization";
import { reportNativeDiagnostic } from "./native-diagnostics";

const surfaceId = "workbench-session-recovery";
const loadRecoveryPanel = () => import("./session-recovery-panel");

function RecoveryPanelEntry({ store, props, agentId, openAll }: {
  store: RecoveryClientStore; props: PluginSurfaceProps | PluginButtonContentProps; agentId?: string; openAll(): void;
}) {
  return <DeferredPanel name="RecoveryPanel" loader={loadRecoveryPanel} exportName="RecoveryPanel" props={{ ...props, store, agentId, openAll }} />;
}

/** Optional UI registration never owns or dispatches backend recovery attempts. */
export function registerRecoveryClient(client: PluginClientContext): () => void {
  const scope = createRegistrationScope(reportNativeDiagnostic);
  try {
    const store = scope.step("recovery:state", () => createRecoveryClientStore(client));
    scope.own("recovery:state", store.close);
    const pills = new Map<string, { button: PluginButtonRegistration; label: string; workspaceId: string }>();
    function removePill(id: string) {
      const pill = pills.get(id);
      pills.delete(id);
      try { pill?.button.remove(); } catch (error) { scope.failure("recovery:pill:cleanup", error); }
    }
    scope.own("recovery:pills", () => { for (const id of pills.keys()) removePill(id); });
    const english = resolveWorkbenchLocale() === "en-US";
    const openAll = () => client.openSurface(surfaceId);
    scope.register("recovery:surface", () => client.addSurface(surfaceId, props => <RecoveryPanelEntry store={store} props={props} openAll={openAll} />));
    scope.register("recovery:sidebar", () => client.addSidebarItem({ id: surfaceId, title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", surface: surfaceId }));
    scope.register("recovery:settings", () => client.addSettingsScreen({ id: "workbench-session-recovery-settings", title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", Component: props => <RecoveryPanelEntry store={store} props={props} openAll={openAll} /> }));
    scope.register("recovery:subscription", () => store.subscribe(() => {
      const sessions = store.getSnapshot().sessions, current = new Set(sessions.map(s => s.agentId));
      for (const id of pills.keys()) if (!current.has(id)) removePill(id);
      for (const session of sessions) {
        if (!session.workspaceId) continue;
        const label = recoveryStatusLabel(session, english), existing = pills.get(session.agentId);
        try {
          if (existing?.workspaceId === session.workspaceId) {
            if (existing.label !== label) {
              scope.step("recovery:pill:update", () => existing.button.update({ label, title: label }));
              existing.label = label;
            }
            continue;
          }
          removePill(session.agentId);
          const button = scope.step("recovery:pill", () => client.addComposerPill({ id: surfaceId, workspaceId: session.workspaceId!, agentId: session.agentId,
            button: { title: label, label, icon: "RotateCw", behavior: { kind: "popover", Content: props => <RecoveryPanelEntry store={store} props={props} agentId={session.agentId} openAll={openAll} /> } } }));
          pills.set(session.agentId, { label, workspaceId: session.workspaceId, button });
        } catch { removePill(session.agentId); /* The global screen remains available. */ }
      }
    }));
    scope.step("recovery:observation", store.start);
    return scope.close;
  } catch (error) { scope.close(); throw error; }
}
