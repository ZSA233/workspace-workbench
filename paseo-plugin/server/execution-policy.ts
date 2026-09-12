import type { PaseoAgent, PaseoAgentConfig } from "@getpaseo/client";

/** A mode is a permission preset; Codex planning is a separate feature. */
export function childExecutionConfig(parent: PaseoAgent, planFirst: boolean): PaseoAgentConfig {
  const provider = parent.runtimeInfo?.provider || parent.provider;
  if (provider !== "codex") throw new Error("execution_provider_unverified");
  const planning = parent.features?.find((feature) => feature.id === "plan_mode");
  if (!planning || planning.type !== "toggle" || planning.value !== false) throw new Error("execution_mode_unconfirmed");
  const mode = parent.currentModeId;
  if (!mode || !["auto", "auto-review", "full-access"].includes(mode) || !parent.availableModes.some((item) => item.id === mode)) throw new Error("execution_permission_unconfirmed");
  if (parent.pendingPermissions.length) throw new Error("execution_permission_pending");
  return {
    provider: `${provider}${parent.model ? `/${parent.model}` : ""}`,
    // A coordinator with full access must not implicitly grant it to a child.
    modeId: mode === "full-access" ? "auto" : mode,
    featureValues: { plan_mode: planFirst },
    ...(parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
  };
}
