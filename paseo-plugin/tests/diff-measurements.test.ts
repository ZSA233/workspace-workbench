import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
function harness(){
 const slots:any[]=[];let cursor=0,id=0,updates=0;const effects:Array<()=>void>=[],jobs=new Map<number,()=>void>();
 const memo=(fn:any,deps:any[],execute:boolean)=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n]))slots[i]={deps,value:execute?fn():fn};return slots[i].value;};
 const react={useRef:(v:any)=>{const i=cursor++;return slots[i]??(slots[i]={current:v});},useState:(v:any)=>{const i=cursor++;if(!(i in slots))slots[i]=v;return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next;updates++;}];},useCallback:(f:any,d:any[])=>memo(f,d,false),useEffect:(f:()=>any,deps:any[])=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n]))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:f()};});}};
 const exports:any={},source=readFileSync(new URL('../client/use-diff-measurements.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>react,requestAnimationFrame:(f:()=>void)=>{jobs.set(++id,f);return id;},cancelAnimationFrame:(i:number)=>jobs.delete(i)});
 return {render(generation:object,paused=false){cursor=0;const value=exports.useDiffMeasurements(generation,paused);while(effects.length)effects.shift()!();return value as {values:Record<string,number>;measure(key:string,height:number):void};},flush(){const pending=[...jobs.values()];jobs.clear();pending.forEach(f=>f());},stats:()=>({updates,pending:jobs.size}),unmount(){for(const item of slots)item?.cleanup?.();}};
}
test('measurement events publish once per frame and unchanged heights cause no update',()=>{
 const h=harness(),g={},m=h.render(g);m.measure('a',22);m.measure('b',44);m.measure('a',33);assert.deepEqual(h.stats(),{updates:0,pending:1});h.flush();assert.equal(h.stats().updates,1);const next=h.render(g);assert.equal(next.values.a,33);assert.equal(next.values.b,44);next.measure('a',33);assert.equal(h.stats().pending,0);h.unmount();
});
test('drag defers heights until release; generations and unmount reject stale callbacks',()=>{
 const h=harness(),first={},second={},old=h.render(first,true);old.measure('row',44);assert.equal(h.stats().pending,0);h.render(first,false);assert.equal(h.render(first).values.row,44);
 const next=h.render(second);old.measure('old',88);assert.equal(h.stats().pending,0);next.measure('new',66);h.unmount();h.flush();next.measure('late',77);assert.equal(h.stats().pending,0);assert.equal(h.stats().updates,1);
});
