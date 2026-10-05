/** Node scheduler/scanner evidence only; this is NOT Android rendering or device latency evidence. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {createNativeSyntaxEngine,NativeSyntaxCache} from '../client/native-syntax-engine.ts';
import {nativeRenderSegments,NATIVE_SYNTAX_LIMITS as limits} from '../client/native-syntax.ts';
const allLines=Array.from({length:20000},(_,i)=>`const value${i} = "sample ${i} 中文"; // bounded source ${i}`);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const report={environment:'Node only; no native renderer or device',sampleLines:allLines.length,visibleRows:40,bufferRows:20,samples:[],plainRenderMs:[],coloredRenderMs:[]};
for(let pass=0;pass<30;pass++){
 const cache=new NativeSyntaxCache(),start=performance.now();let completed;const done=new Promise(resolve=>completed=resolve);
 const batchDurations=[];
 const engine=createNativeSyntaxEngine({cache,publish:()=>{if(engine.stats().pending===0)completed();},onError:error=>{throw error;},
  schedule:fn=>setTimeout(()=>{const at=performance.now();fn();batchDurations.push(performance.now()-at);},0)});
 const lines=allLines.slice(pass*60,pass*60+60);
 const before=performance.now();engine.update('typescript',lines);const updateMs=performance.now()-before;
 assert.equal(engine.stats().scanned,0,'initial caller must get plain text before scanning starts');
 await done;const colorReadyMs=performance.now()-start;
 const a=performance.now();for(const code of lines.slice(0,40))nativeRenderSegments(code,null);report.plainRenderMs.push(performance.now()-a);
 const b=performance.now();for(const code of lines.slice(0,40)){const spans=engine.read(code);assert.ok(spans);assert.equal(nativeRenderSegments(code,spans).map(s=>code.slice(s.start,s.end)).join(''),code);}report.coloredRenderMs.push(performance.now()-b);
 report.samples.push({...engine.stats(),updateMs,colorReadyMs,maxBatchMs:Math.max(...batchDurations)});engine.stop();
}
report.updateP95=percentile(report.samples.map(s=>s.updateMs),.95);
report.colorReadyP95=percentile(report.samples.map(s=>s.colorReadyMs),.95);
report.maxBatchMs=Math.max(...report.samples.map(s=>s.maxBatchMs));
report.plainSegmentsP95=percentile(report.plainRenderMs,.95);report.coloredSegmentsP95=percentile(report.coloredRenderMs,.95);
assert.ok(report.updateP95<=50);assert.ok(report.colorReadyP95<=300);assert.ok(report.maxBatchMs<50);
// Long-running scroll simulation exercises all cache bounds, without retaining source beyond the window.
const cache=new NativeSyntaxCache();let flush;
const engine=createNativeSyntaxEngine({cache,publish:()=>{if(engine.stats().pending===0)flush?.();},onError:error=>{throw error;}});
for(let i=0;i<allLines.length;i+=200){const done=new Promise(resolve=>flush=resolve);engine.update('typescript',allLines.slice(i,i+60));await done;}
report.afterScrolling=engine.stats();assert.ok(report.afterScrolling.lines<=limits.cacheLines&&report.afterScrolling.chars<=limits.cacheChars&&report.afterScrolling.spans<=limits.cacheSpans);engine.stop();
report.ok=true;const path=process.env.WORKBENCH_VERIFY_OUTPUT||'/tmp/workbench-native-syntax-performance.json';writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({path,updateP95:report.updateP95,colorReadyP95:report.colorReadyP95,maxBatchMs:report.maxBatchMs,afterScrolling:report.afterScrolling,ok:true},null,2));
