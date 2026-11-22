import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import {topicContentOptionsSchema,topicMaterialSettingsSchema} from './topic-content-settings.ts';

const id = z.string().min(1).max(512).refine(value => value !== '.' && value !== '..' && !/[\u0000-\u001f]/.test(value));
export const watchedGroupSchema = z.object({ sourceId: id, channelId: id });
export type WatchedGroup = z.infer<typeof watchedGroupSchema>;
export type ArchiveLibrary = { id: string; name: string; projectId?: string };
export type ArchiveChannel = WatchedGroup & { id: string; name: string; provider?: string; state?: string };
export type ArchiveGroup = WatchedGroup & { id: string; name: string; revision: number; enabled: boolean; analysisEnabled?: boolean; autoDiscover?: boolean; discoveryAction?: 'collect' | 'investigate'; replyMode?: 'off' | 'restrained'; allowedTools: string[] };
export type ArchiveTool = { id: string; name?: string; description?: string; enabled: boolean; builtin?: boolean; readOnly?: boolean };
export type ArchiveAsset = { id: string; name: string; kind?: string; state: string; mimeType?: string; size?: number; sha256?: string; error?: string };
export type ArchiveMessage = { id: string; text: string; displayText?: string; sender: string | { name?: string; displayName?: string; id?: string }; senderId?:string;
  mentions?:Array<string|{id?:string;userId?:string;senderId?:string;name?:string;displayName?:string}>;replyTo?:string;externalMessageId?:string;ingestSequence?:number;timestampKnown?:boolean;
  createdAt: number; version: string; sourceId: string; channelId: string; sourceAccountId?: string; archiveId?: string; assets: ArchiveAsset[]; quote?: unknown };
export type ArchiveTopic = { id: string; title: string; issueSummary?: string; question?: string; preview?: string; sourceId: string; channelId: string; sourceAccountId?: string; revision: number; inputRevision: number; status: string; category?: string; updatedAt: number; messageCount?: number; summary?: string; lastAnswer?: string; rootMessageId?: string };
export type ArchiveTopicDetail = ArchiveTopic & { messages: ArchiveMessage[]; messageCount: number; hasMoreMessages: boolean };
export type TopicPage = { items: ArchiveTopic[]; hasMore: boolean; next?: { beforeUpdated: number; beforeId: string } };
export type ArchiveDirectory = { libraries: ArchiveLibrary[]; channels: ArchiveChannel[]; groups: ArchiveGroup[]; tools: ArchiveTool[] };
export type TopicContext = { items: ArchiveMessage[]; hasBefore?: boolean; hasAfter?: boolean };
export type TopicTarget = { id?: string; kind?: 'workspace' | 'session'; workspaceId: string; agentId: string; title?: string; provider?: string; model?: string; thinkingOptionId?: string; permissionLabel?: string; status?: string; cwd?: string; hostWorkspaceId?: string };
export const TOPIC_NOTE_LIMIT = 8000;
export const topicNoteSchema = z.string().max(TOPIC_NOTE_LIMIT);
export const topicNewSessionSchema = z.object({ provider: id, model: id, thinkingOptionId: id.optional(), modeId: id.optional() });
export type TopicNewSession = z.infer<typeof topicNewSessionSchema>;
export type TopicModel = TopicNewSession & { label: string; isDefault: boolean;
  thinkingOptions?: Array<{ id: string; label: string; isDefault?: boolean }>; defaultThinkingOptionId?: string;
  permissionModes?: Array<{ id: string; label: string }>; permissionsUnavailable?: boolean };
export const topicSessionPreferencesSchema = z.object({ destination: z.enum(['existing','new']).default('existing'),
  newSession: topicNewSessionSchema.optional(), targetId: id.optional(),material:topicMaterialSettingsSchema.optional() });
