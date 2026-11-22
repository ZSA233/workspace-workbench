import type { PaseoAgent } from '@getpaseo/client';
import { realpathSync } from 'node:fs';
import { basename, sep } from 'node:path';
import type { AgentContext } from './agent-provider.ts';
import type { ProjectRoute } from './projects.ts';
import type { ReviewArtifactReference } from '../shared/review-packet.ts';
import type { TopicTarget } from '../shared/extensions/project-communications/topics.ts';
import { allAgentBindings } from './agent-store.ts';
import { withProject } from './projects.ts';
import { actualPlanningState } from './execution-policy.ts';
import { digest } from './orchestration-state.ts';
import { resolveArtifactReference, resolvedArtifactImageAttachments, storedArtifactFileAttachment } from './artifacts.ts';
import { appendTopicImages } from './topic-chat-media.ts';

export type TopicSessionIdentity = { agentId: string; cwd: string; hostWorkspaceId: string };
function inside(root: string, path: string) {
  try { const base = realpathSync(root), target = realpathSync(path); return target === base || target.startsWith(base + sep); }
  catch { return false; }
}
function eligible(route: ProjectRoute, agent: PaseoAgent) {
  return !agent.archivedAt && typeof agent.cwd === 'string' && inside(route.sourceRoot, agent.cwd)
    && !/review|workspace-worker/.test(agent.labels?.['workspace-workbench.role'] || '');
}

export async function topicTargets(route: ProjectRoute, context?: AgentContext): Promise<TopicTarget[]> {
  const bindings = withProject({ projectConfig: route.configPath }, () => allAgentBindings());
  const bound = bindings.map(item => ({ id: 'workspace:' + item.workspaceId, kind: 'workspace' as const,
    workspaceId: item.workspaceId, agentId: item.agentId, hostWorkspaceId: item.paseoWorkspaceId, cwd: item.cwd }));
  if (!context) return bound;
  const result: TopicTarget[] = [], seen = new Set<string>(), observed = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const value = await context.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of value.entries) {
      observed.add(agent.id);
      const binding = bound.find(item => item.agentId === agent.id);
      if (binding && (binding.cwd !== agent.cwd || binding.hostWorkspaceId !== agent.workspaceId)) continue;
      if (seen.has(agent.id) || (!binding && !eligible(route, agent)) || agent.archivedAt) continue;
      seen.add(agent.id);
      result.push({ ...(binding || { id: 'session:' + agent.id, kind: 'session' as const, workspaceId: agent.workspaceId || '', agentId: agent.id,
        cwd: agent.cwd, hostWorkspaceId: agent.workspaceId || '' }),
        title: agent.title || (agent.provider + ' · ' + basename(agent.cwd)), provider: agent.provider, model: agent.runtimeInfo?.model || agent.model || undefined, status: agent.status });
    }
    if (!value.pageInfo.hasMore) break;
    cursor = value.pageInfo.nextCursor || undefined;
    if (!cursor) throw Error('topic_targets_incomplete');
  }
  // Keep legacy bindings visible during host-directory lag; delivery still
  // rechecks their live identity through the existing session owner.
  return [...result, ...bound.filter(item => !observed.has(item.agentId))];
}

export async function assertTopicSession(route: ProjectRoute, context: AgentContext, target: TopicSessionIdentity) {
  const agent = (await context.paseo.agents.ref(target.agentId).refresh())?.agent;
  if (!agent || !eligible(route, agent) || agent.cwd !== target.cwd || (agent.workspaceId || '') !== target.hostWorkspaceId) throw Error('topic_target_changed');
  return { agent, planningState: actualPlanningState(agent) };
}

export function topicMessageId(id: string, target: TopicSessionIdentity) { return digest({ kind: 'archive-topic-session', id, agentId: target.agentId }); }
export async function deliverTopicSession(route: ProjectRoute, context: AgentContext, target: TopicSessionIdentity,
  value: { id: string; text: string; dispatchText?: string; references: ReviewArtifactReference[] }, beforeSend?: () => void) {
  return withProject({ projectConfig: route.configPath }, async () => {
    await assertTopicSession(route, context, target);
    const assets = value.references.map(reference => resolveArtifactReference(reference, { repositories: [] }));
    const id = topicMessageId(value.id, target);
    beforeSend?.();
    await appendTopicImages(route,context,target.agentId,value);
    await assertTopicSession(route,context,target);
    beforeSend?.();
    try {
      // Sending a supplement preserves the session's current planning/permission mode.
      const options = { messageId: id, activeTurnBehavior: 'steer' as const, images: resolvedArtifactImageAttachments(assets),
        attachments: assets.filter(asset => !asset.mimeType.startsWith('image/')).map(asset => storedArtifactFileAttachment(asset.assetId)) };
      await context.paseo.agents.ref(target.agentId).send(value.dispatchText || value.text, options);
      return { delivery: 'accepted', messageId: id };
    } catch { return { delivery: 'uncertain', messageId: id }; }
  });
}

export async function topicSessionReceipt(route: ProjectRoute, context: AgentContext, target: TopicSessionIdentity, id: string) {
  await assertTopicSession(route, context, target);
  const expected = topicMessageId(id, target);
  const page = await context.paseo.agents.ref(target.agentId).timeline.refetch({ limit: 100 });
  const accepted = !page.error && page.entries.some(entry => entry.item.type === 'user_message'
    && (entry.item.messageId === expected || entry.item.clientMessageId === expected));
  return { delivery: accepted ? 'accepted' : 'uncertain', messageId: expected };
}
