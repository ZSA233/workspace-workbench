import {randomUUID} from 'node:crypto';
import type {PaseoApi,PaseoAgent} from '@getpaseo/client';
import {aggregateProduction,formatOrganizerTitle,type ConversationAnalysis,type OrganizerInput,type OrganizerJob,type OrganizerPolicy,type OrganizerTarget,type WorkspaceAnalysis,type WorkspaceMaterial} from '../../shared/organizer.ts';
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

type Request=Extract<OrganizerInput['request'],{action:'session.refresh'|'session.apply'|'session.automatic'|'session.associations'|'session.associations.save'}>;
type Dependencies={settings:OrganizerSettings;api():Promise<PaseoApi>;store(route:ProjectRoute):OrganizerStore;read(route:ProjectRoute,method:'workspace.list'|'repository.compare'|'repository.fetch'|'organizer.versions',params?:Record<string,unknown>):Promise<Record<string,any>>;materials(route:ProjectRoute,id:string,key:string,policy:OrganizerPolicy):Promise<WorkspaceMaterial>;model<T>(work:()=>Promise<T>):Promise<T>};
const at=()=>new Date().toISOString();
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const productionState=(rows:WorkspaceAnalysis[])=>aggregateProduction(rows.filter(w=>w.material.state!=='discussion'||w.material.taskBrief||w.material.evidence.some(e=>e.kind==='goal')).map(w=>w.material.state));
type Active={project:string;targetId:string;abort:AbortController;promise:Promise<void>;preview:boolean;force:boolean};
type Messages=SessionMessages&{batch?:ReturnType<typeof conversationBatch>};
const sessionFingerprint=(l:OrganizerLedger,t:OrganizerTarget)=>organizerHash([[...t.workspaceKeys].sort().map(key=>[key,l.workspaces[key]?.material.fingerprint,l.workspaces[key]?.material.latestCommitAt]),[...t.agentIds].sort().map(id=>[id,l.conversations[id]?.fingerprint,l.conversations[id]?.cursor,l.conversations[id]?.pendingMessage])]);
export class SessionOrganizer {
  private active=new Map<string,Active>();private tails=new Map<string,Promise<void>>();private timers=new Map<string,ReturnType<typeof setTimeout>>();private closed=false;
  private writing=new Map<string,Promise<void>>();
  private production=new SessionProduction();
  private deps:Dependencies;
  constructor(deps:Dependencies){this.deps=deps;}
  private config(route:ProjectRoute,contentOnly=false){const settings=this.deps.settings.response(route),profile=settings.profiles.find(p=>p.id===settings.effective.profileId);return organizerHash(contentOnly?[profile,sessionModelPrompt(settings.effective)]:[profile,sessionModelPrompt(settings.effective),settings.effective.markers]);}
  previewStates(route:ProjectRoute,ledger:OrganizerLedger,targets:OrganizerTarget[]){
    const configuration=this.config(route);
    return Object.fromEntries(targets.map(t=>{const p=t.session?.preview;return[t.id,!p?'missing':p.configurationFingerprint!==configuration?'configuration':p.sourceFingerprint!==sessionFingerprint(ledger,t)?'source':t.pendingWrite&&p.reviewedWriteId!==t.pendingWrite.id?'write':'ready'];})) as Record<string,'ready'|'configuration'|'source'|'missing'|'write'>;
  }
  async request(route:ProjectRoute,request:Request){
    if(request.action==='session.associations'||request.action==='session.associations.save')return this.associations(route,request);
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
    const job:OrganizerJob={id:randomUUID(),kind:'session',hostWorkspaceId:targetId,intent:{preview},input:{workspaces:[],history:{pages:0,fragments:0,complete:false}},state:'queued',stage:'queued',workspaceIds:[],completed:0,total:0,createdAt:at(),updatedAt:at(),model:{state:'not-requested',calls:0,completed:0},result:{analyzed:0,cached:0,skipped:0,failed:0,titleWrites:0,conversations:0}};
    const store=this.deps.store(route),abort=new AbortController();store.update(l=>l.jobs.push(job));
    const promise=(this.tails.get(route.configPath)||Promise.resolve()).catch(()=>{}).then(()=>this.perform(route,job.id,targetId,preview,force,abort.signal)).catch(error=>{
      store.update(l=>{const j=l.jobs.find(j=>j.id===job.id)!;j.state=abort.signal.aborted?'cancelled':'failed';j.error=errorText(error);if(j.result&&!abort.signal.aborted)j.result.failed++;j.updatedAt=at();const t=l.targets[targetId];if(t?.session&&!abort.signal.aborted)t.session.error=errorText(error);});
    }).finally(()=>this.active.delete(job.id));
    this.active.set(job.id,{project:route.configPath,targetId,abort,promise,preview,force});this.tails.set(route.configPath,promise);return job;
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
      if(t.session.enabled&&t.lastWritten!==undefined&&native.title!==t.lastWritten){t.session.enabled=false;t.session.paused='标题已在外部修改';}
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
      t.session={...t.session,version:1,enabled:false,controlRevision:(t.session?.controlRevision||0)+1,preview:undefined,lastAttemptAt:undefined,error:undefined};
      if(wasEnabled)t.session.paused='关联已更新，请预览标题后重新开启';else if(t.session.paused==='当前会话暂无关联工作区')delete t.session.paused;
      syncSessionAssociations(l,t,context.rows,context.agents,context.bindings);
      t.state=productionState(t.workspaceKeys.map(key=>l.workspaces[key]));
    });ledger=store.read();target=ledger.targets[request.targetId];return sessionAssociations(ledger,target,context.rows);
  }
  private rows(store:OrganizerStore,targetId:string){const l=store.read();return l.targets[targetId].workspaceKeys.map(k=>l.workspaces[k]).filter(Boolean).sort((a,b)=>{
    const x=Date.parse(a.material.latestCommitAt||''),y=Date.parse(b.material.latestCommitAt||'');if(Number.isFinite(x)&&Number.isFinite(y)&&x!==y)return y-x;if(Number.isFinite(x)!==Number.isFinite(y))return Number.isFinite(x)?-1:1;return a.material.workspaceId.localeCompare(b.material.workspaceId);
  });}
  private fingerprint(store:OrganizerStore,targetId:string){const l=store.read();return sessionFingerprint(l,l.targets[targetId]);}
  private async versions(route:ProjectRoute,ids:string[],policy:OrganizerPolicy){
    const stamps=new Map<string,string|undefined>(),bindings=withProject({projectConfig:route.configPath},allAgentBindings);
    for(let i=0;i<ids.length;i+=100){const group=ids.slice(i,i+100);let result:Record<string,any>|undefined;
      try{result=await this.deps.read(route,'organizer.versions',{workspaceIds:group});}catch{/* Older or degraded backends retain the full verification path. */}
      for(const id of group)stamps.set(id,materialStamp(result,id,policy,bindings.filter(b=>b.workspaceId===id).map(b=>[b.handoffHash,b.handoff])));
    }return stamps;
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
  private async perform(route:ProjectRoute,id:string,targetId:string,preview:boolean,force:boolean,signal:AbortSignal){
    const store=this.deps.store(route),settings=this.deps.settings,policy=settings.response(route).effective,token=settings.fingerprint(route),configuration=this.config(route),contentConfiguration=this.config(route,true),api=await this.deps.api();
    const assertCurrent=()=>{if(signal.aborted||this.closed)throw Error('organizer_cancelled');if(settings.fingerprint(route)!==token)throw Error('organizer_settings_changed');};
    const progress=organizerProgress(store,id);assertCurrent();progress.update(j=>{j.state='running';j.startedAt=at();});progress.stage('discovering');
    const {linked:roster}=await this.discover(route,targetId,api,assertCurrent);progress.update(j=>{j.total=roster.length;j.workspaceIds=roster.map(r=>r.id);});
    const versions=await this.versions(route,roster.map(row=>row.id),policy);assertCurrent();
    for(const row of roster){
      assertCurrent();const previous=store.read().workspaces[row.instanceKey],name=previous.digest?.title||row.displayName||row.id;
      let proof=previous.materialCache,loads=0;
      const load=async()=>{progress.stage('materials',{workspaceId:row.id,name,repositoryCount:row.repositoryCount});
        const before=loads++?(await this.versions(route,[row.id],policy)).get(row.id):versions.get(row.id),material=await this.deps.materials(route,row.id,row.instanceKey,policy),after=(await this.versions(route,[row.id],policy)).get(row.id);assertCurrent();
        proof=before&&before===after?{stamp:before,fingerprint:material.fingerprint,at:at()}:undefined;return material;
      };
      const reused=!force&&reuseMaterial(previous,versions.get(row.id),policy),initial=reused?structuredClone(previous.material):await load();
      progress.update(j=>{j.input!.workspaces.push({id:row.id,name:row.displayName||row.id,repositories:initial.repositories.length,commits:initial.evidence.filter(e=>e.kind==='commit').length,notes:initial.evidence.filter(e=>e.kind==='note').length,diffs:initial.evidence.filter(e=>e.kind==='diff').length,materialCached:reused,cached:!!previous.manual||previous.digest?.fingerprint===initial.fingerprint});});
      const material=reused?initial:await this.production.refresh(route.configPath,initial,policy,id,(method,params)=>this.deps.read(route,method,params),load,signal,(repository,ref,fetching)=>progress.stage(fetching?'fetching':'production',{workspaceId:row.id,name,repository,ref}));
      material.latestCommitAt=row.latestCommitAt||null;assertCurrent();store.update(l=>{const w=l.workspaces[row.instanceKey];w.material=material;w.materialCache=proof;});progress.update(j=>{j.completed++;});
    }
    store.update(l=>{l.targets[targetId].state=productionState(l.targets[targetId].workspaceKeys.map(k=>l.workspaces[k]));});
    let target=store.read().targets[targetId];if(!roster.length){progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    if(target.session?.preview?.configurationFingerprint===configuration&&!target.session.preview.contentConfigurationFingerprint)store.update(l=>{l.targets[targetId].session!.preview!.contentConfigurationFingerprint=contentConfiguration;});
    if(target.session!.enabled&&target.session!.configurationFingerprint!==configuration){store.update(l=>{l.targets[targetId].session!.enabled=false;l.targets[targetId].session!.paused='命名配置已改变，请先预览确认';});target=store.read().targets[targetId];}
    if(!policy.profileId){if(preview)throw Error('organizer_model_required');progress.skip('no-profile');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const own=this.rows(store,targetId).filter(w=>w.material.evidence.some(e=>e.kind==='commit'));
    if(!own.length){if(preview)throw Error('organizer_session_no_commits');progress.skip('no-material');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;});return;}
    const attempted=Date.parse(target.session!.lastAttemptAt||'');if(!preview&&!force&&Number.isFinite(attempted)&&Date.now()-attempted<policy.analysisIntervalSeconds*1000){
      const cached=target.session!.preview;if(target.session!.enabled&&cached?.sourceFingerprint===this.fingerprint(store,targetId)&&cached.configurationFingerprint===configuration){store.update(l=>{l.targets[targetId].session!.preview!.title=formatOrganizerTitle(cached.body,l.targets[targetId].state,policy);});if(target.currentTitle!==store.read().targets[targetId].session!.preview!.title)await this.write(route,targetId,cached.id,false);}
      progress.skip('interval');progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;if(j.result){j.result.cached=own.filter(w=>w.digest?.fingerprint===w.material.fingerprint).length;j.result.previewReady=cached?.sourceFingerprint===this.fingerprint(store,targetId)&&cached?.configurationFingerprint===configuration;j.result.previewId=j.result.previewReady?cached?.id:undefined;}});return;}
    const changed=own.filter(w=>!w.manual&&(!w.digest||w.digest.fingerprint!==w.material.fingerprint)).map(w=>w.key);
    const cached=target.session!.preview,sameContent=!!cached&&(cached.configurationFingerprint===configuration||cached.contentConfigurationFingerprint===contentConfiguration),reusePreview=!force&&!changed.length&&sameContent&&cached?.sourceFingerprint===this.fingerprint(store,targetId);
    const conversation=policy.conversationSummary?await this.messages(store,target,api,assertCurrent,!!reusePreview,progress):{rows:[] as Messages[],heads:{}};assertCurrent();
    const fingerprint=this.fingerprint(store,targetId),wantTitle=preview||target.session!.enabled||changed.length>0||!cached||conversation.rows.some(r=>r.evidence.length);
    const newMessages=conversation.rows.some(r=>r.evidence.length),cachedTitle=target.session!.preview;
    const needTitle=wantTitle&&(force||newMessages||!cachedTitle||cachedTitle.sourceFingerprint!==fingerprint||!sameContent);
    progress.update(j=>{j.intent={preview,title:needTitle,summaries:changed.length};if(j.result)j.result.cached=own.length-changed.length;});
    const batches:string[][]=[];for(let i=0;i<changed.length;i+=4)batches.push(changed.slice(i,i+4));if(!batches.length&&(needTitle||newMessages))batches.push([]);
    if(batches.length)store.update(l=>{delete l.targets[targetId].session!.error;});
    let generatedTitle:Awaited<ReturnType<typeof callSessionModel>>['value']['title'],runId:string|undefined;
    for(let index=0;index<batches.length;index++){
      assertCurrent();const keys=batches[index],title=needTitle&&index===batches.length-1,profile=settings.profile(policy.profileId),rows=this.rows(store,targetId);
      const messages=index===0?conversation.rows:conversation.rows.map(row=>({...row,evidence:[],previous:store.read().conversations[row.agentId]}));
      progress.queued(profile);const result=await this.deps.model(async()=>{assertCurrent();return callSessionModel(profile,settings.secret(profile.id),policy,rows,keys,messages,title,target.currentTitle,target.session?.acceptedBody,targetId,signal,run=>store.addRun(run),(phase,run)=>{runId=run.id;if(phase==='requesting')store.update(l=>{l.targets[targetId].session!.lastAttemptAt=at();});progress.model(phase,run);});});assertCurrent();
      for(const key of keys){const before=rows.find(w=>w.key===key)!;progress.stage('verifying',{workspaceId:before.material.workspaceId,name:before.material.name});const checked=await this.deps.materials(route,before.material.workspaceId,key,policy);assertCurrent();if(checked.fingerprint!==before.material.fingerprint)throw Error('organizer_source_changed');}
      store.update(l=>{
        for(const item of result.value.workspaces){const w=l.workspaces[item.key];if(!w.manual)w.digest={...w.digest,version:1,title:item.title,brief:item.brief,evidenceIds:item.evidenceIds,fingerprint:w.material.fingerprint,at:at(),partial:result.packed.workspaces.find(p=>p.key===item.key)?.coverage!=='complete'};}
        for(const c of result.value.conversations){const packed=result.packed.conversations.find(p=>p.agentId===c.agentId)!,source=messages.find(m=>m.agentId===c.agentId)!,checkpoint=source.batch?.checkpoints.get(packed.evidence.at(-1)!.id),old=l.conversations[c.agentId];
          l.conversations[c.agentId]={...old,agentId:c.agentId,brief:c.brief,items:old?.items||[],evidence:[...(old?.evidence||[]),...packed.evidence].slice(-80),...checkpoint,startedAtBeginning:source.batch?.startedAtBeginning||old?.startedAtBeginning||false,complete:source.complete&&packed.evidence.length===source.evidence.length,updatedAt:at(),fingerprint:organizerHash([old?.fingerprint,packed.evidence])};}
      });progress.update(j=>{if(j.input){for(const row of result.value.workspaces){const entry=j.input.workspaces.find(w=>w.id===store.read().workspaces[row.key].material.workspaceId);if(entry)entry.updated=true;}j.input.history.sentFragments=(j.input.history.sentFragments||0)+result.packed.conversations.reduce((n,c)=>n+c.evidence.length,0);j.input.history.complete=store.read().targets[targetId].agentIds.every(id=>store.read().conversations[id]?.complete);}});for(const key of keys)progress.count('analyzed');for(const row of result.value.conversations)progress.count('conversations');generatedTitle=result.value.title||generatedTitle;
    }
    assertCurrent();const finalFingerprint=this.fingerprint(store,targetId);
    store.update(l=>{const t=l.targets[targetId],session=t.session!;if(generatedTitle)session.preview={...session.preview,id:randomUUID(),body:generatedTitle.text,title:formatOrganizerTitle(generatedTitle.text,t.state,policy),sourceFingerprint:finalFingerprint,configurationFingerprint:configuration,contentConfigurationFingerprint:contentConfiguration,at:at(),runId,evidenceIds:generatedTitle.evidenceIds,conversationComplete:t.agentIds.every(id=>l.conversations[id]?.complete),messageHeads:conversation.heads,reviewedWriteId:preview?t.pendingWrite?.id:undefined};else if(session.preview&&session.preview.sourceFingerprint===finalFingerprint){if(policy.conversationSummary)session.preview.messageHeads=conversation.heads;session.preview.title=formatOrganizerTitle(session.preview.body,t.state,policy);if(sameContent){if(session.preview.configurationFingerprint!==configuration)session.preview.id=randomUUID();session.preview.configurationFingerprint=configuration;session.preview.contentConfigurationFingerprint=contentConfiguration;}if(preview&&session.preview.reviewedWriteId!==t.pendingWrite?.id){session.preview.reviewedWriteId=t.pendingWrite?.id;session.preview.id=randomUUID();}}delete session.error;});
    if(!batches.length)progress.skip('cached');
    target=store.read().targets[targetId];if(!preview&&target.session!.enabled&&target.session!.preview&&target.currentTitle!==target.session!.preview.title&&target.session!.configurationFingerprint===configuration){progress.stage('titles');await this.write(route,targetId,target.session!.preview.id,false);progress.count('titleWrites',target.history.length<store.read().targets[targetId].history.length?1:0);}
    progress.stage('finished');progress.update(j=>{j.state='complete';j.current=undefined;if(j.result){j.result.previewReady=!!target.session!.preview&&target.session!.preview.sourceFingerprint===this.fingerprint(store,targetId)&&target.session!.preview.configurationFingerprint===configuration;j.result.previewId=j.result.previewReady?target.session!.preview?.id:undefined;}});
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
    const {linked:roster}=await this.discover(route,targetId,api,assertCurrent);if(organizerHash(roster.map(r=>r.instanceKey).sort())!==organizerHash([...originalKeys].sort()))throw Error('organizer_source_changed');
    for(const key of originalKeys){const prior=store.read().workspaces[key],material=this.production.applyCached(route.configPath,await this.deps.materials(route,prior.material.workspaceId,key,policy));assertCurrent();if(material.fingerprint!==prior.material.fingerprint)throw Error('organizer_source_changed');store.update(l=>{material.latestCommitAt=l.workspaces[key].material.latestCommitAt;l.workspaces[key].material=material;});}
    for(const [id,head]of Object.entries(preview.messageHeads||{})){const page=await api.agents.ref(id).timeline.refetch({limit:1,direction:'before'});assertCurrent();if(page.error||page.staleCursor||!(await samePublicConversation(api,id,head,{epoch:page.epoch,seq:page.entries.at(-1)?.seqEnd||0},assertCurrent)).same)throw Error('organizer_source_changed');}
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
