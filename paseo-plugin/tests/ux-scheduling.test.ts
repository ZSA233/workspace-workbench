import test from 'node:test';
import assert from 'node:assert/strict';
test('unchanged decorations and directory pages preserve snapshots and structure revisions',async()=>{
  const {FilesTreeState}=await import('../client/files-tree-store.ts');
  const tree=new FilesTreeState('ux-same','w'),page={workspaceId:'w',instance:'one',path:'',version:'v',entries:[]};
  await tree.load('',async()=>page);const revision=tree.structureRevision,entries=tree.pages.get('')!.entries;let notified=0;
  tree.subscribe(()=>notified++);await tree.load('',async()=>({...page,version:'v2'}));assert.equal(notified,0);assert.equal(tree.structureRevision,revision);assert.equal(tree.pages.get('')!.entries,entries);
  const decorations=async()=>({workspaceId:'w',instance:'one',entries:[{path:'',state:'ready'}],freshness:'fresh',observedAt:String(Date.now()),issues:[]});
  await tree.decorations.refresh([''],decorations);const first=notified;await tree.decorations.refresh([''],decorations);assert.equal(notified,first);assert.equal(tree.structureRevision,revision);
});

test('hidden idle and user-blocked transfers stop polling; foreground resumes one validation',async()=>{
  const {FileTransferStore}=await import('../client/files-store.ts');let reads=0;
  const store=new FileTransferStore('hidden-test'),rpc=async()=>{reads++;return {tasks:[],temporaryBytes:0};};
  let detach=store.bind(rpc,{foreground:false});await Promise.resolve();assert.equal(reads,0);assert.equal((store as any).timer,undefined);detach();
  detach=store.bind(rpc,{foreground:true});await store.poll();assert.equal(reads,1);assert.ok((store as any).timer);detach();
  detach=store.bind(rpc,{foreground:false});await Promise.resolve();assert.equal(reads,1);assert.equal((store as any).timer?._destroyed ?? true,true);detach();
});

test('prepared sorting waits for top and idle selection, and a late response cannot move rows under a gesture',async()=>{
  const {FilesTreeState}=await import('../client/files-tree-store.ts');const tree=new FilesTreeState('sort-late','w');tree.sortedListing=true;
  const file=(name:string)=>({path:name,name,kind:'file',size:1,modifiedAt:1,version:'v',protected:false,repository:false});
  const page={workspaceId:'w',instance:'one',path:'',version:'v',entries:[file('b'),file('a')],order:'native',snapshotId:'native',sortState:'preparing'};
  await tree.load('',async()=>page);let finish!:(value:any)=>void;
  const pending=tree.load('',()=>new Promise(resolve=>finish=resolve));tree.selected.add('b');tree.scroll=99;
  finish({...page,order:'sorted',entries:[file('a'),file('b')],snapshotId:'sorted',sortState:'ready'});await pending;
  assert.equal(tree.pages.get('')!.entries[0].name,'b');assert.ok(tree.selected.has('b'));assert.equal(tree.scroll,99);
  tree.selected.clear();tree.scroll=0;await tree.applySorted(async()=>({...page,order:'sorted',entries:[file('a'),file('b')],snapshotId:'sorted',sortState:'ready'}));assert.equal(tree.pages.get('')!.entries[0].name,'a');
});

test('ordinary transfer progress publishes at most every 200ms while pause is immediate',async t=>{
  const {FileTransferStore}=await import('../client/files-store.ts');
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const store=new FileTransferStore('progress-rate') as any;let notifications=0;store.subscribe(()=>notifications++);
  const task:any={id:'progress',direction:'upload',workspaceId:'w',instance:'one',workspaceName:'W',name:'bytes',path:'',state:'active',size:100,offset:0,createdAt:1,updatedAt:1};
  store.accept({...task});for(let offset=1;offset<=50;offset++)store.accept({...task,offset,updatedAt:offset+1});assert.equal(notifications,1);
  t.mock.timers.tick(199);assert.equal(notifications,1);t.mock.timers.tick(1);assert.equal(notifications,2);assert.equal(store.getSnapshot().tasks[0].offset,50);
  store.accept({...task,state:'paused',offset:50,updatedAt:100});assert.equal(notifications,3);assert.equal(store.getSnapshot().tasks[0].state,'paused');
});
