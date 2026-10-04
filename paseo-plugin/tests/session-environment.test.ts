import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,statSync,rmSync,mkdtempSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {loadConfig} from '../server/backend/config.ts';
import {Service} from '../server/backend/service.ts';
import {resolveRuntimeDeclarations} from '../server/backend/runtime-declarations.ts';
import {runtimeEnvironment,cacheExecutionConfig} from '../server/session-environment.ts';
import {sessionOverrides,publishSessionEnvironment} from '../server/session-environment.ts';
import {symlinkSync} from 'node:fs';
import {registerAgentIntegration} from '../server/agent-integration.ts';
import {closeBackends} from '../server/backend-manager.ts';
import {EventEmitter} from 'node:events';

function fixture(extra:any) { const root=mkdtempSync(join(tmpdir(),'wb-session-env-')); mkdirSync(join(root,'one')); for(const args of [['init','-q'],['config','user.email','test@example.invalid'],['config','user.name','Test']])execFileSync('git',['-C',join(root,'one'),...args]); writeFileSync(join(root,'one/file'),'initial');execFileSync('git',['-C',join(root,'one'),'add','.']);execFileSync('git',['-C',join(root,'one'),'commit','-qm','initial']);const path=join(root,'project.json');writeFileSync(path,JSON.stringify({sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'one',path:'one'}],management:{enabled:true},discovery:{mode:'manual'},...extra}));return {root,config:loadConfig(path)}; }

test('project declarations override legacy versions and project caches survive workspace changes',async()=>{
 const f=fixture({cache:{scope:'project'},toolchain:{mode:'system',repositories:{one:{go:'1.25'}}}}),s=new Service(f.config);
 try{
  const a=await s.handle('workspace.create',{name:'alpha',repositories:['one']}),b=await s.handle('workspace.create',{name:'beta',repositories:['one']});
  for(const w of [a,b])writeFileSync(join(w.repositories[0].worktreePath,'mise.toml'),'[tools]\ngo="1.27.1"\n');
  const parsed=await resolveRuntimeDeclarations(f.config,a);assert.equal(parsed.config.toolchain.repositories.one.go,'1.27.1');assert.deepEqual(parsed.sources.one.overrides,['go']);
  const ea=await s.handle('workspace.environment',{workspaceId:a.id,prepare:false}),eb=await s.handle('workspace.environment',{workspaceId:b.id,prepare:false});
  assert.equal(ea.environment.variables.GOCACHE,eb.environment.variables.GOCACHE);assert.equal(ea.environment.variables.GOMODCACHE,eb.environment.variables.GOMODCACHE);
  assert.equal(ea.environment.variables.UV_CACHE_DIR,eb.environment.variables.UV_CACHE_DIR);
  assert.ok(ea.environment.variables.UV_CACHE_DIR.startsWith(ea.cache.root));
  assert.equal(runtimeEnvironment(ea,{UV_CACHE_DIR:'/explicit/uv'}).UV_CACHE_DIR,'/explicit/uv');
  assert.equal(ea.state,'preparing');assert.ok(ea.environment.variables.WORKBENCH_ENVIRONMENT_FILE);
  assert.equal(runtimeEnvironment(ea,{GOCACHE:'/explicit'}).GOCACHE,'/explicit');
  writeFileSync(join(a.repositories[0].worktreePath,'mise.toml'),'[tools]\ngo="1.27.2"\n');
  const before=readFileSync(ea.environment.variables.WORKBENCH_ENVIRONMENT_FILE,'utf8');
  const changed=await s.handle('workspace.environment',{workspaceId:a.id,prepare:false});assert.notEqual(changed.configIdentity,ea.configIdentity);
  assert.notEqual(changed.snapshotId,ea.snapshotId);
  assert.notEqual(changed.environment.variables.WORKBENCH_ENVIRONMENT_FILE,ea.environment.variables.WORKBENCH_ENVIRONMENT_FILE);
  assert.equal(readFileSync(ea.environment.variables.WORKBENCH_ENVIRONMENT_FILE,'utf8'),before);
  const path=changed.environment.variables.WORKBENCH_ENVIRONMENT_FILE,mtime=statSync(path).mtimeMs;
  const again=await s.handle('workspace.environment',{workspaceId:a.id,prepare:false});assert.equal(again.snapshotId,changed.snapshotId);assert.equal(statSync(path).mtimeMs,mtime);
  const inherited=await publishSessionEnvironment(f.config.stateRoot,ea);const bound=JSON.parse(readFileSync(inherited.WORKBENCH_ENVIRONMENT_FILE,"utf8"));assert.equal(runtimeEnvironment(changed,sessionOverrides(inherited,bound,changed)).GOCACHE,changed.environment.variables.GOCACHE);
 }finally{await s.close();rmSync(f.root,{recursive:true,force:true});}
});

