import type { AgentContext } from './agent-provider.ts';
import type { ProjectRoute } from './projects.ts';
import type { ReviewArtifactReference } from '../shared/review-packet.ts';
import type { TopicModel, TopicNewSession } from '../shared/extensions/project-communications/topics.ts';
import type { TopicSessionIdentity } from './topic-targets.ts';
import { digest } from './orchestration-state.ts';
import { withProject } from './projects.ts';
import { resolveArtifactReference, resolvedArtifactImageAttachments, storedArtifactFileAttachment } from './artifacts.ts';
import { assertTopicSession } from './topic-targets.ts';

export async function topicModels(route: ProjectRoute, context: AgentContext): Promise<TopicModel[]> {
  const available = await context.paseo.providers.listAvailable();
  if (available.error) throw Error('topic_models_unavailable');
  const providers = available.providers.filter(item => item.available).slice(0, 16);
  const result: TopicModel[] = [];
  let failed = false;
  // Bound provider discovery; one unavailable provider does not hide the others.
  for (let offset = 0; offset < providers.length; offset += 4) {
    const batch = providers.slice(offset, offset + 4);
    const values = await Promise.allSettled(batch.map(item => context.paseo.providers.listModels(item.provider, { cwd: route.sourceRoot })));
    values.forEach((value, index) => {
      if (value.status !== 'fulfilled' || value.value.error) { failed = true; return; }
      for (const model of value.value.models || []) if (model.isSelectable !== false) result.push({
        provider: batch[index].provider, model: model.id, label: model.label || model.id, isDefault: model.isDefault === true,
      });
    });
  }
  if (!result.length && failed) throw Error('topic_models_unavailable');
  return result;
}

export async function assertTopicModel(route: ProjectRoute, context: AgentContext, choice: TopicNewSession) {
  const available = await context.paseo.providers.listAvailable();
  if (available.error || !available.providers.some(item => item.available && item.provider === choice.provider)) throw Error('topic_model_unavailable');
  const value = await context.paseo.providers.listModels(choice.provider, { cwd: route.sourceRoot });
  if (value.error || !value.models?.some(model => model.id === choice.model && model.isSelectable !== false)) throw Error('topic_model_unavailable');
}

const labels = (route: ProjectRoute, id: string) => ({ 'workspace-workbench.role': 'topic-session',
  'workspace-workbench.project': digest(route.configPath), 'workspace-workbench.topic-material': id });
const messageId = (id: string) => digest({ kind: 'archive-topic-new-session', id });

export async function createTopicSession(route: ProjectRoute, context: AgentContext,
  value: { id: string; text: string; dispatchText?: string; references: ReviewArtifactReference[]; newSession: TopicNewSession; topics: Array<{title: string}> }, beforeCreate: () => void) {
  await assertTopicModel(route, context, value.newSession);
  return withProject({ projectConfig: route.configPath }, async () => {
    const assets = value.references.map(reference => resolveArtifactReference(reference, { repositories: [] }));
    beforeCreate();
    // The durable material claim precedes this single create-and-prompt call.
    // Labels also allow old hosts to reconcile a lost creation acknowledgement.
    const handle = await context.paseo.agents.create({ cwd: route.sourceRoot,
      idempotencyKey: 'archive-topic:' + value.id, clientMessageId: messageId(value.id),
      title: value.topics[0]?.title.slice(0, 80) || '话题分析', labels: labels(route, value.id),
      config: { provider: value.newSession.provider + '/' + value.newSession.model },
      prompt: value.dispatchText || value.text, images: resolvedArtifactImageAttachments(assets),
      attachments: assets.filter(asset => !asset.mimeType.startsWith('image/')).map(asset => storedArtifactFileAttachment(asset.assetId)),
    });
    const agent = (await handle.refresh())?.agent;
    if (!agent || agent.id !== handle.id || agent.cwd !== route.sourceRoot || Object.entries(labels(route, value.id)).some(([key, value]) => agent.labels?.[key] !== value)) throw Error('topic_target_changed');
    const session = { agentId: agent.id, cwd: agent.cwd, hostWorkspaceId: agent.workspaceId || '' };
    await assertTopicSession(route, context, session);
    return { delivery: 'accepted', messageId: messageId(value.id), session };
  });
}

export async function newTopicSessionReceipt(route: ProjectRoute, context: AgentContext, value: { id: string; session?: TopicSessionIdentity }) {
  let session = value.session;
  if (!session) {
    const page = await context.paseo.agents.list({ filter: { includeArchived: false, labels: labels(route, value.id) }, page: { limit: 2 } });
    const candidates = page.entries.map(entry => entry.agent);
    if (candidates.length > 1 || page.pageInfo.hasMore) throw Error('topic_session_ambiguous');
    const agent = candidates[0];
    if (!agent) return { delivery: 'uncertain', messageId: messageId(value.id) };
    if (agent.cwd !== route.sourceRoot || Object.entries(labels(route, value.id)).some(([key, expected]) => agent.labels?.[key] !== expected)) throw Error('topic_target_changed');
    session = { agentId: agent.id, cwd: agent.cwd, hostWorkspaceId: agent.workspaceId || '' };
  }
  await assertTopicSession(route, context, session);
  const page = await context.paseo.agents.ref(session.agentId).timeline.refetch({ limit: 100 });
  const expected = messageId(value.id), accepted = !page.error && page.entries.some(entry => entry.item.type === 'user_message'
    && (entry.item.messageId === expected || entry.item.clientMessageId === expected));
  return { delivery: accepted ? 'accepted' : 'uncertain', messageId: expected, session };
}
