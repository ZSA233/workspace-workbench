import { z } from 'zod';
import type {TopicStoredVideo} from './topic-video.ts';

const id = z.string().min(1).max(512);
export const topicChatMediaKind = 'workbench-topic-images';
export const topicChatMediaSchema = z.object({ projectConfig: z.string().min(1), materialId: id, messageId: id.optional(), hidden: z.boolean().optional() });
export type TopicChatMedia = z.infer<typeof topicChatMediaSchema>;
export type TopicChatImage = {assetId:string;name:string;mimeType:string};
export type TopicChatVideo = TopicStoredVideo & {mimeType:string};
