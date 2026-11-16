import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtinExtensionRegistry } from './backend/extensions/registry.ts';
import { serviceConnectionSchema, type ServiceConnection, type ServiceConnectionStatus, type ExtensionState } from '../shared/extensions.ts';
import type { CommunicationsAction, Delivery, Snapshot } from '../shared/extensions/project-communications/shared.ts';
import { resolveProject, withProject, type ProjectRoute } from './projects.ts';
import { handleSessionOperation } from './session-tools.ts';
import { allAgentBindings } from './agent-store.ts';
import { createExtensionHost } from './extension-host.ts';
import type { AgentContext } from './agent-provider.ts';
import { CommunicationsConnection, defaultServiceConnection, localServiceToken } from './communications-connection.ts';

type Settings={version:number;enabled:Record<string,boolean>;connections?:Record<string,{revision:number;config:ServiceConnection}>;[key:string]:unknown};
type OwnedConnection={connection:CommunicationsConnection;revision:number;ready:Promise<unknown>};
/** A UI connector only. It never starts, owns or stops the independent service. */
export class WorkbenchExtensions {
  readonly registry=builtinExtensionRegistry();
  private clients=new Map<string,OwnedConnection>();private closed=false;
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
      this.write(route,{...old,connections:{...old.connections,[id]:{revision:current.revision+1,config}}});this.clients.get(this.key(route,id))?.connection.close();this.clients.delete(this.key(route,id));
    }
    const current=this.connectionSettings(route,id),file=this.credentialFile(route),hasStored=existsSync(file)&&Boolean(readFileSync(file,'utf8').trim());
    const result:ServiceConnectionStatus={revision:current.revision,connection:current.config,hasToken:Boolean(this.token(route,current.config)),localToken:!hasStored&&Boolean(localServiceToken(current.config))};
    if(action==='check'){const client=new CommunicationsConnection(current.config,()=>this.token(route,current.config));try{const health=await client.check();result.connected=true;result.serviceVersion=health.version;result.detail='独立服务 API 已连接；钉钉授权与消息能力需分别验证';}catch(error){result.connected=false;result.detail=error instanceof Error?error.message:'service_connection_failed';}finally{client.close();}}
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
    try{const snapshot=await (await this.client(route,id)).action({action:'snapshot'}) as Snapshot;return {manifest,enabled:true,state:'ready',unread:snapshot.unread};}
    catch(error){return {manifest,enabled:true,state:'failed',unread:0,error:error instanceof Error?error.message:'service_unavailable'};}
  }
  async setEnabled(projectConfig:string,id:string,enabled:boolean){const route=resolveProject({projectConfig});this.registry.get(id);const old=this.settings(route);this.write(route,{...old,enabled:{...old.enabled,[id]:enabled}});if(!enabled){this.clients.get(this.key(route,id))?.connection.close();this.clients.delete(this.key(route,id));}return this.state(projectConfig,id);}
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
  async close(){this.closed=true;for(const owned of this.clients.values())owned.connection.close();this.clients.clear();}
}
