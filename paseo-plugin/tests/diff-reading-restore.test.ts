import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as model from '../client/model.ts';
import * as layout from '../client/diff-layout.ts';
import * as scroll from '../client/diff-scroll-model.ts';
import * as signal from '../client/diff-scroll-store.ts';
test('a cached tab restores its offset before anchoring the first arriving content',()=>{
 const slots:any[]=[];let cursor=0;const effects:Array<()=>void>=[],EMPTY={},calls:number[]=[];
 const memo=(fn:any,deps:any[],execute:boolean)=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n]))slots[i]={deps,value:execute?fn():fn};return slots[i].value;};
 const effect=(fn:()=>any,deps:any[])=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n]))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});};
 const react={useRef:(v:any)=>{const i=cursor++;return slots[i]??(slots[i]={current:v});},useState:(v:any)=>{const i=cursor++;if(!(i in slots))slots[i]=v;return [slots[i],(next:any)=>slots[i]=typeof next==='function'?next(slots[i]):next];},useCallback:(f:any,d:any[])=>memo(f,d,false),useMemo:(f:any,d:any[])=>memo(f,d,true),useEffect:effect,useLayoutEffect:effect};
 const exports:any={},source=readFileSync(new URL('../client/use-diff-reading.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(name:string)=>{
  if(name==='react')return react;if(name==='react-native')return {Platform:{OS:'web'}};if(name==='./model')return model;if(name==='./diff-layout')return layout;if(name==='./diff-scroll-model')return scroll;if(name==='./diff-scroll-store')return signal;if(name==='./use-diff-code-copy')return {useDiffCodeCopy(){}};if(name==='./use-native-syntax')return {useNativeSyntax:()=>()=>undefined};if(name==='./use-diff-measurements')return {useDiffMeasurements:()=>({values:EMPTY,measure(){}})};throw Error(name);
 }});
 const position={offset:2000,hunk:0},diff={patch:'@@ -0,0 +1,300 @@\n'+Array.from({length:300},(_,i)=>`+line ${i}`).join('\n')};
 const render=(value:any,fontSize=14)=>{cursor=0;const reading=exports.useDiffReading({diff:value,mode:'unified',fontSize,wrap:false,position,foreground:true,path:'sample.ts'});reading.listRef.current={scrollToOffset:({offset}:{offset:number})=>calls.push(offset)};while(effects.length)effects.shift()!();return reading;};
 render(null);const ready=render(diff);assert.equal(position.offset,2000,'first data cannot replace the saved offset with row zero');ready.onListLayout({nativeEvent:{layout:{height:700}}});ready.setContentHeight(ready.rowMetrics.contentHeight);const restored=render(diff);assert.equal(calls.at(-1),2000);assert.equal(restored.restoredPosition.current,true);
 const originalRow=scroll.rowAtOffset(restored.rowMetrics,2000),larger=render(diff,18);assert.equal(scroll.rowAtOffset(larger.rowMetrics,calls.at(-1)!),originalRow,'subsequent font changes still keep the visible row');
 for(const slot of slots)slot?.cleanup?.();
});
