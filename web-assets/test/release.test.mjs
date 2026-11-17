import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {recipeIdentity,resolveRelease,verifyPublication,verifyRuntime,verifyExisting,verifyUploadedAssets,findRelease} from '../src/release.mjs';
const recipe={schema:1,id:'paseo',recipe_version:'wb.1'};
test('draft lookup survives a missing tag ref without creating another release',async()=>{
 const draft={tag_name:'paseo-web-v0.15.4-wb.1',draft:true};
 const api=async path=>path.includes('/tags/')?null:[draft];
 assert.equal(await findRelease('owner/repo',draft.tag_name,api),draft);
 assert.equal(await findRelease('owner/repo','another-version',api),null);
 await assert.rejects(findRelease('owner/repo',draft.tag_name,async path=>path.includes('/tags/')?null:[draft,draft]));
});
test('web versions are independent of plugin and Android channels',()=>{
  assert.deepEqual(recipeIdentity(recipe,'0.15.4'),{version:'0.15.4-wb.1',tag:'paseo-web-v0.15.4-wb.1'});
  for(const version of ['0.15.4-beta','v0.15.4','0.15.4\n','0.16.01','1.0','../0.16.1',null])assert.throws(()=>recipeIdentity(recipe,version));
  assert.deepEqual(recipeIdentity({...recipe,id:'another-static-app'},'0.15.4'),{version:'0.15.4-wb.1',tag:'another-static-app-web-v0.15.4-wb.1'});
});
test('the actual Paseo recipe resolves new stable minor and major releases without a recipe edit',async(t)=>{
 const actualRecipe=JSON.parse(await readFile(new URL('../recipes/paseo/recipe.json',import.meta.url)));
 let upstream='0.16.1';
 t.mock.method(globalThis,'fetch',async(url)=>{
  const path=new URL(url).pathname;
  let body,status=200;
  if(path===`/repos/${actualRecipe.repository}/releases/latest`)body={tag_name:`v${upstream}`,draft:false,prerelease:false};
  else if(path===`/repos/${actualRecipe.repository}/git/ref/tags/v${upstream}`)body={object:{type:'commit',sha:'a'.repeat(40)}};
  else if(path==='/repos/owner/repo/releases')body=[];
  else if(path.startsWith('/repos/owner/repo/releases/tags/')){status=404;body={};}
  else throw Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(body),{status});
 });
 for(upstream of ['0.16.1','0.17.0','1.0.0','2.4.0']) {
  const lock=await resolveRelease(actualRecipe,undefined,'owner/repo',{'recipe.json':'fixture'});
  assert.equal(lock.exists,false);
  assert.equal(lock.upstream_version,upstream);
  assert.equal(lock.tag,`paseo-web-v${upstream}-${actualRecipe.recipe_version}`);
  assert.equal(lock.source_commit,'a'.repeat(40));
 }
});
test('a release cannot pass host verification using an old daemon or stale compatibility claim',()=>{
 const lock={upstream_version:'0.16.1'};
 const descriptor={compatible_runtimes:{'@getpaseo/server':['0.16.1']}};
 const runtime={name:'@getpaseo/server',version:'0.16.1'};
 verifyRuntime(lock,descriptor,runtime);
 assert.throws(()=>verifyRuntime(lock,descriptor,{...runtime,version:'0.15.4'}));
 assert.throws(()=>verifyRuntime(lock,{compatible_runtimes:{'@getpaseo/server':['0.15.4']}},runtime));
 assert.throws(()=>verifyRuntime(lock,{},runtime));
 verifyRuntime({upstream_version:'1.2.3'},{compatible_runtimes:{'@getpaseo/server':['1.2.3']}},{...runtime,version:'1.2.3'});
});
test('draft releases cannot be published with missing or modified remote assets',()=>{
 const bytes=Buffer.from('archive');const files=new Map([['web.tar.gz',bytes]]);const assets=[{name:'web.tar.gz',size:bytes.length,state:'uploaded',digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`}];
 verifyUploadedAssets(files,assets);assert.throws(()=>verifyUploadedAssets(files,[]));assert.throws(()=>verifyUploadedAssets(files,[{...assets[0],digest:'sha256:changed'}]));
});
test('existing releases cannot hide an upstream tag move or a changed recipe',()=>{
  const identity=recipeIdentity(recipe,'0.15.4');const files={'recipe.json':'fixture'};const descriptor={schema:1,version:identity.version,source_commit:'a'.repeat(40),recipe_version:'wb.1',recipe_files:files};
  verifyExisting(descriptor,identity,recipe,'a'.repeat(40),files);
  assert.throws(()=>verifyExisting(descriptor,identity,recipe,'b'.repeat(40),files));
  assert.throws(()=>verifyExisting(descriptor,identity,recipe,'a'.repeat(40),{'recipe.json':'changed'}));
});
test('publication binds the exact source commit and archive bytes',()=>{
  const archive=Buffer.from('fixture archive');const lock={version:'0.15.4-wb.1',source_commit:'a'.repeat(40)};
  const descriptor={schema:1,version:lock.version,source_commit:lock.source_commit,recipe_version:'wb.1',archive:{name:'web.tar.gz',sha256:createHash('sha256').update(archive).digest('hex')}};
  verifyPublication(lock,descriptor,new Map([['web.tar.gz',archive]]));
  assert.throws(()=>verifyPublication(lock,{...descriptor,source_commit:'b'.repeat(40)},new Map([['web.tar.gz',archive]])));
  assert.throws(()=>verifyPublication(lock,descriptor,new Map([['web.tar.gz',Buffer.from('changed')]])));
});
