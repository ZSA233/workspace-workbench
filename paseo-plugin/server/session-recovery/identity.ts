import { createHash } from "node:crypto";
import type { PaseoAgent } from "@getpaseo/client";

/** Shared with the host bridge so its final admission checks the same state. */
export function recoveryIdentity(agent: PaseoAgent): string {
  const feature = agent.features?.find(item => item.id === "plan_mode");
  const planning = feature?.type === "toggle" && typeof feature.value === "boolean" ? feature.value ? "plan" : "execute" : "unknown";
  return createHash("sha256").update(JSON.stringify({
    id: agent.id, provider: agent.provider, cwd: agent.cwd, workspace: agent.workspaceId || null,
    session: agent.persistence?.sessionId || agent.runtimeInfo?.sessionId || null,
    mode: agent.currentModeId, planning, model: agent.model || null, runtimeModel: agent.runtimeInfo?.model || null,
    thinking: agent.thinkingOptionId || null, effectiveThinking: agent.effectiveThinkingOptionId || null,
    features: agent.features?.map(f => [f.id, f.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    labels: Object.entries(agent.labels || {}).filter(([key]) => key.startsWith("workspace-workbench.") && !key.startsWith("workspace-workbench.recovery")).sort(),
  })).digest("hex");
}
