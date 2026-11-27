import {randomUUID} from 'node:crypto';
import type {PaseoApi,PaseoAgent} from '@getpaseo/client';
import {aggregateProduction,formatOrganizerTitle,hasWorkingChanges,type ConversationAnalysis,type OrganizerInput,type OrganizerJob,type OrganizerPolicy,type OrganizerTarget,type WorkspaceAnalysis,type WorkspaceMaterial} from '../../shared/organizer.ts';
import {allAgentBindings} from '../agent-store.ts';
import {withProject,type ProjectRoute} from '../projects.ts';
import {conversationBatch} from './conversation.ts';
import {organizerProgress,type OrganizerProgress} from './jobs.ts';
import {callSessionModel,sessionModelPrompt,type SessionMessages} from './session-model.ts';
import {organizerHash,type OrganizerSettings,type OrganizerStore,type OrganizerLedger} from './storage.ts';
import {SessionProduction} from './session-production.ts';
import {eligibleAssociationWorkspaces,sessionAssociations,syncSessionAssociations} from './session-associations.ts';
import {materialStamp,reuseMaterial} from './material-cache.ts';
import {samePublicConversation} from './conversation-head.ts';
import type {ModelContext} from './model-gateway.ts';

type Request=Extract<OrganizerInput['request'],{action:'session.refresh'|'session.history'|'session.apply'|'session.automatic'|'session.associations'|'session.associations.save'}>;
type Dependencies={settings:OrganizerSettings;api():Promise<PaseoApi>;store(route:ProjectRoute):OrganizerStore;read(route:ProjectRoute,method:'workspace.list'|'repository.compare'|'repository.fetch'|'organizer.versions',params?:Record<string,unknown>):Promise<Record<string,any>>;materials(route:ProjectRoute,id:string,key:string,policy:OrganizerPolicy,committedOnly?:boolean):Promise<WorkspaceMaterial>;model<T>(work:()=>Promise<T>,context?:Omit<ModelContext,'gateway'>):Promise<T>};
const at=()=>new Date().toISOString();
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const retryable=(error:unknown)=>['organizer_source_changed','organizer_preview_changed'].includes(errorText(error))||['observer_timeout','observation_timeout','observer_busy'].includes((error as {code?:string})?.code||'');
const managedTitle=(target:OrganizerTarget)=>target.session?.autoStart?target.session.autoStart.expectedTitle:target.lastWritten;
const productionState=(rows:WorkspaceAnalysis[])=>aggregateProduction(rows.filter(w=>w.material.state!=='discussion'||w.material.taskBrief||w.material.evidence.some(e=>e.kind==='goal')).map(w=>w.material.state));
type Active={project:string;targetId:string;abort:AbortController;promise:Promise<void>;preview:boolean;force:boolean;history:boolean;configuration:string};
type Versions=Map<string,string|undefined>&{facts?:Record<string,any>};
type Messages=SessionMessages&{batch?:ReturnType<typeof conversationBatch>};
const sessionCommitIdentity=(l:OrganizerLedger,t:OrganizerTarget)=>organizerHash([...t.workspaceKeys].sort().map(key=>l.workspaces[key]?.material.committedFingerprint||l.workspaces[key]?.material.fingerprint));
const sessionFingerprint=(l:OrganizerLedger,t:OrganizerTarget)=>organizerHash([[...t.workspaceKeys].sort().map(key=>[key,l.workspaces[key]?.material.fingerprint,l.workspaces[key]?.material.latestCommitAt]),[...t.agentIds].sort().map(id=>[id,l.conversations[id]?.fingerprint,l.conversations[id]?.cursor,l.conversations[id]?.pendingMessage])]);
export class SessionOrganizer {
  private active=new Map<string,Active>();private tails=new Map<string,Promise<void>>();private timers=new Map<string,ReturnType<typeof setTimeout>>();private closed=false;
  private writing=new Map<string,Promise<void>>();
  private sourceWatches=new Map<string,{timer:ReturnType<typeof setTimeout>;seen:Map<string,string>;flight?:Promise<void>}>();
  private production=new SessionProduction();
  private deps:Dependencies;
  constructor(deps:Dependencies){this.deps=deps;}
  /** Only opted-in sessions subscribe to existing backend source versions.
   * Polling these stamps does not enumerate commits or call a model. */
  watch(route:ProjectRoute){
    if(this.closed||this.sourceWatches.has(route.configPath))return;
    const watch={seen:new Map<string,string>(),timer:undefined as unknown as ReturnType<typeof setTimeout>,flight:undefined as Promise<void>|undefined};
    const tick=()=>{if(this.closed)return;watch.flight=this.checkSources(route,watch.seen).catch(()=>{}).finally(()=>{watch.flight=undefined;if(!this.closed){watch.timer=setTimeout(tick,5000);watch.timer.unref();}});};
    watch.timer=setTimeout(tick,5000);watch.timer.unref();this.sourceWatches.set(route.configPath,watch);
  }
  async checkSources(route:ProjectRoute,seen=this.sourceWatches.get(route.configPath)?.seen||new Map<string,string>()){
    if(this.closed)return;
    const ledger=this.deps.store(route).read(),targets=Object.values(ledger.targets).filter(t=>t.session?.enabled&&t.workspaceKeys.length);
    const ids=[...new Set(targets.flatMap(t=>t.workspaceKeys.map(k=>ledger.workspaces[k]?.material.workspaceId).filter(Boolean)))];
    if(!ids.length){seen.clear();return;}
    const policy=this.deps.settings.response(route).effective,versions=await this.versions(route,ids,policy,true);if(this.closed)return;
    for(const target of targets){
      const rows=target.workspaceKeys.map(k=>ledger.workspaces[k]);if(rows.some(w=>!w))continue;
      const stamps=rows.map(w=>versions.get(w.material.workspaceId));if(stamps.some(s=>!s))continue;
      const stamp=organizerHash(stamps),prior=seen.get(target.id);seen.set(target.id,stamp);const active=[...this.active.values()].some(r=>r.project===route.configPath&&r.targetId===target.id),behind=!!target.session?.analyzedCommits&&target.session.analyzedCommits!==sessionCommitIdentity(ledger,target)&&!target.session.error&&!active&&!this.timers.has(route.configPath+':'+target.id);
      const pending=target.session?.autoStart&&!target.session.error&&![...this.active.values()].some(r=>r.project===route.configPath&&r.targetId===target.id);
      if(!behind&&(stamp===prior||!pending&&stamps.every((s,i)=>s===rows[i].materialCache?.stamp)))continue;
      const commitsChanged=rows.some(w=>versions.facts?.[w.material.workspaceId]?.ready&&organizerHash(w.material.repositories.map(r=>[r.repositoryId,r.baseSha,r.head]))!==versions.facts[w.material.workspaceId].commitKey);
      this.schedule(route,target.id,commitsChanged?policy.debounceSeconds*1000:0);
    }
    for(const id of seen.keys())if(!targets.some(t=>t.id===id))seen.delete(id);
  }
  private config(route:ProjectRoute,contentOnly=false){const settings=this.deps.settings.response(route),profile=settings.profiles.find(p=>p.id===settings.effective.profileId);return organizerHash(contentOnly?[profile,sessionModelPrompt(settings.effective)]:[profile,sessionModelPrompt(settings.effective),settings.effective.markers]);}
  previewStates(route:ProjectRoute,ledger:OrganizerLedger,targets:OrganizerTarget[]){
    const configuration=this.config(route);
    return Object.fromEntries(targets.map(t=>{const p=t.session?.preview;return[t.id,!p?'missing':p.needsReview?'source':p.configurationFingerprint!==configuration?'configuration':p.sourceFingerprint!==sessionFingerprint(ledger,t)?'source':t.pendingWrite&&p.reviewedWriteId!==t.pendingWrite.id?'write':'ready'];})) as Record<string,'ready'|'configuration'|'source'|'missing'|'write'>;
  }
  async request(route:ProjectRoute,request:Request){
    if(request.action==='session.associations'||request.action==='session.associations.save')return this.associations(route,request);
    if(request.action==='session.apply'){await this.apply(route,request.targetId,request.previewId);return this.deps.store(route).read().targets[request.targetId];}
    if(request.action==='session.automatic'){
      const timerKey=route.configPath+':'+request.targetId;
      if(request.enabled){
        const store=this.deps.store(route),target=store.read().targets[request.targetId];
        if(!target?.workspaceKeys.length)throw Error('organizer_target_missing');
        if(target.pendingWrite)throw Error('organizer_title_write_uncertain');
        if(!this.deps.settings.response(route).effective.profileId)throw Error('organizer_model_required');
        if(target.session?.enabled)return target;
        clearTimeout(this.timers.get(timerKey));this.timers.delete(timerKey);
        store.update(l=>{const t=l.targets[request.targetId];t.session={...t.session,version:1,enabled:true,controlRevision:(t.session?.controlRevision||0)+1,configurationFingerprint:this.config(route),autoStart:{expectedTitle:t.currentTitle,requestedAt:at()},paused:undefined,error:undefined};});
        this.startAutomatic(route,request.targetId);return store.read().targets[request.targetId];
      }
      clearTimeout(this.timers.get(timerKey));this.timers.delete(timerKey);
      for(const run of this.active.values())if(run.project===route.configPath&&run.targetId===request.targetId)run.abort.abort();
      this.deps.store(route).update(l=>{const t=l.targets[request.targetId];if(!t)throw Error('organizer_target_missing');t.session={...t.session,version:1,enabled:false,autoStart:undefined,error:undefined,retryAt:undefined,controlRevision:(t.session?.controlRevision||0)+1};});return this.deps.store(route).read().targets[request.targetId];
    }
    return this.enqueue(route,request.targetId,request.action==='session.history'||request.preview,request.action==='session.refresh'&&request.force,request.action==='session.history');
  }
  cancel(route:ProjectRoute,id:string){const running=this.active.get(id);if(!running||running.project!==route.configPath)return false;running.abort.abort();organizerProgress(this.deps.store(route),id).update(j=>{j.cancelRequestedAt=at();if(j.state==='queued')j.state='cancelled';});return true;}
  private enqueue(route:ProjectRoute,targetId:string,preview=false,force=false,history=false):OrganizerJob {
    if(this.closed)throw Error('organizer_closed');
    const old=[...this.active].find(([,r])=>r.project===route.configPath&&r.targetId===targetId&&r.preview===preview&&r.force===force&&r.history===history&&!r.abort.signal.aborted);if(old)return this.deps.store(route).read().jobs.find(j=>j.id===old[0])!;
    if(this.active.size>=8)throw Error('organizer_queue_full');
    const job:OrganizerJob={id:randomUUID(),kind:'session',hostWorkspaceId:targetId,intent:{preview},input:{workspaces:[],history:{pages:0,fragments:0,complete:false}},state:'queued',stage:'queued',workspaceIds:[],completed:0,total:0,createdAt:at(),updatedAt:at(),model:{state:'not-requested',calls:0,completed:0},result:{analyzed:0,cached:0,skipped:0,failed:0,titleWrites:0,conversations:0}};
    const store=this.deps.store(route),abort=new AbortController();store.update(l=>l.jobs.push(job));
    const promise=(preview?Promise.resolve():this.tails.get(route.configPath)||Promise.resolve()).catch(()=>{}).then(async()=>{
      for(let attempt=0;;attempt++)try{await this.perform(route,job.id,targetId,preview,force,abort.signal,attempt>0,history);return;}catch(error){
        // Reconcile a newer public message or Git revision within this job,
        // reusing unchanged Workspaces. Unknown writes never enter this path.
        if(preview||attempt>=2||!retryable(error)||abort.signal.aborted||this.closed||!store.read().targets[targetId]?.session?.enabled)throw error;
        organizerProgress(store,job.id).stage('retrying');
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,1000);abort.signal.addEventListener('abort',done,{once:true});});
        if(abort.signal.aborted||this.closed)throw Error('organizer_cancelled');
        store.update(l=>{const j=l.jobs.find(j=>j.id===job.id)!;j.completed=0;j.input={workspaces:[],history:{pages:0,fragments:0,complete:false}};delete l.targets[targetId].session!.error;});
      }
    }).catch(error=>{
      const retryAt=(error as {retryAt?:number})?.retryAt;store.update(l=>{const j=l.jobs.find(j=>j.id===job.id)!;j.state=abort.signal.aborted?'cancelled':'failed';j.error=errorText(error);if(j.result&&!abort.signal.aborted)j.result.failed++;j.updatedAt=at();const t=l.targets[targetId];if(t?.session&&!abort.signal.aborted){t.session.error=errorText(error);t.session.retryAt=retryAt?new Date(retryAt).toISOString():undefined;}});if(retryAt&&!preview&&!abort.signal.aborted)this.schedule(route,targetId,Math.max(100,retryAt-Date.now()));
    }).finally(()=>this.active.delete(job.id));
    this.active.set(job.id,{project:route.configPath,targetId,abort,promise,preview,force,history,configuration:this.deps.settings.fingerprint(route)});if(!preview)this.tails.set(route.configPath,promise);return job;
  }
  private async discover(route:ProjectRoute,targetId:string,api:PaseoApi,assertCurrent:()=>void) {
    const native=await api.workspaces.ref(targetId).refresh();if(!native||(native as {archivedAt?:string}).archivedAt)throw Error('organizer_host_workspace_unavailable');
    const roster=await this.deps.read(route,'workspace.list'),bindings=withProject({projectConfig:route.configPath},allAgentBindings),agents=new Map<string,PaseoAgent>();let cursor:string|undefined;
    for(let page=0;page<20;page++){const result=await api.agents.list({filter:{includeArchived:true},sort:[{key:'created_at',direction:'desc'}],page:{limit:200,...(cursor?{cursor}:{})}});for(const row of result.entries)agents.set(row.agent.id,row.agent);if(!result.pageInfo.hasMore)break;const next=result.pageInfo.nextCursor||undefined;if(!next||next===cursor||page===19)throw Error('organizer_agents_incomplete');cursor=next;}
    assertCurrent();const rows=eligibleAssociationWorkspaces(roster.workspaces||[]);
    const store=this.deps.store(route);store.update(l=>{
      const t=l.targets[targetId]||{id:targetId,agentIds:[],workspaceKeys:[],currentTitle:native.title||null,state:'unknown',policy:'preview',history:[]};
      const linked=syncSessionAssociations(l,t,rows,agents,bindings);
      t.session||={version:1,enabled:false};
      if(t.pendingWrite){t.session.enabled=false;t.session.paused='此前标题写入结果未确认，请重新核对';if(native.title===t.pendingWrite.to){t.lastWritten=native.title||null;delete t.pendingWrite;}}
      if(t.session.enabled&&managedTitle(t)!==undefined&&native.title!==managedTitle(t)){t.session.enabled=false;t.session.autoStart=undefined;t.session.paused='标题已在外部修改';}
      t.currentTitle=native.title||null;
      if(!linked.length){t.session.enabled=false;t.session.paused='当前会话暂无关联工作区';}else if(t.session.paused==='当前会话暂无关联工作区')delete t.session.paused;l.targets[targetId]=t;
    });const keys=new Set(store.read().targets[targetId].workspaceKeys);return {linked:rows.filter(row=>keys.has(row.instanceKey)),rows,agents,bindings};
  }
  private async associations(route:ProjectRoute,request:Extract<Request,{action:'session.associations'|'session.associations.save'}>){
    const store=this.deps.store(route),api=await this.deps.api(),context=await this.discover(route,request.targetId,api,()=>{if(this.closed)throw Error('organizer_closed');});
    let ledger=store.read(),target=ledger.targets[request.targetId],view=sessionAssociations(ledger,target,context.rows);
    if(request.action==='session.associations')return view;
    if(request.revision!==view.revision)throw Error('organizer_associations_changed');
    const selected=new Set(request.workspaceKeys);
    if(selected.size!==request.workspaceKeys.length||request.workspaceKeys.some(key=>!context.rows.some(row=>row.instanceKey===key)))throw Error('organizer_association_workspace_unavailable');
    if(selected.size===target.workspaceKeys.length&&target.workspaceKeys.every(key=>selected.has(key)))return view;
    const timerKey=route.configPath+':'+request.targetId,timer=this.timers.get(timerKey);if(timer)clearTimeout(timer);this.timers.delete(timerKey);
    for(const active of this.active.values())if(active.project===route.configPath&&active.targetId===request.targetId)active.abort.abort();
    store.update(l=>{
      const t=l.targets[request.targetId],links=t.workspaceLinks!;
      for(const row of context.rows){const old=links[row.instanceKey],included=selected.has(row.instanceKey);if(included!==!!old?.included)links[row.instanceKey]={...old,workspaceId:row.id,source:'manual',included,at:at()};}
      const wasEnabled=t.session?.enabled;
      t.session={...t.session,version:1,enabled:false,autoStart:undefined,controlRevision:(t.session?.controlRevision||0)+1,preview:undefined,lastAttemptAt:undefined,error:undefined};
      if(wasEnabled)t.session.paused='关联已更新，自动更新标题已关闭';else if(t.session.paused==='当前会话暂无关联工作区')delete t.session.paused;
      syncSessionAssociations(l,t,context.rows,context.agents,context.bindings);
      t.state=productionState(t.workspaceKeys.map(key=>l.workspaces[key]));t.hasUncommittedChanges=hasWorkingChanges(t.workspaceKeys.map(key=>l.workspaces[key]));
    });ledger=store.read();target=ledger.targets[request.targetId];return sessionAssociations(ledger,target,context.rows);
  }
  private rows(store:OrganizerStore,targetId:string){const l=store.read();return l.targets[targetId].workspaceKeys.map(k=>l.workspaces[k]).filter(Boolean).sort((a,b)=>{
    const x=Date.parse(a.material.activityAt||a.material.latestCommitAt||''),y=Date.parse(b.material.activityAt||b.material.latestCommitAt||'');if(Number.isFinite(x)&&Number.isFinite(y)&&x!==y)return y-x;if(Number.isFinite(x)!==Number.isFinite(y))return Number.isFinite(x)?-1:1;return a.material.workspaceId.localeCompare(b.material.workspaceId);
  });}
  private fingerprint(store:OrganizerStore,targetId:string){const l=store.read();return sessionFingerprint(l,l.targets[targetId]);}
  private async material(route:ProjectRoute,id:string,key:string,policy:OrganizerPolicy,signal?:AbortSignal,committedOnly=false){
    if(signal?.aborted||this.closed)throw Error('organizer_cancelled');
    const read=this.deps.materials(route,id,key,policy,committedOnly);let cancel=()=>{};
    try{return await Promise.race([read,new Promise<never>((_,reject)=>{cancel=()=>reject(Error('organizer_cancelled'));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();})]);}
    finally{signal?.removeEventListener('abort',cancel);}
  }
  private async versions(route:ProjectRoute,ids:string[],policy:OrganizerPolicy,semantic=false){
    const stamps:Versions=new Map(),bindings=withProject({projectConfig:route.configPath},allAgentBindings);
    for(let i=0;i<ids.length;i+=100){const group=ids.slice(i,i+100);let result:Record<string,any>|undefined;
      try{result=await this.deps.read(route,'organizer.versions',{workspaceIds:group,factsOnly:true,productionBranches:policy.productionBranches});}catch{/* Older or degraded backends retain the full verification path. */}
      if(result?.facts)stamps.facts={...stamps.facts,...result.facts};
      for(const id of group)stamps.set(id,result?.facts?.[id]?.ready?organizerHash([result.facts[id].commitKey,result.facts[id].productionKey,result.facts[id].workingKey||result.facts[id].repositories.map((r:any)=>r.dirty)]):materialStamp(result,id,policy,bindings.filter(b=>b.workspaceId===id).map(b=>[b.handoffHash,b.handoff])));
    }return stamps;
  }
  /** Revalidate source stamps in a batch. Missing/degraded proofs still take
   * the full material path; a stable proof never repeats a Git scan. */
  private async verifyMaterials(route:ProjectRoute,keys:string[],policy:OrganizerPolicy,assertCurrent:()=>void,progress?:OrganizerProgress,expected?:WorkspaceAnalysis[],signal?:AbortSignal,committedOnly=false){
    if(!keys.length)return;
    const store=this.deps.store(route),snapshot=store.read(),rows=keys.map(key=>snapshot.workspaces[key]),ids=rows.map(w=>w.material.workspaceId),before=await this.versions(route,ids,policy,committedOnly);assertCurrent();
    if(expected&&rows.some(w=>w.material.fingerprint!==expected.find(row=>row.key===w.key)?.material.fingerprint))throw Error('organizer_source_changed');
    for(const prior of rows){
      const stamp=before.get(prior.material.workspaceId),fact=before.facts?.[prior.material.workspaceId];if(committedOnly&&fact?.ready&&!prior.material.fingerprint&&prior.factsKey===fact.commitKey)continue;if(committedOnly&&fact?.ready&&prior.material.repositories.length===fact.repositories.length&&prior.material.repositories.every(r=>fact.repositories.some((f:any)=>f.repositoryId===r.repositoryId&&f.head===r.head&&f.baseSha===r.baseSha&&(r.committedState==='discussion'||f.productionSha===r.productionSha)))){
        store.update(l=>{const w=l.workspaces[prior.key];for(const repo of w.material.repositories)repo.dirty=!!fact.repositories.find((r:any)=>r.repositoryId===repo.repositoryId)?.dirty;w.materialCache=stamp?{stamp,fingerprint:w.material.fingerprint,at:at()}:undefined;});continue;
      }if(reuseMaterial(prior,stamp,policy))continue;
      progress?.stage('verifying',{workspaceId:prior.material.workspaceId,name:prior.material.name});
      const material=this.production.applyCached(route.configPath,await this.material(route,prior.material.workspaceId,prior.key,policy,signal,committedOnly));assertCurrent();
      if(material.fingerprint!==prior.material.fingerprint)throw Error('organizer_source_changed');if(committedOnly&&fact?.ready)for(const repo of material.repositories)repo.dirty=!!fact.repositories.find((r:any)=>r.repositoryId===repo.repositoryId)?.dirty;
      store.update(l=>{const w=l.workspaces[prior.key];if(w.material.fingerprint!==prior.material.fingerprint)throw Error('organizer_source_changed');material.latestCommitAt=w.material.latestCommitAt;w.material=material;w.materialCache=stamp?{stamp,fingerprint:material.fingerprint,at:at()}:undefined;});
    }
    const after=await this.versions(route,ids,policy,committedOnly);assertCurrent();
    for(const id of ids)if(committedOnly&&before.facts?.[id]?.ready&&after.facts?.[id]?.ready?before.facts[id].commitKey!==after.facts[id].commitKey:before.get(id)!==after.get(id))throw Error('organizer_source_changed');
  }
  private async messages(store:OrganizerStore,target:OrganizerTarget,api:PaseoApi,assertCurrent:()=>void,reusePreview=false,progress?:OrganizerProgress){
    const rows:Messages[]=[],heads:Record<string,{epoch:string;seq:number}>={};
    for(const agentId of target.agentIds){assertCurrent();progress?.stage('conversation',{agentId,page:0});let old=store.read().conversations[agentId];const head=await api.agents.ref(agentId).timeline.refetch({limit:1,direction:'before'});if(head.error||head.staleCursor)throw Error(head.error||'organizer_history_cursor_stale');heads[agentId]={epoch:head.epoch,seq:head.entries.at(-1)?.seqEnd||0};
      if(reusePreview){const checked=await samePublicConversation(api,agentId,target.session?.preview?.messageHeads?.[agentId],heads[agentId],assertCurrent);if(checked.same){heads[agentId]=checked.head;rows.push({agentId,previous:old,evidence:[],complete:old?.complete||false});continue;}}
      for(let pages=0;pages<8;pages++){progress?.stage('conversation',{agentId,page:pages+1});const page=await api.agents.ref(agentId).timeline.refetch({limit:100,direction:'after',...(old?.cursor?{cursor:old.cursor}:{})});assertCurrent();if(page.error||page.staleCursor)throw Error(page.error||'organizer_history_cursor_stale');
        const batch=conversationBatch(agentId,page,old,400);progress?.update(j=>{if(j.input){j.input.history.pages++;j.input.history.fragments+=batch.evidence.length;}});if(batch.evidence.length){rows.push({agentId,previous:old,evidence:batch.evidence,complete:batch.startedAtBeginning&&!page.hasNewer&&!batch.limited,batch});break;}
        const last=page.entries.at(-1);if(last){const next:ConversationAnalysis={...old,agentId,brief:old?.brief||'',items:old?.items||[],evidence:old?.evidence||[],cursor:{epoch:page.epoch,seq:last.seqEnd},pendingMessage:undefined,startedAtBeginning:batch.startedAtBeginning,complete:batch.startedAtBeginning&&!page.hasNewer,updatedAt:old?.updatedAt||''};store.update(l=>{l.conversations[agentId]=next;});old=next;}
        if(!page.hasNewer||!last){rows.push({agentId,previous:old,evidence:[],complete:old?.complete??!page.hasOlder});break;}
        if(pages===7)rows.push({agentId,previous:old,evidence:[],complete:false});
      }
    }progress?.update(j=>{if(j.input)j.input.history.complete=rows.every(row=>row.complete);});return {rows,heads};
  }
  private async recentMessages(store:OrganizerStore,target:OrganizerTarget,api:PaseoApi,assertCurrent:()=>void,progress:OrganizerProgress,reusePreview=false){
    const rows:Messages[]=[],heads:Record<string,{epoch:string;seq:number}>={};let remaining=4000;
    for(const agentId of target.agentIds.slice(0,4)){progress.stage('conversation',{agentId,page:0});if(reusePreview){const head=await api.agents.ref(agentId).timeline.refetch({limit:1,direction:'before'});assertCurrent();if(head.error||head.staleCursor)throw Error('organizer_history_cursor_stale');const current={epoch:head.epoch,seq:head.entries.at(-1)?.seqEnd||0},same=await samePublicConversation(api,agentId,target.session?.preview?.messageHeads?.[agentId],current,assertCurrent);if(same.same){heads[agentId]=same.head;rows.push({agentId,previous:store.read().conversations[agentId],evidence:[],complete:false});continue;}}
      progress.stage('conversation',{agentId,page:1});const page=await api.agents.ref(agentId).timeline.refetch({limit:100,direction:'before'});assertCurrent();if(page.error||page.staleCursor)throw Error('organizer_history_cursor_stale');heads[agentId]={epoch:page.epoch,seq:page.entries.at(-1)?.seqEnd||0};
      const entries=page.entries.filter(e=>['user_message','assistant_message'].includes((e.item as {type?:string}).type||'')).slice(-12);let bytes=0;
      const evidence=entries.reverse().map(entry=>{const item=entry.item as {type:string;text?:string},text=item.text||'',offset=Math.max(0,text.length-1000);return{id:`message:${agentId}:${page.epoch}:${entry.seqStart}:${offset}`,kind:'message' as const,text:item.type+': '+text.slice(offset)};}).filter(e=>{bytes+=Buffer.byteLength(e.text);if(bytes>remaining)return false;return true;}).reverse();remaining-=evidence.reduce((n,e)=>n+Buffer.byteLength(e.text),0);
      const old=store.read().conversations[agentId];rows.push({agentId,previous:old?{...old,brief:old.recentBrief||old.brief}:undefined,evidence,complete:false});
      progress.update(j=>{j.input!.history.pages++;j.input!.history.fragments+=evidence.length;});
    }return{rows,heads};
  }
  private async history(route:ProjectRoute,id:string,target:OrganizerTarget,api:PaseoApi,assertCurrent:()=>void,progress:OrganizerProgress,signal:AbortSignal){
    const store=this.deps.store(route),policy=this.deps.settings.response(route).effective;if(!target.workspaceKeys.length)throw Error('organizer_session_no_commits');if(!policy.profileId)throw Error('organizer_model_required');
    const pendingAgents=target.agentIds.filter(id=>!store.read().conversations[id]?.complete).slice(0,1),conversation=await this.messages(store,{...target,agentIds:pendingAgents},api,assertCurrent,false,progress),messages=conversation.rows.filter(r=>r.evidence.length);
    if(messages.length){const profile=this.deps.settings.profile(policy.profileId);progress.queued(profile);const modelStarted=Date.now(),result=await this.deps.model(()=>callSessionModel(profile,this.deps.settings.secret(profile.id),policy,this.rows(store,target.id),[],messages,false,target.currentTitle,target.session?.acceptedBody,target.id,signal,run=>store.addRun(run),(phase,run)=>progress.model(phase,run)),{project:route.configPath,targetId:target.id,jobId:id,label:target.currentTitle||'会话历史',purpose:'补充历史',workspaceKeys:[...target.workspaceKeys],trigger:'history',assertCurrent});assertCurrent();
      store.update(l=>{for(const c of result.value.conversations){const source=messages.find(m=>m.agentId===c.agentId)!,packed=result.packed.conversations.find(m=>m.agentId===c.agentId)!,checkpoint=source.batch!.checkpoints.get(packed.evidence.at(-1)!.id),old=l.conversations[c.agentId];l.conversations[c.agentId]={...old,agentId:c.agentId,brief:c.brief,items:old?.items||[],evidence:[...(old?.evidence||[]),...packed.evidence].slice(-80),...checkpoint,startedAtBeginning:source.batch!.startedAtBeginning,complete:source.complete&&packed.evidence.length===source.evidence.length,updatedAt:at(),fingerprint:organizerHash([old?.fingerprint,packed.evidence])};}});
    }else progress.skip('cached');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});
  }
  private async perform(route:ProjectRoute,id:string,targetId:string,preview:boolean,force:boolean,signal:AbortSignal,retrying=false,history=false){
    const store=this.deps.store(route),settings=this.deps.settings,policy=settings.response(route).effective,token=settings.fingerprint(route),configuration=this.config(route),contentConfiguration=this.config(route,true),api=await this.deps.api();
    const assertCurrent=()=>{if(signal.aborted||this.closed)throw Error('organizer_cancelled');if(settings.fingerprint(route)!==token)throw Error('organizer_settings_changed');};
    const progress=organizerProgress(store,id);assertCurrent();progress.update(j=>{j.state='running';j.startedAt||=at();});progress.stage('discovering');
    const {linked:roster}=await this.discover(route,targetId,api,assertCurrent);progress.update(j=>{j.total=roster.length;j.workspaceIds=roster.map(r=>r.id);});
    let target=store.read().targets[targetId];
    if(!preview&&!target.session?.enabled){
      const facts=await this.versions(route,roster.map(row=>row.id),policy,true);assertCurrent();const fingerprint=organizerHash([...facts]);
      store.update(l=>{const t=l.targets[targetId];if(t.session?.preview?.factsFingerprint&&t.session.preview.factsFingerprint!==fingerprint)t.session.preview.needsReview=true;});
      progress.skip('automatic-off');progress.stage('finished');progress.update(j=>{j.state='complete';if(j.result){j.result.previewReady=!!target.session?.preview&&!store.read().targets[targetId].session?.preview?.needsReview;j.result.previewStale=store.read().targets[targetId].session?.preview?.needsReview;}});return;
    }
    if(history){await this.history(route,id,target,api,assertCurrent,progress,signal);return;}
    const factsStarted=Date.now(),versions=await this.versions(route,roster.map(row=>row.id),policy,!preview);assertCurrent();
    progress.update(j=>{j.diagnostic={trigger:preview?'preview':target.session?.autoStart?'enable':force?'retry':'automatic',factsMs:Date.now()-factsStarted,cacheMisses:{}};});
    if(!preview&&versions.facts&&roster.some(row=>!versions.facts![row.id]?.ready)){progress.skip('git-pending');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});this.schedule(route,targetId,30_000);return;}
    const ordered=[...roster].sort((a,b)=>(Date.parse(b.latestCommitAt||'')||0)-(Date.parse(a.latestCommitAt||'')||0));
    const deferred:typeof roster=[];
    const loadOne=async(row:typeof roster[number])=>{
      const materialStarted=Date.now();assertCurrent();const previous=store.read().workspaces[row.instanceKey],name=previous.digest?.title||row.displayName||row.id;
      let proof=previous.materialCache;
      const load=async()=>{progress.stage('materials',{workspaceId:row.id,name,repositoryCount:row.repositoryCount});
        // A preceding fetch can update the shared refs of every linked
        // worktree. Capture this read's stamp, not the old roster-wide stamp.
        const before=(await this.versions(route,[row.id],policy,!preview)).get(row.id),material=await this.material(route,row.id,row.instanceKey,policy,signal,!preview),after=(await this.versions(route,[row.id],policy,!preview)).get(row.id);assertCurrent();
        proof=before&&before===after?{stamp:before,fingerprint:material.fingerprint,at:at()}:undefined;return material;
      };
      const fact=versions.facts?.[row.id],prior=structuredClone(!preview?previous.committedMaterial||previous.material:previous.material);
      if(!preview&&prior.committedFingerprint){prior.evidence=prior.evidence.filter(e=>!e.working);prior.fingerprint=organizerHash([prior.committedFingerprint,prior.taskBrief,prior.taskKind,prior.evidence.filter(e=>e.kind==='note'||e.kind==='goal')]);}
      const sameFacts=!!fact?.ready&&!!prior.fingerprint&&(!prior.repositories.some(r=>r.dirty)||!!prior.committedFingerprint)&&prior.repositories.length===fact.repositories.length&&prior.repositories.every(r=>fact.repositories.some((f:any)=>f.repositoryId===r.repositoryId&&f.head===r.head&&f.baseSha===r.baseSha&&(r.committedState==='discussion'||f.productionSha===r.productionSha&&f.productionRef===r.productionRef)));
      const reused=!force&&!(preview&&prior.repositories.some(r=>r.dirty)&&prior.fingerprint===previous.committedMaterial?.fingerprint)&&(preview?reuseMaterial(previous,versions.get(row.id),policy):sameFacts||!versions.facts&&reuseMaterial(previous,versions.get(row.id),policy)),initial=reused?structuredClone(prior):await load();
      if(!reused)progress.update(j=>{j.diagnostic!.cacheMisses![row.id]=force?'explicit-retry':!fact?.ready?'facts-unavailable':prior.repositories.some(r=>!fact.repositories.some((f:any)=>f.repositoryId===r.repositoryId&&f.head===r.head))?'commit-changed':'production-or-first-read';});
      progress.update(j=>{j.input!.workspaces.push({id:row.id,name:row.displayName||row.id,repositories:initial.repositories.length,commits:initial.evidence.filter(e=>e.kind==='commit').length,notes:initial.evidence.filter(e=>e.kind==='note').length,diffs:initial.evidence.filter(e=>e.kind==='diff').length,materialCached:reused,cached:!!previous.manual||previous.digest?.fingerprint===initial.fingerprint});});
      const referenceDue=Date.now()-Date.parse(proof?.at||'')>=policy.fetchIntervalSeconds*1000;const material=reused&&!referenceDue&&!initial.repositories.some(r=>r.referenceUnavailable||r.refreshError)?initial:await this.production.refresh(route.configPath,initial,policy,id,(method,params)=>this.deps.read(route,method,params),load,signal,(repository,ref,fetching)=>progress.stage(fetching?'fetching':'production',{workspaceId:row.id,name,repository,ref}));
      material.latestCommitAt=row.latestCommitAt||null;
      if(!preview&&fact?.ready)for(const repo of material.repositories){const f=fact.repositories.find((r:any)=>r.repositoryId===repo.repositoryId);if(f)repo.dirty=f.dirty;}
      assertCurrent();store.update(l=>{const w=l.workspaces[row.instanceKey];w.material=material;w.materialCache=reused&&versions.get(row.id)?{stamp:versions.get(row.id)!,fingerprint:material.fingerprint,at:at()}:proof;if(!preview){w.committedMaterial=structuredClone(material);if(!previous.material.committedFingerprint&&material.committedFingerprint&&organizerHash(previous.material.evidence.filter(e=>e.kind==='commit').map(e=>e.id))===organizerHash(material.evidence.filter(e=>e.kind==='commit').map(e=>e.id))){w.autoObservedCommits=material.committedFingerprint;if(w.digest?.fingerprint===previous.material.fingerprint&&!previous.material.repositories.some(r=>r.dirty))w.committedDigest={...w.digest,fingerprint:material.fingerprint};}if(!w.autoObservedCommits&&target.session?.acceptedBody&&!target.session.autoStart&&organizerHash(previous.material.evidence.filter(e=>e.kind==='commit').map(e=>e.id))===organizerHash(material.evidence.filter(e=>e.kind==='commit').map(e=>e.id)))w.autoObservedCommits=material.committedFingerprint||material.fingerprint;w.factsKey=fact?.commitKey;if(w.committedDigest?.fingerprint===material.fingerprint)w.digest=w.committedDigest;}});progress.update(j=>{j.completed++;j.diagnostic!.materialsMs=(j.diagnostic!.materialsMs||0)+Date.now()-materialStarted;});
    };
    for(const [index,row]of ordered.entries()){
      if(!preview&&target.session?.autoStart&&!target.session.preview&&policy.namingMode==='latest'&&index>=1&&this.rows(store,targetId).some(w=>w.material.evidence.some(e=>e.kind==='commit'))&&!store.read().workspaces[row.instanceKey].material.fingerprint&&versions.facts?.[row.id]?.ready){
        deferred.push(row);store.update(l=>{l.workspaces[row.instanceKey].factsKey=versions.facts![row.id].commitKey;});
      }else await loadOne(row);
    }
    store.update(l=>{const t=l.targets[targetId];t.state=productionState(t.workspaceKeys.map(k=>l.workspaces[k]));t.hasUncommittedChanges=hasWorkingChanges(t.workspaceKeys.map(k=>l.workspaces[k]));});
    target=store.read().targets[targetId];if(!roster.length){progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    // State symbols describe current Git evidence, not the age of a model result.
    // Preserve the accepted body while a changed summary awaits its cooldown.
    if(!preview&&target.session?.enabled&&!target.session.autoStart&&target.session.acceptedBody&&target.session.preview&&target.session.configurationFingerprint===configuration&&target.currentTitle!==formatOrganizerTitle(target.session.acceptedBody,target.state,policy,false,target.hasUncommittedChanges)){
      const writes=target.history.length;progress.stage('titles');await this.write(route,targetId,target.session.preview.id,false,true,signal);target=store.read().targets[targetId];if(target.history.length>writes)progress.count('titleWrites');
    }
    if(target.session?.preview?.configurationFingerprint===configuration&&!target.session.preview.contentConfigurationFingerprint)store.update(l=>{l.targets[targetId].session!.preview!.contentConfigurationFingerprint=contentConfiguration;});
    if(target.session!.enabled&&target.session!.configurationFingerprint!==configuration){store.update(l=>{l.targets[targetId].session!.enabled=false;l.targets[targetId].session!.autoStart=undefined;l.targets[targetId].session!.paused='命名配置已改变，请重新开启自动更新';});target=store.read().targets[targetId];}
    if(!preview&&!target.session?.enabled){progress.skip('automatic-off');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    if(!policy.profileId){if(preview)throw Error('organizer_model_required');progress.skip('no-profile');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const own=this.rows(store,targetId).filter(w=>w.material.evidence.some(e=>e.kind==='commit'));
    if(!own.length){if(preview)throw Error('organizer_session_no_commits');progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const attempted=Date.parse(target.session!.lastAttemptAt||''),savedPreview=target.session?.preview,initial=target.session?.autoStart&&(!(attempted>=Date.parse(target.session.autoStart.requestedAt))||(!target.session.error||target.session.error==='organizer_source_changed')&&(!savedPreview||savedPreview.sourceFingerprint!==this.fingerprint(store,targetId)||savedPreview.configurationFingerprint!==configuration));if(!preview&&!force&&!retrying&&!initial&&Number.isFinite(attempted)&&Date.now()-attempted<policy.analysisIntervalSeconds*1000){
      const cached=target.session!.preview;if(target.session!.enabled&&cached?.sourceFingerprint===this.fingerprint(store,targetId)&&cached.configurationFingerprint===configuration){store.update(l=>{l.targets[targetId].session!.preview!.title=formatOrganizerTitle(cached.body,l.targets[targetId].state,policy,false,l.targets[targetId].hasUncommittedChanges);});if(target.session!.autoStart||cached.body===target.session!.acceptedBody&&target.currentTitle!==store.read().targets[targetId].session!.preview!.title)await this.write(route,targetId,cached.id,false,false,signal);}
      if(target.session?.enabled&&cached?.sourceFingerprint!==this.fingerprint(store,targetId))this.schedule(route,targetId,Math.max(100,attempted+policy.analysisIntervalSeconds*1000-Date.now()));
      progress.skip('interval');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;if(j.result){j.result.cached=own.filter(w=>w.digest?.fingerprint===w.material.fingerprint).length;j.result.previewReady=cached?.sourceFingerprint===this.fingerprint(store,targetId)&&cached?.configurationFingerprint===configuration;j.result.previewId=j.result.previewReady?cached?.id:undefined;}});return;}
    const sessionChanged=!!target.session?.analyzedCommits&&target.session.analyzedCommits!==sessionCommitIdentity(store.read(),target);
    const changed=own.filter(w=>!w.manual&&(preview||target.session?.autoStart||w.autoObservedCommits!==(w.material.committedFingerprint||w.material.fingerprint))&&(!w.digest||w.digest.fingerprint!==w.material.fingerprint)).map(w=>w.key);
    const cached=target.session!.preview,sameContent=!!cached&&(!(!preview&&cached.inputMode==='working'))&&(cached.configurationFingerprint===configuration||cached.contentConfigurationFingerprint===contentConfiguration),reusePreview=!force&&!changed.length&&sameContent&&cached?.sourceFingerprint===this.fingerprint(store,targetId);
    const conversation=policy.conversationSummary&&(preview||changed.length||sessionChanged||target.session?.autoStart&&!cached)?await this.recentMessages(store,target,api,assertCurrent,progress,!!reusePreview):{rows:[] as Messages[],heads:{}};assertCurrent();
    const fingerprint=this.fingerprint(store,targetId),wantTitle=preview||target.session!.enabled||changed.length>0||!cached||conversation.rows.some(r=>r.evidence.length);
    const newMessages=conversation.rows.some(r=>r.evidence.length),cachedTitle=target.session!.preview;
    const needTitle=preview?wantTitle&&(force||newMessages||!cachedTitle||cachedTitle.sourceFingerprint!==fingerprint||!sameContent):!!(changed.length||sessionChanged||target.session?.autoStart&&!cachedTitle||!sameContent&&target.session?.autoStart);
    progress.update(j=>{j.intent={preview,title:needTitle,summaries:changed.length};if(j.result)j.result.cached=own.length-changed.length;});
    const batches:string[][]=[];for(let i=0;i<changed.length;i+=4)batches.push(changed.slice(i,i+4));if(!batches.length&&(needTitle||newMessages))batches.push([]);
    if(batches.length)store.update(l=>{delete l.targets[targetId].session!.error;});
    let generatedTitle:Awaited<ReturnType<typeof callSessionModel>>['value']['title'],runId:string|undefined;
    for(let index=0;index<batches.length||deferred.length;index++){
      if(index>=batches.length){const pending=deferred.splice(0,4);for(const row of pending)await loadOne(row);const current=store.read();const keys=pending.map(row=>row.instanceKey).filter(key=>{const w=current.workspaces[key];return !w.manual&&w.material.evidence.some(e=>e.kind==='commit')&&w.digest?.fingerprint!==w.material.fingerprint;});if(!keys.length){index--;continue;}batches.push(keys);}

      assertCurrent();const keys=batches[index],title=needTitle&&(policy.namingMode==='latest'?index===0:index===batches.length-1),profile=settings.profile(policy.profileId),rows=this.rows(store,targetId).map(w=>preview?w:{...w,digest:w.committedDigest|| (w.digest?.fingerprint===w.material.fingerprint?w.digest:undefined)});
      const messages=index===0?conversation.rows:conversation.rows.map(row=>({...row,evidence:[],previous:store.read().conversations[row.agentId]}));
      progress.update(j=>{j.intent={preview,title,summaries:keys.length};});progress.queued(profile);const modelStarted=Date.now(),result=await this.deps.model(async()=>{assertCurrent();return callSessionModel(profile,settings.secret(profile.id),policy,rows,keys,messages,title,target.currentTitle,target.session?.acceptedBody,targetId,signal,run=>store.addRun(run),(phase,run)=>{runId=run.id;if(phase==='requesting')store.update(l=>{l.targets[targetId].session!.lastAttemptAt=at();});progress.model(phase,run);});},{project:route.configPath,targetId,jobId:id,label:target.currentTitle||'会话标题',purpose:title?'标题和摘要':'工作区摘要',workspaceKeys:keys,trigger:preview?'preview':force?'retry':target.session?.autoStart?'enable':'automatic',inputVersion:organizerHash(rows.map(w=>[w.key,w.material.committedFingerprint||w.material.fingerprint])),assertCurrent,beforeStart:()=>this.verifyMaterials(route,keys,policy,assertCurrent,progress,rows,signal,!preview)});assertCurrent();
      progress.update(j=>{if(j.diagnostic)j.diagnostic.modelMs=(j.diagnostic.modelMs||0)+Date.now()-modelStarted;});
      await this.verifyMaterials(route,keys,policy,assertCurrent,progress,rows,signal,!preview);
      store.update(l=>{
        if(keys.some(key=>l.workspaces[key].material.fingerprint!==rows.find(row=>row.key===key)?.material.fingerprint))throw Error('organizer_source_changed');
        for(const item of result.value.workspaces){const w=l.workspaces[item.key];if(!w.manual)w.digest={...w.digest,version:1,title:item.title,brief:item.brief,evidenceIds:item.evidenceIds,fingerprint:w.material.fingerprint,at:at(),partial:result.packed.workspaces.find(p=>p.key===item.key)?.coverage!=='complete'};if(!preview&&!w.manual){w.committedDigest=w.digest;w.autoObservedCommits=w.material.committedFingerprint||w.material.fingerprint;}}
        for(const c of result.value.conversations){const packed=result.packed.conversations.find(p=>p.agentId===c.agentId)!,source=messages.find(m=>m.agentId===c.agentId)!,checkpoint=source.batch?.checkpoints.get(packed.evidence.at(-1)!.id),old=l.conversations[c.agentId];
          l.conversations[c.agentId]=source.batch?{...old,agentId:c.agentId,brief:c.brief,items:old?.items||[],evidence:[...(old?.evidence||[]),...packed.evidence].slice(-80),...checkpoint,startedAtBeginning:source.batch.startedAtBeginning||old?.startedAtBeginning||false,complete:source.complete&&packed.evidence.length===source.evidence.length,updatedAt:at(),fingerprint:organizerHash([old?.fingerprint,packed.evidence])}:{...old,agentId:c.agentId,brief:old?.brief||'',items:old?.items||[],evidence:old?.evidence||[],complete:old?.complete||false,updatedAt:old?.updatedAt||'',recentBrief:c.brief};}
      });progress.update(j=>{if(j.input){for(const row of result.value.workspaces){const entry=j.input.workspaces.find(w=>w.id===store.read().workspaces[row.key].material.workspaceId);if(entry)entry.updated=true;}j.input.history.sentFragments=(j.input.history.sentFragments||0)+result.packed.conversations.reduce((n,c)=>n+c.evidence.length,0);j.input.history.complete=store.read().targets[targetId].agentIds.every(id=>store.read().conversations[id]?.complete);}});for(const key of keys)progress.count('analyzed');for(const row of result.value.conversations)progress.count('conversations');generatedTitle=result.value.title||generatedTitle;
      if(!preview&&result.value.title&&policy.namingMode==='latest'&&(deferred.length||index<batches.length-1)){
        const proposed=result.value.title;store.update(l=>{const t=l.targets[targetId];t.state=productionState(t.workspaceKeys.map(k=>l.workspaces[k]));t.hasUncommittedChanges=hasWorkingChanges(t.workspaceKeys.map(k=>l.workspaces[k]));t.session!.preview={id:randomUUID(),body:proposed.text,title:formatOrganizerTitle(proposed.text,t.state,policy,false,t.hasUncommittedChanges),sourceFingerprint:this.fingerprint(store,targetId),configurationFingerprint:configuration,contentConfigurationFingerprint:contentConfiguration,at:at(),runId,inputMode:'committed',evidenceIds:proposed.evidenceIds,conversationComplete:false,messageHeads:{}};});
        const current=store.read().targets[targetId];if(current.session?.enabled){progress.stage('titles');await this.write(route,targetId,current.session.preview!.id,false,false,signal);progress.count('titleWrites',current.history.length<store.read().targets[targetId].history.length?1:0);}
      }

    }
    store.update(l=>{const t=l.targets[targetId];t.state=productionState(t.workspaceKeys.map(k=>l.workspaces[k]));t.hasUncommittedChanges=hasWorkingChanges(t.workspaceKeys.map(k=>l.workspaces[k]));});assertCurrent();const finalFingerprint=this.fingerprint(store,targetId);
    store.update(l=>{const t=l.targets[targetId],session=t.session!;if(generatedTitle)session.preview={...session.preview,id:randomUUID(),body:generatedTitle.text,title:formatOrganizerTitle(generatedTitle.text,t.state,policy,false,t.hasUncommittedChanges),sourceFingerprint:finalFingerprint,configurationFingerprint:configuration,contentConfigurationFingerprint:contentConfiguration,at:at(),runId,factsFingerprint:organizerHash([...versions]),needsReview:false,inputMode:preview&&this.rows(store,targetId).some(w=>w.material.repositories.some(r=>r.dirty))?'working':'committed',evidenceIds:generatedTitle.evidenceIds,conversationComplete:t.agentIds.every(id=>l.conversations[id]?.complete),messageHeads:conversation.heads,reviewedWriteId:preview?t.pendingWrite?.id:undefined};else if(session.preview&&(session.preview.sourceFingerprint===finalFingerprint||!preview&&!changed.length&&sameContent)){if(!preview&&session.preview.inputMode==='working'){session.preview.needsReview=!!session.preview.needsReview||session.preview.factsFingerprint!==organizerHash([...versions]);}else{session.preview.factsFingerprint=organizerHash([...versions]);session.preview.needsReview=false;}if(!preview)session.preview.sourceFingerprint=finalFingerprint;if(policy.conversationSummary&&conversation.rows.length)session.preview.messageHeads=conversation.heads;session.preview.title=formatOrganizerTitle(session.preview.body,t.state,policy,false,t.hasUncommittedChanges);if(sameContent){if(session.preview.configurationFingerprint!==configuration)session.preview.id=randomUUID();session.preview.configurationFingerprint=configuration;session.preview.contentConfigurationFingerprint=contentConfiguration;}if(preview&&session.preview.reviewedWriteId!==t.pendingWrite?.id){session.preview.reviewedWriteId=t.pendingWrite?.id;session.preview.id=randomUUID();}}delete session.error;delete session.retryAt;if(!preview)session.analyzedCommits=sessionCommitIdentity(l,t);});
    if(!batches.length)progress.skip('cached');
    target=store.read().targets[targetId];if(!preview&&target.session!.enabled&&target.session!.preview&&(generatedTitle||target.session!.autoStart)&&(target.session!.autoStart||target.currentTitle!==target.session!.preview.title)&&target.session!.configurationFingerprint===configuration){progress.stage('titles');await this.write(route,targetId,target.session!.preview.id,false,false,signal);progress.count('titleWrites',target.history.length<store.read().targets[targetId].history.length?1:0);}
    progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;if(j.result){j.result.cached=Math.max(0,this.rows(store,targetId).filter(w=>w.material.evidence.some(e=>e.kind==='commit')).length-j.result.analyzed);j.result.previewReady=!!target.session!.preview&&target.session!.preview.sourceFingerprint===this.fingerprint(store,targetId)&&target.session!.preview.configurationFingerprint===configuration;j.result.previewId=j.result.previewReady?target.session!.preview?.id:undefined;}});
  }
  private async apply(route:ProjectRoute,targetId:string,previewId:string){await this.write(route,targetId,previewId,true);}
  private write(route:ProjectRoute,targetId:string,previewId:string,explicit:boolean,statusOnly=false,signal?:AbortSignal){
    const key=route.configPath+':'+targetId;if(this.writing.has(key))throw Error('organizer_title_write_busy');const started=Date.now(),job=[...this.active.entries()].find(([,a])=>a.project===route.configPath&&a.targetId===targetId),promise=this.writeProtected(route,targetId,previewId,explicit,statusOnly,signal).finally(()=>{this.writing.delete(key);if(job)this.deps.store(route).update(l=>{const j=l.jobs.find(j=>j.id===job[0]);if(j?.diagnostic)j.diagnostic.writeMs=(j.diagnostic.writeMs||0)+Date.now()-started;});});this.writing.set(key,promise);return promise;
  }
  private async writeProtected(route:ProjectRoute,targetId:string,previewId:string,explicit:boolean,statusOnly=false,signal?:AbortSignal){
    const store=this.deps.store(route),settings=this.deps.settings,policy=settings.response(route).effective,token=settings.fingerprint(route),configuration=this.config(route),api=await this.deps.api();let target=store.read().targets[targetId];const saved=target?.session?.preview;
    const preview=statusOnly&&saved&&target.session?.acceptedBody?{...saved,body:target.session.acceptedBody,title:formatOrganizerTitle(target.session.acceptedBody,target.state,policy,false,target.hasUncommittedChanges),sourceFingerprint:this.fingerprint(store,targetId),messageHeads:{}}:saved;
    if(!preview||explicit&&preview.needsReview||preview.id!==previewId||target.pendingWrite&&(!explicit||preview.reviewedWriteId!==target.pendingWrite.id))throw Error('organizer_preview_changed');if(!explicit&&(!target.session!.enabled||target.session!.configurationFingerprint!==configuration))return;
    if(preview.configurationFingerprint!==configuration||preview.sourceFingerprint!==this.fingerprint(store,targetId))throw Error('organizer_preview_changed');
    const originalKeys=[...target.workspaceKeys],expected=target.currentTitle,control=target.session!.controlRevision||0;
    const assertCurrent=()=>{if(signal?.aborted)throw Error('organizer_cancelled');if(this.closed||settings.fingerprint(route)!==token)throw Error('organizer_settings_changed');};
    const {linked:roster}=await this.discover(route,targetId,api,assertCurrent);if(organizerHash(roster.map(r=>r.instanceKey).sort())!==organizerHash([...originalKeys].sort()))throw Error('organizer_source_changed');
    await this.verifyMaterials(route,originalKeys,policy,assertCurrent,undefined,undefined,signal,!explicit);
    for(const [id,head]of Object.entries(explicit?preview.messageHeads||{}:{})){const page=await api.agents.ref(id).timeline.refetch({limit:1,direction:'before'});assertCurrent();if(page.error||page.staleCursor||!(await samePublicConversation(api,id,head,{epoch:page.epoch,seq:page.entries.at(-1)?.seqEnd||0},assertCurrent)).same)throw Error('organizer_source_changed');}
    target=store.read().targets[targetId];const rows=originalKeys.map(k=>store.read().workspaces[k]),state=productionState(rows),workingChanges=hasWorkingChanges(rows),title=formatOrganizerTitle(preview.body,state,policy,false,workingChanges);
    if(!explicit&&preview.inputMode!=='working'&&target.session?.preview?.id===previewId){preview.title=title;store.update(l=>{l.targets[targetId].session!.preview!.title=title;});}
    if(title!==preview.title||target.session?.preview?.id!==previewId||statusOnly&&target.session.acceptedBody!==preview.body||preview.sourceFingerprint!==this.fingerprint(store,targetId))throw Error('organizer_preview_changed');
    const native=await api.workspaces.ref(targetId).refresh();assertCurrent();if(!native||(native as {archivedAt?:string}).archivedAt)throw Error('organizer_host_workspace_unavailable');
    const live=store.read().targets[targetId];if((live.session?.controlRevision||0)!==control)throw Error('organizer_cancelled');if(live.session?.preview?.id!==previewId)throw Error('organizer_preview_changed');if(!explicit&&!live.session?.enabled)return;
    if(native.title!==expected||!explicit&&(!target.session!.enabled||native.title!==managedTitle(target))){store.update(l=>{const t=l.targets[targetId];t.currentTitle=native?.title||null;t.session!.enabled=false;t.session!.autoStart=undefined;t.session!.paused='标题已在外部修改';});throw Error('organizer_external_title_change');}
    const finish=()=>store.update(l=>{const t=l.targets[targetId];t.currentTitle=title;t.lastWritten=title;t.state=state;t.hasUncommittedChanges=workingChanges;t.session={...t.session,version:1,enabled:(t.session?.controlRevision||0)===control,autoStart:undefined,acceptedBody:preview.body,...(!statusOnly?{materialFingerprint:preview.sourceFingerprint}:{}),configurationFingerprint:configuration,paused:undefined,error:undefined};if(statusOnly&&t.session.preview)t.session.preview.title=formatOrganizerTitle(t.session.preview.body,state,policy,false,workingChanges);t.policy='preview';delete t.pendingWrite;});
    if(title===native.title){finish();return;}
    store.update(l=>{const t=l.targets[targetId];if(t.originalTitle===undefined)t.originalTitle=native.title||null;if(t.pendingWrite)t.uncertainWrites=[...(t.uncertainWrites||[]),t.pendingWrite].slice(-100);t.pendingWrite={id:randomUUID(),from:native.title||null,to:title};});
    try{await api.workspaces.ref(targetId).setTitle(title);store.update(l=>{const t=l.targets[targetId];t.history=[...t.history,{at:at(),from:native.title||null,to:title}].slice(-100);});finish();}
    catch(error){store.update(l=>{const s=l.targets[targetId].session!;s.enabled=false;s.paused='标题写入结果未确认，请重新核对';});throw error;}
  }
  private startAutomatic(route:ProjectRoute,targetId:string){
    try{this.enqueue(route,targetId);}catch(error){if(errorText(error)!=='organizer_queue_full')throw error;this.schedule(route,targetId,1000);}
  }
  private schedule(route:ProjectRoute,targetId:string,delayMs=this.deps.settings.response(route).effective.debounceSeconds*1000){
    if(this.closed)return;const key=route.configPath+':'+targetId,old=this.timers.get(key);if(old)clearTimeout(old);
    const timer=setTimeout(()=>{this.timers.delete(key);if(this.closed||!this.deps.store(route).read().targets[targetId]?.session?.enabled)return;
      const active=[...this.active.values()].find(r=>r.project===route.configPath&&r.targetId===targetId);
      if(active){void active.promise.finally(()=>{if(!this.closed)this.schedule(route,targetId);});return;}
      try{this.startAutomatic(route,targetId);}catch{this.sourceWatches.get(route.configPath)?.seen.delete(targetId);}
    },delayMs);timer.unref();this.timers.set(key,timer);
  }
  changed(route:ProjectRoute,_agentId?:string){if(!this.closed)void this.checkSources(route).catch(()=>{});}
  abort(project?:string){for(const active of this.active.values())if(!project||active.project===project)active.abort.abort();}
  reconfigure(){for(const active of this.active.values()){const route={configPath:active.project} as ProjectRoute;if(this.deps.settings.fingerprint(route)!==active.configuration)active.abort.abort();}}
  async close(){this.closed=true;for(const watch of this.sourceWatches.values())clearTimeout(watch.timer);for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.abort();await Promise.allSettled([...this.active.values()].map(r=>r.promise));await Promise.allSettled([...this.sourceWatches.values()].flatMap(w=>w.flight?[w.flight]:[]));this.sourceWatches.clear();await Promise.allSettled([...this.writing.values()]);}
}
