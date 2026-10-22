import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { SYNTAX_SOURCE_BYTES, syntaxLanguages, type SyntaxDocument } from '../../shared/code-syntax.ts';
import type { MarkdownNode } from '../../shared/document.ts';
type Result=SyntaxDocument&{markdown?:MarkdownNode[]};
type Consumer={resolve:(value:Result)=>void;signal?:AbortSignal;abort:()=>void};
type Job={id:number;key:string;text:string;language:string;renderMarkdown:boolean;consumers:Set<Consumer>;owner:string;epoch:object};
/** One lazy, bounded parser per backend; a stuck grammar cannot block RPC/Git. */
export class SyntaxService {
  private worker?:Worker;private queue:Job[]=[];private active?:Job;private sequence=0;private closed=false;
  private timeout?:ReturnType<typeof setTimeout>;private idle?:ReturnType<typeof setTimeout>;
  private flights=new Map<string,Job>();
  private cache=new Map<string,{value:Result;bytes:number;owner:string}>();private bytes=0;private epochs=new Map<string,object>();
  private plain(job:Pick<Job,'language'>,reason:string):Result{return {language:job.language,state:'plain',reason,lines:[]};}
  /** Only callers that already checked an immutable blob/file version may use this. */
  lookup(owner:string,identity:string,language:string,renderMarkdown=false):Result|undefined{
    const prefix=JSON.stringify([owner,identity,language,renderMarkdown])+'\0';
    for(const [key,cached]of this.cache)if(key.startsWith(prefix)){this.cache.delete(key);this.cache.set(key,cached);return cached.value;}
  }
  async parse(owner:string,identity:string,text:string,language:string,renderMarkdown=false,signal?:AbortSignal):Promise<Result>{
    if(this.closed||signal?.aborted)return this.plain({language},'cancelled');
    if(Buffer.byteLength(text)>SYNTAX_SOURCE_BYTES)return this.plain({language},'large_file');
    if(!syntaxLanguages.includes(language))return this.plain({language},'unknown_language');
    const key=JSON.stringify([owner,identity,language,renderMarkdown])+'\0'+createHash('sha256').update(text).digest('hex'),cached=this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached.value;}
    let job=this.flights.get(key);
    if(!job){
      if(this.queue.length>=24)return this.plain({language},'busy');
      const epoch=this.epochs.get(owner)||{};this.epochs.set(owner,epoch);
      job={id:++this.sequence,key,text,language,renderMarkdown,consumers:new Set(),owner,epoch};
      this.flights.set(key,job);this.queue.push(job);
    }
    const shared=job;
    const result=new Promise<Result>(resolve=>{
      const consumer:Consumer={resolve,signal,abort:()=>{
        shared.consumers.delete(consumer);resolve(this.plain(shared,'cancelled'));
        // A consumer owns its subscription, never another reader's parser.
        if(!shared.consumers.size){
          if(this.active===shared)this.reset('cancelled');
          else{this.queue=this.queue.filter(j=>j!==shared);this.settle(shared,this.plain(shared,'cancelled'));}
        }
      }};
      shared.consumers.add(consumer);signal?.addEventListener('abort',consumer.abort,{once:true});
    });
    this.dispatch();return result;
  }
  private settle(job:Job,value:Result){
    this.flights.delete(job.key);
    if(job.epoch!==this.epochs.get(job.owner)||this.closed)value=this.plain(job,'cancelled');
    if(value.state==='ready'||value.reason==='markdown_preview_limit'){
      const bytes=Buffer.byteLength(JSON.stringify(value));
      if(bytes<=4*1024*1024){while(this.bytes+bytes>8*1024*1024||this.cache.size>=32){const first=this.cache.keys().next().value;if(first===undefined)break;this.bytes-=this.cache.get(first)!.bytes;this.cache.delete(first);}this.cache.set(job.key,{value,bytes,owner:job.owner});this.bytes+=bytes;}
    }
    for(const c of job.consumers){c.signal?.removeEventListener('abort',c.abort);c.resolve(value);}job.consumers.clear();
  }

  private dispatch(){
    if(this.closed||this.active||!this.queue.length)return;
    clearTimeout(this.idle);const job=this.active=this.queue.shift()!;
    try{
      if(!this.worker){
        const worker=this.worker=new Worker(new URL('./syntax-worker.ts',import.meta.url),{execArgv:['--experimental-strip-types','--disable-warning=ExperimentalWarning'],resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4}});
        worker.on('message',message=>{if(this.worker!==worker||this.active?.id!==message.id)return;const active=this.active!;this.finish(message.error?this.plain(active,message.reason==='syntax_budget'?'syntax_budget':'parser_error'):{...message.result,...(message.markdown?{markdown:message.markdown}:{})});});
        worker.on('error',error=>{if(this.worker===worker)this.reset((error as NodeJS.ErrnoException).code==='ERR_WORKER_OUT_OF_MEMORY'?'syntax_budget':'parser_error');});
        worker.on('exit',()=>{if(this.worker===worker)this.reset('parser_error');});
      }
      this.timeout=setTimeout(()=>this.reset('timeout'),3000);this.timeout.unref();
      this.worker.postMessage({id:job.id,text:job.text,language:job.language,renderMarkdown:job.renderMarkdown});
    }catch{this.reset('parser_error');}
  }
  private finish(value:Result){const job=this.active;clearTimeout(this.timeout);this.active=undefined;if(job)this.settle(job,value);this.dispatch();if(!this.active&&!this.queue.length){this.idle=setTimeout(()=>this.stopWorker(),30000);this.idle.unref();}}
  private stopWorker(){const worker=this.worker;this.worker=undefined;if(worker)void worker.terminate();}
  private reset(reason:string){this.stopWorker();if(this.active)this.finish(this.plain(this.active,reason));}
  retire(owner:string){this.epochs.delete(owner);for(const [key,entry]of this.cache)if(entry.owner===owner){this.bytes-=entry.bytes;this.cache.delete(key);}const queued=this.queue.filter(j=>j.owner===owner);this.queue=this.queue.filter(j=>j.owner!==owner);for(const job of queued)this.settle(job,this.plain(job,'cancelled'));if(this.active?.owner===owner)this.reset('cancelled');}
  async close(){this.closed=true;clearTimeout(this.idle);clearTimeout(this.timeout);for(const job of [...this.queue,...(this.active?[this.active]:[])])this.settle(job,this.plain(job,'cancelled'));this.queue=[];this.active=undefined;const worker=this.worker;this.worker=undefined;await worker?.terminate();this.cache.clear();this.bytes=0;this.epochs.clear();}
}
