import type { AgentContext } from './agent-provider.ts';
import type { ProjectRoute } from './projects.ts';
import type { ReviewArtifactReference } from '../shared/review-packet.ts';
import type { TopicModel, TopicNewSession } from '../shared/extensions/project-communications/topics.ts';
import type { TopicSessionIdentity } from './topic-targets.ts';
import { digest } from './orchestration-state.ts';
import { assertTopicSession, deliverTopicSession, topicMessageId } from './topic-targets.ts';

export async function topicModels(route: ProjectRoute, context: AgentContext): Promise<TopicModel[]> {
  const available = await context.paseo.providers.listAvailable();
  if (available.error) throw Error('topic_models_unavailable');
  const providers = available.providers.filter(item => item.available).slice(0, 16);
  const result: TopicModel[] = [];
  let failed = false;
  // Bound provider discovery; one unavailable provider does not hide the others.
  for (let offset = 0; offset < providers.length; offset += 4) {
    const batch = providers.slice(offset, offset + 4);
    const values = await Promise.allSettled(batch.map(async item => {
      const [models,modes]=await Promise.all([context.paseo.providers.listModels(item.provider,{cwd:route.sourceRoot}),
        context.paseo.providers.listModes(item.provider,{cwd:route.sourceRoot}).catch(()=>({modes:[],error:'unavailable'}))]);
      return {models,modes};
    }));
    values.forEach((value, index) => {
      if (value.status !== 'fulfilled' || value.value.models.error) { failed = true; return; }
      for (const model of value.value.models.models || []) if (model.isSelectable !== false) result.push({
        provider: batch[index].provider, model: model.id, label: model.label || model.id, isDefault: model.isDefault === true,
        thinkingOptions:model.thinkingOptions?.map(({id,label,isDefault})=>({id,label,...(isDefault===undefined?{}:{isDefault})})),defaultThinkingOptionId:model.defaultThinkingOptionId,
        permissionModes:value.value.modes.modes?.map(({id,label})=>({id,label})),permissionsUnavailable:Boolean(value.value.modes.error),
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
  const model=value.models?.find(model=>model.id===choice.model&&model.isSelectable!==false);
  if (value.error || !model) throw Error('topic_model_unavailable');
  if(choice.thinkingOptionId&&!model.thinkingOptions?.some(option=>option.id===choice.thinkingOptionId))throw Error('topic_effort_unavailable');
  if(choice.modeId){
    const modes=await context.paseo.providers.listModes(choice.provider,{cwd:route.sourceRoot});
    if(modes.error||!modes.modes?.some(mode=>mode.id===choice.modeId))throw Error('topic_permission_unavailable');
  }
}

const labels = (route: ProjectRoute, id: string) => ({ 'workspace-workbench.role': 'topic-session',
  'workspace-workbench.project': digest(route.configPath), 'workspace-workbench.topic-material': id });
const messageId = (id: string) => digest({ kind: 'archive-topic-new-session', id });

export async function createTopicSession(route: ProjectRoute, context: AgentContext,
  value: { id: string; text: string; dispatchText?: string; references: ReviewArtifactReference[]; newSession: TopicNewSession }, beforeCreate: () => void,
  recordCreated: (session:TopicSessionIdentity,messageId:string)=>void) {
  await assertTopicModel(route, context, value.newSession);
    beforeCreate();
    // Create an empty native session, journal its identity, then use the same
    // ordinary image-message path as existing sessions. Never replay either phase.
    const handle = await context.paseo.agents.create({ cwd: route.sourceRoot,
      idempotencyKey: 'archive-topic:' + value.id,
      title: (value.text.split('\n').find(line=>line.trim())?.trim() || (value.references.some(item=>item.mimeType?.startsWith('image/'))?'图片讨论':'材料讨论')).slice(0,80),
      labels: labels(route, value.id),
      config: { provider: value.newSession.provider + '/' + value.newSession.model,
        ...(value.newSession.thinkingOptionId?{thinkingOptionId:value.newSession.thinkingOptionId}:{}),
        ...(value.newSession.modeId?{modeId:value.newSession.modeId}:{}) },
    });
    const agent = (await handle.refresh())?.agent;
    if (!agent || agent.id !== handle.id || agent.cwd !== route.sourceRoot || Object.entries(labels(route, value.id)).some(([key, value]) => agent.labels?.[key] !== value)) throw Error('topic_target_changed');
    const session = { agentId: agent.id, cwd: agent.cwd, hostWorkspaceId: agent.workspaceId || '' };
    await assertTopicSession(route, context, session);
    recordCreated(session,topicMessageId(value.id,session));
    return {...await deliverTopicSession(route,context,session,value,beforeCreate),session};
}

export async function newTopicSessionReceipt(route: ProjectRoute, context: AgentContext, value: { id: string; session?: TopicSessionIdentity; messageId?:string }) {
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
  const expected = value.messageId || messageId(value.id), accepted = !page.error && page.entries.some(entry => entry.item.type === 'user_message'
    && (entry.item.messageId === expected || entry.item.clientMessageId === expected));
  return { delivery: accepted ? 'accepted' : 'uncertain', messageId: expected, session };
}
