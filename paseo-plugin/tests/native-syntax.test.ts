import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {NATIVE_SYNTAX_LIMITS as limits,scanNativeLine,nativeRenderSegments,nativeLanguage} from '../client/native-syntax.ts';
import {createNativeSyntaxEngine,NativeSyntaxCache} from '../client/native-syntax-engine.ts';
import {syntaxPalette} from '../client/syntax-palette.ts';
const tokens=(code:string,lang:'go'|'javascript'|'typescript'|'json')=>scanNativeLine(code,lang)!.filter(t=>t.kind!=='plain').map(t=>[code.slice(t.start,t.end),t.kind]);
test('native scanner identifies basic Go, JS, TS and JSON tokens',()=>{
 assert.deepEqual(tokens('func name() { return "hello" // comment','go'),[['func','keyword'],['return','keyword'],['"hello"','string'],['// comment','comment']]);
 assert.deepEqual(tokens('const value = 12.5; // safe','javascript'),[['const','keyword'],['12.5','number'],['// safe','comment']]);
 assert.deepEqual(tokens('type Value = string | null','typescript'),[['type','keyword'],['string','keyword'],['null','keyword']]);
 assert.deepEqual(tokens('{"enabled": true, "n": 12}','json'),[['"enabled"','string'],['true','keyword'],['"n"','string'],['12','number']]);
 assert.equal(nativeLanguage('tsx'),null);assert.equal(nativeLanguage('python'),null);
});
test('escaped strings, Unicode and tabs survive exact reconstruction and inline clipping',()=>{
 for(const code of ['', '\tconst 名称 = "文字😀\\\""; // 字符', 'var x = `raw\\value`', "const a = 'escaped\\\'value';",'/* comment */ const value = 2','const x = `template ${value}`']){
  const spans=scanNativeLine(code,'javascript');assert.equal((spans||[]).map(s=>code.slice(s.start,s.end)).join(''),code);
  for(const change of [[0,code.length],[2,8],[0,0]] as const){const pieces=nativeRenderSegments(code,spans,change);assert.equal(pieces.map(s=>code.slice(s.start,s.end)).join(''),code);assert.ok(pieces.every(s=>!s.changed||s.start>=change[0]&&s.end<=change[1]));}
 }
});
test('incomplete and ambiguous constructs stay plain, without speculative regexp parsing',()=>{
 for(const code of ['"unterminated','/* unfinished','`across lines','/long[regex] const string/'])assert.ok(scanNativeLine(code,'javascript')!.every(s=>s.kind==='plain'));
 assert.deepEqual(tokens('var value = 0xF + 1e3','go'),[['var','keyword'],['0xF','number'],['1e3','number']]);
 assert.deepEqual(tokens('1e+','json'),[]);
});
test('line size, span count and cooperative budget limits return plain content',()=>{
 assert.equal(scanNativeLine('a'.repeat(limits.lineChars+1),'go'),null);
 assert.equal(scanNativeLine('1+'.repeat(60),'go'),null);
 let checks=0;assert.equal(scanNativeLine('"'+'x'.repeat(1000)+'"','go',()=>++checks>10),null);assert.ok(checks<=11);
 assert.equal(nativeRenderSegments('a'.repeat(3000),null).length,1);
 assert.equal(scanNativeLine('someIdentifier','go')!.length,1);
});
function harness(scan?:typeof scanNativeLine,clock?:()=>number){
 const jobs=new Map<number,()=>void>();let id=0,published=0,errors=0;
 const cache=new NativeSyntaxCache();
 const engine=createNativeSyntaxEngine({cache,scan,now:clock||(()=>0),publish:()=>published++,onError:()=>errors++,schedule:fn=>{jobs.set(++id,fn);return id;},cancel:handle=>{jobs.delete(handle as number);}});
 const step=()=>{const first=jobs.entries().next().value;if(first){jobs.delete(first[0]);first[1]();}};
 return {engine,cache,jobs,step,published:()=>published,errors:()=>errors,drain(){let n=0;while(jobs.size){assert.ok(++n<1000);step();}}};
}
test('no synchronous scanning, bounded batches, cancellation, cache reuse and deduplication',()=>{
 let calls=0;const h=harness((...args)=>{calls++;return scanNativeLine(...args);});
 const lines=Array.from({length:6},(_,i)=>`// ${i} `+'x'.repeat(2000));h.engine.update('go',[...lines,...lines]);assert.equal(calls,0);assert.equal(h.jobs.size,1);
 h.step();assert.equal(calls,2);assert.equal(h.published(),1);
 h.engine.stop();assert.equal(h.jobs.size,0);h.engine.update('go',lines);h.drain();assert.equal(calls,6);assert.ok(h.engine.stats().hits>=2);
 h.engine.update('go',['const old = 1']);const oldJob=[...h.jobs.values()][0];h.engine.update('go',['const newer = 2']);oldJob();h.drain();assert.equal(h.engine.read('const old = 1'),undefined);assert.ok(h.engine.read('const newer = 2'));
});
test('scanner failure stops the view, cannot loop, and the next view can recover',()=>{
 const h=harness(()=>{throw Error('injected');});h.engine.update('go',['const x = 1']);h.drain();assert.equal(h.errors(),1);assert.equal(h.published(),0);assert.equal(h.engine.stats().failed,true);
 h.engine.update('go',['const x = 2']);h.drain();assert.equal(h.errors(),1);
 const next=harness();next.engine.update('go',['const x = 1']);next.drain();assert.ok(next.engine.read('const x = 1'));
});
test('deadline is checked during scanning, rather than racing an uninterruptible promise',()=>{
 let time=0;const h=harness(undefined,()=>time+=0.5);h.engine.update('go',['"'+'x'.repeat(1000)+'"']);h.drain();assert.equal(h.engine.read('"'+'x'.repeat(1000)+'"'),null);assert.ok(h.engine.stats().yielded>0);
});
test('cache enforces all three bounds and keys exclude theme',()=>{
 const cache=new NativeSyntaxCache();for(let i=0;i<400;i++)cache.put('go',`// ${i} `+'x'.repeat(1000),[{start:0,end:1000,kind:'comment'}]);
 assert.ok(cache.stats().lines<=limits.cacheLines);assert.ok(cache.stats().chars<=limits.cacheChars);
 for(let i=0;i<400;i++)cache.put('javascript',`line${i}`,Array.from({length:96},(_,j)=>({start:j,end:j+1,kind:'plain'})));
 assert.ok(cache.stats().spans<=limits.cacheSpans);assert.ok(cache.stats().lines<=limits.cacheLines);
 const code='const x=1',spans=scanNativeLine(code,'javascript');cache.put('javascript',code,spans);
 const theme=(surface0:string)=>({colors:{surface0,foreground:'#eee',foregroundMuted:'#999'}});
 assert.notEqual(syntaxPalette(theme('#ffffff')).keyword,syntaxPalette(theme('#111111')).keyword);assert.equal(cache.get('javascript',code)?.spans,spans);assert.equal(cache.get('go',code),undefined);
});
test('native scanner/engine/palette execute with no window, document, Element or Worker',()=>{
 const result=buildSync({stdin:{contents:"export {scanNativeLine} from './client/native-syntax'; export {createNativeSyntaxEngine} from './client/native-syntax-engine'; export {syntaxPalette} from './client/syntax-palette';",resolveDir:new URL('..',import.meta.url).pathname},bundle:true,format:'cjs',platform:'neutral',write:false});
 const module={exports:{} as any};vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports});const exports=module.exports;
 assert.equal((exports as any).scanNativeLine('return 12','go')[0].kind,'keyword');
 assert.ok(!/prism|Element\.prototype|document\./i.test(result.outputFiles[0].text));
});

