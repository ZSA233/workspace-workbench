import {createdInSession,workspaceCreators} from '../shared/workspace-creator.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceForest, workspaceTreeRows, workspaceListRows, workspaceIndent } from '../client/workspace-tree.ts';
import { sortWorkspacesByLatestCommit } from '../client/model.ts';
import { workspaceSource } from '../shared/workspace-lineage.ts';
import type { WorkspaceSummary } from '../client/model.ts';
const workspace = (id: string, parent?: WorkspaceSummary): WorkspaceSummary => ({ id, instanceKey:`${id}:first`, displayName:id, description:'', state:'active', repositoryCount:1, dirtyRepositoryCount:0, dirty:false,unpushed:false,claim:null,blockerCount:0,
  ...(parent ? {lineage:{ version:1,parent:workspaceSource(parent),ancestors:parent.lineage?.parent ? [parent.lineage.parent,...parent.lineage.ancestors]:[],recordedBy:'creation',repositories:[] }} : {}) });
const names = (rows: ReturnType<typeof workspaceTreeRows>) => rows.map(row => row.node.source.displayName);
test('list order and tree group order follow commit snapshots with bounded indentation', () => {
  const parent = workspace('parent'), child = workspace('child', parent), sibling = workspace('sibling', parent), main = workspace('main');
  parent.latestCommitAt = '2026-01-01T00:00:00Z'; child.latestCommitAt = sibling.latestCommitAt = '2026-03-01T00:00:00Z'; main.latestCommitAt = '2026-02-01T00:00:00Z';
  const ordered = sortWorkspacesByLatestCommit([parent, sibling, main, child]);
  assert.deepEqual(names(workspaceListRows(ordered)), ['child','sibling','main','parent']);
  assert.ok(workspaceListRows(ordered).every(row => row.depth === 0));
  assert.deepEqual(names(workspaceTreeRows(workspaceForest(ordered, ordered), new Set())), ['parent','child','sibling','main']);
  assert.deepEqual([0,1,2,3,50].map(workspaceIndent), [0,12,24,24,24]);
});
test('independent workspaces remain plain rows; only explicit ancestry creates a tree', () => {
  const a=workspace('a'),b=workspace('b'),c=workspace('c',a);
  const forest=workspaceForest([a,b,c],[b,c,a]);
  assert.deepEqual(names(workspaceTreeRows(forest,new Set())),['b','a','c']);
  assert.equal(forest[0].children.length,0); assert.equal(forest[1].members.length,2);
});
test('search inserts context ancestors without selecting them; clearing search restores collapse', () => {
  const a=workspace('a'),b=workspace('b',a),c=workspace('c',b),all=[a,b,c];
  const collapsed=new Set([a.instanceKey!]);
  assert.deepEqual(names(workspaceTreeRows(workspaceForest(all,all),collapsed)),['a']);
  const forest=workspaceForest(all,[c]);
  assert.deepEqual(names(workspaceTreeRows(forest,collapsed,true)),['a','b','c']);
  assert.deepEqual(forest[0].members.map(w=>w.id),['c']); assert.equal(forest[0].match,false);
  assert.deepEqual(names(workspaceTreeRows(workspaceForest(all,all),collapsed)),['a']);
});
test('history and active groups include matching members; permanently deleted ancestors have no rows', () => {
  const a=workspace('a'),b=workspace('b',a),c=workspace('c',b);a.state='removed';
  const active=workspaceForest([a,b,c],[c,b]);assert.deepEqual(active[0].members.map(w=>w.id),['b','c']);
  const before=JSON.stringify(c.lineage);
  const deleted=workspaceForest([c],[c]);assert.deepEqual(names(workspaceTreeRows(deleted,new Set())),['c']);
  assert.equal(deleted[0].workspace,c);assert.equal(JSON.stringify(c.lineage),before);
});
test('same ID recreated with a new identity does not adopt old descendants', () => {
  const old=workspace('root'),child=workspace('child',old),newRoot={...old,instanceKey:'root:second'};
  const forest=workspaceForest([newRoot,child],[newRoot,child]);
  assert.equal(forest.length,2);assert.equal(forest[0].members.length,1);
  assert.equal(forest[1].key,child.instanceKey);assert.equal(forest[1].workspace,child);
});
test('a deleted intermediate source is skipped while an available ancestor keeps its descendants', () => {
  const root=workspace('root'),deleted=workspace('deleted',root),child=workspace('child',deleted);
  const before=JSON.stringify(child.lineage),forest=workspaceForest([root,child],[child]);
  assert.deepEqual(names(workspaceTreeRows(forest,new Set())),['root','child']);
  assert.deepEqual(forest[0].members.map(w=>w.id),['child']);assert.equal(JSON.stringify(child.lineage),before);
});
test('legacy Gitlink source is explicit; clearing it suppresses fallback', () => {
  const source={...workspace('linked-one'),kind:'linked-live' as const},child={...workspace('child'),sourceWorkspaceId:source.id};
  assert.equal(workspaceForest([source,child],[source,child]).length,1);
  child.lineage={version:1,parent:null,ancestors:[],recordedBy:'user',repositories:[]};
  assert.equal(workspaceForest([source,child],[source,child]).length,2);
});
test('corrupt cycle cannot hang rendering; current ancestry wins over retained ancestor snapshots', () => {
  const a=workspace('a'),b=workspace('b',a);a.lineage={version:1,parent:workspaceSource(b),ancestors:[],recordedBy:'user',repositories:[]};
  assert.equal(workspaceTreeRows(workspaceForest([a,b],[a,b]),new Set()).length,2);
  const root=workspace('new-root'),child=workspace('child',b);
  b.lineage={version:1,parent:workspaceSource(root),ancestors:[],recordedBy:'user',repositories:[]};
  assert.deepEqual(names(workspaceTreeRows(workspaceForest([root,b,child],[child]),new Set())),['new-root','b','child']);
});
test('malformed optional provenance leaves the workspace available without an inferred group', () => {
  const row=workspace('independent');
  for(const metadata of [{version:2,parent:{}},{version:1,parent:{}},{version:1,parent:null,ancestors:'invalid',repositories:'invalid'}]) {
    row.lineage=metadata as unknown as WorkspaceSummary['lineage'];
    const forest=workspaceForest([row],[row]);assert.equal(forest.length,1);assert.equal(forest[0].children.length,0);
  }
});