test('resume refreshes injected defaults and retains caller overrides', () => {
 const old={snapshotId:'old-snapshot',schemaVersion:'workspace.workbench.environment/v1',projectId:'sample',binding:{defaultKeys:['GOCACHE'],defaultPath:'/tools/old:'+(process.env.PATH || '')},environment:{pathEntries:['/tools/old'],variables:{GOCACHE:'/cache/old'}}};
 const current={...old,environment:{pathEntries:['/tools/new'],variables:{GOCACHE:'/cache/new'}}};
 const inherited=runtimeEnvironment(old,{PIP_CACHE_DIR:'/caller/pip'});
 const updated=runtimeEnvironment(current,sessionOverrides(inherited,old,current));
 assert.equal(updated.GOCACHE,'/cache/new');assert.match(updated.PATH,/^\/tools\/new:/);assert.equal(updated.PIP_CACHE_DIR,'/caller/pip');
 assert.equal(runtimeEnvironment(current,sessionOverrides({...inherited,GOCACHE:'/caller/go'},old,current)).GOCACHE,'/caller/go');
 assert.deepEqual(sessionOverrides(inherited,old,{...current,projectId:'other'}),inherited);
});

test('bounded declarations reject links and version expressions, and expose unmanaged tools', async()=>{
 const f=fixture({}),s=new Service(f.config);
 try{
  const w=await s.handle('workspace.create',{name:'sample',repositories:['one']}),path=join(w.repositories[0].worktreePath,'mise.toml');
  writeFileSync(path,'[tools]\ngo="latest"\n');await assert.rejects(resolveRuntimeDeclarations(f.config,w),/numeric version/);
  rmSync(path);symlinkSync('/outside/mise.toml',path);await assert.rejects(resolveRuntimeDeclarations(f.config,w),/bounded regular file/);
  rmSync(path);writeFileSync(path,'[tools]\ncustom="latest"\nnode="22"\n');
  const result=await resolveRuntimeDeclarations(f.config,w);assert.deepEqual(result.sources.one.unmanaged,['custom']);assert.equal(result.config.toolchain.repositories.one.node,'22');
  await assert.rejects(s.handle('workspace.environment',{workspaceId:w.id,repositoryId:'missing',prepare:false}),/repository/);
 }finally{await s.close();rmSync(f.root,{recursive:true,force:true});}
});

test('automatic preparation deduplicates and never replays a failed operation',async()=>{
 const f=fixture({toolchain:{mode:'system',repositories:{one:{go:'1.99'}}}}),s=new Service(f.config);
 let executions=0;
 // Exercise durable failure/replay rules without scanning whatever tool
 // versions happen to be installed on the developer or CI machine.
 (s.preparations as any).workerFactory=()=>{
  executions++;
  const worker=new EventEmitter();
  Object.assign(worker,{postMessage(){},terminate(){return Promise.resolve(0);}});
  queueMicrotask(()=>worker.emit('message',{result:{status:'prepare_failed',issues:[{code:'toolchain_unavailable',message:'Controlled preparation failure'}]}}));
  return worker;
 };
 try{
  const w=await s.handle('workspace.create',{name:'sample',repositories:['one']});
  const a=await s.handle('workspace.environment',{workspaceId:w.id}),b=await s.handle('workspace.environment',{workspaceId:w.id});
  assert.equal(a.preparation.operationId,b.preparation.operationId);
  const terminal=await s.preparations.wait(a.preparation.operationId,30000);assert.equal(terminal.state,'failed');
  const c=await s.handle('workspace.environment',{workspaceId:w.id});assert.equal(c.preparation.operationId,terminal.operationId);assert.equal(c.state,'needs_attention');
  assert.equal(executions,1);
 }finally{await s.close();rmSync(f.root,{recursive:true,force:true});}
});