test('actual native syntax entry renders colored ranges without executing web modules or per-row effects',()=>{
 const result=buildSync({entryPoints:[new URL('../client/syntax.tsx',import.meta.url).pathname],bundle:true,format:'cjs',platform:'neutral',external:['react','react/jsx-runtime','react-native'],jsx:'automatic',write:false});
 const module={exports:{} as any};const element=(type:any,props:any)=>({type,props});
 const context:any={module,exports:module.exports,require:(id:string)=>{
  if(id==='react-native')return {Platform:{OS:'android'},Text:'Text'};
  if(id==='react/jsx-runtime')return {jsx:element,jsxs:element};
  if(id==='react')return {memo:(fn:any)=>fn,useEffect:()=>{throw Error('per-row effect');},useState:()=>{throw Error('per-row state');}};
  throw Error('Unexpected dependency '+id);
 }};
 for(const key of ['window','document','Element','Worker','Prism'])Object.defineProperty(context,key,{get(){throw Error('native accessed '+key);}});
 vm.runInNewContext(result.outputFiles[0].text,context);
 const code='\tconst 标记 = "hello😀";',spans=scanNativeLine(code,'typescript');
 const theme={colors:{surface0:'#111111',foreground:'#eee',foregroundMuted:'#999'}};
 const node=module.exports.HighlightedCode({code,path:'sample.ts',theme,spans,inlineChange:[code.indexOf('hello'),code.indexOf('hello')+5],changeBackground:'#abcdef',style:{fontSize:14,lineHeight:22}});
 const text=(value:any):string=>typeof value==='string'?value:Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';
 assert.equal(text(node),code);
 const children=node.props.children as any[];
 assert.ok(children.some(n=>n.props.style.color==='#569CD6'));
 assert.ok(children.some(n=>n.props.style.backgroundColor==='#abcdef'&&n.props.style.color==='#CE9178'));
 assert.ok(children.every(n=>n.props.style.fontSize===undefined&&n.props.style.lineHeight===undefined),'tokens inherit identical text metrics');
 const plain=module.exports.HighlightedCode({code,path:'sample.ts',theme});assert.equal(plain.props.children,code,'first render remains plain with no per-token nodes');
});

test('a fully exhausted scheduling turn degrades without an endless retry loop',()=>{
 let time=0;const h=harness(undefined,()=>time+=10);h.engine.update('go',['const value = 1']);h.drain();assert.equal(h.engine.stats().pending,0);assert.equal(h.engine.stats().scanned,0);assert.equal(h.jobs.size,0);assert.equal(h.engine.read('const value = 1'),undefined);
});
test('late cancelled callbacks cannot lose the current cancellation handle',()=>{
 const h=harness();h.engine.update('go',['old']);const stale=[...h.jobs.values()][0];h.engine.update('go',['new']);stale();h.engine.stop();assert.equal(h.jobs.size,0);h.drain();assert.equal(h.engine.stats().scanned,0);
});
