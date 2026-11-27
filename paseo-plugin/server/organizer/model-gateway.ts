import {AsyncLocalStorage} from 'node:async_hooks';
import {organizerHash} from './storage.ts';
import {OrganizerModelQueue} from './model-queue.ts';
import {ModelMetrics,type ModelScope} from './model-metrics.ts';
import type {ModelProfile,OrganizerRun} from '../../shared/organizer.ts';

export type ModelContext=ModelScope&{gateway?:ModelGateway;assertCurrent?:()=>void;beforeStart?:()=>Promise<void>;inputVersion?:string;jobId?:string;testId?:string;label?:string;purpose?:string;force?:boolean};
const contexts=new AsyncLocalStorage<ModelContext>();
export const modelContext=()=>contexts.getStore();
export const withModelContext=<T>(context:ModelContext,work:()=>Promise<T>)=>contexts.run(context,work);
type Flight={abort:AbortController;promise:Promise<unknown>;users:number;priority:number;subscribers:Set<ModelContext>;queuedAt:string;startedAt?:string;model:string};
export class ModelGateway {
 readonly metrics:ModelMetrics;readonly queue:OrganizerModelQueue;private flights=new Map<string,Flight>();
 private probes=new Map<string,{at:number;promise:Promise<unknown>}>();
 constructor(root:string,limit:()=>number){this.metrics=new ModelMetrics(root);this.metrics.recover();this.queue=new OrganizerModelQueue(limit);}
 status(){return{...this.queue.status(),tasks:[...this.flights.values()].flatMap(f=>[...f.subscribers].map(c=>({project:c.project,targetId:c.targetId,jobId:c.jobId,testId:c.testId,label:c.label||'整理资料',purpose:c.purpose,model:f.model,state:f.startedAt?'running':'queued',queuedAt:f.queuedAt}))).slice(0,32)};}
 async probe<T>(key:string,work:()=>Promise<T>,force=false):Promise<T>{const old=this.probes.get(key);if(!force&&old&&Date.now()-old.at<30_000)return old.promise as Promise<T>;this.metrics.probe();const promise=work();this.probes.set(key,{at:Date.now(),promise});if(this.probes.size>40)this.probes.delete(this.probes.keys().next().value!);try{return await promise;}catch(e){this.probes.delete(key);throw e;}}
 async run<T>(profile:ModelProfile,secret:string,input:{prompt:string;input:string;references?:Record<string,string>;kind:string;owner:string},signal:AbortSignal,work:(signal:AbortSignal,audit:(run:OrganizerRun)=>void,queueMs:number)=>Promise<T>):Promise<T>{
  const context=modelContext()||{trigger:'legacy' as const},manual=['preview','retry','history','test'].includes(context.trigger),priority=manual?0:context.trigger==='enable'?1:2;
  const connection=organizerHash([profile.baseUrl,profile.model,secret]),key=organizerHash([connection,profile.contextTokens,profile.outputTokens,input.kind,input.owner,input.prompt,input.input,input.references]),retryKey=context.inputVersion?organizerHash([connection,input.kind,input.owner,input.prompt,context.inputVersion]):key;
  if(signal.aborted)throw Error('organizer_cancelled');context.assertCurrent?.();
  let flight=this.flights.get(key);
  if(!flight){this.metrics.gate(retryKey,connection,manual);const abort=new AbortController(),queued=Date.now();flight={abort,users:0,priority,promise:Promise.resolve(),subscribers:new Set(),queuedAt:new Date(queued).toISOString(),model:profile.model};
   flight.promise=this.queue.run(async()=>{flight!.startedAt=new Date().toISOString();let current:ModelContext|undefined;for(const candidate of flight!.subscribers)try{candidate.assertCurrent?.();current=candidate;break;}catch{/* Another subscriber may still own this exact input. */}if(!current)throw Error('organizer_cancelled');await current.beforeStart?.();const queueMs=Date.now()-queued,scope={project:current.project,targetId:current.targetId,workspaceKeys:current.workspaceKeys?.slice(0,32),workspaceCount:current.workspaceKeys?.length,scopeHash:organizerHash(current.workspaceKeys||[]),trigger:current.trigger};try{const result=await withModelContext(current,()=>work(abort.signal,run=>this.metrics.record(run,key,scope,queueMs,retryKey,connection),queueMs));this.metrics.success(retryKey,connection);return result;}catch(e){this.metrics.failure(retryKey,connection,e);const retry=this.metrics.retry(retryKey,connection);if(!manual&&retry){if(retry.paused)throw Object.assign(Error('organizer_model_retry_paused'),{cause:e});if(e instanceof Error)Object.assign(e,{retryAt:retry.at});}throw e;}},{signal:abort.signal,priority,label:context.targetId||input.owner}).finally(()=>{if(this.flights.get(key)===flight)this.flights.delete(key);});this.flights.set(key,flight);
  }else{this.metrics.reuse();if(priority<flight.priority){flight.priority=priority;this.queue.promote(flight.abort.signal,priority);}}
  const own=flight;own.users++;own.subscribers.add(context);let listener=()=>{};
  try{return structuredClone(await Promise.race([own.promise,new Promise<never>((_resolve,reject)=>{listener=()=>reject(Error('organizer_cancelled'));signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();})])) as T;}
  finally{signal.removeEventListener('abort',listener);own.subscribers.delete(context);if(--own.users===0)own.abort.abort();}
 }
 async close(){for(const f of this.flights.values())f.abort.abort();await this.queue.idle();}
}
