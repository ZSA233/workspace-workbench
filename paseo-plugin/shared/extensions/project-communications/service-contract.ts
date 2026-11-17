// TypeScript client SDK for Project Communications API v1.
// API-v1 compatibility fixtures are frozen in tests/fixtures/communications-protocol-v1.json.
// The independent service repository validates the same versioned protocol.
import { z } from 'zod';

export const categorySchema = z.enum(['requirement', 'change', 'feedback', 'bug', 'decision']);
export type Category = z.infer<typeof categorySchema>;
export const categoryLabels: Record<Category, string> = { requirement: '新增需求', change: '需求变更', feedback: '反馈', bug: '缺陷', decision: '决策' };
export const modelConfigSchema = z.object({ protocol: z.literal('chat-completions').default('chat-completions'), baseUrl: z.string().url().default('http://127.0.0.1:12345/v1'),
  model: z.string().max(512).default(''), timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  contextTokens: z.number().int().min(4096).max(4194304).default(131072), outputTokens: z.number().int().min(256).max(131072).default(8192),
  modelLimit: z.number().int().min(4096).max(4194304).default(524288), vision: z.boolean().default(true) }).default({ protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:12345/v1', model: '', timeoutMs: 180000, contextTokens: 131072, outputTokens: 8192, modelLimit: 524288, vision: true });
export const configSchema = z.object({
  source: z.object({ executable: z.string().min(1).max(2048).default('dws'), mode: z.enum(['default', 'custom']).default('custom'),
    clientId: z.string().max(512).default(''), profile: z.string().max(512).default(''), botId: z.string().max(512).default('') }).default({ executable: 'dws', mode: 'custom', clientId: '', profile: '', botId: '' }),
  model: modelConfigSchema,
  analysis: z.object({ enabled: z.boolean().default(true), coalesceSeconds: z.number().int().min(1).max(3600).default(30),
    reconcileSeconds: z.number().int().min(15).max(3600).default(60), focusPeople: z.array(z.string().max(200)).max(100).default([]),
    keywords: z.array(z.string().max(200)).max(100).default([]), categories: z.array(categorySchema).min(1).default(['requirement', 'change', 'feedback', 'bug', 'decision']),
    instructions: z.string().max(16000).default('保留讨论上下文，识别明确的需求、变更、反馈、缺陷和决策；不确定内容标为待核实。') }).default({ enabled: true, coalesceSeconds: 30, reconcileSeconds: 60, focusPeople: [], keywords: [], categories: ['requirement', 'change', 'feedback', 'bug', 'decision'], instructions: '保留讨论上下文，识别明确的需求、变更、反馈、缺陷和决策；不确定内容标为待核实。' }),
}).superRefine((value, ctx) => {
  if (value.model.contextTokens > value.model.modelLimit) ctx.addIssue({ code: 'custom', message: '上下文预算超过模型上限', path: ['model', 'contextTokens'] });
  if (value.model.outputTokens >= value.model.contextTokens) ctx.addIssue({ code: 'custom', message: '输出预留必须小于上下文预算', path: ['model', 'outputTokens'] });
  let url:URL;try{url=new URL(value.model.baseUrl);}catch{return;}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) ctx.addIssue({ code: 'custom', message: '模型地址必须是无凭证、无查询参数的 HTTP(S) 地址', path: ['model', 'baseUrl'] });
});
export type CommunicationsConfig = z.infer<typeof configSchema>;
export function defaultCommunicationsConfig(): CommunicationsConfig { return configSchema.parse({}); }
export type Capability = { state: 'pending' | 'verified' | 'unavailable' | 'failed'; detail?: string; checkedAt?: string };
export type SourceStatus = { installed: boolean; version?: string; authenticated: boolean; identity?: { profile: string; corpId: string; userId: string; clientId?: string };
  state: 'not-installed' | 'unauthorized' | 'ready' | 'failed'; detail?: string; capabilities: { messages: Capability; history: Capability; attachments: Capability } };
export type Group = { id: string; name: string; boundAt: number; checkpoint: number; generation: number; enabled: boolean;
  identity?: string;
  membership: Capability; stream: Capability; history: Capability; status: 'pending' | 'syncing' | 'ready' | 'partial' | 'paused' | 'failed';
  lastEventAt?: number; lastCheckedAt?: number; error?: string; cursor?: string; window?: { start: number; end: number }; };
export type GroupDirectoryPage = { items: Array<{ id: string; name: string }>; hasMore: boolean; nextCursor: string; complete: boolean; partial: boolean };
export type Attachment = { id: string; name: string; mimeType: string; size?: number; state: 'pending' | 'ready' | 'unsupported' | 'failed';
  sourceId: string; resourceType?: 'mediaId' | 'fileId'; error?: string; analysisState?: 'ready' | 'unsupported'; analysisNote?: string; };
export type Message = { id: string; sourceId: string; groupId: string; senderId: string; sender: string; text: string; createdAt: number; updatedAt: number;
  version: string; replyTo?: string; mentions: string[]; attachments: Attachment[]; raw?: unknown; };
export type Candidate = { id: string; groupId: string; category: Category; title: string; body: string; evidenceIds: string[];
  relatedRequirementId?: string; expectedVersion?: number; uncertainty: string; status: 'pending' | 'accepted' | 'ignored' | 'snoozed'; unread: boolean; createdAt: number;
  requirementId?: string; acceptedVersion?: number; revision: number; };
export type Requirement = { id: string; number: number; title: string; body: string; category: Category; version: number; evidenceIds: string[]; createdAt: number; updatedAt: number; };
export type Task = { id: string; kind: 'auth' | 'connection' | 'models' | 'generation' | 'sync' | 'analysis'; state: 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; detail?: string; authUrl?: string; groupId?: string; error?: string; result?: unknown; };
export type Delivery = { id: string; identity: string; requirementId: string; requirementVersion: number; workspaceId: string; messageIds: string[]; attachmentIds: string[];
  materials?: Array<{id:string;title:string;mimeType:string;size:number;digest:string}>;
  text: string; state: 'preview' | 'sending' | 'accepted' | 'uncertain'; createdAt: number; messageId?: string; readConfirmed: false; };
export type Snapshot = { revision: number; modelScope?: 'service' | 'project'; modelRevision?: number; background: 'running' | 'paused'; config: CommunicationsConfig; credentials: { modelKey: boolean; appSecret: boolean }; source: SourceStatus;
  groups: Group[]; candidates: Candidate[]; requirements: Requirement[]; requirementCount:number; tasks: Task[]; unread: number; pending: number; messageCount: number; analysisPending: number; };
const target = z.string().min(1).max(512);
export const communicationsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }),
  z.object({ action: z.literal('configure'), revision: z.number().int(), config: configSchema, modelScope:z.enum(['service','project']).optional(), modelKey: z.string().max(16384).optional(), appSecret: z.string().max(16384).optional() }),
  z.object({ action:z.literal('model.settings.read') }),
  z.object({ action:z.literal('model.settings.configure'),revision:z.number().int(),model:modelConfigSchema,modelKey:z.string().max(16384).optional() }),
  z.object({ action:z.literal('model.binding'),scope:z.enum(['service','project']) }),
  z.object({ action: z.enum(['connection.check', 'auth.start', 'models.check', 'generation.check', 'analysis.retry']) }),
  z.object({ action: z.literal('groups.search'), query: z.string().min(1).max(200) }),
  z.object({ action: z.literal('groups.list'), query: z.string().max(200).default(''), cursor: z.string().max(512).default(''), limit: z.number().int().min(1).max(100).default(50) }),
  z.object({ action: z.literal('groups.bind'), groupId: target, name: z.string().min(1).max(512) }),
  z.object({ action: z.enum(['groups.pause', 'groups.resume', 'groups.remove', 'sync.start']), groupId: target }),
  z.object({ action: z.literal('history.start'), groupId: target, start:z.number().int().nonnegative(),end:z.number().int().positive() }).refine(value=>value.start<value.end),
  z.object({ action:z.enum(['history.pause','history.resume','history.status']),id:target }),
  z.object({ action: z.literal('messages.list'), groupId: target.optional(), query: z.string().max(500).default(''), before: z.number().optional(), beforeId: target.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  z.object({ action: z.literal('messages.read'), ids: z.array(target).max(100) }),
  z.object({ action: z.literal('attachment.read'), id: target }),
  z.object({ action:z.literal('candidate.list'),query:z.string().max(500).default(''),includeSnoozed:z.boolean().default(false),before:z.object({time:z.number(),id:target}).optional(),limit:z.number().int().min(1).max(100).default(50) }),
  z.object({ action:z.literal('requirement.list'),query:z.string().max(500).default(''),before:z.number().int().positive().optional(),limit:z.number().int().min(1).max(100).default(50) }),
  z.object({ action: z.enum(['candidate.read', 'candidate.ignore', 'candidate.snooze']), id: target }),
  z.object({ action: z.enum(['candidate.preview', 'candidate.accept']), id: target, revision: z.number().int(), title: z.string().min(1).max(500), body: z.string().min(1).max(32000), relatedRequirementId: target.optional(), expectedVersion: z.number().int().nonnegative().optional() }),
  z.object({ action: z.literal('requirement.history'), id: target }),
  z.object({ action: z.literal('delivery.preview'), requirementId: target, version: z.number().int(), workspaceId: target, messageIds: z.array(target).max(100), attachmentIds: z.array(target).max(20) }),
  z.object({ action: z.literal('delivery.targets') }),
  z.object({ action: z.enum(['delivery.send', 'delivery.status']), id: target }),
]);
export type CommunicationsAction = z.infer<typeof communicationsActionSchema>;
export type CandidateProposal = Pick<Candidate, 'title' | 'body' | 'category' | 'evidenceIds' | 'relatedRequirementId' | 'uncertainty'>;
