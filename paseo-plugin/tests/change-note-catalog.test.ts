import test from 'node:test';
import assert from 'node:assert/strict';
import {buildComparisonCatalog} from '../server/backend/change-note-catalog.ts';
import {comparisonRecordState,comparisonExplanationRequest} from '../client/comparison-notes-model.ts';
import type {ChangeNote,NotesResult} from '../shared/change-notes.ts';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const content={title:'Explain cache defaults',reason:'Requirement',behavior:'New default',basis:'requirement' as const,requirement:'Use two',perspective:'implementer' as const,question:'',evidence:'',anchors:[{path:'one.go',side:'file' as const},{path:'two.go',side:'file' as const}]};
function fixture(){
 const comparison={fromRef:'origin/main',toRef:'feature/cache',fromSha:a,toSha:b,leftSha:a,mergeBase:null,mode:'endpoints' as const};
 const s={projectId:'sample',workspaceId:'work',instance:'first',repoPath:'repo',scope:'compare',comparison,left:a,right:b,files:[]};
 const note:ChangeNote={id:'one',revision:1,snapshotId:'page1',author:'agent',updatedAt:'2026-10-01T00:00:00Z',withdrawn:false,content};
 return {notes:[note],history:[] as ChangeNote[],feedback:[] as NotesResult['feedback'],snapshots:{page1:s,page2:{...s,comparison:{...comparison,fromRef:'release/stable'}}} };}
test('catalog groups pages and aliases, deduplicates revisions and counts multi-file notes once',()=>{
 const f=fixture();f.history.push(f.notes[0]);f.notes=[{...f.notes[0],revision:2,snapshotId:'page2'}, {...f.notes[0],id:'two',snapshotId:'page1'}];
 const index=buildComparisonCatalog(f);assert.equal(index.records.length,1);assert.equal(index.records[0].record.noteCount,2);assert.equal(index.records[0].record.aliases.length,2);assert.equal(index.records[0].notes.get('one')?.revision,2);
});
test('migrated explanation keeps old revision read-only; withdrawal hides every scope',()=>{
 const f=fixture();f.history.push(f.notes[0]);f.snapshots.page2={...f.snapshots.page2,comparison:{...f.snapshots.page2.comparison,toSha:c},right:c};f.notes=[{...f.notes[0],snapshotId:'page2',revision:2}];
 const records=buildComparisonCatalog(f).records;assert.equal(records.length,2);assert.equal(records.find(g=>g.record.comparison.toSha===b)?.notes.get('one')?.historical,true);
 f.notes[0].withdrawn=true;assert.equal(buildComparisonCatalog(f).records.length,0);
});
test('catalog excludes other scopes and distinguishes modes and instance ownership',()=>{
 const f=fixture();const id=buildComparisonCatalog(f).records[0].record.id;
 f.snapshots.page1.instance='second';assert.notEqual(buildComparisonCatalog(f).records[0].record.id,id);
 f.snapshots.page1.scope='commit';assert.equal(buildComparisonCatalog(f).records.length,0);
 const g=fixture();g.snapshots.page2.comparison={...g.snapshots.page2.comparison,mode:'contribution',mergeBase:a} as any;g.notes.push({...g.notes[0],id:'two',snapshotId:'page2'});assert.equal(buildComparisonCatalog(g).records.length,2);
});
test('pending count follows user feedback, deletion and read-only history; elapsed time is not history evidence',()=>{
 const f=fixture();f.feedback.push({id:'one',revision:1,action:'question',text:'Why?',at:'now'});assert.equal(buildComparisonCatalog(f).records[0].record.pendingCount,1);
 f.feedback[0].deleted=true;const record=buildComparisonCatalog(f).records[0].record;assert.equal(record.pendingCount,0);
 assert.equal(comparisonRecordState(record,[]),'fixed');assert.equal(comparisonRecordState(record,[{name:'origin/main',shortName:'origin/main',sha:c}]),'historical');
 const request=comparisonExplanationRequest('sample.json','work','repo',record.comparison);assert.match(request,new RegExp(a));assert.match(request, /fromLabel/);assert.match(request,/scope/);
});

test('legacy comparison metadata without branch names still lists fixed SHAs',()=>{
 const f=fixture();delete (f.snapshots.page1 as any).comparison;
 const record=buildComparisonCatalog(f).records[0].record;assert.equal(record.comparison.fromRef,a);assert.equal(record.comparison.toRef,b);
 assert.equal(comparisonRecordState(record,[]),'fixed');
});