export type TopicSessionPreferences = z.infer<typeof topicSessionPreferencesSchema>;
const messageRef = z.object({ id, version: z.string().min(1).max(512), contextOf: id.optional(),editedText:z.string().max(120000).optional() });
const assetRef = z.object({ id, messageId: id, messageVersion: z.string().min(1).max(512), contextOf: id.optional() });
export const topicSelectionSchema = z.object({
  topicId: id, revision: z.number().int().nonnegative(), inputRevision: z.number().int().nonnegative(),
  messages: z.array(messageRef).max(100), assets: z.array(assetRef).max(20), includeAnalysis: z.boolean().default(false),
});
export type TopicSelection = z.infer<typeof topicSelectionSchema>;
export type SelectedTopic = { topic: ArchiveTopicDetail; messages: ArchiveMessage[]; assetIds: string[]; includeAnalysis: boolean; contexts: Record<string, string>;editedTexts?:Record<string,string> };
export type TopicMaterialPreview = {
  id: string; workspaceId: string; text: string; createdAt: number; state: 'preview' | 'sending' | 'accepted' | 'uncertain';
  topics: Array<{ id: string; title: string; revision: number; inputRevision: number; messageCount: number; assetCount: number }>;
  assets: Array<{ id: string; name: string; mimeType: string; sha256: string; size: number }>;
  messageId?: string; readConfirmed: false;
  targetId?: string;
  targetAgentId?: string; note?: string; newSession?: TopicNewSession;
};
export const topicActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('directory'), libraryId: id.optional() }),
  z.object({ action: z.literal('list'), query: z.string().max(500).default(''), group: watchedGroupSchema.optional(), beforeUpdated: z.number().int().nonnegative().optional(), beforeId: id.optional(), limit: z.number().int().min(1).max(50).default(30) }),
  z.object({ action: z.literal('read'), topicId: id }),
  z.object({ action: z.literal('messages'), topicId: id, offset: z.number().int().min(0).max(100000) }),
  z.object({ action: z.literal('context'), topicId: id, messageId: id }),
  z.object({ action: z.literal('asset'), topicId: id, messageId: id, assetId: id, contextOf: id.optional(), part: z.enum(['original','video-preview','thumbnail']).optional(), view: z.literal('thumbnail').optional() }),
  z.object({ action: z.literal('group.configure'), sourceId: id, channelId: id, revision: z.number().int().nonnegative(), collect: z.boolean().optional(), allowedTools: z.array(id).max(32), requestId: id }),
  z.object({ action: z.literal('targets') }),
  z.object({ action: z.literal('models') }),
  z.object({ action: z.literal('preferences'), value: topicSessionPreferencesSchema.optional() }),
  z.object({ action: z.literal('preview'), workspaceId: id.optional(), targetId: id.optional(), newSession: topicNewSessionSchema.optional(), note: topicNoteSchema.optional(),content:topicContentOptionsSchema.optional(), selections: z.array(topicSelectionSchema).min(1).max(20) })
    .refine(value => !value.newSession || !value.workspaceId && !value.targetId, 'topic_target_conflict'),
  z.object({ action: z.enum(['send', 'receipt']), id }),
]);
export type TopicAction = z.infer<typeof topicActionSchema>;
export const archiveTopicsRpc = defineRpc({
  name: 'workspace.workbench.archive-topics',
  input: z.object({ projectConfig: z.string().min(1), extensionId: z.literal('project-communications'), connectionRevision: z.number().int().positive(), request: topicActionSchema }),
  output: z.unknown(),
});
export const archiveTopicsDeliveryRpc = defineRpc({ name: 'workspace.workbench.archive-topics-delivery', input: archiveTopicsRpc.input, output: archiveTopicsRpc.output });
export function groupKey(group: WatchedGroup) { return JSON.stringify([group.sourceId, group.channelId]); }
export function senderName(message: ArchiveMessage) { return typeof message.sender === 'string' ? message.sender : message.sender?.displayName || message.sender?.name || message.sender?.id || '未知作者'; }
export function assetIsImage(asset: ArchiveAsset) { return asset.kind === 'image' || Boolean(asset.mimeType?.startsWith('image/')); }
export function assetIsVideo(asset: ArchiveAsset) { return asset.kind === 'video' || asset.mimeType === 'video' || Boolean(asset.mimeType?.startsWith('video/')); }
export { messageText, topicTime, topicTitle } from './topic-presentation.ts';
