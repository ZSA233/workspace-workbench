import { readState } from './orchestration-state.ts';
import { currentProject, resolveProject } from './projects.ts';
import type { WorkspaceCreator } from '../shared/workspace-creator.ts';
/** Optional local provenance. Host availability never gates Git-only creation. */
export function creationSource(input: { token?: string; contextAgentId?: string }): WorkspaceCreator | undefined {
  try {
    const token = input.token || (input.contextAgentId ? readState<{token:string}>(`session:${input.contextAgentId}`)?.token : undefined);
    if (!token) return;
    const identity = readState<{agentId?:string;cwd?:string;revoked?:boolean;title?:string}>(`context:${token}`);
    if (!identity?.agentId || !identity.cwd || identity.revoked || input.contextAgentId && identity.agentId !== input.contextAgentId) return;
    if (readState<{token:string}>(`session:${identity.agentId}`)?.token !== token) return;
    if (resolveProject({directory:identity.cwd}).configPath !== currentProject()?.configPath) return;
    return {agentId:identity.agentId, ...(identity.title ? {name:identity.title} : {}), recordedAt:new Date().toISOString()};
  } catch { return; }
}
