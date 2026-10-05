import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withProject} from '../server/projects.ts';
import {readState,writeState} from '../server/orchestration-state.ts';
import {orchestrate} from '../server/orchestrator.ts';
import {workflowSubmitRequest} from '../shared/orchestration.ts';
import {readBundle,readBundleFile} from '../server/handoff-bundles.ts';
import {creationSource} from '../server/workspace-creator.ts';
import type {AgentContext} from '../server/agent-provider.ts';
async function fixture(run:(f:any)=>Promise<void>){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-light-'))),config=join(root,'project.json');
 writeFileSync(config,JSON.stringify({sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:root,repositories:[],agent:{provider:'paseo'},review:{mode:'off'}}));
 const old=process.env.WORKSPACE_WORKBENCH_CONFIG;process.env.WORKSPACE_WORKBENCH_CONFIG=config;
 let creates=0,exports=0;const sent:any[]=[],calls:any[]=[];
 const parent={id:'parent',cwd:root,title:'Fixture session',provider:'codex',model:'fixture',currentModeId:'auto',availableModes:[{id:'auto'}],pendingPermissions:[],features:[{id:'plan_mode',type:'toggle',value:false}]};
 let worker:any;
 const context:AgentContext={paseo:{agents:{ref:(id:string)=>({refresh:async()=>({agent:id==='parent'?parent:worker})}),list:async()=>({entries:worker?[{agent:worker}]:[],pageInfo:{hasMore:false}})},workspaces:{open:async()=>({id:'host-workspace',agents:{create:async(options:any)=>{creates++;worker={...parent,id:'worker',labels:options.labels,status:'idle',workspaceId:'host-workspace'};return{id:worker.id,current:()=>worker,send:async(text:string,options:any)=>{sent.push({text,options});if(f.drop)throw Error('Transport disconnected after dispatch');}};}}})}} as any,
 exportHistory:async()=>{exports++;return{attachment:{type:'text',text:'Latest requirement: amber. Earlier blue is rejected.'},itemCount:2};},
 query:async(input:any)=>{calls.push(input);if(input.method==='workspace.create' && f.gate)await f.gate;if(input.method==='workspace.list')return{ok:true,result:{capabilities:{agent:true,create:true}}};if(input.method==='workspace.detail')return{ok:true,result:{workspace:{sourceRoot:root},repositories:[{id:'repo',worktreePath:root,sourcePath:root,repoPath:'.'}]}};if(input.method==='workspace.runtime')return{ok:true,result:{managed:true,treePath:root,workspaceId:'sample',capabilities:{agent:true},repositories:[{id:'repo',worktreePath:root}]}};return{ok:true,result:{id:'sample'}};}};
 const progress=()=>readState<any>('workflow:parent:request');
 const f={root,config,context,sent,calls,drop:false,gate:undefined as Promise<void>|undefined,creates:()=>creates,exports:()=>exports,progress,
 submit:async(extra:any={})=>orchestrate('submit',workflowSubmitRequest.parse({requestId:'request',name:'sample',repositories:['repo'],task:'Implement the latest requirement',...extra}),'parent',context),
 settled:async()=>{const deadline=Date.now()+4000;while(!['handed-off','failed','handoff-blocked'].includes(progress()?.stage)){if(Date.now()>deadline)throw Error('handoff did not settle');await new Promise(resolve=>setImmediate(resolve));}return progress();}};
 try{await withProject({projectConfig:config},()=>run(f));}finally{if(old===undefined)delete process.env.WORKSPACE_WORKBENCH_CONFIG;else process.env.WORKSPACE_WORKBENCH_CONFIG=old;rmSync(root,{recursive:true,force:true});}
}
test('lightweight handoff freezes history and originals, sends images and exposes the actual receipt',async()=>fixture(async f=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xQAAAAASUVORK5CYII=','base64');
 writeFileSync(join(f.root,'reference.png'),png);writeFileSync(join(f.root,'spec.txt'),'FILE-ONLY requirement');
 const input={references:[{id:'image',path:'reference.png',kind:'image'},{id:'spec',path:'spec.txt'}]};
 let release!:()=>void;f.gate=new Promise<void>(resolve=>{release=resolve;});
 await f.submit(input);writeFileSync(join(f.root,'spec.txt'),'Changed after acceptance');f.context.exportHistory=async()=>{throw Error('must not recapture');};release();const result=await f.settled();assert.equal(result.stage,'handed-off');assert.equal(f.creates(),1);assert.equal(f.exports(),1);
 assert.match(f.sent[0].options.attachments[0].text,/amber/);assert.deepEqual(Buffer.from(f.sent[0].options.images[0].data,'base64'),png);
 assert.match(f.sent[0].text,/Historical directory names/);assert.equal(result.result.transfer.sources.length,2);
 const bundle=readBundle(result.bundle);assert.equal(readBundleFile(result.bundle,bundle.sources.find((s:any)=>s.id==='spec')!.file!).toString(),'FILE-ONLY requirement');
 writeFileSync(join(f.root,'spec.txt'),'later change');await f.submit(input);assert.equal(f.creates(),1);assert.equal(f.exports(),1);assert.equal(f.sent.length,1);
 assert.equal((await f.submit({...input,task:'different'})).ok,false);
 assert.equal(f.calls.find((c:any)=>c.method==='workspace.create').params.creator.agentId,'parent');
}));
test('unavailable history and missing declared files stop before Git creation or Agent dispatch',async()=>{
 for(const failure of ['history','file'])await fixture(async f=>{
  if(failure==='history')f.context.exportHistory=undefined;
  const response=await f.submit(failure==='file'?{originalPaths:['missing.txt']} : {});
  assert.equal(response.ok,false);const result={result:response};assert.equal(f.creates(),0);assert.equal(f.calls.some((c:any)=>c.method==='workspace.create'),false);
  assert.match(result.result.error.message,failure==='history'?/history_unavailable/:/required_materials_unavailable/);
 });
});
test('lost handoff response retains uncertain delivery and never automatically redelivers',async()=>fixture(async f=>{
 f.drop=true;await f.submit();const progress=await f.settled();assert.equal(progress.stage,'handoff-blocked');assert.equal(f.sent.length,1);
 await f.submit();assert.equal(f.sent.length,1);assert.equal(f.creates(),1);
}));
test('creator lookup uses saved token identity, tolerates missing identity and ignores revoked sources',async()=>fixture(async f=>{
 writeState('context:token',{agentId:'parent',cwd:f.root,title:'Saved session'});writeState('session:parent',{token:'token'});
 assert.equal(creationSource({token:'token'})?.agentId,'parent');assert.equal(creationSource({contextAgentId:'parent'})?.name,'Saved session');
 assert.equal(creationSource({token:'wrong',contextAgentId:'parent'}),undefined);
 writeState('context:token',{agentId:'parent',cwd:f.root,revoked:true});assert.equal(creationSource({token:'token'}),undefined);
}));
