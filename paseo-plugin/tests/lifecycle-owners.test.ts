import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceRecords} from '../server/backend/workspace-records.ts';
import {WorkspaceRemoval} from '../server/backend/workspace-removal.ts';
import type {Config} from '../server/backend/config.ts';
import {createReviewLifecycle} from '../server/review/lifecycle.ts';
import {reviewInfrastructure} from '../server/review/infrastructure.ts';
import {reviewPreferencesSchema} from '../shared/agent-review.ts';

test('record persistence keeps unknown/history fields and journals before manifest failure',()=>{
 const writes:Array<{path:string;value:any}>=[];
 const records=new WorkspaceRecords({config:()=>({recordsRoot:'/state/records'} as Config),files:{existsSync:()=>true},storage:{readJson:()=>({}),now:()=> '2026-01-01T00:00:00.000Z',atomicJson:(path,value)=>{writes.push({path,value});if(path.endsWith('manifest.json'))throw Error('manifest unavailable');}}});
 const record={schemaVersion:1,id:'sample',treePath:'/trees/sample',repositories:[],history:[{event:'created'}],extension:{owner:'caller'}};
 assert.throws(()=>records.save(record),/manifest unavailable/);
 assert.equal(writes[0].path,'/state/records/sample.json');assert.equal(writes.length,2);
 assert.deepEqual(writes[0].value.history,record.history);assert.deepEqual(writes[0].value.extension,record.extension);assert.equal(writes[0].value.updatedAt,'2026-01-01T00:00:00.000Z');assert.equal('updatedAt' in record,false);
});
test('removal owner retains pending-operation identity and restoration refuses unfinished deletion',async()=>{
 const record:any={id:'sample',managed:true,state:'active',treePath:'/trees/sample'};const saved:any[]=[];
 const removal=new WorkspaceRemoval({directory:{get:()=>record},records:{save:value=>{saved.push({...value});return value;}},files:{existsSync:()=>true},storage:{now:()=> '2026-01-01T00:00:00.000Z'}});
 await removal.remove({workspaceId:'sample',activeTasks:[{id:'running'}]});
 assert.equal(saved[0].state,'deletion_pending');assert.equal(saved[0].deletion.blocksNewTasks,true);
 record.permanentDeletion={status:'in_progress'};
 assert.throws(()=>removal.restore({workspaceId:'sample'}),/retried before restoring/);assert.equal(saved.length,1);
});
test('review assemblies isolate runtime state and use injected session identity and clock',()=>{
 const dependencies={...reviewInfrastructure,identity:{randomUUID:()=> '00000000-0000-4000-8000-000000000001' as const},clock:{now:()=> '2026-01-01T00:00:00.000Z',millis:()=> 1767225600000},storage:{...reviewInfrastructure.storage,getAgentBinding:()=>null}};
 const first=createReviewLifecycle(dependencies),second=createReviewLifecycle(dependencies);
 first.recovery.coordinatorGeneration++;
 assert.equal(second.recovery.coordinatorGeneration,0);
 const session=first.sessions.newSession({workspaceId:'sample',projectConfig:'/project/config.json',executionAgentId:null,preferences:reviewPreferencesSchema.parse({}),handoff:undefined});
 assert.equal(session.id,'00000000-0000-4000-8000-000000000001');assert.equal(session.updatedAt,'2026-01-01T00:00:00.000Z');assert.equal(session.status,'waiting_execution');
});
