import type { PaseoAgent, PaseoAgentConfig } from "@getpaseo/client";
import { resolveAgentPermissionMode } from "./agent-session.ts";
import type { AgentPermissionMode } from "../shared/agent-session.ts";

/** A mode is a permission preset; Codex planning is a separate feature. */
export function childExecutionConfig(parent: PaseoAgent, planFirst: boolean, configuredPermissionMode?: AgentPermissionMode): PaseoAgentConfig {
  const provider = parent.runtimeInfo?.provider || parent.provider;
  if (provider !== "codex") throw new Error("execution_provider_unverified");
  const planning = parent.features?.find((feature) => feature.id === "plan_mode");
  if (!planning || planning.type !== "toggle" || planning.value !== false) throw new Error("execution_mode_unconfirmed");
  const currentMode = parent.currentModeId;
  if (!currentMode || !parent.availableModes.some((item) => item.id === currentMode)) throw new Error("execution_permission_unconfirmed");
  if (parent.pendingPermissions.length) throw new Error("execution_permission_pending");
  const permissionMode = configuredPermissionMode || resolveAgentPermissionMode();
  const mode = permissionMode === "inherit" ? currentMode : permissionMode;
  if (!parent.availableModes.some((item) => item.id === mode)) throw new Error("execution_permission_unavailable");
  return {
    provider: `${provider}${parent.model ? `/${parent.model}` : ""}`,
    // Permission inheritance is explicit and resolved once, at creation time.
    modeId: mode,
    featureValues: { plan_mode: planFirst },
    ...(parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
  };
}
