import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig} from '../server/backend/config.ts';
import {Service} from '../server/backend/service.ts';
import {documentLink} from '../shared/document.ts';
import {createDocumentReader,clearDocumentCache} from '../client/document-reader.ts';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'wb-documents-')),repo=join(root,'repo');await mkdir(repo);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  const configPath=join(root,'project.json');await writeFile(configPath,JSON.stringify({schemaVersion:1,sourceRoot:root,repositories:[{id:'repo',path:'repo'}],management:{enabled:true}}));
  const service=new Service(loadConfig(configPath)),workspaceId=service.workspaces.list()[0].id;
  const call=(input:Record<string,any>)=>service.handle('files.request',{workspaceId,...input});
  return {root,repo,service,git,workspaceId,call,async close(){await service.close();await rm(root,{recursive:true,force:true});}};
}
test('versioned pages preserve UTF-8/UTF-16 characters and never create transfer tasks',async()=>{
  const f=await fixture();try{
    const text='字😀'.repeat(100000)+'\r\nend';
    for(const [name,data]of [['utf8',Buffer.from('\ufeff'+text)],['utf16',Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')])],['utf16be',Buffer.concat([Buffer.from([254,255]),Buffer.from(text,'utf16le').swap16()])]] as const){
      await writeFile(join(f.root,name),data);let page=await f.call({action:'document',path:name}),actual=page.text;
      while(!page.eof){page=await f.call({action:'document',path:name,version:page.version,offset:page.nextOffset});actual+=page.text;}
      assert.equal(actual,'\ufeff'+text,name);assert.equal(page.binary,false);
    }
    assert.equal((await f.call({action:'tasks'})).tasks.length,0);
    await writeFile(join(f.root,'binary'),Buffer.from([1,0,2]));assert.equal((await f.call({action:'document',path:'binary'})).binary,true);
    await writeFile(join(f.root,'rows'),'\n'.repeat(20000));const rows=await f.call({action:'document',path:'rows'});assert.equal(rows.text.split('\n').length,4001);assert.equal(rows.eof,false);
    await symlink(tmpdir(),join(f.root,'outside'));await assert.rejects(f.call({action:'document',path:'outside/any'}),/symbolic/);
  }finally{await f.close();}
});
test('file and working/commit/branch Diff share tokens bound to the matching source version',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.repo,'main.py'),'"""first\nold body\nlast"""\nprint("old")\n');f.git('add','.');f.git('commit','-qm','initial');const first=f.git('rev-parse','HEAD');
    await writeFile(join(f.repo,'main.py'),'"""first\nnew body\nlast"""\nprint("new")\n');
    const page=await f.call({action:'document',path:'repo/main.py'}),document=await f.call({action:'document-syntax',path:'repo/main.py',version:page.version});
    const params={workspaceId:f.workspaceId,repoPath:'repo',scope:'working',path:'main.py'};
    const diff=await f.service.handle('repository.diff',params);
    assert.equal(diff.left,first);assert.equal(diff.syntax.patchDigest,diff.patchDigest);assert.deepEqual(diff.syntax.right['2'],document.lines['2']);
    assert.ok(diff.syntax.right['2'].spans.some((s:any)=>s.kind==='string'));assert.equal(diff.syntax.left['2'].code,'old body');
    f.git('add','.');f.git('commit','-qm','second');const second=f.git('rev-parse','HEAD');
    const committed=await f.service.handle('repository.diff',{...params,scope:'commit',commitSha:second});assert.equal(committed.syntax.left['2'].code,'old body');assert.equal(committed.syntax.right['2'].code,'new body');
    const compared=await f.service.handle('repository.diff',{...params,scope:'compare',comparison:{leftSha:first,toSha:second}});assert.equal(compared.syntax.right['2'].code,'new body');
    await writeFile(join(f.repo,'added.go'),'package main\nfunc main() {}\n');f.git('add','added.go');f.git('commit','-qm','added source');
    const added=await f.service.handle('repository.diff',{...params,scope:'commit',commitSha:f.git('rev-parse','HEAD'),path:'added.go'});assert.equal(added.syntax.state,'ready');assert.equal(added.syntax.reason,undefined);assert.deepEqual(added.syntax.left,{});assert.ok(added.syntax.right['1'].spans.some((s:any)=>s.kind==='keyword'));
    await writeFile(join(f.repo,'main.py'),'changed');await assert.rejects(f.call({action:'document-syntax',path:'repo/main.py',version:page.version}),/changed/);
    await assert.rejects(f.call({action:'download',id:'changed-preview',paths:['repo/main.py'],versions:{'repo/main.py':page.version}}),/changed/);assert.equal((await f.call({action:'tasks'})).tasks.length,0);
    assert.equal(await readFile(join(f.repo,'main.py'),'utf8'),'changed');
  }finally{await f.close();}
});
test('document links stay rooted at the actual file directory',()=>{
  assert.deepEqual(documentLink('docs/readme.md','../images/a.png'),{path:'images/a.png',fragment:undefined});
  assert.equal(documentLink('readme.md','../outside'),null);assert.equal(documentLink('readme.md','javascript:alert(1)'),null);assert.equal(documentLink('readme.md','//elsewhere'),null);
  assert.equal(documentLink('readme.md','%2fetc/passwd'),null);assert.equal(documentLink('readme.md','%2e%2e/outside'),null);
  assert.deepEqual(documentLink('docs/readme.md','next.md#part'),{path:'docs/next.md',fragment:'part'});
});
test('CRLF byte boundaries, embedded BOMs and CR-only paging preserve original source',async()=>{
  const f=await fixture();try{
    const boundary='a'.repeat(256*1024-1)+'\r\nsecond\n\ufeffembedded';
    for(const [name,data]of [['crlf',Buffer.from(boundary)],['wide-crlf',Buffer.concat([Buffer.from([255,254]),Buffer.from('a'.repeat(128*1024-2)+'\r\nsecond','utf16le')])]] as const){
      await writeFile(join(f.root,name),data);const first=await f.call({action:'document',path:name});assert.ok(!first.text.endsWith('\r'));const second=await f.call({action:'document',path:name,offset:first.nextOffset,version:first.version});
      assert.equal(first.text+second.text,name==='crlf'?boundary:'\ufeff'+'a'.repeat(128*1024-2)+'\r\nsecond');
    }
    await writeFile(join(f.root,'mac-lines'),'\r'.repeat(12000));const first=await f.call({action:'document',path:'mac-lines'});assert.ok(first.text.length<=4000);assert.equal(first.eof,false);
    assert.deepEqual(await f.call({action:'document-stat',path:'crlf'}),{version:(await f.call({action:'document',path:'crlf'})).version,size:Buffer.byteLength(boundary)});
  }finally{await f.close();}
});
test('renamed sides use their own languages and expanded context keeps the canonical digest',async()=>{
  const f=await fixture();try{
    const source=Array.from({length:400},(_,i)=>`# retained context ${i+1}`);source[199]='const answer = "old";';
    await writeFile(join(f.repo,'before.ts'),source.join('\r\n')+'\r\n');f.git('add','.');f.git('commit','-qm','initial');const base=f.git('rev-parse','HEAD');f.git('branch','baseline',base);f.git('branch','--set-upstream-to=baseline');
    f.git('mv','before.ts','after.py');source[199]='answer = "new"';await writeFile(join(f.repo,'after.py'),source.join('\r\n')+'\r\n');f.git('add','.');f.git('commit','-qm','rename');const head=f.git('rev-parse','HEAD');
    const params={workspaceId:f.workspaceId,repoPath:'repo',scope:'compare',path:'after.py',comparison:{leftSha:base,toSha:head}};
    const compared=await f.service.handle('repository.diff',params);assert.equal(compared.oldPath,'before.ts');assert.equal(compared.syntax.left['200'].code,'const answer = "old";');assert.equal(compared.syntax.right['200'].code,'answer = "new"');
    assert.ok(compared.syntax.left['200'].spans.some((s:any)=>s.kind==='keyword'));assert.equal(compared.syntax.left['199'].spans.some((s:any)=>s.kind==='comment'),false);assert.ok(compared.syntax.right['199'].spans.some((s:any)=>s.kind==='comment'));
    assert.equal(compared.syntax.sources.left.path,'before.ts');assert.equal(compared.syntax.sources.right.path,'after.py');assert.ok(compared.syntax.sources.left.version!==compared.syntax.sources.right.version);
    const context=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}});assert.equal(context.patchDigest,compared.patchDigest);assert.equal(context.syntax.patchDigest,compared.patchDigest);assert.equal(context.syntax.right['1'].code,source[0]);assert.ok(context.syntax.right['1'].spans.some((s:any)=>s.kind==='comment'));
    const branch=await f.service.handle('repository.diff',{...params,scope:'branch'});assert.equal(branch.syntax.right['200'].code,compared.syntax.right['200'].code);
  }finally{await f.close();}
});
test('large source and a single huge line use bounded windows that can be read backwards',async()=>{
  const f=await fixture();try{
    const text='x'.repeat(4*1024*1024)+'\nlast\n';await writeFile(join(f.root,'large.txt'),text);
    const first=await f.call({action:'document',path:'large.txt'}),highlight=await f.call({action:'document-syntax',path:'large.txt',version:first.version});assert.equal(highlight.reason,'large_file');assert.ok(first.text.length<=256*1024);
    const context={workspaceId:f.workspaceId,instance:first.instance,path:'large.txt'},reader=createDocumentReader('large\0'+JSON.stringify([0,f.workspaceId]),context,f.call);
    await reader.load();let windows=0;while(!reader.state.page!.eof){await reader.more();assert.ok(reader.state.text.length<=1280*1024);if(reader.state.windowOffset)windows++;}
    assert.ok(windows>0);assert.equal(reader.state.startLine,1);assert.ok(reader.state.text.endsWith('\nlast\n'));assert.ok(reader.state.continuation);
    await reader.previous();assert.ok(reader.state.windowIndex>=0);assert.equal(reader.state.page!.version,first.version);reader.close();clearDocumentCache('large');
    await rm(join(f.root,'large.txt'));await assert.rejects(f.call({action:'document',path:'large.txt',version:first.version}),/ENOENT/);
  }finally{await f.close();}
});
test('closed and reloaded readers discard late text and syntax, retaining snapshots on failure',async()=>{
  let resolve!:(v:any)=>void;const calls:any[]=[];const scope={workspaceId:'main',instance:'one',path:'file'};
  const page={protocol:1,...scope,version:'v1',size:3,offset:0,nextOffset:3,text:'old',encoding:'utf-8',binary:false,eof:true};
  const reader=createDocumentReader('unit\0one',scope,async input=>{calls.push(input);if(input.action==='document')return page;if(input.action==='document-syntax')return new Promise(r=>resolve=r);return {};});
  await reader.load();const pending=reader.highlight(1);reader.close();resolve({version:'v1',state:'ready',language:'go',lines:{'1':{code:'old',spans:[]}}});await pending;assert.deepEqual(reader.state.tokens,{});assert.ok(calls.some(c=>c.action==='document-cancel'));
  clearDocumentCache('unit');
  let fail=false;const next=createDocumentReader('unit\0two',scope,async()=>{if(fail)throw Error('offline');return page;});await next.load();fail=true;await next.load(true);assert.equal(next.state.text,'old');assert.match(next.state.error!,/offline/);next.close();clearDocumentCache('unit');
});
test('a transient Markdown parser failure retries once and later failures remain readable',async()=>{
  const scope={workspaceId:'main',instance:'one',path:'file.md'},page={protocol:1,...scope,version:'v1',size:7,offset:0,nextOffset:7,text:'# Title',encoding:'utf-8',binary:false,eof:true};let parses=0;
  const reader=createDocumentReader('retry\0one',scope,async input=>input.action==='document-syntax'?++parses===1?{version:'v1',language:'markdown',state:'plain',reason:'timeout',lines:{}}:{version:'v1',language:'markdown',state:'ready',lines:{},markdown:[]} :page);
  await reader.load();await reader.highlight(1,true);assert.equal(parses,2);assert.deepEqual(reader.state.markdown,[]);assert.equal(reader.state.mode,undefined);reader.close();clearDocumentCache('retry');
});
test('host view replacement reuses the snapshot and only validates metadata',async()=>{
  const scope={workspaceId:'main',instance:'one',path:'file.py'},page={protocol:1,...scope,version:'v1',size:3,offset:0,nextOffset:3,text:'old',encoding:'utf-8',binary:false,eof:true},calls:string[]=[];
  const call=async(input:Record<string,unknown>)=>{calls.push(String(input.action));return input.action==='document-syntax'?{version:'v1',state:'ready',language:'python',lines:{'1':{code:'old',spans:[]}}}:page;};
  const previous=createDocumentReader('theme\0one',scope,call);await previous.load();await previous.highlight(1);
  const replacement=createDocumentReader('theme\0one',scope,call);previous.close();await replacement.load();await replacement.highlight(1);
  assert.deepEqual(calls,['document','document-syntax','document-stat']);assert.equal(replacement.state.text,'old');
  const revision=replacement.state.revision;await replacement.load(true);assert.equal(replacement.state.revision,revision+1);replacement.close();clearDocumentCache('theme');
});

test('first syntax viewport starts immediately and scroll requests coalesce to the latest viewport',async()=>{
  const starts:number[]=[],scope={workspaceId:'w',instance:'one',path:'code.go'},page={version:'fixed',text:'line\n'.repeat(1200),binary:false,eof:true} as any;
  let resolve!: (value:any)=>void;
  const reader=createDocumentReader('coalesce\0one',scope,async input=>{if(input.action==='document')return page;if(input.action==='document-syntax'){starts.push(input.lineStart as number);if(starts.length===1)return new Promise(r=>resolve=r);return {version:'fixed',state:'ready',language:'go',lines:{}};}return {};});
  await reader.load();const first=reader.highlight(1);assert.deepEqual(starts,[1]);
  for(let line=201;line<=1001;line+=100)void reader.highlight(line);
  resolve({version:'fixed',state:'ready',language:'go',lines:{}});await first;assert.deepEqual(starts,[1,1001]);reader.close();clearDocumentCache('coalesce');
});
