import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildSync} from 'esbuild';
const binary=process.env.HERMES_BINARY||new URL('../node_modules/react-native/sdks/hermesc/osx-bin/hermes',import.meta.url).pathname;
const available=existsSync(binary)&&(process.platform==='darwin'||!!process.env.HERMES_BINARY);
test('Hermes lazy-source loader initializes native syntax and colors all supported languages',{skip:!available&&'Set HERMES_BINARY for native-engine verification'},()=>{
 const entry=`import('./client/native-syntax-engine.ts').then(function(m){
  var jobs=[],publications=0;
  var engine=m.createNativeSyntaxEngine({publish:function(){publications++;},onError:function(e){print('FAILED: '+e.stack);},schedule:function(fn){jobs.push(fn);return jobs.length;},cancel:function(){},now:function(){return Date.now();}});
  var fixtures=[['go','package sample'],['go','import "fmt"'],['go','type Record struct {'],['go','// comment'],['javascript','const x = 12'],['typescript','interface Record {'],['json','{"value": true}']];
  fixtures.forEach(function(pair){engine.update(pair[0],[pair[1]]);var budget=100;while(jobs.length&&--budget)jobs.shift()();var spans=engine.read(pair[1]);if(!spans||!spans.some(function(s){return s.kind!=='plain';}))throw Error('missing color for '+pair[0]);if(spans.map(function(s){return pair[1].slice(s.start,s.end);}).join('')!==pair[1])throw Error('text changed');});
  engine.stop();if(publications!==fixtures.length)throw Error('publication missing');print('native-syntax-hermes-ok');
 }).catch(function(e){print('FAILED: '+e.stack);});`;
 const source=buildSync({stdin:{contents:entry,resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,tsconfigRaw:{compilerOptions:{alwaysStrict:true}},format:'cjs',platform:'neutral',target:'es2020',supported:{'async-await':false},write:false}).outputFiles[0].text;
 const root=mkdtempSync(join(tmpdir(),'wb-syntax-hermes-'));
 try{
  const path=join(root,'evaluate.js');writeFileSync(path,`eval(${JSON.stringify('/*'+' '.repeat(100000)+'*/\n'+source)});setTimeout(function(){},0);`);
  const output=execFileSync(binary,['-w','-lazy','-Xes6-promise','-Xmicrotask-queue',path],{encoding:'utf8',timeout:15000});
  assert.match(output,/native-syntax-hermes-ok/);assert.doesNotMatch(output,/FAILED/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
