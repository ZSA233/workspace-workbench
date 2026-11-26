import { OrganizerModelQueue } from './model-queue.ts';
import { randomUUID } from 'node:crypto';
import type { PaseoApi, PaseoAgent } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { organizerRpc, aggregateProduction, representativeWorkspace, formatOrganizerTitle, stripOrganizerMarker, type OrganizerInput, type OrganizerSnapshot, type OrganizerTarget, type WorkspaceMaterial, type WorkspaceAnalysis, type OrganizerEvidence, type ConversationAnalysis, type OrganizerJob, type OrganizerPolicy, type OrganizerRun } from '../../shared/organizer.ts';
import { resolveProject, withProject, type ProjectRoute } from '../projects.ts';
import { queryObserver } from '../observer.ts';
import { allAgentBindings } from '../agent-store.ts';
import { OrganizerSettings, OrganizerStore, OrganizerTestStore, organizerHash, type OrganizerLedger } from './storage.ts';
import { callOrganizerModel, checkOrganizerModel, mergeOrganizerItems, retainOrganizerSources } from './model.ts';
import { conversationBatch } from './conversation.ts';

type Dependencies = { api(): Promise<PaseoApi>; query?: typeof queryObserver; settings?: OrganizerSettings;legacyBranches?():Promise<Record<string,string>> };
type JobOptions = { workspaceIds?: string[]; analyze: boolean; conversation: boolean; regenerate: boolean; automatic: boolean; fetch: boolean; forceFetch?: boolean };
const now = () => new Date().toISOString();
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const matches = (ids: string[], target: OrganizerTarget) => ids.includes(target.id) || target.workspaceKeys.some(key => ids.includes(key) || ids.includes(key.split(':')[0]));
const visible = (policy: OrganizerPolicy, target: OrganizerTarget) => !matches(policy.excludedIds, target) && (policy.mode !== 'selected' || matches(policy.selectedIds, target));

