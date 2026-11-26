import type { ArchiveMessage } from '../shared/extensions/project-communications/topics.ts';
import { assetIsMessageAttachment } from '../shared/extensions/project-communications/topics.ts';
import { uniqueMessages } from './topic-selection.ts';

export const TOPIC_ASSET_REFRESH_MS = 10_000;
export function pendingTopicAssets(data?: { messages?: ArchiveMessage[]; items?: ArchiveMessage[] }): boolean {
  return (data?.messages || data?.items || []).some(message => message.assets.some(asset => assetIsMessageAttachment(asset) && ['pending', 'deferred'].includes(asset.state)));
}

/** Update display metadata without adding material or replacing a frozen body. */
export function topicDisplayMessages(latest: ArchiveMessage[], frozen: ArchiveMessage[] = []): ArchiveMessage[] {
  const current = new Map(latest.map(message => [message.id, message]));
  return uniqueMessages([...latest, ...frozen]).map(message => {
    const fresh = current.get(message.id);
    if (!fresh || fresh === message || fresh.version !== message.version || fresh.sourceId !== message.sourceId || fresh.channelId !== message.channelId
      || fresh.sourceAccountId !== message.sourceAccountId || fresh.archiveId !== message.archiveId) return message;
    const assets = new Map(fresh.assets.map(asset => [asset.id, asset]));
    return { ...message, assets: message.assets.map(asset => assets.has(asset.id) ? { ...asset, ...assets.get(asset.id) } : asset) };
  });
}
