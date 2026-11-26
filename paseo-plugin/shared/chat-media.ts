import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const chatMediaKind = 'workbench-chat-media';
export const chatMediaSchema = z.object({ receiptId: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string().min(1).max(512) });
export type ChatMedia = z.infer<typeof chatMediaSchema>;
export type ChatMediaFile = { assetId: string; name: string; mimeType: string; size: number; available: boolean };
export const chatMediaRpc = defineRpc({ name: 'workspace.workbench.chat-media',
  input: chatMediaSchema.extend({ agentId: z.string().min(1).max(512), assetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    action: z.enum(['read', 'download', 'chunk']).default('read'), offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), revision:z.string().regex(/^[a-f0-9]{64}$/).optional() }), output: z.unknown() });
