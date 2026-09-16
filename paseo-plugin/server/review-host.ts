import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentContext } from "./agent-provider.ts";
import type { ReviewSession } from "../shared/agent-review.ts";
import { currentProject } from "./projects.ts";
import { digest } from "./orchestration-state.ts";
type CoordinatorTurnInspection = "active" | "changed" | "ended" | "unknown";
export async function findExistingReviewer(session: ReviewSession, context: AgentContext): Promise<PaseoAgent | null> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const result = await context.paseo.agents.list({ filter: { labels: { "workspace-workbench.role": "reviewer", "workspace-workbench.review-session": session.id, "workspace-workbench.review-round": String(session.round), "workspace-workbench.project": digest(project.configPath) } }, page: { limit: 50 } });
  const entries = result.entries.map((entry) => entry.agent);
  if (entries.length > 1) throw new Error("reviewer_candidates_ambiguous");
  return entries[0] || null;
}

export async function reviewerTurnIsActive(handle: PaseoAgentHandle, session: ReviewSession): Promise<boolean | null> {
  if (!session.reviewerTurnId || session.reviewerAgentId !== handle.id) return false;
  try {
    const refreshed = await handle.refresh();
    if (!refreshed?.agent || refreshed.agent.id !== handle.id) return null;
    return refreshed.agent.activeTurn?.turnId === session.reviewerTurnId;
  } catch {
    return null;
  }
}

export async function inspectCoordinatorTurn(session: ReviewSession, context: AgentContext): Promise<CoordinatorTurnInspection> {
  const agentId = session.reviewerAgentId;
  const turnId = session.reviewerTurnId;
  if (!agentId || !turnId || session.coordinator?.agentId !== agentId) return "changed";
  try {
    const refreshed = await context.paseo.agents.ref(agentId).refresh();
    const agent = refreshed?.agent;
    if (!agent || agent.id !== agentId) return "unknown";
    if (agent.activeTurn?.turnId === turnId) return "active";
    return agent.activeTurn ? "changed" : "ended";
  } catch {
    return "unknown";
  }
}

export async function availableCodexModels(context: AgentContext, cwd: string): Promise<Array<{ id: string; label: string; selectable: boolean; isDefault: boolean }>> {
  const response = await context.paseo.providers.listModels("codex", { cwd, requestId: randomUUID() });
  return (response.models || []).map((model) => ({ id: model.id, label: model.label || model.id, selectable: model.isSelectable !== false, isDefault: model.isDefault === true }));
}

