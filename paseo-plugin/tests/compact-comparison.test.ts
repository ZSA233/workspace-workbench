import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {iconGeometry,iconShapes} from '../client/icon-shapes.ts';
import {comparisonRequest,comparisonRowHeight,keyboardOverlap,sameComparisonRequest,shortComparisonRef} from '../client/comparison-display.ts';
import {previousDisplay} from '../client/query-continuity.ts';

test('comparison labels shorten presentation only; requests remain exact and input is explicit',()=>{
 assert.equal(shortComparisonRef('refs/remotes/origin/release/long-name'),'origin/release/long-name');
 assert.equal(shortComparisonRef('a'.repeat(40)),'aaaaaaaa');
 assert.deepEqual(comparisonRequest(' main ',' HEAD '),{fromRef:'main',toRef:'HEAD',mode:'endpoints'});
 assert.equal(comparisonRequest(' '),null);assert.equal(comparisonRequest('x\0'),null);
 assert.equal(sameComparisonRequest(comparisonRequest('main'),comparisonRequest('main')),true);
 assert.equal(sameComparisonRequest(comparisonRequest('main'),comparisonRequest('main','HEAD','contribution')),false);
});
test('comparison transition retains a cache address scoped to the repository, not a copied result',()=>{
 const cache=new Map([['old',{from:'main',files:['old']}],['new',{from:'release',files:['new']}]]);
 const address={family:'project/workspace/repo',key:['old']};
 assert.equal(previousDisplay(address,address.family,key=>cache.get(String(key[0]))),cache.get('old'));
 assert.equal(previousDisplay(address,'project/workspace/other',key=>cache.get(String(key[0]))),undefined);
 cache.delete('old');assert.equal(previousDisplay(address,address.family,key=>cache.get(String(key[0]))),undefined);
});
test('all shared UI icons have finite font-independent geometry',()=>{
 const names=['GitCompare','ArrowLeftRight','ArrowLeft','Search','Ellipsis','FolderTree','List','Info','CircleAlert','RefreshCw','ChevronDown','ChevronRight','ChevronUp','ChevronLeft','ChevronsUpDown','CircleX','GitBranch','Lock','Columns2','Rows3','Pin','X','Check'];
 for(const name of names){assert.ok(iconShapes[name],name);for(const part of iconGeometry(name)){for(const value of Object.values(part)){if(typeof value==='number')assert.ok(Number.isFinite(value)&&value>=0&&value<=24,name);}}}
 assert.equal(iconGeometry('Ellipsis').length,3);assert.ok(iconGeometry('Ellipsis').every(part=>part.kind==='box'&&part.fill));
 assert.ok(iconGeometry('not-known').length>1);
 const bridge=readFileSync(new URL('../client/native-components.tsx',import.meta.url),'utf8');assert.ok(!bridge.includes('text-glyph'));assert.ok(bridge.includes('createElement(GeometricIcon'));
});
test('native icon module loads and renders using View only without DOM, text glyphs or SVG',async()=>{
 const bundle=await build({entryPoints:[new URL('../client/geometric-icon.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['react'],plugins:[{name:'native-view-only',setup(builder){
   builder.onResolve({filter:/^react-native$/},()=>({path:'native',namespace:'test'}));
   builder.onResolve({filter:/native-diagnostics$/},()=>({path:'diagnostics',namespace:'test'}));
   builder.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='native'?`import React from 'react';export function View({children,style}){return React.createElement('view',{'data-shape':JSON.stringify(style)},children);}`:`export function reportNativeDiagnostic(){}`,loader:'js'}));
 }}]});
 const require=createRequire(import.meta.url),module={exports:{} as any};new Function('require','module','exports',bundle.outputFiles[0].text)(require,module,module.exports);
 const render=(element:any):any=>typeof element.type==='function'?render(element.type(element.props)):{tag:element.type,props:element.props,children:[element.props.children].flat().filter(Boolean).map(render)};
 const tree=render(module.exports.GeometricIcon.type({name:'Ellipsis',size:18,color:'#aaa'}));
 assert.equal(tree.tag,'view');assert.equal(tree.children.length,3);assert.ok(tree.children.every((child:any)=>child.tag==='view'));
 assert.ok(!/react-native-svg|createElement\("svg"/.test(bundle.outputFiles[0].text));
});

test('normal controls fit three compact rows and larger native type gets additional height',()=>{
 assert.equal(comparisonRowHeight(false),32);assert.equal(comparisonRowHeight(true),44);assert.ok(comparisonRowHeight(true)*3<=150);assert.equal(comparisonRowHeight(true,2),64);assert.ok(comparisonRowHeight(true,3)>=96);
});

test('sheet keyboard avoidance accounts for windows already resized by Android',()=>{
 assert.equal(keyboardOverlap(800,500),300);assert.equal(keyboardOverlap(500,500),0);assert.equal(keyboardOverlap(500,null),0);
});
