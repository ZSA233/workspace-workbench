import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as lexical from '../client/native-syntax.ts';
import {createNativeSyntaxEngine,createNativeSyntaxCache} from '../client/native-syntax-engine.ts';
import type {DiffDisplayRow} from '../client/model.ts';
function harness(failLoad=false){
 const slots:any[]=[];let cursor=0,loads=0,scans=0,updates=0,id=0;const effects:Array<()=>void>=[],jobs=new Map<number,()=>void>(),diagnostics:unknown[]=[];
 const cache=createNativeSyntaxCache();
 const react={useRef:(value:unknown)=>{const at=cursor++;return slots[at]??(slots[at]={current:value});},useState:(value:unknown)=>{const at=cursor++;if(!(at in slots))slots[at]=value;return [slots[at],(next:any)=>{slots[at]=typeof next==='function'?next(slots[at]):next;updates++;}];},
  useEffect:(effect:()=>unknown,deps:unknown[])=>{const at=cursor++,previous=slots[at];if(!previous||deps.some((value,i)=>value!==previous.deps[i])){effects.push(()=>{previous?.cleanup?.();slots[at]={deps,cleanup:effect()};});}}
 };
 const source=readFileSync(new URL('../client/use-native-syntax.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:any={};vm.runInNewContext(code,{exports,requestAnimationFrame:(fn:()=>void)=>{jobs.set(++id,fn);return id;},cancelAnimationFrame:(id:number)=>jobs.delete(id),setTimeout:(fn:()=>void)=>{jobs.set(++id,fn);return id;},clearTimeout:(id:number)=>jobs.delete(id),require:(name:string)=>{
  if(name==='react')return react;if(name==='react-native')return {Platform:{OS:'android'}};
  if(name==='./model')return {languageForPath:(path:string)=>path.endsWith('.go')?'go':path.endsWith('.ts')?'typescript':'plain'};
  if(name==='./native-syntax')return lexical;
  if(name==='./native-diagnostics')return {reportNativeDiagnostic:(...args:unknown[])=>diagnostics.push(args)};
  if(name==='./native-syntax-engine'){loads++;if(failLoad)throw Error('injected import failure');return {createNativeSyntaxEngine:(options:any)=>createNativeSyntaxEngine({...options,cache,scan:(...args:Parameters<typeof lexical.scanNativeLine>)=>{scans++;return lexical.scanNativeLine(...args);}})};}
  throw Error('Unknown dependency '+name);
 }});
 return {render(rows:DiffDisplayRow[],foreground=true,visible=[0],path='sample.go'):{(code:string):unknown}{cursor=0;return exports.useNativeSyntax(rows,path,foreground,visible);},async commit(){while(effects.length)effects.shift()!();await Promise.resolve();await Promise.resolve();},drain(){let n=0;while(jobs.size){assert.ok(++n<1000);const [id,fn]=jobs.entries().next().value!;jobs.delete(id);fn();}},unmount(){for(const item of slots)item?.cleanup?.();},stats:()=>({loads,scans,updates,pending:jobs.size,diagnostics:diagnostics.length}),diagnostics};
}
const rows=(size=50):DiffDisplayRow[]=>Array.from({length:size},(_,i)=>({kind:'unified',key:String(i),hunkIndex:0,line:{kind:'context',content:`const value${i} = "文字"`,oldLine:i+1,newLine:i+1}}));
test('controller first returns plain text, then colors only visible rows and nearby context',async()=>{
 const h=harness(),data=rows(),visible=[20,21];const read=h.render(data,true,visible);assert.equal(read(data[0].kind==='unified'?data[0].line.content:''),undefined);assert.equal(h.stats().loads,0);await h.commit();assert.equal(h.stats().scans,0,'effect schedules after paint, not immediate parsing');h.drain();assert.equal(h.stats().scans,22);assert.ok(read('const value20 = "文字"'));assert.equal(read('const value0 = "文字"'),undefined);
 const previous=h.stats().scans;h.render(data,true,visible);await h.commit();h.drain();assert.equal(h.stats().scans,previous,'same viewport/theme rerender does not rescan');h.unmount();
});
test('background pause cancels queued frames; foreground recovery reuses cached tokens',async()=>{
 const h=harness(),data=rows(),visible=[10];h.render(data,true,visible);await h.commit();assert.equal(h.stats().pending,1);h.render(data,false,visible);await h.commit();h.drain();assert.equal(h.stats().scans,0);
 h.render(data,true,visible);await h.commit();h.drain();const before=h.stats().scans;h.render(data,false,visible);await h.commit();h.render(data,true,visible);await h.commit();h.drain();assert.equal(h.stats().scans,before);h.unmount();
});
test('viewport replacement and unmount invalidate pending imports and computation',async()=>{
 const h=harness(),data=rows();h.render(data,true,[1]);await h.commit();h.render(data,true,[40]);await h.commit();h.drain();assert.equal(h.render(data,true,[40])('const value1 = "文字"'),undefined);
 const pending=harness();pending.render(data);await pending.commit();pending.unmount();pending.drain();assert.equal(pending.stats().scans,0);
 const late=harness();late.render(data);const commit=late.commit();late.unmount();await commit;late.drain();assert.equal(late.stats().scans,0);
});
test('module load failure reports once, leaves text available, and does not retry on scrolling',async()=>{
 const h=harness(true),data=rows();const read=h.render(data);await h.commit();await Promise.resolve();h.drain();assert.equal(read('const value0 = "文字"'),undefined);assert.equal(h.stats().diagnostics,1);
 h.render(data,true,[20]);await h.commit();h.drain();assert.equal(h.stats().loads,1);assert.equal(h.stats().pending,0);h.unmount();
});
