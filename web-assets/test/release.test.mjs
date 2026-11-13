import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {recipeIdentity,verifyPublication} from '../src/release.mjs';
const recipe={schema:1,id:'paseo',recipe_version:'wb.1',version_pattern:'^0\\.15\\.[0-9]+$'};
test('web versions are independent of plugin and Android channels',()=>{
  assert.deepEqual(recipeIdentity(recipe,'0.15.4'),{version:'0.15.4-wb.1',tag:'paseo-web-v0.15.4-wb.1'});
  for(const version of ['0.16.0','0.15.4-beta','v0.15.4','0.15.4\n'])assert.throws(()=>recipeIdentity(recipe,version));
  assert.deepEqual(recipeIdentity({...recipe,id:'another-static-app'},'0.15.4'),{version:'0.15.4-wb.1',tag:'another-static-app-web-v0.15.4-wb.1'});
});
test('publication binds the exact source commit and archive bytes',()=>{
  const archive=Buffer.from('fixture archive');const lock={version:'0.15.4-wb.1',source_commit:'a'.repeat(40)};
  const descriptor={schema:1,version:lock.version,source_commit:lock.source_commit,recipe_version:'wb.1',archive:{name:'web.tar.gz',sha256:createHash('sha256').update(archive).digest('hex')}};
  verifyPublication(lock,descriptor,new Map([['web.tar.gz',archive]]));
  assert.throws(()=>verifyPublication(lock,{...descriptor,source_commit:'b'.repeat(40)},new Map([['web.tar.gz',archive]])));
  assert.throws(()=>verifyPublication(lock,descriptor,new Map([['web.tar.gz',Buffer.from('changed')]])));
});
