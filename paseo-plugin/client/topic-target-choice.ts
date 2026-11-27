import type { TopicTarget } from '../shared/extensions/project-communications/topics.ts';

export const topicTargetKey = (target: TopicTarget) => target.id || 'workspace:' + target.workspaceId;
export const topicTargetTitle = (target: TopicTarget, workspaceNames: Record<string, string>) =>
  target.title || workspaceNames[target.workspaceId] || target.agentId;

/** Explicit choices belong to this dialog. Remembered choices only fill an
 * empty host context; they cannot override the conversation on screen. */
export function resolveTopicTarget(targets:TopicTarget[],context:{manualId?:string;rememberedId?:string;currentAgentId?:string;currentHostWorkspaceId?:string;currentWorkspaceId?:string}):TopicTarget|undefined{
 if(context.manualId)return targets.find(t=>topicTargetKey(t)===context.manualId);
 const agent=context.currentAgentId&&targets.find(t=>t.agentId===context.currentAgentId);if(agent)return agent;
 if(context.currentHostWorkspaceId)return targets.find(t=>t.kind==='session'&&t.workspaceId===context.currentHostWorkspaceId)||targets.find(t=>t.hostWorkspaceId===context.currentHostWorkspaceId);
 if(context.currentAgentId)return;
 return targets.find(t=>topicTargetKey(t)===context.rememberedId)||targets.find(t=>t.kind!=='session'&&t.workspaceId===context.currentWorkspaceId)||(targets.length===1?targets[0]:undefined);
}

export function topicTargetMatches(target: TopicTarget, query: string, workspaceNames: Record<string, string>): boolean {
  const text = query.trim().toLowerCase();
  return !text || [topicTargetTitle(target, workspaceNames), target.sessionTitle, target.provider, target.model, workspaceNames[target.workspaceId]]
    .some(value => value?.toLowerCase().includes(text));
}