test('creator filtering retains ancestry as context without selecting another session’s workspace',()=>{
 const parent=workspace('parent'),child=workspace('child',parent),legacy=workspace('legacy');
 parent.creator={agentId:'other',recordedAt:'2026-01-01T00:00:00Z'};child.creator={agentId:'current',recordedAt:'2026-01-02T00:00:00Z'};
 const all=[parent,child,legacy],matches=all.filter(w=>createdInSession(w,'current'));
 const tree=workspaceForest(all,matches);assert.deepEqual(tree[0].members.map(w=>w.id),['child']);assert.equal(tree[0].match,false);
 assert.deepEqual(names(workspaceTreeRows(tree,new Set())),['parent','child']);assert.equal(createdInSession(child,''),false);assert.equal(createdInSession(legacy,'current'),false);
});

test('creator picker includes historical sessions, deduplicates workspaces and keeps the newest name',()=>{
 const a={...workspace('a'),creator:{agentId:'owner',name:'Earlier title',recordedAt:'2026-01-01T00:00:00Z'}};
 const b={...workspace('b'),state:'removed',creator:{agentId:'owner',name:'Latest title',recordedAt:'2026-02-01T00:00:00Z'}};
 const other={...workspace('c'),creator:{agentId:'other',recordedAt:'2026-01-01T00:00:00Z'}};
 assert.deepEqual(workspaceCreators([b,a,a,workspace('legacy'),other]).map(x=>({id:x.agentId,name:x.name,count:x.count})),[{id:'owner',name:'Latest title',count:2},{id:'other',name:undefined,count:1}]);
});

test('a pinned creator remains independent of the selected workspace and execution session',()=>{
 const creator={agentId:'creator-a',recordedAt:'2026-01-01T00:00:00Z'};
 const original={...workspace('original'),creator};
 const sibling={...workspace('sibling'),creator};
 const unrelated={...workspace('unrelated'),creator:{...creator,agentId:'creator-b'}};
 const pinned=original.creator.agentId;
 // Removal and selection fallback do not change the captured creation identity.
 const records=[{...original,state:'removed'},sibling,unrelated,workspace('main')];
 assert.deepEqual(records.filter(w=>createdInSession(w,pinned)).map(w=>w.id),['original','sibling']);
 assert.equal(workspaceCreators(records).find(x=>x.agentId===pinned)?.count,2);
 assert.deepEqual([unrelated].filter(w=>createdInSession(w,pinned)),[]);
 assert.equal(workspaceCreators([unrelated]).some(x=>x.agentId===pinned),false);
});

test('invalid or absent creator records are never inferred from workspace identity',()=>{
 const row=workspace('creator-a');
 for(const creator of [undefined,{agentId:'creator-a',recordedAt:'invalid'},{agentId:'',recordedAt:'2026-01-01T00:00:00Z'}]){
   const candidate={...row,creator};
   assert.equal(createdInSession(candidate,'creator-a'),false);
   assert.deepEqual(workspaceCreators([candidate]),[]);
 }
});
