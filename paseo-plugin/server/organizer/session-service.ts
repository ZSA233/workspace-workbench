import {randomUUID} from 'node:crypto';
import type {PaseoApi,PaseoAgent} from '@getpaseo/client';
import {aggregateProduction,formatOrganizerTitle,type ConversationAnalysis,type OrganizerInput,type OrganizerJob,type OrganizerPolicy,type OrganizerTarget,type WorkspaceAnalysis,type WorkspaceMaterial} from '../../shared/organizer.ts';
import {allAgentBindings} from '../agent-store.ts';
import {withProject,type ProjectRoute} from '../projects.ts';
import {conversationBatch} from './conversation.ts';
import {organizerProgress} from './jobs.ts';
import {callSessionModel,sessionModelPrompt,type SessionMessages} from './session-model.ts';
import {organizerHash,type OrganizerSettings,type OrganizerStore} from './storage.ts';
import {SessionProduction} from './session-production.ts';

type Request=Extract<OrganizerInput['request'],{action:'session.refresh'|'session.apply'|'session.automatic'}>;
type Dependencies={settings:OrganizerSettings;api():Promise<PaseoApi>;store(route:ProjectRoute):OrganizerStore;read(route:ProjectRoute,method:'workspace.list'|'repository.compare'|'repository.fetch',params?:Record<string,unknown>):Promise<Record<string,any>>;materials(route:ProjectRoute,id:string,key:string,policy:OrganizerPolicy):Promise<WorkspaceMaterial>;model<T>(work:()=>Promise<T>):Promise<T>};
const at=()=>new Date().toISOString();
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const productionState=(rows:WorkspaceAnalysis[])=>aggregateProduction(rows.filter(w=>w.material.state!=='discussion'||w.material.taskBrief||w.material.evidence.some(e=>e.kind==='goal')).map(w=>w.material.state));
type Active={project:string;targetId:string;abort:AbortController;promise:Promise<void>;preview:boolean;force:boolean};
type Messages=SessionMessages&{batch?:ReturnType<typeof conversationBatch>};
export class SessionOrganizer {
  private active=new Map<string,Active>();private tails=new Map<string,Promise<void>>();private timers=new Map<string,ReturnType<typeof setTimeout>>();private closed=false;
  private writing=new Map<string,Promise<void>>();
  private production=new SessionProduction();
  private deps:Dependencies;
  constructor(deps:Dependencies){this.deps=deps;}
  private config(route:ProjectRoute){const settings=this.deps.settings.response(route),profile=settings.profiles.find(p=>p.id===settings.effective.profileId);return organizerHash([profile,sessionModelPrompt(settings.effective),settings.effective.markers]);}
  async request(route:ProjectRoute,request:Request){
    if(request.action==='session.apply'){await this.apply(route,request.targetId,request.previewId);return this.deps.store(route).read().targets[request.targetId];}
    if(request.action==='session.automatic'){
      const timerKey=route.configPath+':'+request.targetId,timer=this.timers.get(timerKey);if(timer)clearTimeout(timer);this.timers.delete(timerKey);
      for(const run of this.active.values())if(run.project===route.configPath&&run.targetId===request.targetId)run.abort.abort();
      this.deps.store(route).update(l=>{const t=l.targets[request.targetId];if(!t)throw Error('organizer_target_missing');t.session={...t.session,version:1,enabled:false,controlRevision:(t.session?.controlRevision||0)+1};});return this.deps.store(route).read().targets[request.targetId];
    }
    return this.enqueue(route,request.targetId,request.preview,request.force);
  }
  cancel(route:ProjectRoute,id:string){const running=this.active.get(id);if(!running||running.project!==route.configPath)return false;running.abort.abort();organizerProgress(this.deps.store(route),id).update(j=>{j.cancelRequestedAt=at();if(j.state==='queued')j.state='cancelled';});return true;}
  private enqueue(route:ProjectRoute,targetId:string,preview=false,force=false):OrganizerJob {
    if(this.closed)throw Error('organizer_closed');
    const old=[...this.active].find(([,r])=>r.project===route.configPath&&r.targetId===targetId&&r.preview===preview&&r.force===force&&!r.abort.signal.aborted);if(old)return this.deps.store(route).read().jobs.find(j=>j.id===old[0])!;
    if(this.active.size>=8)throw Error('organizer_queue_full');
    const job:OrganizerJob={id:randomUUID(),kind:'session',hostWorkspaceId:targetId,state:'queued',stage:'queued',workspaceIds:[],completed:0,total:0,createdAt:at(),updatedAt:at(),model:{state:'not-requested',calls:0,completed:0},result:{analyzed:0,cached:0,skipped:0,failed:0,titleWrites:0,conversations:0}};
    const store=this.deps.store(route),abort=new AbortController();store.update(l=>l.jobs.push(job));
    const promise=(this.tails.get(route.configPath)||Promise.resolve()).catch(()=>{}).then(()=>this.perform(route,job.id,targetId,preview,force,abort.signal)).catch(error=>{
      store.update(l=>{const j=l.jobs.find(j=>j.id===job.id)!;j.state=abort.signal.aborted?'cancelled':'failed';j.error=errorText(error);j.updatedAt=at();const t=l.targets[targetId];if(t?.session&&!abort.signal.aborted)t.session.error=errorText(error);});
    }).finally(()=>this.active.delete(job.id));
    this.active.set(job.id,{project:route.configPath,targetId,abort,promise,preview,force});this.tails.set(route.configPath,promise);return job;
  }
  private async discover(route:ProjectRoute,targetId:string,api:PaseoApi,assertCurrent:()=>void) {
    const native=await api.workspaces.ref(targetId).refresh();if(!native||(native as {archivedAt?:string}).archivedAt)throw Error('organizer_host_workspace_unavailable');
    const roster=await this.deps.read(route,'workspace.list'),bindings=withProject({projectConfig:route.configPath},allAgentBindings),agents=new Map<string,PaseoAgent>();let cursor:string|undefined;
    for(let page=0;page<20;page++){const result=await api.agents.list({filter:{includeArchived:false},page:{limit:200,...(cursor?{cursor}:{})}});for(const row of result.entries)agents.set(row.agent.id,row.agent);if(!result.pageInfo.hasMore)break;const next=result.pageInfo.nextCursor||undefined;if(!next||next===cursor||page===19)throw Error('organizer_agents_incomplete');cursor=next;}
    assertCurrent();const linked:Array<Record<string,any>>=[],agentIds=new Set<string>();
    for(const row of roster.workspaces||[]){if(!row.managed||row.id==='main'||['record_invalid','removed','deletion_pending'].includes(row.state))continue;
      const ids=new Set<string>([row.creator?.agentId,...bindings.filter(b=>b.workspaceId===row.id).map(b=>b.agentId)].filter(Boolean));let belongs=false;
      for(const id of ids){const agent=agents.get(id);if(!agent||agent.workspaceId!==targetId||agent.archivedAt)continue;const binding=bindings.find(b=>b.workspaceId===row.id&&b.agentId===id);if(binding&&(binding.cwd!==agent.cwd||binding.paseoWorkspaceId!==targetId))continue;belongs=true;agentIds.add(id);}
      if(belongs&&typeof row.instanceKey==='string')linked.push(row);
    }
    const store=this.deps.store(route);store.update(l=>{
      for(const row of linked){const key=String(row.instanceKey);if(!l.workspaces[key])l.workspaces[key]={key,title:row.displayName||row.id,brief:'',items:[],material:{workspaceId:row.id,instance:key,name:row.displayName||row.id,createdAt:row.createdAt||'',activityAt:row.createdAt||'',latestCommitAt:row.latestCommitAt||null,taskBrief:row.taskBrief||'',fingerprint:'',evidence:[],repositories:[],state:'unknown',complete:false}};}
      const t=l.targets[targetId]||{id:targetId,agentIds:[],workspaceKeys:[],currentTitle:native.title||null,state:'unknown',policy:'preview',history:[]};
      t.session||={version:1,enabled:false};
      if(t.pendingWrite){t.session.enabled=false;t.session.paused='此前标题写入结果未确认，请重新核对';if(native.title===t.pendingWrite.to){t.lastWritten=native.title||null;delete t.pendingWrite;}}
      if(t.session.enabled&&t.lastWritten!==undefined&&native.title!==t.lastWritten){t.session.enabled=false;t.session.paused='标题已在外部修改';}
      t.currentTitle=native.title||null;t.agentIds=[...agentIds];t.workspaceKeys=linked.map(row=>String(row.instanceKey));
      if(!linked.length){t.session.enabled=false;t.session.paused='当前会话暂无关联工作区';}l.targets[targetId]=t;
    });return linked;
  }
  private rows(store:OrganizerStore,targetId:string){const l=store.read();return l.targets[targetId].workspaceKeys.map(k=>l.workspaces[k]).filter(Boolean).sort((a,b)=>{
    const x=Date.parse(a.material.latestCommitAt||''),y=Date.parse(b.material.latestCommitAt||'');if(Number.isFinite(x)&&Number.isFinite(y)&&x!==y)return y-x;if(Number.isFinite(x)!==Number.isFinite(y))return Number.isFinite(x)?-1:1;return a.material.workspaceId.localeCompare(b.material.workspaceId);
  });}
  private fingerprint(store:OrganizerStore,targetId:string){const l=store.read(),t=l.targets[targetId];return organizerHash([[...t.workspaceKeys].sort().map(key=>[key,l.workspaces[key]?.material.fingerprint,l.workspaces[key]?.material.latestCommitAt]),[...t.agentIds].sort().map(id=>[id,l.conversations[id]?.fingerprint,l.conversations[id]?.cursor,l.conversations[id]?.pendingMessage])]);}
  private async messages(store:OrganizerStore,target:OrganizerTarget,api:PaseoApi,assertCurrent:()=>void,reusePreview=false){
    const rows:Messages[]=[],heads:Record<string,{epoch:string;seq:number}>={};
    for(const agentId of target.agentIds){assertCurrent();let old=store.read().conversations[agentId];const head=await api.agents.ref(agentId).timeline.refetch({limit:1,direction:'before'});if(head.error||head.staleCursor)throw Error(head.error||'organizer_history_cursor_stale');heads[agentId]={epoch:head.epoch,seq:head.entries.at(-1)?.seqEnd||0};
      if(reusePreview&&organizerHash(heads[agentId])===organizerHash(target.session?.preview?.messageHeads?.[agentId])){rows.push({agentId,previous:old,evidence:[],complete:old?.complete||false});continue;}
      for(let pages=0;pages<8;pages++){const page=await api.agents.ref(agentId).timeline.refetch({limit:100,direction:'after',...(old?.cursor?{cursor:old.cursor}:{})});assertCurrent();if(page.error||page.staleCursor)throw Error(page.error||'organizer_history_cursor_stale');
        const batch=conversationBatch(agentId,page,old,400);if(batch.evidence.length){rows.push({agentId,previous:old,evidence:batch.evidence,complete:batch.startedAtBeginning&&!page.hasNewer&&!batch.limited,batch});break;}
        const last=page.entries.at(-1);if(last){const next:ConversationAnalysis={...old,agentId,brief:old?.brief||'',items:old?.items||[],evidence:old?.evidence||[],cursor:{epoch:page.epoch,seq:last.seqEnd},pendingMessage:undefined,startedAtBeginning:batch.startedAtBeginning,complete:batch.startedAtBeginning&&!page.hasNewer,updatedAt:old?.updatedAt||''};store.update(l=>{l.conversations[agentId]=next;});old=next;}
        if(!page.hasNewer||!last){rows.push({agentId,previous:old,evidence:[],complete:old?.complete??!page.hasOlder});break;}
        if(pages===7)rows.push({agentId,previous:old,evidence:[],complete:false});
      }
    }return {rows,heads};
  }
  private async perform(route:ProjectRoute,id:string,targetId:string,preview:boolean,force:boolean,signal:AbortSignal){
    const store=this.deps.store(route),settings=this.deps.settings,policy=settings.response(route).effective,token=settings.fingerprint(route),configuration=this.config(route),api=await this.deps.api();
    const assertCurrent=()=>{if(signal.aborted||this.closed)throw Error('organizer_cancelled');if(settings.fingerprint(route)!==token)throw Error('organizer_settings_changed');};
    const progress=organizerProgress(store,id);assertCurrent();progress.update(j=>{j.state='running';j.startedAt=at();});progress.stage('discovering');
    const roster=await this.discover(route,targetId,api,assertCurrent);progress.update(j=>{j.total=roster.length;j.workspaceIds=roster.map(r=>r.id);});
    for(const row of roster){assertCurrent();progress.stage('materials',{workspaceId:row.id,name:row.displayName||row.id});const load=()=>this.deps.materials(route,row.id,row.instanceKey,policy),initial=await load(),material=await this.production.refresh(route.configPath,initial,policy,id,(method,params)=>this.deps.read(route,method,params),load,signal,repository=>progress.stage('fetching',{workspaceId:row.id,name:row.displayName||row.id,repository}));material.latestCommitAt=row.latestCommitAt||null;assertCurrent();store.update(l=>{l.workspaces[row.instanceKey].material=material;});progress.update(j=>{j.completed++;});}
    store.update(l=>{l.targets[targetId].state=productionState(l.targets[targetId].workspaceKeys.map(k=>l.workspaces[k]));});
    let target=store.read().targets[targetId];if(!roster.length){progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    if(target.session!.enabled&&target.session!.configurationFingerprint!==configuration){store.update(l=>{l.targets[targetId].session!.enabled=false;l.targets[targetId].session!.paused='命名配置已改变，请先预览确认';});target=store.read().targets[targetId];}
    if(!policy.profileId){if(preview)throw Error('organizer_model_required');progress.skip('no-profile');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const own=this.rows(store,targetId).filter(w=>w.material.evidence.some(e=>e.kind==='commit'));
    if(!own.length){if(preview)throw Error('organizer_session_no_commits');progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const attempted=Date.parse(target.session!.lastAttemptAt||'');if(!preview&&!force&&Number.isFinite(attempted)&&Date.now()-attempted<policy.analysisIntervalSeconds*1000){
      const cached=target.session!.preview;if(target.session!.enabled&&cached?.sourceFingerprint===this.fingerprint(store,targetId)&&cached.configurationFingerprint===configuration){store.update(l=>{l.targets[targetId].session!.preview!.title=formatOrganizerTitle(cached.body,l.targets[targetId].state,policy);});if(target.currentTitle!==store.read().targets[targetId].session!.preview!.title)await this.write(route,targetId,cached.id,false);}
      progress.skip('interval');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const changed=own.filter(w=>!w.manual&&(!w.digest||w.digest.fingerprint!==w.material.fingerprint)).map(w=>w.key);
    const cached=target.session!.preview,reusePreview=preview&&!force&&!changed.length&&cached?.configurationFingerprint===configuration&&cached?.sourceFingerprint===this.fingerprint(store,targetId);
    const conversation=policy.conversationSummary?await this.messages(store,target,api,assertCurrent,reusePreview):{rows:[] as Messages[],heads:{}};assertCurrent();
    const fingerprint=this.fingerprint(store,targetId),wantTitle=preview||target.session!.enabled||changed.length>0;
    const newMessages=conversation.rows.some(r=>r.evidence.length),cachedTitle=target.session!.preview;
    const needTitle=wantTitle&&(force||newMessages||!cachedTitle||cachedTitle.sourceFingerprint!==fingerprint||cachedTitle.configurationFingerprint!==configuration);
    const batches:string[][]=[];for(let i=0;i<changed.length;i+=4)batches.push(changed.slice(i,i+4));if(!batches.length&&(needTitle||newMessages))batches.push([]);
    if(batches.length)store.update(l=>{l.targets[targetId].session!.lastAttemptAt=at();delete l.targets[targetId].session!.error;});
    let generatedTitle:Awaited<ReturnType<typeof callSessionModel>>['value']['title'],runId:string|undefined;
    for(let index=0;index<batches.length;index++){
      assertCurrent();const keys=batches[index],title=needTitle&&index===batches.length-1,profile=settings.profile(policy.profileId),rows=this.rows(store,targetId);
      const messages=index===0?conversation.rows:conversation.rows.map(row=>({...row,evidence:[],previous:store.read().conversations[row.agentId]}));
      progress.queued(profile);const result=await this.deps.model(async()=>{assertCurrent();return callSessionModel(profile,settings.secret(profile.id),policy,rows,keys,messages,title,target.currentTitle,target.session?.acceptedBody,targetId,signal,run=>store.addRun(run),(phase,run)=>{runId=run.id;progress.model(phase,run);});});assertCurrent();
      for(const key of keys){const before=rows.find(w=>w.key===key)!,checked=await this.deps.materials(route,before.material.workspaceId,key,policy);assertCurrent();if(checked.fingerprint!==before.material.fingerprint)throw Error('organizer_source_changed');}
      store.update(l=>{
        for(const item of result.value.workspaces){const w=l.workspaces[item.key];if(!w.manual)w.digest={...w.digest,version:1,title:item.title,brief:item.brief,evidenceIds:item.evidenceIds,fingerprint:w.material.fingerprint,at:at(),partial:result.packed.workspaces.find(p=>p.key===item.key)?.coverage!=='complete'};}
        for(const c of result.value.conversations){const packed=result.packed.conversations.find(p=>p.agentId===c.agentId)!,source=messages.find(m=>m.agentId===c.agentId)!,checkpoint=source.batch?.checkpoints.get(packed.evidence.at(-1)!.id),old=l.conversations[c.agentId];
          l.conversations[c.agentId]={...old,agentId:c.agentId,brief:c.brief,items:old?.items||[],evidence:[...(old?.evidence||[]),...packed.evidence].slice(-80),...checkpoint,startedAtBeginning:source.batch?.startedAtBeginning||old?.startedAtBeginning||false,complete:source.complete&&packed.evidence.length===source.evidence.length,updatedAt:at(),fingerprint:organizerHash([old?.fingerprint,packed.evidence])};}
      });for(const key of keys)progress.count('analyzed');for(const row of result.value.conversations)progress.count('conversations');generatedTitle=result.value.title||generatedTitle;
    }
    assertCurrent();const finalFingerprint=this.fingerprint(store,targetId);
    store.update(l=>{const t=l.targets[targetId],session=t.session!;if(generatedTitle)session.preview={...session.preview,id:randomUUID(),body:generatedTitle.text,title:formatOrganizerTitle(generatedTitle.text,t.state,policy),sourceFingerprint:finalFingerprint,configurationFingerprint:configuration,at:at(),runId,evidenceIds:generatedTitle.evidenceIds,conversationComplete:t.agentIds.every(id=>l.conversations[id]?.complete),messageHeads:conversation.heads,reviewedWriteId:preview?t.pendingWrite?.id:undefined};else if(session.preview&&session.preview.sourceFingerprint===finalFingerprint){session.preview.title=formatOrganizerTitle(session.preview.body,t.state,policy);if(preview&&session.preview.reviewedWriteId!==t.pendingWrite?.id){session.preview.reviewedWriteId=t.pendingWrite?.id;session.preview.id=randomUUID();}}delete session.error;});
    if(!batches.length){progress.skip('cached');progress.count('cached',own.length);}
    target=store.read().targets[targetId];if(target.session!.enabled&&target.session!.preview&&target.session!.configurationFingerprint===configuration){progress.stage('titles');await this.write(route,targetId,target.session!.preview.id,false);progress.count('titleWrites',target.history.length<store.read().targets[targetId].history.length?1:0);}
    progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});
  }
  private async apply(route:ProjectRoute,targetId:string,previewId:string){await this.write(route,targetId,previewId,true);}
  private write(route:ProjectRoute,targetId:string,previewId:string,explicit:boolean){
    const key=route.configPath+':'+targetId;if(this.writing.has(key))throw Error('organizer_title_write_busy');const promise=this.writeProtected(route,targetId,previewId,explicit).finally(()=>this.writing.delete(key));this.writing.set(key,promise);return promise;
  }
  private async writeProtected(route:ProjectRoute,targetId:string,previewId:string,explicit:boolean){
    const store=this.deps.store(route),settings=this.deps.settings,policy=settings.response(route).effective,token=settings.fingerprint(route),configuration=this.config(route),api=await this.deps.api();let target=store.read().targets[targetId];const preview=target?.session?.preview;
    if(!preview||preview.id!==previewId||target.pendingWrite&&(!explicit||preview.reviewedWriteId!==target.pendingWrite.id))throw Error('organizer_preview_changed');if(!explicit&&(!target.session!.enabled||target.session!.configurationFingerprint!==configuration))return;
    if(preview.configurationFingerprint!==configuration||preview.sourceFingerprint!==this.fingerprint(store,targetId))throw Error('organizer_preview_changed');
    const originalKeys=[...target.workspaceKeys],expected=target.currentTitle,control=target.session!.controlRevision||0;
    const assertCurrent=()=>{if(this.closed||settings.fingerprint(route)!==token)throw Error('organizer_settings_changed');};
    const roster=await this.discover(route,targetId,api,assertCurrent);if(organizerHash(roster.map(r=>r.instanceKey).sort())!==organizerHash([...originalKeys].sort()))throw Error('organizer_source_changed');
    for(const key of originalKeys){const prior=store.read().workspaces[key],material=this.production.applyCached(route.configPath,await this.deps.materials(route,prior.material.workspaceId,key,policy));assertCurrent();if(material.fingerprint!==prior.material.fingerprint)throw Error('organizer_source_changed');store.update(l=>{material.latestCommitAt=l.workspaces[key].material.latestCommitAt;l.workspaces[key].material=material;});}
    for(const [id,head]of Object.entries(preview.messageHeads||{})){const page=await api.agents.ref(id).timeline.refetch({limit:1,direction:'before'});assertCurrent();if(page.error||page.staleCursor||page.epoch!==head.epoch||(page.entries.at(-1)?.seqEnd||0)!==head.seq)throw Error('organizer_source_changed');}
    target=store.read().targets[targetId];const state=productionState(originalKeys.map(k=>store.read().workspaces[k])),title=formatOrganizerTitle(preview.body,state,policy);
    if(title!==preview.title||target.session?.preview?.id!==previewId||preview.sourceFingerprint!==this.fingerprint(store,targetId))throw Error('organizer_preview_changed');
    const native=await api.workspaces.ref(targetId).refresh();assertCurrent();if(!native||(native as {archivedAt?:string}).archivedAt)throw Error('organizer_host_workspace_unavailable');
    const live=store.read().targets[targetId];if((live.session?.controlRevision||0)!==control)throw Error('organizer_cancelled');if(live.session?.preview?.id!==previewId)throw Error('organizer_preview_changed');if(!explicit&&!live.session?.enabled)return;
    if(native.title!==expected||!explicit&&(!target.session!.enabled||native.title!==target.lastWritten)){store.update(l=>{const t=l.targets[targetId];t.currentTitle=native?.title||null;t.session!.enabled=false;t.session!.paused='标题已在外部修改';});throw Error('organizer_external_title_change');}
    const finish=()=>store.update(l=>{const t=l.targets[targetId];t.currentTitle=title;t.lastWritten=title;t.state=state;t.session={...t.session,version:1,enabled:(t.session?.controlRevision||0)===control,acceptedBody:preview.body,materialFingerprint:preview.sourceFingerprint,configurationFingerprint:configuration,paused:undefined,error:undefined};t.policy='preview';delete t.pendingWrite;});
    if(title===native.title){finish();return;}
    store.update(l=>{const t=l.targets[targetId];if(t.originalTitle===undefined)t.originalTitle=native.title||null;if(t.pendingWrite)t.uncertainWrites=[...(t.uncertainWrites||[]),t.pendingWrite].slice(-100);t.pendingWrite={id:randomUUID(),from:native.title||null,to:title};});
    try{await api.workspaces.ref(targetId).setTitle(title);store.update(l=>{const t=l.targets[targetId];t.history=[...t.history,{at:at(),from:native.title||null,to:title}].slice(-100);});finish();}
    catch(error){store.update(l=>{const s=l.targets[targetId].session!;s.enabled=false;s.paused='标题写入结果未确认，请重新核对';});throw error;}
  }
  changed(route:ProjectRoute,agentId?:string){if(this.closed)return;for(const target of Object.values(this.deps.store(route).read().targets)){if(!target.session?.enabled||agentId&&!target.agentIds.includes(agentId))continue;const key=route.configPath+':'+target.id;const old=this.timers.get(key);if(old)clearTimeout(old);const timer=setTimeout(()=>{this.timers.delete(key);try{this.enqueue(route,target.id);}catch{}},this.deps.settings.response(route).effective.debounceSeconds*1000);timer.unref();this.timers.set(key,timer);}}
  abort(project?:string){for(const active of this.active.values())if(!project||active.project===project)active.abort.abort();}
  async close(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.abort();await Promise.allSettled([...this.active.values()].map(r=>r.promise));await Promise.allSettled([...this.writing.values()]);}
}
