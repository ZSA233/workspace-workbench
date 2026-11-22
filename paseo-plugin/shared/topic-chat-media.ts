import { z } from 'zod';

const id = z.string().min(1).max(512);
export const topicChatMediaKind = 'workbench-topic-images';
export const topicChatMediaSchema = z.object({ projectConfig: z.string().min(1), materialId: id });
export type TopicChatMedia = z.infer<typeof topicChatMediaSchema>;
export type TopicChatImage = {assetId:string;name:string;mimeType:string};
