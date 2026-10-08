import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as model from '../client/diff-scroll-model.ts';
function harness(native=false){
 const slots:any[]=[];let cursor=0;const effects:Array<()=>void>=[],changes:boolean[]=[],offsets:number[]=[],selected:number[]=[];let interactions=0;
 const effect=(fn:()=>any,deps:any[])=>{const at=cursor++,old=slots[at];if(!old||deps.some((d,i)=>d!==old.deps[i]))effects.push(()=>{old?.cleanup?.();slots[at]={deps,cleanup:fn()};});};
 const react={memo:(fn:any)=>fn,useRef:(value:any)=>{const i=cursor++;return slots[i]??(slots[i]={current:value});},useState:(value:any)=>{const i=cursor++;if(!(i in slots))slots[i]=value;return [slots[i],(v:any)=>slots[i]=typeof v==='function'?v(slots[i]):v];},useEffect:effect,useMemo:(fn:()=>any,deps:any[])=>{const at=cursor++,old=slots[at];if(!old||deps.some((d,i)=>d!==old.deps[i]))slots[at]={deps,value:fn()};return slots[at].value;},useSyncExternalStore:(_:any,read:()=>number)=>read()};
 const source=readFileSync(new URL('../client/components/diff-overview.tsx',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,exports:any={};
 vm.runInNewContext(code,{exports,require:(name:string)=>{if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};if(name==='react-native')return {Platform:{OS:native?'android':'web'},View:'View'};if(name==='../diff-scroll-model')return model;if(name==='../../shared/copy')return {copy:{diffOverview:'Overview'}};if(name==='../theme')return {observerAccent:()=> '#00f'};throw Error(name);}});
 const props={contentHeight:10000,height:1000,markers:[{position:.8,extent:.01,startRow:77,endRow:80,kind:'added',hunkIndex:0,startLine:1,endLine:4}],scroll:{get:()=>2000,subscribe:()=>()=>{}},theme:{colors:{statusSuccess:'#0f0',statusDanger:'#f00',foregroundMuted:'#999',surface2:'#222'}},onSelectRow:(row:number)=>selected.push(row),onOffset:(offset:number)=>offsets.push(offset),onInteractionStart:()=>interactions++,onDragStateChange:(drag:boolean)=>changes.push(drag),active:true,layoutIdentity:{}};
 function render(){cursor=0;const node=exports.OverviewRail(props);while(effects.length)effects.shift()!();return node.props;}
 return {props,render,changes,offsets,selected,interactions:()=>interactions,unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
function pointer(y:number){return {button:0,pointerId:1,clientY:y+10,preventDefault(){},currentTarget:{focus(){},setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){},getBoundingClientRect:()=>({top:10})}};}
test('web rail drag preserves grab offset, suppresses clicks and releases frozen layout',()=>{
 const h=harness(),p=h.render();p.onPointerDown(pointer(240));p.onPointerMove(pointer(400));assert.deepEqual(h.changes,[true]);assert.equal(h.offsets.at(-1),3600);p.onPointerUp(pointer(600));assert.equal(h.offsets.at(-1),5600);assert.deepEqual(h.changes,[true,false]);assert.deepEqual(h.selected,[]);p.onLostPointerCapture();assert.deepEqual(h.changes,[true,false]);h.unmount();
});
test('web enlarged marker hit, blank-track positioning, keyboard and cancellation are distinct',()=>{
 const h=harness(),p=h.render();p.onPointerDown(pointer(798));p.onPointerUp(pointer(798));assert.deepEqual(h.selected,[77]);p.onPointerDown(pointer(500));p.onPointerUp(pointer(500));assert.equal(h.offsets.at(-1),4500);
 p.onKeyDown({key:'End',preventDefault(){}});assert.equal(h.offsets.at(-1),9000);p.onPointerDown(pointer(240));p.onPointerMove(pointer(270));p.onPointerCancel();assert.deepEqual(h.changes,[true,false]);assert.equal(h.interactions(),4);h.unmount();
});
test('background and layout changes cancel an active gesture without replaying a marker click',()=>{
 const h=harness();let p=h.render();p.onPointerDown(pointer(240));p.onPointerMove(pointer(300));h.props.active=false;h.render();assert.deepEqual(h.changes,[true,false]);h.props.active=true;p=h.render();p.onPointerDown(pointer(240));p.onPointerMove(pointer(300));h.props.layoutIdentity={};h.render();assert.deepEqual(h.changes,[true,false,true,false]);assert.deepEqual(h.selected,[]);h.unmount();
});
test('native responder has a 44px target, works without DOM globals and terminates cleanly',()=>{
 const h=harness(true),p=h.render();assert.equal(p.style.width,44);assert.equal(p.onStartShouldSetResponder(),true);const event=(y:number)=>({nativeEvent:{pageY:y+10,locationY:y}});p.onResponderGrant(event(240));p.onResponderMove(event(400));assert.equal(h.offsets.at(-1),3600);assert.equal(p.onResponderTerminationRequest(),false);p.onResponderTerminate();assert.deepEqual(h.changes,[true,false]);p.onAccessibilityAction({nativeEvent:{actionName:'increment'}});assert.equal(h.offsets.at(-1),2900);h.unmount();
});
