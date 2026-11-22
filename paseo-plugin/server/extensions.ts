import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtinExtensionRegistry } from './backend/extensions/registry.ts';
import { serviceConnectionSchema, type ServiceConnection, type ServiceConnectionStatus, type ExtensionState } from '../shared/extensions.ts';
import type { CommunicationsAction, Delivery } from '../shared/extensions/project-communications/shared.ts';
import { resolveProject, withProject, type ProjectRoute } from './projects.ts';
import { handleSessionOperation } from './session-tools.ts';
import { allAgentBindings } from './agent-store.ts';
import { createExtensionHost } from './extension-host.ts';
import type { AgentContext } from './agent-provider.ts';
import { CommunicationsConnection, defaultServiceConnection, localServiceToken } from './communications-connection.ts';
import { ArchiveTopics } from './archive-topics.ts';
import { TopicMaterials } from './topic-materials.ts';
import { assertTopicSession, deliverTopicSession, topicSessionReceipt, topicTargets } from './topic-targets.ts';
import { assertTopicModel, createTopicSession, newTopicSessionReceipt, topicModels } from './topic-sessions.ts';
import { appendTopicImages } from './topic-chat-media.ts';
import { topicSessionPreferences } from './topic-session-preferences.ts';
import type { TopicAction } from '../shared/extensions/project-communications/topics.ts';

