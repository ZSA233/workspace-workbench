import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildSync} from 'esbuild';
import {SyntaxService} from '../server/backend/syntax-service.ts';

const binary=process.env.HERMES_BINARY||new URL('../node_modules/react-native/sdks/hermesc/osx-bin/hermes',import.meta.url).pathname;
const available=existsSync(binary)&&(process.platform==='darwin'||!!process.env.HERMES_BINARY);
test('Hermes consumes backend ranges and opens/closes the real document reader without DOM or Prism',{skip:!available&&'Set HERMES_BINARY for native-engine verification'},async()=>{
  const syntax=new SyntaxService();let line;
  try{line=(await syntax.parse('fixture','python','"""first\nUnicode 字😀 body\nlast"""','python')).lines[1];}finally{await syntax.close();}
  const entry=`
    import {createDocumentReader,clearDocumentCache} from './client/document-reader.ts';
    import {nativeRenderSegments} from './client/native-syntax.ts';
    import {diffLineSyntax} from './shared/code-syntax.ts';
    import {documentLink} from './shared/document.ts';
    var line=${JSON.stringify(line)},scope={workspaceId:'main',instance:'instance',path:'file.py'};
    var syntax={protocol:1,patchDigest:'digest',state:'ready',left:{'2':line},right:{'2':line}};
    var spans=diffLineSyntax(syntax,'digest',line.code,{oldLine:2,newLine:2,kind:'context'});
    if(!spans||!spans.some(function(s){return s.kind==='string';}))throw Error('backend ranges missing');
    if(nativeRenderSegments(line.code,spans,[0,3]).map(function(s){return line.code.slice(s.start,s.end);}).join('')!==line.code)throw Error('source changed');
    if(documentLink('docs/readme.md','../file.py').path!=='file.py')throw Error('relative link failed');
    var page={protocol:1,workspaceId:'main',instance:'instance',path:'file.py',version:'v1',size:3,offset:0,nextOffset:3,text:'old',encoding:'utf-8',binary:false,eof:true};
    var reader=createDocumentReader('hermes\\0one',scope,function(input){return Promise.resolve(input.action==='document-syntax'?{version:'v1',state:'ready',language:'python',lines:{'2':line}}:page);});
    reader.load().then(function(){return reader.highlight(2);}).then(function(){
      if(reader.state.text!=='old'||reader.state.tokens['2'].code!==line.code)throw Error('reader failed');
      reader.close();clearDocumentCache('hermes');print('documents-hermes-ok');
    }).catch(function(error){print('FAILED: '+error.stack);});`;
  const source=buildSync({stdin:{contents:entry,resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,tsconfigRaw:{compilerOptions:{alwaysStrict:true}},format:'cjs',platform:'neutral',target:'es2020',supported:{'async-await':false},write:false}).outputFiles[0].text;
  assert.doesNotMatch(source,/prismjs|node:worker_threads|Element\.prototype/);
  const root=mkdtempSync(join(tmpdir(),'wb-documents-hermes-'));
  try{
    const path=join(root,'evaluate.js');writeFileSync(path,`var window,document,Element,Worker;eval(${JSON.stringify('/*'+' '.repeat(100000)+'*/\n'+source)});setTimeout(function(){},0);`);
    const output=execFileSync(binary,['-w','-lazy','-Xes6-promise','-Xmicrotask-queue',path],{encoding:'utf8',timeout:15000});
    assert.match(output,/documents-hermes-ok/);assert.doesNotMatch(output,/FAILED/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
