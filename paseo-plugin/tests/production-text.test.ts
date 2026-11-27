import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {retainedRequirementEdits} from '../server/backend/production-text.ts';

function proof(base:string,head:string,production:string){
 const root=mkdtempSync(join(tmpdir(),'wb-text-coverage-'));try{
  for(const [name,text]of Object.entries({base,head,production}))writeFileSync(join(root,name),text);
  const diff=(a:string,b:string,context:number)=>{try{return execFileSync('git',['diff','--no-index','--no-ext-diff','--no-textconv','--diff-algorithm=myers','--unified='+context,join(root,a),join(root,b)],{encoding:'utf8',stdio:['pipe','pipe','pipe']});}catch(error:any){if(error.status===1)return String(error.stdout);throw error;}};
  return retainedRequirementEdits(diff('base','head',3),diff('head','production',0),head,production);
 }finally{rmSync(root,{recursive:true,force:true});}
}
const base='header: original\nkeep A\nkeep B\nfeature: old\nkeep C\nkeep D\nfooter: original\n',head=base.replace('feature: old','feature: new');
test('positional proof tolerates independent insertion, replacement and deletion of patch context',()=>{
 for(const production of [head.replace('keep B','other requirement\nkeep B'),head.replace('header: original','header: new').replace('keep B','keep B changed'),head.replace('keep A\n','')])assert.equal(proof(base,head,production),true);
});
test('positional proof rejects modified, removed, moved or duplicated requirement lines and restored old values',()=>{
 for(const production of [head.replace('feature: new','feature: changed'),head.replace('feature: new\n',''),head.replace('feature: new\n','')+'feature: new\n',head+'feature: new\n',head.replace('feature: new','feature: new\nfeature: old')])assert.equal(proof(base,head,production),false);
});
test('pure deletions require a surviving boundary and cannot pass a restoration or an edit across that boundary',()=>{
 const removed=base.replace('feature: old\n','');assert.equal(proof(base,removed,removed.replace('header: original','header: changed')),true);
 for(const production of [base,removed.replace('keep B','keep B\nfeature: old'),removed.replace('keep C','keep C changed')])assert.equal(proof(base,removed,production),false);
});
test('partial rollback of a requirement block is not complete coverage',()=>{
 const added=base.replace('feature: old','feature: one\nfeature: two');assert.equal(proof(base,added,added.replace('header: original','header: changed')),true);
 assert.equal(proof(base,added,added.replace('feature: two','feature: old')),false);
});
test('binary, invalid text, missing newline markers and truncated patches cannot provide positional proof',()=>{
 assert.equal(proof(base,head,head+'\0'),false);assert.equal(proof(base,head,head+'\ufffd'),false);
 assert.equal(proof(base,head,head.trimEnd()),false);
 assert.equal(retainedRequirementEdits('@@ -1,2 +1,2 @@\n-before\n+after\n','',head,head),false);
});
