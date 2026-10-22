import type { DocumentPage,DocumentSyntax } from '../shared/document.ts';
import type { SyntaxLine } from '../shared/code-syntax.ts';
const newFileId=()=>`document-${Date.now()}-${Math.random().toString(36).slice(2)}`;
type Call=(request:Record<string,unknown>)=>Promise<any>;
type Scope={workspaceId:string;instance:string;path:string};
type WindowAnchor={offset:number;line:number;continuation:boolean};
export type ReaderState={page?:DocumentPage;revision:number;text:string;startLine:number;windowOffset:number;windows:WindowAnchor[];windowIndex:number;continuation?:boolean;tokens:Record<string,SyntaxLine>;markdown?:DocumentSyntax['markdown'];syntaxState?:string;reason?:string;loading:boolean;error?:string;changed?:boolean;scroll:number;mode?:'source'|'preview'};
const cache=new Map<string,ReaderState>();let cacheBytes=0,cacheEpoch=0;
const cost=(state:ReaderState)=>JSON.stringify({...state,loading:false}).length*2;
const changedError=(error:unknown)=>['file_source_changed','workspace_instance_changed','workspace_not_found','workspace_state_invalid','ENOENT'].includes((error as any)?.code);
export function clearDocumentCache(scope:string,workspaceId?:string){cacheEpoch++;for(const [key,state]of cache)if(key.startsWith(scope+'\0')&&(!workspaceId||JSON.parse(key.slice(scope.length+1))[1]===workspaceId)){cacheBytes-=cost(state);cache.delete(key);}}
export function evictDocumentCache(key:string){cacheEpoch++;const value=cache.get(key);if(value){cacheBytes-=cost(value);cache.delete(key);}}
/** View-owned async generation; no response can write after close or a later reload. */
export function createDocumentReader(key:string,scope:Scope,call:Call){
  const cacheGeneration=cacheEpoch,listeners=new Set<()=>void>(),requestIds=new Set<string>();
  let generation=0,closed=false,reading=false,retriedSyntaxVersion:string|undefined;
  const reader={state:(cache.get(key)||{revision:0,text:'',startLine:1,windowOffset:0,windows:[{offset:0,line:1,continuation:false}],windowIndex:0,tokens:{},loading:false,scroll:0}) as ReaderState,subscribe,snapshot,setView,load,more,previous,highlight,validate,close};
  function subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
  function snapshot(){return reader.state;}
  function update(patch:Partial<ReaderState>){if(closed)return;reader.state={...reader.state,...patch};listeners.forEach(f=>f());}
  function cancelSyntax(){pendingViewport=undefined;syntaxFlight=undefined;for(const requestId of requestIds)void call({action:'document-cancel',...scope,requestId}).catch(()=>{});requestIds.clear();}
  function setView(patch:Pick<Partial<ReaderState>,'scroll'|'mode'>){if(patch.mode!==undefined)update(patch);else reader.state={...reader.state,...patch};}
  async function load(reset=false){
    if(closed)return;const epoch=++generation;cancelSyntax();if(reset)retriedSyntaxVersion=undefined;
    // A host can construct the replacement view before running the old view's
    // cleanup (for example while switching theme). Pick up that snapshot here.
    if(!reset&&!reader.state.page&&cache.has(key))update(cache.get(key)!);
    update({loading:true,error:undefined});
    try{if(reader.state.page&&!reset){await call({action:'document-stat',...scope,version:reader.state.page.version});if(!closed&&epoch===generation)update({loading:false,changed:false});return;}
      const page:DocumentPage=await call({action:'document',...scope});if(closed||epoch!==generation)return;
      if(reader.state.page?.version===page.version&&!reset){update({loading:false,changed:false});return;}
      if(reader.state.page&&!reset){update({loading:false,changed:true});return;}
      update({page,revision:reader.state.revision+1,text:page.text,startLine:1,windowOffset:0,windows:[{offset:0,line:1,continuation:false}],windowIndex:0,continuation:false,tokens:{},markdown:undefined,syntaxState:undefined,reason:undefined,loading:false,changed:false,scroll:0});
    }catch(error){if(epoch===generation)update({loading:false,error:String((error as Error).message),changed:(error as any).code==='file_source_changed'||(error as any).code==='workspace_instance_changed'});}
  }
  async function more(){
    const before=reader.state,page=before.page;if(closed||reading||!page||page.eof)return;reading=true;const epoch=generation;update({loading:true,error:undefined});
    try{const next:DocumentPage=await call({action:'document',...scope,offset:page.nextOffset,version:page.version});if(closed||epoch!==generation)return;
      const replace=before.text.length*2>2*1024*1024||before.text.split(/\r\n|\r|\n/).length>12000;
      const anchor:WindowAnchor={offset:page.nextOffset,line:before.startLine+before.text.split(/\r\n|\r|\n/).length-1,continuation:!/[\r\n]$/.test(before.text)};
      const windows=replace?[...before.windows.slice(0,before.windowIndex+1),anchor].slice(-128):before.windows;
      // Do not retain a whole unfinished line: one line can itself be gigabytes.
      update({page:next,text:replace?next.text:before.text+next.text,startLine:replace?anchor.line:before.startLine,windowOffset:replace?anchor.offset:before.windowOffset,tokens:replace?{}:before.tokens,loading:false,...(replace?{windows,windowIndex:windows.length-1,continuation:anchor.continuation,scroll:0}:{} )});
    }catch(error){if(epoch===generation)update({loading:false,error:String((error as Error).message),changed:(error as any).code==='file_source_changed'});}finally{reading=false;}
  }
  async function previous(){
    const before=reader.state,anchor=before.windows[before.windowIndex-1];if(closed||reading||!before.page||!anchor)return;
    reading=true;const epoch=++generation;update({loading:true,error:undefined});
    try{const page:DocumentPage=await call({action:'document',...scope,offset:anchor.offset,version:before.page.version});if(closed||epoch!==generation)return;
      update({page,text:page.text,startLine:anchor.line,windowOffset:anchor.offset,windowIndex:before.windowIndex-1,continuation:anchor.continuation,tokens:{},loading:false,scroll:0});
    }catch(error){if(epoch===generation)update({loading:false,error:String((error as Error).message),changed:changedError(error)});}finally{reading=false;}
  }
  let syntaxFlight:Promise<void>|undefined, pendingViewport:{lineStart:number;markdown:boolean}|undefined;
  function highlight(lineStart:number,markdown=false):Promise<void>{
    pendingViewport={lineStart,markdown};
    if(syntaxFlight)return syntaxFlight;
    const epoch=generation;
    const flight=(async()=>{while(pendingViewport&&!closed&&epoch===generation){const next=pendingViewport;pendingViewport=undefined;await highlightNow(next.lineStart,next.markdown);}})().finally(()=>{if(syntaxFlight===flight){syntaxFlight=undefined;if(pendingViewport&&!closed)void highlight(pendingViewport.lineStart,pendingViewport.markdown);}});
    syntaxFlight=flight;return flight;
  }
  async function highlightNow(lineStart:number,markdown=false):Promise<void>{
    const page=reader.state.page;if(!page||page.binary||closed||reader.state.changed)return;
    if(markdown&&reader.state.markdown||['large_file','syntax_budget','unknown_language'].includes(reader.state.reason||''))return;
    const end=Math.min(lineStart+199,reader.state.startLine+reader.state.text.split(/\r\n|\r|\n/).length-1);
    if(!markdown&&end>=lineStart&&Array.from({length:end-lineStart+1},(_,index)=>lineStart+index).every(number=>reader.state.tokens[String(number)]))return;
    const epoch=generation,requestId=newFileId();requestIds.add(requestId);
    try{const result:DocumentSyntax=await call({action:'document-syntax',...scope,version:page.version,lineStart,count:200,markdown,requestId});
      if(closed||epoch!==generation||reader.state.page?.version!==result.version)return;
      if(markdown&&['timeout','busy','parser_error'].includes(result.reason||'')&&retriedSyntaxVersion!==result.version){retriedSyntaxVersion=result.version;await new Promise(resolve=>setTimeout(resolve,250));if(!closed&&epoch===generation)return highlightNow(lineStart,true);return;}
      update({tokens:{...Object.fromEntries(Object.entries(reader.state.tokens).slice(-200)),...result.lines},...(result.markdown?{markdown:result.markdown}:{}),...(markdown&&result.state==='plain'&&!result.markdown?{mode:'source' as const}:{}),syntaxState:result.state,reason:!markdown&&reader.state.reason==='markdown_preview_limit'?reader.state.reason:result.reason});
    }catch(error){void call({action:'document-cancel',...scope,requestId}).catch(()=>{});if(epoch===generation&&!closed)update({syntaxState:'plain',error:String((error as Error).message),changed:(error as any).code==='file_source_changed'});}
    finally{requestIds.delete(requestId);}
  }
  async function validate(){if(closed||reader.state.loading||reader.state.changed)return;if(!reader.state.page)return load();const epoch=generation;try{await call({action:'document-stat',...scope,version:reader.state.page.version});if(epoch===generation)update({error:undefined});}catch(error){if(epoch===generation)update({error:String((error as Error).message),changed:changedError(error)});}}
  function close(){
    if(closed)return;closed=true;generation++;
    cancelSyntax();
    if(reader.state.page&&cacheGeneration===cacheEpoch){const previous=cache.get(key);if(previous){cacheBytes-=cost(previous);cache.delete(key);}const bytes=cost(reader.state);
      while(cache.size>=8||cacheBytes+bytes>8*1024*1024){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=cost(cache.get(first)!);cache.delete(first);}if(bytes<=8*1024*1024){cache.set(key,{...reader.state,loading:false});cacheBytes+=bytes;}}
    listeners.clear();
  }
  return reader;
}
export type DocumentReader=ReturnType<typeof createDocumentReader>;
