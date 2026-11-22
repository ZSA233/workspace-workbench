import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
import {topicChatMediaSchema} from './topic-chat-media.ts';

export const topicChatMediaRpc=defineRpc({name:'workspace.workbench.topic-chat-media',
  input:topicChatMediaSchema.extend({agentId:z.string().min(1).max(512),assetId:z.string().min(1).max(512).optional()}),output:z.unknown()});
