import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
import {topicChatMediaSchema} from './topic-chat-media.ts';

export const topicChatMediaRpc=defineRpc({name:'workspace.workbench.topic-chat-media',
  input:topicChatMediaSchema.extend({agentId:z.string().min(1).max(512),assetId:z.string().min(1).max(512).optional(),action:z.enum(['read','download','chunk']).default('read'),
    offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),revision:z.string().regex(/^[a-f0-9]{64}$/).optional()}),output:z.unknown()});