test('ordinary Agent hooks reuse the ready child environment without exclusive workspace binding', async()=>{
 const f=fixture({cache:{scope:'project'},toolchain:{mode:'system',runtimePaths:[process.execPath],repositories:{one:{node:process.version.slice(1)}}}}),s=new Service(f.config);
 let cleanup:undefined|(()=>void);const previous=process.env.WORKSPACE_WORKBENCH_CONFIG, previousRoot=process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT;
 try{
  const w=await s.handle('workspace.create',{name:'sample',repositories:['one']});
  const task=await s.handle('workspace.prepare.task',{action:'start',workspaceId:w.id,repositories:['one'],requestId:'ready'});
  assert.equal((await s.preparations.wait(task.operationId,30000)).state,'ready');
  const cwd=w.repositories[0].worktreePath,ready=await s.handle('workspace.environment',{cwd,prepare:false});await s.close();
  process.env.WORKSPACE_WORKBENCH_CONFIG=join(f.root,'project.json');process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT=process.cwd();
  const hooks=new Map<string,any>();cleanup=registerAgentIntegration({before:(name:any,hook:any)=>{hooks.set(name,hook);return ()=>{};},on:()=>()=>{},handle:()=>{}} as any);
  const actual=await hooks.get('agent.create')({request:{config:{provider:'codex',cwd},env:{GOCACHE:'/caller/cache'}}});
  assert.equal(actual.env.NPM_CONFIG_CACHE,runtimeEnvironment(ready).NPM_CONFIG_CACHE);assert.equal(actual.env.GOCACHE,'/caller/cache');assert.ok(actual.env.PATH.startsWith(ready.environment.pathEntries.join(':')));
  assert.ok(actual.config.providerOptions.sandbox_workspace_write.writable_roots.includes(ready.cache.root));
  assert.ok(!actual.config.providerOptions.sandbox_workspace_write.writable_roots.includes('/caller/cache'));
  const opened=await hooks.get('agent.session_open')({request:{agentId:'same-session',cwd,purpose:'interactive',env:actual.env}});
  assert.equal(opened.env.NPM_CONFIG_CACHE,actual.env.NPM_CONFIG_CACHE);assert.equal(Object.hasOwn(actual.env,'WORKBENCH_WORKER_WORKSPACE'),false);
 }finally{cleanup?.();await closeBackends();await s.close();if(previous===undefined)delete process.env.WORKSPACE_WORKBENCH_CONFIG;else process.env.WORKSPACE_WORKBENCH_CONFIG=previous;if(previousRoot===undefined)delete process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT;else process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT=previousRoot;rmSync(f.root,{recursive:true,force:true});}
});

