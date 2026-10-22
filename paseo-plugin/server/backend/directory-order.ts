import { opendir } from 'node:fs/promises';
import { hash } from './storage.ts';
import type { ObservationCache } from './cache.ts';
export type DirectoryName = { name:string; directory:boolean };
const compare=(a:DirectoryName,b:DirectoryName)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)||(a.name<b.name?-1:a.name>b.name?1:0);
const internal=(name:string)=>name.toLowerCase().startsWith('.workbench-transfer-');
/** Keep the smallest K successors without retaining a large directory in memory. */
function candidate(heap:DirectoryName[],item:DirectoryName,limit:number){
  if(heap.length<limit){heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(compare(heap[p],heap[i])>=0)break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}}
  else if(compare(item,heap[0])<0){heap[0]=item;let i=0;for(;;){let child=i*2+1;if(child>=heap.length)break;if(child+1<heap.length&&compare(heap[child+1],heap[child])>0)child++;if(compare(heap[i],heap[child])>=0)break;[heap[i],heap[child]]=[heap[child],heap[i]];i=child;}}
}
/** Names only, within the shared derived-cache budget. No per-entry stat during indexing. */
export class DirectoryOrder {
  private pending=new Map<string,{full:string;version:string;workspaceId:string;epoch:number;generation:number}>();
  private running?:Promise<void>;
  private closed=false;
  private cache:ObservationCache;
  constructor(cache:ObservationCache){this.cache=cache;}
  key(instance:string,path:string){return `file-order:${hash(instance)}:${path}`;}
  state(key:string,version:string){return this.cache.transient(key,version) as {mode:'indexed'|'windowed';names?:DirectoryName[]}|undefined;}
  prepare(key:string,full:string,version:string,workspaceId:string){
    if(this.closed||this.state(key,version)||this.pending.has(key))return;
    // Speculation is best effort. Visible reads may use bounded windows immediately.
    if(this.pending.size>=32)return;
    this.pending.set(key,{full,version,workspaceId,epoch:this.cache.workspaceEpoch(workspaceId),generation:this.cache.epoch});
    if(!this.running){const run=(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));while(!this.closed&&this.pending.size){const [key,job]=this.pending.entries().next().value!;try{
      const limit=Math.max(0,Math.min(4*1024*1024,Math.floor(this.cache.config.cacheBytes/8))),names:DirectoryName[]=[];let bytes=256,windowed=false;
      for await(const item of await opendir(job.full)){if(this.closed)break;if(internal(item.name))continue;bytes+=Buffer.byteLength(item.name)*2+80;if(bytes>limit){windowed=true;break;}names.push({name:item.name,directory:item.isDirectory()});}
      if(!this.closed&&this.pending.get(key)===job&&job.generation===this.cache.epoch&&job.epoch===this.cache.workspaceEpoch(job.workspaceId)){
        if(!windowed)names.sort(compare);
        this.cache.publishTransient(key,job.version,{mode:windowed?'windowed':'indexed',...(windowed?{}:{names})},{workspaceId:job.workspaceId},windowed?256:bytes);
      }
    }catch{/* Keep the first page; retry on a later visible read. */}finally{if(this.pending.get(key)===job)this.pending.delete(key);}}})().finally(()=>{if(this.running===run)this.running=undefined;});this.running=run;}
  }
  async page(key:string,version:string,full:string,limit:number,after?:DirectoryName){
    const index=this.state(key,version);
    if(index?.names){let lo=0,hi=index.names.length;if(after)while(lo<hi){const mid=(lo+hi)>>1;if(compare(index.names[mid],after)<=0)lo=mid+1;else hi=mid;}return index.names.slice(lo,lo+limit+1);}
    const heap:DirectoryName[]=[];
    for await(const item of await opendir(full)){if(this.closed)break;if(internal(item.name))continue;const name={name:item.name,directory:item.isDirectory()};if(!after||compare(name,after)>0)candidate(heap,name,limit+1);}
    return heap.sort(compare);
  }
  retire(workspaceId:string){for(const [key,job]of this.pending)if(job.workspaceId===workspaceId)this.pending.delete(key);}
  async close(){this.closed=true;this.pending.clear();await this.running;}
}
