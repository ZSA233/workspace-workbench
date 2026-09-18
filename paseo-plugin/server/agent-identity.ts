import type { PaseoApi } from "@getpaseo/client";
import { readState, writeState } from "./orchestration-state.ts";

export type AgentIdentity = { agentId: string; cwd: string; revoked?: boolean; workspaceId?: string };

// An archive event can be followed by a host resume while the same MCP server
// remains attached. The host's current agent state is authoritative; the saved
// revoked bit is only a hint for deciding whether the old token may be revived.
export async function liveAgentIdentity(token: string, paseo: PaseoApi): Promise<AgentIdentity | null> {
  const identity = readState<AgentIdentity>(`context:${token}`);
  if (!identity?.agentId || !identity.cwd) return null;
  if (identity.revoked) {
    const session = readState<{ token: string }>(`session:${identity.agentId}`);
    if (session?.token !== token) return null;
  }
  const agent = (await paseo.agents.ref(identity.agentId).refresh())?.agent;
  if (!agent || agent.archivedAt || agent.cwd !== identity.cwd) return null;
  if (identity.revoked) {
    const restored = { ...identity, revoked: false };
    writeState(`context:${token}`, restored);
    return restored;
  }
  return identity;
}
