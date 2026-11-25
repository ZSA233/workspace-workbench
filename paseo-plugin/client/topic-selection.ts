import type { ArchiveAsset, ArchiveMessage, ArchiveTopicDetail, SelectedTopic, TopicSelection } from '../shared/extensions/project-communications/topics.ts';
import { supportedArtifact } from '../shared/artifact-limits.ts';
import {topicMessageKey,type TopicContentEntry} from '../shared/extensions/project-communications/topic-content.ts';
import type { IssueBasket } from './issue-selection';
export type TopicBasket = Record<string, SelectedTopic>;
export function selectTopic(basket: TopicBasket, topic: ArchiveTopicDetail): TopicBasket {
  if (basket[topic.id]) { const next = { ...basket }; delete next[topic.id]; return next; }
  return { ...basket, [topic.id]: { topic, messages: uniqueMessages(topic.messages), assetIds: topic.messages.flatMap(message => message.assets.filter(asset => asset.state === 'ready' && supportedArtifact(asset.mimeType || '', asset.size)).map(asset => asset.id)), includeAnalysis: false, contexts: {} } };
}
export function changeMessage(basket: TopicBasket, topic: ArchiveTopicDetail, message: ArchiveMessage, contextOf?: string): TopicBasket {
  const current = basket[topic.id] || { topic, messages: [], assetIds: [], includeAnalysis: false, contexts: {} };
  const selected = current.messages.some(item => item.id === message.id);
  const editedTexts={...current.editedTexts};if(selected)delete editedTexts[message.id];
  return compact({ ...basket, [topic.id]: { ...current, messages: selected ? current.messages.filter(item => item.id !== message.id) : uniqueMessages([...current.messages, message]),
    editedTexts,
    assetIds: selected ? current.assetIds : [...new Set([...current.assetIds, ...message.assets.filter(asset => asset.state === 'ready' && supportedArtifact(asset.mimeType || '', asset.size)).map(asset => asset.id)])],
    contexts: contextOf ? { ...current.contexts, [message.id]: contextOf } : current.contexts,
    topic: { ...current.topic, messages: uniqueMessages([...current.topic.messages, message]) } } });
}
export function changeAsset(basket: TopicBasket, topic: ArchiveTopicDetail, message: ArchiveMessage, asset: ArchiveAsset, contextOf?: string): TopicBasket {
  if (asset.state !== 'ready' || !supportedArtifact(asset.mimeType || '', asset.size)) return basket;
  const current = basket[topic.id] || { topic, messages: [], assetIds: [], includeAnalysis: false, contexts: {} };
  return compact({ ...basket, [topic.id]: { ...current,
    assetIds: current.assetIds.includes(asset.id) ? current.assetIds.filter(id => id !== asset.id) : [...current.assetIds, asset.id],
    contexts: contextOf ? { ...current.contexts, [message.id]: contextOf } : current.contexts,
    topic: { ...current.topic, messages: uniqueMessages([...current.topic.messages, message]) } } });
}
export function compact(basket: TopicBasket): TopicBasket {
  return Object.fromEntries(Object.entries(basket).filter(([, item]) => item.messages.length || item.assetIds.length || item.includeAnalysis));
}
export function uniqueMessages(messages: ArchiveMessage[]) {
  return [...new Map(messages.map(message => [message.id, message])).values()].sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function selectedAssets(item: SelectedTopic) {
  return uniqueMessages(item.topic.messages).flatMap(message => message.assets.filter(asset => item.assetIds.includes(asset.id)).map(asset => ({ message, asset })));
}
export function basketCounts(basket: TopicBasket) {
  const items = Object.values(basket);
  return { topics: items.length, messages: new Set(items.flatMap(item => item.messages.map(message => message.id))).size,
    assets: new Set(items.flatMap(item => item.assetIds)).size };
}

export function materialCounts(basket: TopicBasket, issues: IssueBasket) {
  const topics = basketCounts(basket), selected = Object.values(issues);
  return { topics: topics.topics, issues: selected.length, records: topics.topics + selected.length,
    messages: topics.messages + selected.reduce((count, item) => count + Number(item.selection.body) + item.selection.comments.length, 0),
    assets: topics.assets + selected.reduce((count, item) => count + item.selection.attachments.length, 0) };
}

export function materialLimitExceeded(counts: ReturnType<typeof materialCounts>) {
  return counts.records > 20 || counts.messages > 100 || counts.assets > 20;
}
export function basketSelections(basket: TopicBasket): TopicSelection[] {
  return Object.values(basket).map(item => ({
    topicId: item.topic.id, revision: item.topic.revision, inputRevision: item.topic.inputRevision,
    messages: item.messages.map(message => ({ id: message.id, version: message.version, ...(item.contexts[message.id] ? { contextOf: item.contexts[message.id] } : {}),
      ...(item.editedTexts?.[message.id]===undefined?{}:{editedText:item.editedTexts[message.id]}) })),
    assets: selectedAssets(item).map(({ message, asset }) => ({ id: asset.id, messageId: message.id, messageVersion: message.version, ...(item.contexts[message.id] ? { contextOf: item.contexts[message.id] } : {}) })),
    includeAnalysis: item.includeAnalysis,
  }));
}
export function editSelectedMessage(basket:TopicBasket,message:ArchiveMessage,text:string|undefined):TopicBasket{
  return Object.fromEntries(Object.entries(basket).map(([id,selected])=>{
    const hasText=selected.messages.some(item=>topicMessageKey(item)===topicMessageKey(message));
    if(!hasText&&!selectedAssets(selected).some(item=>topicMessageKey(item.message)===topicMessageKey(message)))return [id,selected];
    const editedTexts={...selected.editedTexts};if(text===undefined)delete editedTexts[message.id];else editedTexts[message.id]=text;
    return [id,{...selected,editedTexts,messages:hasText||text===undefined?selected.messages:uniqueMessages([...selected.messages,message])}];
  }));
}
export function basketContentEntries(basket:TopicBasket):TopicContentEntry[]{
  return Object.values(basket).flatMap(selected=>{
    const assets=selectedAssets(selected),messages=uniqueMessages([...selected.messages,...assets.map(item=>item.message)]);
    return messages.map(message=>({topicId:selected.topic.id,message,includeText:selected.messages.some(item=>item.id===message.id),
      editedText:selected.editedTexts?.[message.id],assetIds:message.assets.filter(asset=>selected.assetIds.includes(asset.id)).map(asset=>asset.id)}));
  });
}