type Settings={version:number;enabled:Record<string,boolean>;connections?:Record<string,{revision:number;config:ServiceConnection}>;[key:string]:unknown};
type OwnedConnection={connection:CommunicationsConnection;revision:number;ready:Promise<unknown>};
/** A UI connector only. It never starts, owns or stops the independent service. */
export class WorkbenchExtensions {
  readonly registry=builtinExtensionRegistry();
  private clients=new Map<string,OwnedConnection>();private closed=false;
  private archives=new Map<string,OwnedConnection>();
  private key(route:ProjectRoute,id:string){return route.configPath+'\0'+id;}
  private settingsPath(route:ProjectRoute){return join(route.stateRoot,'extensions','enabled.json');}
  private settings(route:ProjectRoute):Settings {const path=this.settingsPath(route);if(!existsSync(path))return {version:1,enabled:{}};const raw=JSON.parse(readFileSync(path,'utf8'));if(raw.version!==1||!raw.enabled||typeof raw.enabled!=='object')throw Error('extension_settings_invalid');return raw;}
  private write(route:ProjectRoute,value:Settings){const path=this.settingsPath(route);mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID();writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);}
  private credentialFile(route:ProjectRoute){const home=process.env.PASEO_HOME?.replace(/^~(?=\/|$)/,homedir())||join(homedir(),'.paseo');return join(home,'secrets','workspace-workbench',createHash('sha256').update(route.configPath).digest('hex'),'communications-service-token');}
  private token(route:ProjectRoute,config:ServiceConnection){const file=this.credentialFile(route);if(!existsSync(file))return localServiceToken(config);const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('service_token_storage_invalid');return readFileSync(file,'utf8').trim()||localServiceToken(config);}
  private connectionSettings(route:ProjectRoute,id:string){return this.settings(route).connections?.[id]||{revision:1,config:defaultServiceConnection(route.configPath)};}
  restore(){/* Collection is owned by the service; visible status requests reconnect. */}
  async connection(projectConfig:string,id:string,action:'read'|'configure'|'check',input?:{revision?:number;connection?:ServiceConnection;token?:string}):Promise<ServiceConnectionStatus>{
    this.registry.get(id);const route=resolveProject({projectConfig});
    if(action==='configure'){
      const old=this.settings(route),current=this.connectionSettings(route,id);if(input?.revision!==current.revision)throw Error('settings_revision_conflict');
      const config=serviceConnectionSchema.parse(input?.connection),file=this.credentialFile(route);
      if(input?.token!==undefined||current.config.endpoint!==config.endpoint){mkdirSync(dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID();writeFileSync(temporary,input?.token||'',{mode:0o600});renameSync(temporary,file);}
      this.write(route,{...old,connections:{...old.connections,[id]:{revision:current.revision+1,config}}});this.clients.get(this.key(route,id))?.connection.close();this.clients.delete(this.key(route,id));this.archives.get(this.key(route,id))?.connection.close();this.archives.delete(this.key(route,id));
    }
    const current=this.connectionSettings(route,id),file=this.credentialFile(route),hasStored=existsSync(file)&&Boolean(readFileSync(file,'utf8').trim());
    const result:ServiceConnectionStatus={revision:current.revision,connection:current.config,hasToken:Boolean(this.token(route,current.config)),localToken:!hasStored&&Boolean(localServiceToken(current.config))};
    if(action==='check'){const client=new CommunicationsConnection(current.config,()=>this.token(route,current.config));try{const health=await client.check();result.connected=true;result.serviceVersion=health.version;result.detail='AI 助手已连接';}catch(error){result.connected=false;result.detail=error instanceof Error?error.message:'service_connection_failed';}finally{client.close();}}
    return result;
  }
  private async client(route:ProjectRoute,id:string){
    if(this.closed)throw Error('extension_host_unloaded');if(!this.settings(route).enabled[id])throw Error('extension_disabled');
    const settings=this.connectionSettings(route,id),key=this.key(route,id);let owned=this.clients.get(key);
    if(!owned||owned.revision!==settings.revision){owned?.connection.close();const connection=new CommunicationsConnection(settings.config,()=>this.token(route,settings.config));owned={connection,revision:settings.revision,ready:connection.register(route.displayName)};this.clients.set(key,owned);
      const captured=owned;void owned.ready.catch(()=>{if(this.clients.get(key)===captured)this.clients.delete(key);connection.close();});}
    await owned.ready;return owned.connection;
  }
  async state(projectConfig:string,id:string):Promise<ExtensionState>{
    const route=resolveProject({projectConfig}),manifest=this.registry.get(id),enabled=Boolean(this.settings(route).enabled[id]);if(!enabled)return {manifest,enabled:false,state:'disabled',unread:0};
    try{await this.archiveClient(route,id);return {manifest,enabled:true,state:'ready',unread:0};}
    catch(error){return {manifest,enabled:true,state:'failed',unread:0,error:error instanceof Error?error.message:'service_unavailable'};}
  }
  async setEnabled(projectConfig:string,id:string,enabled:boolean){const route=resolveProject({projectConfig});this.registry.get(id);const old=this.settings(route);this.write(route,{...old,enabled:{...old.enabled,[id]:enabled}});if(!enabled){this.clients.get(this.key(route,id))?.connection.close();this.clients.delete(this.key(route,id));this.archives.get(this.key(route,id))?.connection.close();this.archives.delete(this.key(route,id));}return this.state(projectConfig,id);}
  private async archiveClient(route:ProjectRoute,id:string){
    if(this.closed)throw Error('extension_host_unloaded');
    const settings=this.connectionSettings(route,id),key=this.key(route,id);let owned=this.archives.get(key);
    if(!owned||owned.revision!==settings.revision){owned?.connection.close();const connection=new CommunicationsConnection(settings.config,()=>this.token(route,settings.config));owned={connection,revision:settings.revision,ready:connection.check()};this.archives.set(key,owned);
      const captured=owned;void owned.ready.catch(()=>{if(this.archives.get(key)===captured)this.archives.delete(key);connection.close();});}
    await owned.ready;return owned.connection;
  }
  async topics(projectConfig:string,id:string,revision:number,request:TopicAction,context?:AgentContext):Promise<unknown>{
    this.registry.get(id);const route=resolveProject({projectConfig}),settings=this.connectionSettings(route,id);
    if(settings.revision!==revision)throw Error('project_connection_changed');
    if(request.action!=='directory'&&!this.settings(route).enabled[id])throw Error('extension_disabled');
    if(request.action==='preferences')return topicSessionPreferences(route,request.value);
    const archive=new ArchiveTopics(await this.archiveClient(route,id));
    const materials=new TopicMaterials(route.stateRoot,createHash('sha256').update(JSON.stringify([route.configPath,settings.revision,settings.config])).digest('hex'));
    const targets=()=>topicTargets(route,context);
    switch(request.action){
      case 'directory':return archive.directory(request.libraryId);
      case 'list':return archive.list(request);
      case 'read':return archive.read(request.topicId);
      case 'messages':return archive.messages(request.topicId,request.offset);
      case 'context':return archive.context(request.topicId,request.messageId);
      case 'asset':return archive.asset(request.topicId,request.messageId,request.assetId,request.contextOf,request.part||request.view);
      case 'group.configure':return archive.configure(request);
      case 'targets':return targets();
      case 'models':{
        if(!context)throw Error('extension_host_delivery_unavailable');
        return topicModels(route,context);
      }
      case 'preview':{
        if(request.newSession){
          if(request.targetId||request.workspaceId)throw Error('topic_target_conflict');
          if(!context)throw Error('extension_host_delivery_unavailable');
          await assertTopicModel(route,context,request.newSession);
          return withProject({projectConfig},()=>materials.preview(archive,'','',request.selections,undefined,{note:request.note,newSession:request.newSession,content:request.content}));
        }
        const candidates=request.targetId?.startsWith('session:') ? await targets() : await topicTargets(route);
        const target=candidates.find(item=>request.targetId ? item.id===request.targetId : item.kind==='workspace'&&item.workspaceId===request.workspaceId);
        if(!target)throw Error('topic_target_unavailable');
        return withProject({projectConfig},()=>materials.preview(archive,target.workspaceId,target.agentId,request.selections,target,{note:request.note,content:request.content}));
      }
      case 'send':case 'receipt':{
        if(!context)throw Error('extension_host_delivery_unavailable');
        const preview=materials.read(request.id);
        const current=()=>{if(this.closed||this.connectionSettings(route,id).revision!==revision||!this.settings(route).enabled[id])throw Error('project_connection_changed');};
        if(preview.newSession){
          if(request.action==='send'&&preview.state==='preview')await assertTopicModel(route,context,preview.newSession);
          current();
          if(request.action==='receipt'&&preview.state==='accepted'&&preview.session){
            await assertTopicSession(route,context,preview.session);
            await appendTopicImages(route,context,preview.session.agentId,preview);
          }
          return request.action==='receipt'
            ? materials.receipt(request.id,preview.agentId,value=>newTopicSessionReceipt(route,context,value))
            : materials.send(request.id,preview.agentId,value=>createTopicSession(route,context,{...value,newSession:preview.newSession!},current,(session,messageId)=>{
              materials.recordSession(value.id,session,messageId);
              Object.assign(value,{session,messageId,targetAgentId:session.agentId,workspaceId:session.hostWorkspaceId});
            }));
        }
        if(preview.session){
          await assertTopicSession(route,context,preview.session);
          current();
          if(request.action==='receipt'&&preview.state==='accepted')await appendTopicImages(route,context,preview.session.agentId,preview);
          return request.action==='receipt'
            ? materials.receipt(request.id,preview.session.agentId,value=>topicSessionReceipt(route,context,preview.session!,value.id))
            : materials.send(request.id,preview.session.agentId,value=>deliverTopicSession(route,context,preview.session!,value,current));
        }
        const target=(await topicTargets(route)).find(item=>item.workspaceId===preview.workspaceId);
        if(!target)throw Error('topic_target_unavailable');
        if(request.action==='receipt')return materials.receipt(request.id,target.agentId,value=>withProject({projectConfig},()=>handleSessionOperation({projectConfig,workspaceId:value.workspaceId,action:'receipt',requestId:'archive-topic:'+value.id,attachments:[],behavior:'steer',limit:20,timeoutMs:0},context)) as Promise<{delivery:string;messageId?:string}>);
        const host=createExtensionHost(route,context);
        if(this.closed||this.connectionSettings(route,id).revision!==revision||!this.settings(route).enabled[id])throw Error('project_connection_changed');
        return materials.send(request.id,target.agentId,async value=>{
          await appendTopicImages(route,context,target.agentId,value); current();
          return host.deliver({workspaceId:value.workspaceId,requestId:'archive-topic:'+value.id,text:value.dispatchText||value.text||'请查看图片。',attachments:value.references});
        });
      }
    }
  }
  async request(projectConfig:string,id:string,request:CommunicationsAction,context?:AgentContext):Promise<any>{
    const route=resolveProject({projectConfig});this.registry.get(id);const client=await this.client(route,id);
    if(request.action==='delivery.targets')return withProject({projectConfig},()=>allAgentBindings().map(item=>({workspaceId:item.workspaceId,agentId:item.agentId})));
    if(request.action==='delivery.send'||request.action==='delivery.status'){
      if(!context)throw Error('extension_host_delivery_unavailable');const status=await client.action({action:'delivery.status',id:request.id}) as Delivery;
      if(request.action==='delivery.status'&&['uncertain','sending'].includes(status.state)){
        const receipt:any=await withProject({projectConfig},()=>handleSessionOperation({projectConfig,workspaceId:status.workspaceId,action:'receipt',requestId:'communications:'+status.id,attachments:[],behavior:'steer',limit:20,timeoutMs:0},context));
        return receipt.delivery==='accepted'?client.delivery(status.id,'finish',receipt):status;
      }
      if(request.action==='delivery.status')return status;
      const claim=await client.delivery(request.id,'claim');if(!claim.claimed)return claim.delivery;
      try{
        const host=createExtensionHost(route,context);
        const references=await host.registerMaterials(claim.attachments.map((item:{id:string;title:string;mimeType:string;base64:string})=>({...item,id:item.id+'-'+createHash('sha256').update(item.base64).digest('hex').slice(0,16),bytes:Buffer.from(item.base64,'base64')})));
        const receipt=await host.deliver({workspaceId:claim.delivery.workspaceId,requestId:'communications:'+request.id,text:claim.delivery.text,attachments:references});
        return client.delivery(request.id,'finish',receipt);
      }catch{return client.delivery(request.id,'finish',{delivery:'uncertain'});}
    }
    return client.action(request);
  }
  async close(){this.closed=true;for(const owned of [...this.clients.values(),...this.archives.values()])owned.connection.close();this.clients.clear();this.archives.clear();}
}
