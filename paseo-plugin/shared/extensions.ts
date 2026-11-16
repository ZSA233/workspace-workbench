import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const EXTENSION_API_VERSION = 1;
export type ExtensionManifest = {
  id: string; version: string; apiVersion: number; name: string; description: string;
  contributions: { tab?: string; settings: boolean; unread: boolean };
  capabilities: Array<'project-data' | 'background' | 'materials' | 'session-delivery'>;
};
export type ExtensionState = { manifest: ExtensionManifest; enabled: boolean; state: 'disabled' | 'starting' | 'ready' | 'failed'; error?: string; unread: number };
export const extensionsRpc = defineRpc({
  name: 'workspace.workbench.extensions',
  input: z.object({ projectConfig: z.string().min(1), extensionId: z.string().min(1),
    action: z.enum(['status', 'enable', 'disable']) }),
  output: z.custom<ExtensionState>(),
});

export const serviceConnectionSchema = z.object({
  endpoint: z.string().url().max(2048).superRefine((value, ctx) => {
    let url:URL;try{url=new URL(value);}catch{return;}
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) ctx.addIssue({ code:'custom', message:'服务地址需使用 HTTPS；本机可使用 HTTP，地址中不能包含凭证或查询参数' });
  }),
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
});
export type ServiceConnection = z.infer<typeof serviceConnectionSchema>;
export type ServiceConnectionStatus = { revision:number; connection:ServiceConnection; hasToken:boolean; localToken:boolean; connected?:boolean; detail?:string; serviceVersion?:string };
export const communicationsConnectionRpc = defineRpc({ name:'workspace.workbench.communications-connection',
  input:z.object({projectConfig:z.string().min(1),extensionId:z.literal('project-communications'),action:z.enum(['read','configure','check']),revision:z.number().int().optional(),connection:serviceConnectionSchema.optional(),token:z.string().max(16384).optional()}),
  output:z.custom<ServiceConnectionStatus>(),
});
