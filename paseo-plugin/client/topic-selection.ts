import type { ArchiveAsset, ArchiveMessage, ArchiveTopicDetail, SelectedTopic, TopicSelection } from '../shared/extensions/project-communications/topics.ts';
import { supportedArtifact } from '../shared/artifact-limits.ts';
export type TopicBasket = Record<string, SelectedTopic>;
export function selectTopic(basket: TopicBasket, topic: ArchiveTopicDetail): TopicBasket {
  if (basket[topic.id]) { const next = { ...basket }; delete next[topic.id]; return next; }
  return { ...basket, [topic.id]: { topic, messages: uniqueMessages(topic.messages), assetIds: topic.messages.flatMap(message => message.assets.filter(asset => asset.state === 'ready' && supportedArtifact(asset.mimeType || '', asset.size)).map(asset => asset.id)), includeAnalysis: false, contexts: {} } };
}
export function changeMessage(basket: TopicBasket, topic: ArchiveTopicDetail, message: ArchiveMessage, contextOf?: string): TopicBasket {
  const current = basket[topic.id] || { topic, messages: [], assetIds: [], includeAnalysis: false, contexts: {} };
  const selected = current.messages.some(item => item.id === message.id);
  return compact({ ...basket, [topic.id]: { ...current, messages: selected ? current.messages.filter(item => item.id !== message.id) : uniqueMessages([...current.messages, message]),
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
export function basketSelections(basket: TopicBasket): TopicSelection[] {
  return Object.values(basket).map(item => ({
    topicId: item.topic.id, revision: item.topic.revision, inputRevision: item.topic.inputRevision,
    messages: item.messages.map(message => ({ id: message.id, version: message.version, ...(item.contexts[message.id] ? { contextOf: item.contexts[message.id] } : {}) })),
    assets: selectedAssets(item).map(({ message, asset }) => ({ id: asset.id, messageId: message.id, messageVersion: message.version, ...(item.contexts[message.id] ? { contextOf: item.contexts[message.id] } : {}) })),
    includeAnalysis: item.includeAnalysis,
  }));
}
