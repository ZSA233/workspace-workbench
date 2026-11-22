import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConnection } from '../shared/extensions.ts';

export const DEFAULT_SERVICE_ENDPOINT = 'http://127.0.0.1:47191';
export function defaultServiceConnection(projectConfig:string):ServiceConnection { return {endpoint:DEFAULT_SERVICE_ENDPOINT,projectId:createHash('sha256').update(projectConfig).digest('hex')}; }
export function localServiceToken(connection:ServiceConnection):string {
  if(connection.endpoint.replace(/\/$/,'')!==DEFAULT_SERVICE_ENDPOINT)return '';
  const file=join(process.env.AI_ASSISTANT_HOME||process.env.COMMUNICATIONS_HOME||join(homedir(),'.project-communications'),'api-token');
  if(!existsSync(file))return '';const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)return '';
  const token=readFileSync(file,'utf8').trim();return /^[a-f0-9]{64}$/.test(token)?token:'';
}
export class CommunicationsConnection {
  private controller=new AbortController();
  readonly config:ServiceConnection;
  private token:()=>string;
  constructor(config:ServiceConnection,token:()=>string){this.config=config;this.token=token;}
  get signal() { return this.controller.signal; }
  async metadata(path:string):Promise<{mimeType:string;size?:number}> {
    const token=this.token();if(!token)throw Error('service_unauthorized');
    if(this.controller.signal.aborted)throw Error('extension_host_unloaded');
    const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,5000);
    this.controller.signal.addEventListener('abort',cancel,{once:true});
    try {
      const response=await fetch(this.config.endpoint.replace(/\/$/,'')+path,{method:'HEAD',headers:{Authorization:`Bearer ${token}`},signal:controller.signal,redirect:'error'});
      if(!response.ok)throw Error('service_http_'+response.status);
      const length=response.headers.get('content-length'),size=length===null?undefined:Number(length);
      return {mimeType:(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),
        ...(size!==undefined&&Number.isSafeInteger(size)&&size>0?{size}:{})};
    } finally {clearTimeout(timer);this.controller.signal.removeEventListener('abort',cancel);}
  }
  async bytes(path:string,method='GET',body?:unknown,limit=12*1024*1024):Promise<{bytes:Buffer;mimeType:string}> {
    if(this.controller.signal.aborted)throw Error('extension_host_unloaded');
    const token=this.token();if(!token)throw Error('独立沟通服务尚未配置 API Token；请先启动服务并配置连接');
    const controller=new AbortController(),cancel=()=>controller.abort();this.controller.signal.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,40000);
    try {
      const response=await fetch(this.config.endpoint.replace(/\/$/,'')+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,redirect:'error'});
      const reader=response.body?.getReader();if(!reader)throw Error('service_empty_response');let bytes=0;const chunks:Uint8Array[]=[];
      try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>limit)throw Error('service_response_too_large');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
      const result=Buffer.concat(chunks);
      if(!response.ok){let error='service_http_'+response.status;try{const data=JSON.parse(result.toString('utf8'));error=data.error||data.message||error;}catch{}throw Error(response.status>=500?'service_unavailable: '+error:error);}
      return {bytes:result,mimeType:(response.headers.get('content-type')||'application/octet-stream').split(';')[0]};
    }catch(error){if(error instanceof TypeError)throw Error('独立沟通服务不可达，请检查服务进程和连接地址');throw error;}
    finally{clearTimeout(timer);this.controller.signal.removeEventListener('abort',cancel);}
  }
  async request<T=any>(path:string,method='GET',body?:unknown):Promise<T> {
    const result=await this.bytes(path,method,body);
    if(!result.mimeType.includes('application/json'))throw Error('service_unexpected_response');
    return JSON.parse(result.bytes.toString('utf8')) as T;
  }
  async archive<T>(path:string,method='GET',body?:unknown):Promise<T> {
    const result=await this.request<{code:number;message:string;data:T}>('/v2/archive/'+path,method,body);
    if(result.code!==0)throw Error(result.message||'archive_api_incompatible');
    return result.data;
  }
  async check(){const result=await this.request('/health');if(result.product!=='project-communications-service'||result.apiVersion!==1)throw Error('communications_service_api_incompatible');return result;}
  async register(name:string){await this.check();return this.request(`/v1/projects/${encodeURIComponent(this.config.projectId)}`,'PUT',{name});}
  async action(request:unknown){return (await this.request(`/v1/projects/${encodeURIComponent(this.config.projectId)}/actions`,'POST',request)).result;}
  async delivery(id:string,action:'claim'|'finish',receipt?:unknown){return (await this.request(`/v1/projects/${encodeURIComponent(this.config.projectId)}/deliveries/${encodeURIComponent(id)}/${action}`,'POST',receipt||{})).result;}
  close(){this.controller.abort();}
}