test('cache roots preserve permission mode, planning state and caller roots',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-cache-config-')));
 try{
  const cwd=join(root,'source'),cache=join(root,'cache'),install=join(root,'install');for(const p of [cwd,cache,install])mkdirSync(p);
  const config={provider:'codex',cwd,modeId:'auto',featureValues:{plan_mode:true},providerOptions:{approval_policy:'on-request',sandbox_workspace_write:{network_access:false,writable_roots:['/caller/root']}}};
  const value={cache:{root:cache},environment:{variables:{UV_CACHE_DIR:join(cache,'uv'),MISE_DATA_DIR:install}}};
  const actual=await cacheExecutionConfig(config,value);
  assert.deepEqual(actual.providerOptions.sandbox_workspace_write.writable_roots,['/caller/root',cache]);
  assert.equal(actual.providerOptions.approval_policy,'on-request');assert.equal(actual.providerOptions.sandbox_workspace_write.network_access,false);
  assert.deepEqual(actual.featureValues,config.featureValues);assert.equal(actual.modeId,config.modeId);
  assert.deepEqual(await cacheExecutionConfig({...config,provider:'claude'},value),{...config,provider:'claude'});
  for(const sandbox_mode of ['read-only','danger-full-access']){const pinned={...config,providerOptions:{...config.providerOptions,sandbox_mode}};assert.deepEqual(await cacheExecutionConfig(pinned,value),pinned);}
  assert.deepEqual(await cacheExecutionConfig(config,{...value,cache:{root}}),config,'an ancestor of source is never granted');
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('single repository environment ignores unrelated declarations and mixed versions never concatenate binaries',async()=>{
 const f=fixture({toolchain:{mode:'system',repositories:{one:{go:'1.25'}}},repositories:[{id:'one',path:'one'},{id:'two',path:'two'}]});
 execFileSync('git',['clone','-q',join(f.root,'one'),join(f.root,'two')]);const s=new Service(f.config);
 try {
  const w=await s.handle('workspace.create',{name:'sample',repositories:['one','two']}),one=w.repositories.find((repo:any)=>repo.id==='one'),two=w.repositories.find((repo:any)=>repo.id==='two');
  writeFileSync(join(one.worktreePath,'mise.toml'),'[tools]\nnode="22"\n');writeFileSync(join(two.worktreePath,'mise.toml'),'[tools]\ngo="latest"\n');
  const scoped=await s.handle('workspace.environment',{workspaceId:w.id,repositoryId:'one',prepare:false});assert.equal(scoped.toolchain.requirements.go,undefined);assert.ok(scoped.toolchain.requirements.node);
  writeFileSync(join(one.worktreePath,'mise.toml'),'[tools]\ngo="1.27.1"\n');writeFileSync(join(two.worktreePath,'mise.toml'),'[tools]\ngo="1.26.4"\n');
  const mixed=await s.handle('workspace.environment',{workspaceId:w.id,prepare:false});assert.deepEqual(mixed.toolchain.requirements.go.requested.slice().sort(),['1.26.4','1.27.1']);assert.equal(mixed.versions.go,undefined);assert.ok(mixed.environment.pathEntries.every((path:string)=>path.endsWith('/shims')));
 }finally{await s.close();rmSync(f.root,{recursive:true,force:true});}
});

test('legacy mixed-version summary falls back to directory-aware shims', () => {
 const value={toolchain:{requirements:{go:{requested:['1.26','1.27']}},environment:{pathEntries:['/older/bin','/newer/bin'],variables:{MISE_DATA_DIR:'/shared/mise'}}}};
 const env=runtimeEnvironment(value);assert.ok(env.PATH.startsWith('/shared/mise/shims:'));assert.ok(!env.PATH.includes('/older/bin'));assert.ok(!env.PATH.includes('/newer/bin'));
});


test('legacy mutable descriptions preserve unknown caller values',()=>{
 const previous={schemaVersion:'workspace.workbench.environment/v1',projectId:'sample',environment:{variables:{GOCACHE:'/same'}}};
 assert.deepEqual(sessionOverrides({GOCACHE:'/same'},previous,previous),{GOCACHE:'/same'});
});

test('explicit overrides equal to old defaults retain ownership across version changes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-binding-ownership-'));
 try {
  const value={schemaVersion:'workspace.workbench.environment/v1',snapshotId:'source',projectId:'example',environment:{pathEntries:[],variables:{GOCACHE:'/cache/old',GOMODCACHE:'/modules/old'}}};
  const env=await publishSessionEnvironment(root,value,{GOCACHE:'/cache/old',PRIVATE_TOKEN:'must-not-be-persisted'});
  const text=readFileSync(env.WORKBENCH_ENVIRONMENT_FILE,'utf8'),saved=JSON.parse(text);
  assert.ok(!text.includes('must-not-be-persisted'));assert.ok(!text.includes('PRIVATE_TOKEN'));
  const next={...value,environment:{pathEntries:[],variables:{GOCACHE:'/cache/new',GOMODCACHE:'/modules/new'}}};
  const actual=runtimeEnvironment(next,sessionOverrides(env,saved,next));
  assert.equal(actual.GOCACHE,'/cache/old');assert.equal(actual.GOMODCACHE,'/modules/new');
  assert.equal(readFileSync(env.WORKBENCH_ENVIRONMENT_FILE,'utf8'),text);
 }finally{rmSync(root,{recursive:true,force:true});}
});
