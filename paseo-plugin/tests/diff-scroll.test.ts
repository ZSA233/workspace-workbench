import test from 'node:test';
import assert from 'node:assert/strict';
import {railWidth,railMetrics,trackOffset,dragOffset,keyOffset,railMarks,markerAt,rowAtOffset} from '../client/diff-scroll-model.ts';
import {createScrollSignal} from '../client/diff-scroll-store.ts';
import type {DiffOverviewMarker} from '../client/model.ts';
const mark=(position:number,extent=.005,startRow=10):DiffOverviewMarker=>({position,extent,startRow,endRow:startRow,kind:'added',hunkIndex:0,startLine:startRow,endLine:startRow});
test('wide input surface keeps a bounded narrow scrollbar with correct endpoint geometry',()=>{
 assert.equal(railWidth(false),24);assert.equal(railWidth(true),44);
 assert.deepEqual(railMetrics(50,100,90),{maxScroll:0,thumbHeight:100,travel:0,thumbTop:0});
 const m=railMetrics(100000,1000,99000);assert.equal(m.thumbHeight,24);assert.equal(m.thumbTop,976);
 assert.equal(trackOffset(0,10000,1000),0);assert.equal(trackOffset(500,10000,1000),4500);assert.equal(trackOffset(1000,10000,1000),9000);
 assert.equal(dragOffset(m.thumbTop+7,7,100000,1000),99000);assert.equal(dragOffset(-10,7,100000,1000),0);assert.equal(dragOffset(5000,7,100000,1000),99000);
});
test('marker hits expand around paint and select nearest original row, including dense bottom marks',()=>{
 const markers=[mark(.1,.003,1),mark(.11,.003,2),mark(.9,.04,3)];assert.equal(markerAt(markers,1000,98,4)?.startRow,1);assert.equal(markerAt(markers,1000,109,4)?.startRow,2);assert.equal(markerAt(markers,1000,916,4)?.startRow,3);assert.equal(markerAt(markers,1000,500,4),undefined);
 const dense=Array.from({length:1000},(_,i)=>mark(.999+i*.0000001,.00000001,i));assert.equal(markerAt(dense,1000,999,4)?.startRow,0);
 const huge=[mark(.1,.5,1),mark(.8,.01,2)];assert.equal(markerAt(huge,1000,599,4)?.startRow,1);
});
test('paint aggregation is bounded by screen resolution and does not discard original positions',()=>{
 const original=Array.from({length:20000},(_,i)=>({...mark(i/20000,1/20000,i),kind:i%2?'added' as const:'removed' as const}));
 const painted=railMarks(original,600);assert.ok(painted.length<=600);assert.equal(original.length,20000);assert.equal(painted.at(-1)?.last,19999);assert.equal(markerAt(original,600,300,0)?.startRow!==undefined,true);
});
test('keyboard and index lookup clamp short and long documents without scanning every row',()=>{
 assert.equal(keyOffset('Home',400,1000,100),0);assert.equal(keyOffset('End',400,1000,100),900);assert.equal(keyOffset('PageDown',400,1000,100),490);assert.equal(keyOffset('ArrowUp',0,1000,100),0);assert.equal(keyOffset('x',0,1000,100),null);
 const offsets=Array.from({length:20000},(_,i)=>i*22),metrics={offsets,lengths:offsets.map(()=>22),contentHeight:440000};assert.equal(rowAtOffset(metrics,330001),15000);assert.equal(rowAtOffset(metrics,999999),19999);assert.equal(rowAtOffset(metrics,-10),0);
});
test('pixel signal publishes at most once per frame, preserves the latest position and cancels on disposal',()=>{
 const global=globalThis as any,oldRaf=global.requestAnimationFrame,oldCancel=global.cancelAnimationFrame,jobs=new Map<number,()=>void>();let id=0;
 global.requestAnimationFrame=(fn:()=>void)=>{jobs.set(++id,fn);return id;};global.cancelAnimationFrame=(id:number)=>jobs.delete(id);
 try{const signal=createScrollSignal(),seen:number[]=[];signal.subscribe(()=>seen.push(signal.get()));for(let n=1;n<=100;n++)signal.set(n);assert.equal(signal.get(),100);assert.equal(jobs.size,1);const fn=jobs.values().next().value!;jobs.clear();fn();assert.deepEqual(seen,[100]);signal.set(101);signal.dispose();assert.equal(jobs.size,0);assert.deepEqual(seen,[100]);}finally{global.requestAnimationFrame=oldRaf;global.cancelAnimationFrame=oldCancel;}
});
