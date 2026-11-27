import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const productionState = z.enum(['deployed', 'partial', 'pending', 'unknown', 'discussion']);
export type ProductionState = z.infer<typeof productionState>;
export const defaultMarkers: Record<ProductionState, string> = { deployed: '✓', partial: '◐', pending: '○', unknown: '?', discussion: '·' };
export const productionLabels: Record<ProductionState, string> = { deployed: '已上线', partial: '部分上线', pending: '未上线', unknown: '待核实', discussion: '讨论中' };
export const defaultOrganizerPrompt = '使用简体中文，提炼具体模块和行为，保留主要需求。名称仅作为弱线索；不要把合入的其他分支功能、版本号、构建产物和发布操作当成主要需求。不因同义表述改变已接受的标题。信息不足时说明缺失，不编造需求。';
export const modelProfileSchema = z.object({
  id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(), model: z.string().trim().min(1).max(300),
  contextTokens: z.number().int().min(1024).max(131072).default(16384),
  outputTokens: z.number().int().min(128).max(8192).default(2048),
  timeoutMs: z.number().int().min(1000).max(300000).default(120000),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export const organizerPolicySchema = z.object({
  enabled: z.boolean().default(false), profileId: z.string().default(''),
  mode: z.enum(['automatic', 'selected', 'exclude']).default('automatic'),
  selectedIds: z.array(z.string()).max(1000).default([]), excludedIds: z.array(z.string()).max(1000).default([]),
  prompt: z.string().max(16000).default(defaultOrganizerPrompt), titleLength: z.number().int().min(4).max(40).default(16),
  namingMode: z.enum(['latest','overall','custom']).default('latest'),
  markers: z.object({ deployed: z.string().max(16), partial: z.string().max(16), pending: z.string().max(16), unknown: z.string().max(16), discussion: z.string().max(16) }).default(defaultMarkers),
  productionBranches: z.record(z.string(), z.string().trim().max(512)).default({}),
  conversationSummary: z.boolean().default(true), debounceSeconds: z.number().int().min(0).max(600).default(30),
  analysisIntervalSeconds: z.number().int().min(0).max(86400).default(300),
  fetchIntervalSeconds: z.number().int().min(60).max(86400).default(900),
  modelConcurrency:z.number().int().min(1).max(4).default(1),
});
export type OrganizerPolicy = z.infer<typeof organizerPolicySchema>;
// Zod v4 applies inner defaults even through .partial(). Patches must contain only supplied keys.
export const organizerPatchSchema = z.object(Object.fromEntries(Object.entries(organizerPolicySchema.shape).map(([key, schema]) => [key, schema.removeDefault().optional()]))) as z.ZodType<Partial<OrganizerPolicy>>;
const action = <const T extends string>(name: T) => z.literal(name);
const ids = z.array(z.string().min(1)).max(200);
export const organizerRpc = defineRpc({
  name: 'workspace.workbench.organizer',
  input: z.object({ projectConfig: z.string().optional(), request: z.discriminatedUnion('action', [
    z.object({ action: action('settings.get') }),
    z.object({ action: action('settings.save'), scope: z.enum(['host', 'project']), revision: z.number().int(), patch: organizerPatchSchema, reset: z.array(z.string()).default([]) }),
    z.object({ action: action('profile.save'), revision: z.number().int(), profile: modelProfileSchema, secret: z.string().max(8192).optional() }),
    z.object({ action: action('profile.delete'), revision: z.number().int(), profileId: z.string() }),
    z.object({ action: action('profile.check'), profileId: z.string() }),
    z.object({ action: action('profile.probe'),profile:modelProfileSchema,secret:z.string().max(8192).optional() }),
    z.object({ action: action('profile.test'), profileId: z.string(), text: z.string().trim().min(1).max(32000), prompt: z.string().max(16000).optional() }),
    z.object({ action: action('profile.test.result'),testId:z.string().min(1) }),
    z.object({ action: action('profile.test.cancel'),testId:z.string().min(1) }),
    z.object({ action: action('profile.tests') }),
    z.object({ action: action('snapshot'), hostWorkspaceId: z.string().optional() }),
    z.object({ action: action('session.refresh'), targetId:z.string().min(1), preview:z.boolean().default(false), force:z.boolean().default(false) }),
    z.object({ action: action('session.apply'), targetId:z.string().min(1), previewId:z.string().min(1) }),
    z.object({ action: action('session.automatic'), targetId:z.string().min(1), enabled:z.literal(false) }),
    z.object({ action: action('session.associations'), targetId:z.string().min(1) }),
    z.object({ action: action('session.associations.save'), targetId:z.string().min(1), revision:z.string().min(1), workspaceKeys:z.array(z.string().min(1)).max(1000) }),
    z.object({ action: action('status') }),
    z.object({ action: action('refresh'), hostWorkspaceId: z.string().optional(), workspaceIds:ids.optional(), forceFetch: z.boolean().default(false), productionOnly: z.boolean().optional(), productionBranches: z.record(z.string(), z.string()).optional() }),
    z.object({ action: action('analyze'), hostWorkspaceId: z.string().optional(), workspaceIds: ids.optional(), conversation: z.boolean().default(true), regenerate: z.boolean().default(false) }),
    z.object({ action: action('job'), jobId: z.string() }), z.object({ action: action('cancel'), jobId: z.string() }),
    z.object({ action: action('resume'), jobId: z.string() }), z.object({ action: action('run'), runId: z.string() }),
    z.object({ action: action('apply'), targetIds: ids, revision: z.number().int(), maintain: z.boolean().default(true) }),
    z.object({ action: action('target.policy'), targetId: z.string(), policy: z.enum(['preview','auto', 'symbols', 'excluded']) }),
    z.object({ action: action('restore'), targetId: z.string() }),
    z.object({ action: action('item.update'), owner: z.string(), itemId: z.string(), revision: z.number().int(), text: z.string().trim().min(1).max(2000).optional(), state: z.enum(['todo', 'done', 'cancelled', 'confirm']).optional() }),
    z.object({ action: action('conversation.reset'), agentId: z.string().min(1) }),
    z.object({ action: action('summary.edit'), workspaceKey: z.string(), revision: z.number().int(), title: z.string().trim().min(1).max(80), brief: z.string().max(4000) }),
  ]) }),
  output: z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
});
export type OrganizerInput = z.infer<typeof organizerRpc.input>;
export type OrganizerEvidence = { id: string; kind: 'goal' | 'commit' | 'note' | 'message' | 'diff' | 'hint'; text: string; repository?: string; sha?: string };
export type OrganizerItem = { id: string; text: string; state: 'todo' | 'done' | 'cancelled' | 'confirm'; evidenceIds: string[]; manual?: boolean };
export type RepositoryCoverage = { repositoryId: string; repoPath: string; sourcePath?:string; productionRef: string; baseSha?: string; head?: string; productionSha?: string; state: ProductionState; reason?: string; covered: number; pending: number; uncertain: number; dirty: boolean; observedAt: string };
export type WorkspaceMaterial = { workspaceId: string; instance: string; name: string; createdAt: string; activityAt: string; latestCommitAt?:string|null; creatorAgentId?: string; taskBrief: string; taskKind?: string; fingerprint: string; evidence: OrganizerEvidence[]; repositories: RepositoryCoverage[]; state: ProductionState; complete: boolean };
export type WorkspaceDigest = { version:1; title:string; brief:string; fingerprint:string; at:string; evidenceIds:string[]; partial:boolean };
export type SessionTitlePreview = { id:string; body:string; title:string; sourceFingerprint:string; configurationFingerprint:string; contentConfigurationFingerprint?:string; at:string; runId?:string; evidenceIds:string[]; conversationComplete:boolean; reviewedWriteId?:string; messageHeads?:Record<string,{epoch:string;seq:number}> };
export type SessionTitleMaintenance = { version:1; enabled:boolean; controlRevision?:number; acceptedBody?:string; preview?:SessionTitlePreview; materialFingerprint?:string; configurationFingerprint?:string; paused?:string; error?:string; lastAttemptAt?:string };
export type WorkspaceAnalysis = { key: string; material: WorkspaceMaterial; materialCache?:{stamp:string;fingerprint:string;at:string}; digest?:WorkspaceDigest; sources?:OrganizerEvidence[]; title: string; proposedTitle?: string; brief: string; items: OrganizerItem[]; fingerprint?: string; analyzedAt?: string; lastAttemptAt?:string; manual?: boolean; error?: string };
export type SessionWorkspaceAssociation = { workspaceId:string; source:'automatic'|'manual'; included:boolean; at:string };
export type SessionAssociations = { targetId:string; title?:string|null; revision:string; workspaces:Array<{key:string;id:string;name:string;title?:string;linked:boolean;source?:'automatic'|'manual'}> };
export type OrganizerTarget = { id: string; agentIds: string[]; workspaceKeys: string[]; workspaceLinks?:Record<string,SessionWorkspaceAssociation>; currentTitle: string | null; session?:SessionTitleMaintenance; previewTitle?: string; body?: string; representative?: string; state: ProductionState; policy: 'preview' | 'auto' | 'symbols' | 'excluded' | 'paused'; originalTitle?: string | null; lastWritten?: string | null; reason?: string; pendingWrite?: { from: string | null; to: string | null; id: string }; uncertainWrites?:Array<{from:string|null;to:string|null;id:string}>; history: Array<{ at: string; from: string | null; to: string; representative?: string }> };
export type ConversationAnalysis = { agentId: string; brief: string; items: OrganizerItem[]; cursor?: { epoch: string; seq: number }; fingerprint?: string; complete: boolean; startedAtBeginning?: boolean; pendingMessage?: { seq: number; offset: number }; error?: string; updatedAt: string; lastAttemptAt?:string; evidence: OrganizerEvidence[] };
export type OrganizerModelPhase = 'checking' | 'requesting' | 'validating' | 'complete' | 'failed';
export type OrganizerContextBudget={contextTokens:number;outputTokens:number;reservedTokens:number;promptBytes:number;inputBytes:number;selectedSources:number;totalSources:number;selectedFragments:number;totalFragments:number};
export type OrganizerRun = { id: string; kind: 'workspace' | 'conversation' | 'session'; owner: string; at: string; profileId: string; model?:string; endpoint?:string; references?:Record<string,string>; contextBudget?:OrganizerContextBudget; prompt: string; input: string; output?: string; truncated: boolean; elapsedMs?: number; usage?: Record<string, unknown>; error?: string; state?: OrganizerModelPhase; requestedAt?:string; finishedAt?:string };
export type OrganizerModelTest={id:string;state:'queued'|'running'|'complete'|'failed'|'cancelled'|'interrupted';createdAt:string;run?:OrganizerRun;error?:string};
export type OrganizerJobOptions = { workspaceIds?:string[]; hostWorkspaceId?:string; analyze:boolean; conversation:boolean; regenerate:boolean; automatic:boolean; fetch:boolean; forceFetch?:boolean; productionOnly?:boolean };
export type OrganizerStage = 'queued'|'discovering'|'materials'|'production'|'fetching'|'model-queued'|OrganizerModelPhase|'conversation'|'verifying'|'titles'|'finished';
export type OrganizerJob = { id: string; state: 'queued' | 'running' | 'complete' | 'cancelled' | 'interrupted' | 'failed'; workspaceIds: string[]; completed: number; total: number; createdAt: string; updatedAt: string; error?: string;
  kind?:'refresh'|'production'|'analysis'|'regenerate'|'session'; hostWorkspaceId?:string; options?:OrganizerJobOptions; startedAt?:string; stage?:OrganizerStage; stageAt?:string; cancelRequestedAt?:string;
  intent?:{preview:boolean;title?:boolean;summaries?:number};
  input?:{workspaces:Array<{id:string;name:string;repositories:number;commits:number;notes:number;diffs:number;cached:boolean;materialCached?:boolean;updated?:boolean}>;history:{pages:number;fragments:number;sentFragments?:number;complete:boolean}};
  current?:{workspaceId?:string;name?:string;repository?:string;ref?:string;repositoryCount?:number;agentId?:string;page?:number};
  model?:{profileId?:string;name?:string;model?:string;state:'not-requested'|'queued'|OrganizerModelPhase;calls:number;completed:number;reason?:'automatic-off'|'production-only'|'cached'|'no-material'|'no-profile'|'interval'|'scope';runId?:string;requestedAt?:string;timeoutMs?:number};
  result?:{analyzed:number;cached:number;skipped:number;failed:number;titleWrites:number;conversations:number;previewReady?:boolean};
  events?:Array<{at:string;stage:OrganizerStage;workspaceId?:string;message:string;current?:OrganizerJob['current']}>;
};
export type OrganizerSnapshot = { revision: number; workspaces: WorkspaceAnalysis[]; targets: OrganizerTarget[]; conversations: ConversationAnalysis[]; jobs: OrganizerJob[]; runs: OrganizerRun[]; unlinked: string[]; error?: string };

export function organizerStep(job:OrganizerJob|undefined,hasPreview:boolean,applied:boolean):number {
  if(job&&(job.state==='running'||job.state==='queued')){if(job.stage==='titles')return 3;return job.model&&job.model.state!=='not-requested'?1:0;}
  return hasPreview?applied?4:2:0;
}

export function aggregateProduction(states: ProductionState[]): ProductionState {
  if (!states.length || states.every(s => s === 'discussion')) return 'discussion';
  if (states.some(s => s === 'unknown')) return 'unknown';
  if (states.every(s => s === 'deployed')) return 'deployed';
  if (states.some(s => s === 'deployed' || s === 'partial')) return 'partial';
  return states.some(s => s === 'pending') ? 'pending' : 'discussion';
}
export function aggregateRepositoryProduction(states:ProductionState[]):ProductionState {return aggregateProduction(states.filter(state=>state!=='discussion'));}
export function representativeWorkspace(workspaces: WorkspaceAnalysis[]): WorkspaceAnalysis | undefined {
  const rank = (s: ProductionState) => s === 'pending' || s === 'partial' ? 0 : s === 'unknown' || s === 'discussion' ? 1 : 2;
  return [...workspaces].sort((a, b) => rank(a.material.state) - rank(b.material.state) || (Date.parse(b.material.activityAt)||0)-(Date.parse(a.material.activityAt)||0) || a.key.localeCompare(b.key))[0];
}
export function stripOrganizerMarker(title:string,policy:OrganizerPolicy):string {
  const marker=[...new Set([...Object.values(policy.markers),...Object.values(defaultMarkers)])].filter(Boolean).sort((a,b)=>b.length-a.length).find(marker=>title.startsWith(marker+' '));
  return marker?title.slice(marker.length+1):title;
}
export function formatOrganizerTitle(body: string, state: ProductionState, policy: OrganizerPolicy, preserveBody=false): string {
  const clean = body.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const marker = policy.markers[state].replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return [marker, preserveBody?clean:[...clean].slice(0, policy.titleLength).join('')].filter(Boolean).join(' ');
}
