import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {recipeIdentity,verifyPublication,verifyExisting,verifyUploadedAssets} from '../src/release.mjs';
const recipe={schema:1,id:'paseo',recipe_version:'wb.1',version_pattern:'^0\\.15\\.[0-9]+$'};
test('web versions are independent of plugin and Android channels',()=>{
  assert.deepEqual(recipeIdentity(recipe,'0.15.4'),{version:'0.15.4-wb.1',tag:'paseo-web-v0.15.4-wb.1'});
  for(const version of ['0.16.0','0.15.4-beta','v0.15.4','0.15.4\n'])assert.throws(()=>recipeIdentity(recipe,version));
  assert.deepEqual(recipeIdentity({...recipe,id:'another-static-app'},'0.15.4'),{version:'0.15.4-wb.1',tag:'another-static-app-web-v0.15.4-wb.1'});
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
