import {NATIVE_SYNTAX_LIMITS as limits,scanNativeLine,type SyntaxSpan,type NativeLanguage} from './native-syntax.ts';
export class NativeSyntaxCache{
 private entries=new Map<string,{code:string;spans:SyntaxSpan[]|null}>();private chars=0;private spans=0;
 key(language:NativeLanguage,code:string){return `${limits.version}:${language}:${code}`;}
 get(language:NativeLanguage,code:string){return this.entries.get(this.key(language,code));}
 put(language:NativeLanguage,code:string,spans:SyntaxSpan[]|null){
  if(code.length>limits.lineChars)return;
  const key=this.key(language,code),old=this.entries.get(key);if(old){this.chars-=old.code.length;this.spans-=old.spans?.length||0;this.entries.delete(key);}
  this.entries.set(key,{code,spans});this.chars+=code.length;this.spans+=spans?.length||0;
  while(this.entries.size>limits.cacheLines||this.chars>limits.cacheChars||this.spans>limits.cacheSpans){const key=this.entries.keys().next().value!;const entry=this.entries.get(key)!;this.chars-=entry.code.length;this.spans-=entry.spans?.length||0;this.entries.delete(key);}
 }
 stats(){return {lines:this.entries.size,chars:this.chars,spans:this.spans};}
}
export const nativeSyntaxCache=new NativeSyntaxCache();
type Options={publish():void;onError(error:unknown):void;cache?:NativeSyntaxCache;now?:()=>number;schedule?:(fn:()=>void)=>unknown;cancel?:(handle:unknown)=>void;scan?:typeof scanNativeLine};
/** One cancellable queue per reading view, not a timer or loader per rendered line. */
export function createNativeSyntaxEngine(options:Options){
 const cache=options.cache||nativeSyntaxCache,now=options.now||(()=>typeof performance==='undefined'?Date.now():performance.now());
 const schedule=options.schedule||((fn)=>setTimeout(fn,0)),cancel=options.cancel||((handle)=>clearTimeout(handle as ReturnType<typeof setTimeout>));
 let generation=0,handle:unknown=null,failed=false,queue:string[]=[],language:NativeLanguage='go';
 const counters={batches:0,scanned:0,hits:0,yielded:0,maxBatchMs:0};
 const count=(name:'batches'|'scanned'|'hits'|'yielded')=>{counters[name]=Math.min(1e9,counters[name]+1);};
 function stop(){generation++;if(handle!==null)cancel(handle);handle=null;queue=[];}
 function run(epoch:number){
  if(failed||epoch!==generation)return;handle=null;const started=now();let chars=0,changed=false;
  try{
   while(queue.length&&chars+queue[0].length<=limits.batchChars&&now()-started<limits.batchMs){
    const code=queue.shift()!;chars+=code.length;
    if(cache.get(language,code)){count('hits');changed=true;continue;}
    let yielded=false;
    const spans=(options.scan||scanNativeLine)(code,language,()=>{yielded=now()-started>=limits.batchMs;return yielded;});
    if(epoch!==generation)return;
    cache.put(language,code,spans);count('scanned');if(yielded)count('yielded');changed=true;
   }
   // If this turn could not start even one line, keep text plain instead of scheduling a busy loop.
   if(chars===0&&queue.length){queue=[];count('yielded');changed=true;}
   count('batches');counters.maxBatchMs=Math.max(counters.maxBatchMs,now()-started);
   if(changed)options.publish();
   if(queue.length&&epoch===generation)handle=schedule(()=>run(epoch));
  }catch(error){failed=true;stop();options.onError(error);}
 }
 return {
  update(next:NativeLanguage,codes:readonly string[]){
   stop();if(failed)return;language=next;
   // Rendering and hashing huge/minified lines is avoided before constructing a key.
   queue=[...new Set(codes.slice(0,limits.cacheLines).filter(code=>code.length>0&&code.length<=limits.lineChars))].slice(0,limits.cacheLines);
   const epoch=generation;if(queue.length)handle=schedule(()=>run(epoch));
  },stop,stats:()=>({...counters,...cache.stats(),pending:queue.length,failed}),
  read(code:string){return code.length<=limits.lineChars?cache.get(language,code)?.spans:undefined;},
 };
}