export class OrganizerService {
  readonly settings: OrganizerSettings;
  private deps: Dependencies;
  private query: typeof queryObserver;
  private stores = new Map<string, OrganizerStore>();
  private running = new Map<string, { abort: AbortController; promise: Promise<void>; project: string; options: JobOptions }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fetches = new Map<string, {at:number;state:string}>();
  private modelQueue:OrganizerModelQueue;
  private testStore:OrganizerTestStore;
  private projectTails = new Map<string, Promise<unknown>>();
  private tests = new Map<string,AbortController>();
  private closed = false;
  constructor(deps: Dependencies) { this.deps = deps; this.query = deps.query || queryObserver; this.settings = deps.settings || new OrganizerSettings();this.modelQueue=new OrganizerModelQueue(()=>this.settings.response().effective.modelConcurrency);this.testStore=new OrganizerTestStore(this.settings.root);this.testStore.recover(); }
  store(route: ProjectRoute) {
    let value = this.stores.get(route.configPath);
    if (!value) { value = new OrganizerStore(route, this.settings.root); value.recover(); this.stores.set(route.configPath, value); }
    return value;
  }
  private async read(route: ProjectRoute, method: Parameters<typeof queryObserver>[0]['method'], params: Record<string, unknown> = {}) {
    const result = await withProject({ projectConfig: route.configPath }, () => this.query({ method, params }));
    if (!result.ok) throw Error(result.error?.message || 'organizer_backend_unavailable');
    return result.result as Record<string, any>;
  }
  snapshot(route: ProjectRoute, hostWorkspaceId?: string): OrganizerSnapshot {
    const l = this.store(route).read(), targets = Object.values(l.targets).filter(t => !hostWorkspaceId || t.id === hostWorkspaceId);
    const keys = new Set(targets.flatMap(t => t.workspaceKeys)), agents = new Set(targets.filter(t=>t.workspaceKeys.length).flatMap(t => t.agentIds));
    return { revision: l.revision, workspaces: Object.values(l.workspaces).filter(w => keys.has(w.key)||!hostWorkspaceId&&l.unlinked.includes(w.material.workspaceId)), targets,
      conversations: Object.values(l.conversations).filter(c => agents.has(c.agentId)), jobs: l.jobs.slice(-15).reverse(), runs: l.runs.slice(-20).reverse(), unlinked: l.unlinked, error: l.error };
  }
  private async syncLegacy(route:ProjectRoute,values?:Record<string,string>){if(values||this.deps.legacyBranches)this.settings.importLegacyBranches(route,values||await this.deps.legacyBranches!());}
  async request(input: OrganizerInput): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      if (this.closed) throw Error('organizer_closed');
      const request = input.request, route = input.projectConfig ? resolveProject(input) : undefined;
      if (request.action === 'settings.get') {if(route)await this.syncLegacy(route);return { ok: true, result: this.settings.response(route) };}
      if (request.action === 'settings.save') {
        const result = this.settings.save(request.scope, request.revision, request.patch, request.reset, route);
        // Requests already in flight must not publish a result made with old settings.
        for (const run of this.running.values()) if (!route || run.project === route.configPath) run.abort.abort();
        return { ok: true, result };
      }
      if (request.action === 'profile.save') { this.settings.saveProfile(request.revision, request.profile, request.secret); for (const run of this.running.values()) run.abort.abort(); return { ok: true, result: this.settings.response(route) }; }
      if (request.action === 'profile.delete') { this.settings.deleteProfile(request.revision, request.profileId); for (const run of this.running.values()) run.abort.abort(); return { ok: true, result: this.settings.response(route) }; }
      if (request.action === 'profile.check') return { ok: true, result: await checkOrganizerModel(this.settings.profile(request.profileId), this.settings.secret(request.profileId)) };
      if(request.action==='profile.tests')return{ok:true,result:this.testStore.list()};
      if(request.action==='profile.test.result')return{ok:true,result:this.testStore.get(request.testId)};
      if(request.action==='profile.test.cancel'){this.tests.get(request.testId)?.abort();return{ok:true,result:this.testStore.get(request.testId)};}
      if (request.action === 'profile.test') {
        if(this.tests.size>=8)throw Error('organizer_queue_full');
        const profile=this.settings.profile(request.profileId),secret=this.settings.secret(profile.id),test=this.testStore.create(),revision=this.settings.read().revision;
        const policy={...this.settings.response(route).effective,...(request.prompt===undefined?{}:{prompt:request.prompt})};
        const abort=new AbortController();this.tests.set(test.id,abort);
        void this.model(async()=>{
          if(abort.signal.aborted||this.settings.read().revision!==revision)throw Error('organizer_settings_changed');
          this.testStore.update(test.id,{state:'running'});
          let run:OrganizerRun|undefined;
          try {await callOrganizerModel(profile,secret,policy,[{id:'test:input',kind:'goal',text:request.text}],undefined,'workspace','connection-test',abort.signal,value=>{run=value;});}
          finally{this.testStore.update(test.id,{state:abort.signal.aborted?'cancelled':run?.error?'failed':'complete',run});}
        }).catch(error=>{this.testStore.update(test.id,{state:abort.signal.aborted?'cancelled':'failed',error:failure(error)});}).finally(()=>this.tests.delete(test.id));
        return {ok:true,result:test};
      }
      if (!route) throw Error('project_context_required');
      const store = this.store(route);
      if (request.action === 'snapshot') return { ok: true, result: this.snapshot(route, request.hostWorkspaceId) };
      if (request.action === 'run') return { ok: true, result: store.run(request.runId) };
      if (request.action === 'refresh') {
        if(request.productionBranches)await this.syncLegacy(route,request.productionBranches);
        return { ok: true, result: this.enqueue(route, { analyze: true, conversation: true, regenerate: false, automatic: true, fetch: true, forceFetch: request.forceFetch }) };
      }
      if (request.action === 'analyze') return { ok: true, result: this.enqueue(route, { workspaceIds: request.workspaceIds, analyze: true, conversation: request.conversation, regenerate: request.regenerate, automatic: false, fetch: false }) };
      if (request.action === 'resume') {
        const old = store.read().jobs.find(j => j.id === request.jobId); if (!old) throw Error('organizer_job_missing');
        return { ok: true, result: this.enqueue(route, { workspaceIds: old.workspaceIds, analyze: true, conversation: true, regenerate: false, automatic: false, fetch: false }) };
      }
      if (request.action === 'cancel') { const running = this.running.get(request.jobId); if (running?.project === route.configPath) running.abort.abort(); return { ok: true, result: this.snapshot(route) }; }
      if (request.action === 'job') return { ok: true, result: store.read().jobs.find(j => j.id === request.jobId) || null };
      if (request.action === 'apply') {
        const frozen=store.read();
        if (frozen.revision !== request.revision) throw Error('organizer_preview_changed');
        const result: Array<{ id: string; error?: string }> = [];
        for (const id of request.targetIds) {
          try {
            const current=store.read(),before=frozen.targets[id],target=current.targets[id];
            if(!before||!target)throw Error('organizer_target_missing');
            if(before.policy!==target.policy||before.previewTitle!==target.previewTitle||JSON.stringify(before.workspaceKeys)!==JSON.stringify(target.workspaceKeys))throw Error('organizer_preview_changed');
            if(before.workspaceKeys.some(key=>frozen.workspaces[key]?.material.fingerprint!==current.workspaces[key]?.material.fingerprint))throw Error('organizer_source_changed');
            store.update(l => { const t = l.targets[id]; if (!t) throw Error('organizer_target_missing'); const w = t.representative && l.workspaces[t.representative]; if (w && w.proposedTitle) { w.title = w.proposedTitle; delete w.proposedTitle; } });
            await this.writeTarget(route, id, true, request.maintain); result.push({ id });
          } catch (error) { result.push({ id, error: failure(error) }); }
        }
        return { ok: true, result };
      }
      if (request.action === 'target.policy') {
        const current = await (await this.deps.api()).workspaces.ref(request.targetId).refresh();
        if (!current) throw Error('organizer_target_unavailable');
        store.update(l => { const t = l.targets[request.targetId]; if (!t) throw Error('organizer_target_missing'); t.policy = request.policy; t.currentTitle = current.title || null; t.lastWritten = current.title || null; if (request.policy === 'symbols') t.body = stripOrganizerMarker(current.title||'',this.settings.response(route).effective); t.reason = undefined; delete t.pendingWrite; this.projectTargets(l,this.settings.response(route).effective); });
        return { ok: true, result: this.snapshot(route) };
      }
      if (request.action === 'conversation.reset') {
        store.update(l => { const c = l.conversations[request.agentId]; if (c) { delete c.cursor; delete c.pendingMessage; delete c.fingerprint; c.startedAtBeginning = false; c.complete = false; c.updatedAt = ''; } });
        return { ok: true, result: this.snapshot(route) };
      }
      if (request.action === 'restore') { await this.restore(route, request.targetId); return { ok: true, result: this.snapshot(route) }; }
      if (request.action === 'item.update') {
        store.update(l => {
          if (l.revision !== request.revision) throw Error('organizer_preview_changed');
          const record = l.workspaces[request.owner] || l.conversations[request.owner];
          const item = record?.items.find(i => i.id === request.itemId); if (!item) throw Error('organizer_item_missing');
          if (request.text !== undefined) item.text = request.text;
          if (request.state !== undefined) item.state = request.state;
          item.manual = true;
        });
        return { ok: true, result: this.snapshot(route) };
      }
      if (request.action === 'summary.edit') {
        store.update(l => { if (l.revision !== request.revision) throw Error('organizer_preview_changed'); const w = l.workspaces[request.workspaceKey]; if (!w) throw Error('organizer_workspace_missing'); w.title = request.title; w.brief = request.brief; w.manual = true; delete w.proposedTitle; this.projectTargets(l, this.settings.response(route).effective); });
        return { ok: true, result: this.snapshot(route) };
      }
      throw Error('organizer_action_invalid');
    } catch (error) { return { ok: false, error: failure(error) }; }
  }
  private enqueue(route: ProjectRoute, options: JobOptions): OrganizerJob {
    if (this.closed) throw Error('organizer_closed');
    const duplicate = [...this.running.entries()].find(([, run]) => run.project === route.configPath && organizerHash(run.options) === organizerHash(options));
    if (duplicate) return this.store(route).read().jobs.find(j => j.id === duplicate[0])!;
    if (this.running.size >= 8) throw Error('organizer_queue_full');
    const job: OrganizerJob = { id: randomUUID(), state: 'queued', workspaceIds: options.workspaceIds || [], completed: 0, total: 0, createdAt: now(), updatedAt: now() };
    const store = this.store(route), abort = new AbortController(); store.update(l => { l.jobs.push(job); });
    const promise = (this.projectTails.get(route.configPath) || Promise.resolve()).catch(() => {}).then(() => withProject({ projectConfig: route.configPath }, () => this.perform(route, job.id, options, abort.signal))).catch(error => {
      store.update(l => { const j = l.jobs.find(j => j.id === job.id)!; j.state = abort.signal.aborted ? 'cancelled' : 'failed'; j.error = failure(error); j.updatedAt = now(); });
    }).finally(() => this.running.delete(job.id));
    this.projectTails.set(route.configPath, promise);
    this.running.set(job.id, { abort, promise, project: route.configPath, options }); return job;
  }
  private async agents(api: PaseoApi) {
    const agents = new Map<string, PaseoAgent>(); let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await api.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const row of result.entries) agents.set(row.agent.id, row.agent);
      if (!result.pageInfo.hasMore) return agents;
      const next = result.pageInfo.nextCursor || undefined; if (!next || next === cursor) break; cursor = next;
    }
    throw Error('organizer_agents_incomplete');
  }
  private async directory(api: PaseoApi) {
    const workspaces = new Map<string, Awaited<ReturnType<ReturnType<PaseoApi['workspaces']['ref']>['refresh']>>>(); let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await api.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const workspace of result.entries) workspaces.set(workspace.id, workspace);
      if (!result.pageInfo.hasMore) return workspaces;
      const next = result.pageInfo.nextCursor || undefined; if (!next || next === cursor) break; cursor = next;
    }
    throw Error('organizer_workspaces_incomplete');
  }
  private projectTargets(ledger: OrganizerLedger, policy: OrganizerPolicy) {
    for (const target of Object.values(ledger.targets)) {
      const workspaces = target.workspaceKeys.flatMap(key => ledger.workspaces[key] ? [ledger.workspaces[key]] : []);
      target.state = aggregateProduction(workspaces.map(w => w.material.state));
      const representative = representativeWorkspace(workspaces);
      target.representative = representative?.key;
      const body = target.policy === 'symbols' && target.body ? target.body : representative?.proposedTitle || representative?.title || representative?.material.taskBrief || representative?.material.name;
      if (body) target.previewTitle = formatOrganizerTitle(body, target.state, policy,target.policy==='symbols');
    }
  }
  private async materials(route: ProjectRoute, workspaceId: string, instance: string, policy: OrganizerPolicy): Promise<WorkspaceMaterial> {
    const material = await this.read(route, 'organizer.materials', { workspaceId, instance, productionBranches: policy.productionBranches }) as WorkspaceMaterial;
    const binding = withProject({ projectConfig: route.configPath }, () => allAgentBindings().find(b => b.workspaceId === workspaceId));
    if (binding?.handoff) material.evidence.unshift({ id: 'goal:handoff:' + (binding.handoffHash || organizerHash(binding.handoff)), kind: 'goal', text: [binding.handoff.goal, binding.handoff.reviewPacket?.requirementUnderstanding].filter(Boolean).join('\n').slice(0,8000) });
    for (const repo of material.repositories) {
      const notes = await this.read(route, 'notes.read', { workspaceId, repoPath: repo.repoPath, action: 'list' }).catch(() => null);
      for (const note of notes?.notes || []) material.evidence.push({ id: `note:${repo.repositoryId}:${note.id}:${note.revision}`, kind: 'note', text: [note.content.title, note.content.requirement, note.content.reason, note.content.behavior].filter(Boolean).join('\n').slice(0,8000), repository: repo.repositoryId });
      if (notes?.nextOffset) material.complete = false;
    }
    const priority={goal:0,note:1,commit:2,diff:3,message:4,hint:5};material.evidence.sort((a,b)=>priority[a.kind]-priority[b.kind]);
    material.fingerprint = organizerHash([material.fingerprint, material.evidence]);
    return material;
  }
  private async perform(route: ProjectRoute, jobId: string, options: JobOptions, signal: AbortSignal) {
    await this.syncLegacy(route);
    const store = this.store(route), config = this.settings.response(route), policy = config.effective, configToken = this.settings.fingerprint(route);
    const assertCurrent = () => { if (signal.aborted) throw Error('organizer_cancelled'); if (this.closed || this.settings.fingerprint(route) !== configToken) throw Error('organizer_settings_changed'); };
    const updateJob = (patch: Partial<OrganizerJob>) => store.update(l => { Object.assign(l.jobs.find(j => j.id === jobId)!, patch, { updatedAt: now() }); });
    updateJob({ state: 'running' });
    const roster = await this.read(route, 'workspace.list', { includeRemoved: false }); assertCurrent();
    const rows = (roster.workspaces as Array<Record<string, any>>).filter(w => w.managed && w.id !== 'main' && w.state !== 'record_invalid');
    const bindings = withProject({ projectConfig: route.configPath }, () => allAgentBindings());
    const api = await this.deps.api(), [agents, directory] = await Promise.all([this.agents(api), this.directory(api)]); assertCurrent();
    const links = new Map<string, { agentIds: Set<string>; keys: Set<string>; fresh: boolean }>();
    const unlinked: string[] = [];
    store.update(l => {
      for (const row of rows) {
        const key = String(row.instanceKey), previous = l.workspaces[key];
        if (!previous) l.workspaces[key] = { key, title: row.taskBrief || row.displayName || row.id, brief: row.taskBrief || '', items: [], material: { workspaceId: row.id, instance: key, name: row.displayName || row.id, taskBrief: row.taskBrief || '', createdAt: row.createdAt || '', activityAt: row.createdAt || '', fingerprint: '', evidence: [], repositories: [], state: 'unknown', complete: false } };
        const ids = new Set<string>([row.creator?.agentId, bindings.find(b => b.workspaceId === row.id)?.agentId].filter(Boolean));
        let linked = false;
        for (const id of ids) {
          const agent = agents.get(id), nativeId = agent?.workspaceId;
          if (!nativeId || !directory.has(nativeId) || (directory.get(nativeId) as unknown as { archivedAt?: string })?.archivedAt) continue;
          const binding = bindings.find(b => b.workspaceId === row.id && b.agentId === id);
          if (binding && (binding.cwd !== agent.cwd || binding.paseoWorkspaceId !== nativeId)) continue;
          const link = links.get(nativeId) || { agentIds: new Set<string>(), keys: new Set<string>(), fresh: false };
          link.agentIds.add(id); link.keys.add(key); link.fresh ||= String(row.createdAt || '') >= this.settings.enabledAt(route); links.set(nativeId, link); linked = true;
        }
        if (!linked) unlinked.push(row.id);
      }
      for (const [id, link] of links) {
        const currentTitle = directory.get(id)?.title || null, previous = l.targets[id];
        const target: OrganizerTarget = previous || { id, agentIds: [], workspaceKeys: [], currentTitle, state: 'unknown', policy: 'preview', history: [] };
        target.agentIds = [...link.agentIds]; target.workspaceKeys = [...link.keys]; target.currentTitle = currentTitle;
        if (target.pendingWrite) {
          if (currentTitle === target.pendingWrite.to) { target.lastWritten = currentTitle; delete target.pendingWrite; }
          else { target.policy = 'paused'; target.reason = '此前标题写入结果未确认，请核对后恢复自动维护'; }
        }
        if (target.lastWritten !== undefined && currentTitle !== target.lastWritten && !target.pendingWrite && ['auto', 'symbols'].includes(target.policy)) { target.policy = 'paused'; target.reason = '检测到外部改名，已保留当前标题并暂停自动维护'; }
        if (!previous && policy.enabled && visible(policy, target) && link.fresh && options.automatic) target.policy = 'auto';
        l.targets[id] = target;
      }
      // No stale target may keep writing after its explicit association disappears.
      for (const target of Object.values(l.targets)) if (!links.has(target.id)) { target.workspaceKeys = []; target.policy = 'paused'; target.reason = '当前关联或宿主对象不可用'; }
      l.unlinked = unlinked; this.projectTargets(l, policy); delete l.error;
    });
    const current = store.read(), selected = options.workspaceIds ? new Set(options.workspaceIds) : null;
    const automaticKeys = new Set(Object.values(current.targets).filter(t => ['auto', 'symbols'].includes(t.policy) && visible(policy, t)).flatMap(t => t.workspaceKeys.filter(key=>policy.mode!=='selected'||policy.selectedIds.includes(t.id)||policy.selectedIds.includes(key)||policy.selectedIds.includes(current.workspaces[key]?.material.workspaceId))));
    const candidates = rows.filter(row => !selected || selected.has(row.id));
    const selectedKeys=new Set(candidates.filter(row=>!options.automatic||automaticKeys.has(String(row.instanceKey))).map(row=>String(row.instanceKey)));
    const selectedAgents=new Set(candidates.filter(row=>selectedKeys.has(String(row.instanceKey))).flatMap(row=>[row.creator?.agentId,bindings.find(b=>b.workspaceId===row.id)?.agentId].filter(Boolean)));
    updateJob({ total: candidates.length, workspaceIds: candidates.map(row => row.id) });
    let completed = 0;
    for (const row of candidates) {
      assertCurrent(); const key = String(row.instanceKey);
      if (options.automatic && !automaticKeys.has(key) && !options.forceFetch&&!current.workspaces[key]?.fingerprint) { updateJob({ completed: ++completed }); continue; }
      let material: WorkspaceMaterial;
      let materialUpdated = false;
      try {
        material = await this.materials(route, row.id, key, policy);
        assertCurrent();
        let fetched=false;
        for (const repo of material.repositories) {
          const fetchKey=route.configPath+':'+(repo.sourcePath||repo.repositoryId)+':'+repo.productionRef;
          if(!repo.productionRef)continue;
          let previous=this.fetches.get(fetchKey);
          if(options.fetch) {
            const refs=await this.read(route,'repository.compare',{workspaceId:row.id,repoPath:repo.repoPath,action:'refs'});
            const selectedRef=refs.refs?.find((r:any)=>r.kind==='remote'&&(r.name===repo.productionRef||r.shortName===repo.productionRef));
            // A local production branch is read as configured; fetching only applies to remote refs.
            if(!selectedRef)continue;
            if(refs.fetch?.state==='ready'&&refs.fetch?.ref===repo.productionRef&&Date.parse(refs.fetch.lastFetchedAt||'')>(previous?.at||0)) previous={at:Date.parse(refs.fetch.lastFetchedAt),state:'ready'};
            if(options.forceFetch||!previous||Date.now()-previous.at>=policy.fetchIntervalSeconds*1000) {
              const value=await this.read(route,'repository.fetch',{workspaceId:row.id,repoPath:repo.repoPath,ref:repo.productionRef,requestId:`organizer:${jobId}:${organizerHash(fetchKey)}`});
              let state=value.state;
              const deadline=Date.now()+35000;
              while(state==='running'&&Date.now()<deadline) {
                assertCurrent();
                await new Promise<void>(resolve=>{const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();};const timer=setTimeout(stop,300);signal.addEventListener('abort',stop,{once:true});});
                const observed=await this.read(route,'repository.compare',{workspaceId:row.id,repoPath:repo.repoPath,action:'refs'});state=observed.fetch?.state;
              }
              previous={at:Date.now(),state:state==='ready'?'ready':'unknown'};this.fetches.set(fetchKey,previous);fetched ||= state==='ready';
            }
          }
          if(previous?.state==='unknown'){repo.state='unknown';repo.reason='生产引用获取未确认，请在生产设置中重试';}
        }
        if(fetched) {
          material=await this.materials(route,row.id,key,policy);
          for(const repo of material.repositories)if(this.fetches.get(route.configPath+':'+(repo.sourcePath||repo.repositoryId)+':'+repo.productionRef)?.state==='unknown'){repo.state='unknown';repo.reason='生产引用获取未确认';}
        }
        material.state = aggregateProduction(material.repositories.map(r => r.state));
        store.update(l => { l.workspaces[key].material = material; this.projectTargets(l, policy); });
        materialUpdated = true;
        const previous = store.read().workspaces[key];
        const due = !previous.analyzedAt || Date.now() - Date.parse(previous.analyzedAt) >= policy.analysisIntervalSeconds * 1000;
        if (options.analyze && (!options.automatic || policy.enabled && automaticKeys.has(key)) && policy.profileId && material.evidence.some(e=>e.kind!=='hint') && (options.regenerate || previous.fingerprint !== material.fingerprint && (!options.automatic || due))) {
          await this.model(async () => {
            assertCurrent(); const latest = store.read().workspaces[key], profile = this.settings.profile(policy.profileId);
            const result = await callOrganizerModel(profile, this.settings.secret(profile.id), policy, material.evidence, latest.fingerprint ? latest : undefined, 'workspace', key, signal, run => store.addRun(run));
            assertCurrent();
            const checked = await this.materials(route, row.id, key, policy);
            if (checked.fingerprint !== material.fingerprint) throw Error('organizer_source_changed');
            store.update(l => { const w = l.workspaces[key]; if (!w.fingerprint && !w.manual) w.title = result.value.title; else if (options.regenerate && result.value.title !== w.title) w.proposedTitle = result.value.title; if (!w.manual) w.brief = result.value.brief; w.items = mergeOrganizerItems(w.items, result.value, key);w.sources=retainOrganizerSources([...(w.sources||[]),...material.evidence],w.items); w.fingerprint = material.fingerprint; w.analyzedAt = now(); w.material.complete &&= !result.truncated; delete w.error; this.projectTargets(l, policy); });
          });
        }
      } catch (error) {
        assertCurrent(); store.update(l => { const w = l.workspaces[key]; w.error = failure(error); if (!materialUpdated || failure(error) === 'organizer_source_changed') w.material.state = 'unknown'; this.projectTargets(l, policy); });
      }
      updateJob({ completed: ++completed });
    }
    if (options.conversation && policy.conversationSummary && policy.profileId) {
      const targets = Object.values(store.read().targets).filter(t => t.workspaceKeys.some(key=>selectedKeys.has(key))&&(!options.automatic || policy.enabled && automaticKeys.has(t.representative || '')));
      for (const id of new Set(targets.flatMap(t => t.agentIds).filter(id=>selectedAgents.has(id)))) { assertCurrent(); await this.analyzeConversation(route, id, api, policy, signal, assertCurrent, !options.automatic).catch(error => { if (signal.aborted) throw error; store.update(l => { const c = l.conversations[id]; if (c) c.error = failure(error); }); }); }
    }
    assertCurrent();
    if (options.automatic && policy.enabled) for (const t of Object.values(store.read().targets)) if (['auto', 'symbols'].includes(t.policy) && visible(policy, t)) await this.writeTarget(route, t.id, false, true).catch(error => { store.update(l => { l.targets[t.id].reason = failure(error); }); });
    store.update(l => { l.refreshedAt = now(); }); updateJob({ state: 'complete' });
  }
  private model<T>(work: () => Promise<T>): Promise<T> {return this.modelQueue.run(work);}
  private async analyzeConversation(route: ProjectRoute, agentId: string, api: PaseoApi, policy: OrganizerPolicy, signal: AbortSignal, assertCurrent: () => void, force = false) {
    const store = this.store(route), old = store.read().conversations[agentId];
    if (!force && old?.updatedAt && Date.now() - Date.parse(old.updatedAt) < policy.analysisIntervalSeconds * 1000) return;
    const page = await api.agents.ref(agentId).timeline.refetch({ limit: 40, direction: 'after', ...(old?.cursor ? { cursor: old.cursor } : {}) });
    if (page.error || page.staleCursor) throw Error(page.error || 'organizer_history_cursor_stale');
    const batch = conversationBatch(agentId, page, old), evidence = batch.evidence;
    if (!evidence.length) {
      const last=page.entries.at(-1);
      if(last)store.update(l=>{l.conversations[agentId]={...old,agentId,brief:old?.brief||'',items:old?.items||[],evidence:old?.evidence||[],cursor:{epoch:page.epoch,seq:last.seqEnd},pendingMessage:undefined,startedAtBeginning:batch.startedAtBeginning,complete:batch.startedAtBeginning&&!page.hasNewer,updatedAt:old?.updatedAt||''};});
      return;
    }
    const fingerprint = organizerHash(evidence); if (old?.fingerprint === fingerprint) return;
    await this.model(async () => {
      assertCurrent(); const profile = this.settings.profile(policy.profileId);
      const result = await callOrganizerModel(profile, this.settings.secret(profile.id), policy, evidence, old, 'conversation', agentId, signal, run => store.addRun(run)); assertCurrent();
      const last = result.consumedIds.at(-1), checkpoint = last ? batch.checkpoints.get(last) : undefined;
      store.update(l => { const current = l.conversations[agentId],items=mergeOrganizerItems(current?.items||[],result.value,agentId); l.conversations[agentId] = { ...current, agentId, brief: result.value.brief, items, evidence: retainOrganizerSources([...(current?.evidence||[]),...evidence.filter(e=>result.consumedIds.includes(e.id))],items), cursor: checkpoint?.cursor || current?.cursor, pendingMessage: checkpoint?.pendingMessage, startedAtBeginning: batch.startedAtBeginning, complete: batch.startedAtBeginning && !page.hasNewer && !batch.limited && !result.truncated, fingerprint, updatedAt: now() }; });
    });
  }
  private async writeTarget(route: ProjectRoute, id: string, explicit: boolean, maintain: boolean) {
    await this.syncLegacy(route);
    const store=this.store(route),configToken=this.settings.fingerprint(route),policy=this.settings.response(route).effective;
    let ledger=store.read(),target=ledger.targets[id];
    if (!target || !target.workspaceKeys.length || !target.previewTitle || target.pendingWrite) throw Error('organizer_target_unavailable');
    if (!explicit && (!policy.enabled || !visible(policy, target) || !['auto', 'symbols'].includes(target.policy))) return;
    const preview=target.previewTitle,representative=target.representative,priorPolicy=target.policy;
    let changed=false;
    const verified:WorkspaceMaterial[]=[];
    for(const key of target.workspaceKeys) {
      const w=ledger.workspaces[key];if(!w)throw Error('organizer_source_changed');
      const material=await this.materials(route,w.material.workspaceId,key,policy);
      for(const repo of material.repositories)if(this.fetches.get(route.configPath+':'+(repo.sourcePath||repo.repositoryId)+':'+repo.productionRef)?.state==='unknown'){repo.state='unknown';repo.reason='生产引用获取未确认';}
      material.state=aggregateProduction(material.repositories.map(r=>r.state));
      changed ||= material.fingerprint!==w.material.fingerprint;verified.push(material);
    }
    if(this.closed||this.settings.fingerprint(route)!==configToken)throw Error('organizer_settings_changed');
    store.update(l=>{for(const material of verified)if(l.workspaces[material.instance])l.workspaces[material.instance].material=material;this.projectTargets(l,policy);});
    ledger=store.read();target=ledger.targets[id];
    if(changed)throw Error('organizer_source_changed');
    if(target.policy!==priorPolicy||explicit&&(target.previewTitle!==preview||target.representative!==representative))throw Error('organizer_preview_changed');
    const api = await this.deps.api(), workspace = await api.workspaces.ref(id).refresh();
    if (!workspace || workspace.id !== id || (workspace as unknown as { archivedAt?: string }).archivedAt) throw Error('organizer_host_workspace_unavailable');
    const agent = (await api.agents.ref(target.agentIds[0]).refresh())?.agent;
    if (!agent || agent.workspaceId !== id || agent.archivedAt) throw Error('organizer_target_changed');
    const expected = explicit ? target.currentTitle : target.lastWritten === undefined ? target.currentTitle : target.lastWritten;
    if (workspace.title !== expected || store.read().targets[id]?.policy !== target.policy) {
      store.update(l => { l.targets[id].policy = 'paused'; l.targets[id].currentTitle = workspace.title || null; l.targets[id].reason = '标题已在外部修改，已暂停覆盖'; }); throw Error('organizer_external_title_change');
    }
    const w = target.representative && ledger.workspaces[target.representative];
    if (!explicit && w && !w.fingerprint && !w.material.taskBrief) return;
    const body = target.policy === 'symbols' ? target.body || workspace.title || '' : w ? w.title : target.body || '';
    const title = formatOrganizerTitle(body, target.state, policy,target.policy==='symbols');
    if (title === workspace.title) { store.update(l => { const t = l.targets[id]; t.lastWritten = title; t.currentTitle = title; t.body = body; if (explicit) t.policy = maintain ? 'auto' : 'preview'; }); return; }
    if(this.closed||this.settings.fingerprint(route)!==configToken)throw Error('organizer_settings_changed');
    store.update(l => { const t = l.targets[id]; if (t.originalTitle === undefined) t.originalTitle = workspace.title || null; t.pendingWrite = { from: workspace.title || null, to: title, id: randomUUID() }; });
    try {
      await api.workspaces.ref(id).setTitle(title);
      store.update(l => { const t = l.targets[id]; t.history.push({ at: now(), from: workspace.title || null, to: title, representative: target.representative }); t.history = t.history.slice(-100); t.lastWritten = title; t.currentTitle = title; t.body = body; if (explicit) t.policy = maintain ? 'auto' : 'preview'; delete t.pendingWrite; delete t.reason; });
    } catch (error) { store.update(l => { l.targets[id].policy = 'paused'; l.targets[id].reason = '标题写入结果未确认，需读取核对；不会自动重发'; }); throw error; }
  }
  private async restore(route: ProjectRoute, id: string) {
    const store = this.store(route), target = store.read().targets[id];
    if (!target || target.originalTitle === undefined || target.pendingWrite) throw Error('organizer_restore_unavailable');
    const api = await this.deps.api(), current = await api.workspaces.ref(id).refresh();
    if (!current || current.title !== target.lastWritten) throw Error('organizer_external_title_change');
    store.update(l => { l.targets[id].policy = 'excluded'; l.targets[id].pendingWrite = { from: current.title || null, to: target.originalTitle!, id: randomUUID() }; });
    await api.workspaces.ref(id).setTitle(target.originalTitle);
    store.update(l => { const t = l.targets[id]; t.currentTitle = target.originalTitle!; t.lastWritten = target.originalTitle; delete t.pendingWrite; t.reason = '已恢复原标题并排除自动维护'; });
  }
  changed(route: ProjectRoute) {
    if (this.closed) return;
    const policy = this.settings.response(route).effective; if (!policy.enabled) return;
    const previous = this.timers.get(route.configPath); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => { this.timers.delete(route.configPath); try { this.enqueue(route, { analyze: true, conversation: true, regenerate: false, automatic: true, fetch: false }); } catch {} }, policy.debounceSeconds * 1000);
    timer.unref(); this.timers.set(route.configPath, timer);
  }
  async close() { this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for(const test of this.tests.values())test.abort();for (const job of this.running.values()) job.abort.abort(); await Promise.allSettled([...this.running.values()].map(j => j.promise));await this.modelQueue.idle(); }
}

export function registerOrganizer(server: PluginServerContext, service: OrganizerService) {
  server.handle(organizerRpc, input => service.request(input));
  const cleanup = server.on('agent.turn_ended', ({ agent }) => {
    try { service.changed(resolveProject({ directory: agent.cwd })); } catch {}
  });
  return async () => { cleanup(); await service.close(); };
}
