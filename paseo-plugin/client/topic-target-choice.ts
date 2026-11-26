import type { TopicTarget } from '../shared/extensions/project-communications/topics.ts';

export const topicTargetKey = (target: TopicTarget) => target.id || 'workspace:' + target.workspaceId;
export const topicTargetTitle = (target: TopicTarget, workspaceNames: Record<string, string>) =>
  target.title || workspaceNames[target.workspaceId] || target.agentId;

export function topicTargetMatches(target: TopicTarget, query: string, workspaceNames: Record<string, string>): boolean {
  const text = query.trim().toLowerCase();
  return !text || [topicTargetTitle(target, workspaceNames), target.sessionTitle, target.provider, target.model, workspaceNames[target.workspaceId]]
    .some(value => value?.toLowerCase().includes(text));
}
