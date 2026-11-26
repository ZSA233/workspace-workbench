import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from '../server/backend/git.ts';
import { inspectRepository, textPatchCoverage } from '../server/backend/production-coverage.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-production-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config','user.name','Test'); git('config','user.email','test@example.invalid');
  const commit = (text: string, name = 'change') => { writeFileSync(join(root, 'file'), text); git('add','file'); git('commit','-qm',name); return git('rev-parse','HEAD'); };
  const base = commit('before\nkeep\n'), head = commit('after\nkeep\n', 'Fix login');
  git('update-ref','refs/remotes/origin/main',base);
  const inspect = () => inspectRepository(new Git(root,10000),{repositoryId:'repo',repoPath:'repo',baseSha:base});
  return { root, git, commit, base, head, inspect, close: () => rmSync(root,{recursive:true,force:true}) };
}
test('production coverage follows current content, catches rollback and does not mutate refs or files',async()=>{
  const f=fixture();try {
    assert.equal((await f.inspect()).coverage.state,'pending');
    f.git('update-ref','refs/remotes/origin/main',f.head);
    const before=f.git('status','--porcelain');assert.equal((await f.inspect()).coverage.state,'deployed');assert.equal(f.git('status','--porcelain'),before);
    const changed=f.commit('after\nkeep\nnew\n','Follow up');assert.equal((await f.inspect()).coverage.state,'pending');
    f.git('update-ref','refs/remotes/origin/main',changed);assert.equal((await f.inspect()).coverage.state,'deployed');
    f.git('update-ref','refs/remotes/origin/main',f.base);assert.equal((await f.inspect()).coverage.state,'pending');
    writeFileSync(join(f.root,'file'),'uncommitted\n');assert.equal((await f.inspect()).coverage.dirty,true);assert.notEqual((await f.inspect()).coverage.state,'deployed');
  } finally {f.close();}
});
test('squash equivalence and later non-overlapping production edits are verified by blobs and text',async()=>{
  const f=fixture();try {
    f.git('checkout','-qb','production',f.base);const squash=f.commit('after\nkeep\n','Squashed');assert.notEqual(squash,f.head);
    f.git('update-ref','refs/remotes/origin/main',squash);f.git('checkout','-q','main');assert.equal((await f.inspect()).coverage.state,'deployed');
    f.git('checkout','-q','production');const later=f.commit('after\nkeep\nproduction extra\n','Other production work');f.git('update-ref','refs/remotes/origin/main',later);f.git('checkout','-q','main');
    assert.equal((await f.inspect()).coverage.state,'deployed');
    f.git('checkout','-q','production');const reverted=f.commit('before\nkeep\nproduction extra\n','Revert login');f.git('update-ref','refs/remotes/origin/main',reverted);f.git('checkout','-q','main');assert.equal((await f.inspect()).coverage.state,'pending');
  } finally {f.close();}
});
test('missing baseline, missing production ref, binary mismatches and ambiguous hunks never mean shipped',async()=>{
  const f=fixture();try {
    assert.equal((await inspectRepository(new Git(f.root),{repositoryId:'r',repoPath:'r'})).coverage.state,'unknown');
    f.git('update-ref','-d','refs/remotes/origin/main');assert.equal((await f.inspect()).coverage.state,'unknown');
    assert.equal(textPatchCoverage('@@ -1 +1 @@\n-before\n+after\n','after\nafter\n'),'unknown');
    assert.equal(textPatchCoverage('GIT binary patch','after'),'unknown');
  }finally{f.close();}
});
test('first-parent materials exclude incoming mainline changes and initial empty work is discussion',async()=>{
  const f=fixture();try {
    const first=await f.inspect();assert.equal(first.evidence.filter(e=>e.kind==='commit').length,1);
    const empty=await inspectRepository(new Git(f.root),{repositoryId:'r',repoPath:'r',baseSha:f.head});assert.equal(empty.coverage.state,'discussion');
    f.git('checkout','-qb','incoming',f.base);writeFileSync(join(f.root,'other'),'upstream');f.git('add','other');f.git('commit','-qm','Unrelated upstream');f.git('checkout','-q','main');f.git('merge','-q','--no-edit','incoming');
    assert.deepEqual((await f.inspect()).evidence.filter(e=>e.kind==='commit').map(e=>e.text),['Fix login']);
  }finally{f.close();}
});
test('cherry-picked changes are checked against current production blobs and incoming-only merges remain discussion',async()=>{
  const f=fixture();try{
    f.git('checkout','-qb','release',f.base);writeFileSync(join(f.root,'release-only'),'release');f.git('add','.');f.git('commit','-qm','Unrelated production setup');f.git('cherry-pick',f.head);const cherry=f.git('rev-parse','HEAD');assert.notEqual(cherry,f.head);f.git('update-ref','refs/remotes/origin/main',cherry);f.git('checkout','-q','main');assert.equal((await f.inspect()).coverage.state,'deployed');
    f.git('checkout','-qb','empty-work',f.base);f.git('merge','-q','--no-edit','release');
    // A fast-forward is real first-parent history, so use a true merge with an empty own commit.
    f.git('checkout','-qb','merge-only',f.base);f.git('commit','--allow-empty','-qm','Discuss target');f.git('merge','-q','--no-edit','release');
    const coverage=await f.inspect();assert.equal(coverage.coverage.state,'discussion');assert.ok(!coverage.evidence.filter(e=>e.kind==='commit').some(e=>e.text==='Unrelated production setup'));
  }finally{f.close();}
});
