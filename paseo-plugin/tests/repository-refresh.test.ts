import { WorkbenchError } from '../server/backend/storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
import { Git } from '../server/backend/git.ts';
import { QueryClient } from '@tanstack/react-query';
import { createRepositoryRefreshClient, publishRefresh, repositoryQueryKeys } from '../client/repository-refresh-client.ts';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const git = (p: string, ...args: string[]) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-refresh-')));
  for (const name of ['one', 'two']) { const p = join(root, name); mkdirSync(p); git(p, 'init', '-q'); git(p, 'config', 'user.name', 'Test'); git(p, 'config', 'user.email', 'test@example.invalid'); writeFileSync(join(p, 'file'), 'old\n'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'initial'); }
  const path = join(root, 'project.json'); writeFileSync(path, JSON.stringify({ schemaVersion: 1, project: { id: 'refresh' }, sourceRoot: root, workspaceRoot: join(root, 'workspaces'), stateRoot: join(root, 'state'), repositories: ['one','two'].map(id => ({ id, path: id })), discovery: { mode: 'manual' }, management: { enabled: true } }));
  const service = new Service(loadConfig(path));
  return { root, service, config: path };
}
async function finish(service: Service, input: any) {
  let task = await service.handle('observer.refresh', input);
  for (let i = 0; i < 100 && ['queued','running'].includes(task.state); i++) { await sleep(20); task = await service.handle('observer.refresh', { action: 'status', requestId: input.requestId, taskId: task.taskId }); }
  assert.equal(task.state, 'ready', JSON.stringify(task)); return task;
}

test('selected refresh shares HEAD/status, publishes independent regions and does not inspect other repositories', async () => {
  const f = fixture(), original = Git.prototype.run, calls: { path: string; args: string[] }[] = [];
  Git.prototype.run = async function(...args) { calls.push({ path: this.path, args: args[0] }); return original.apply(this, args); };
  try {
    const id = (await f.service.handle('workspace.list', {})).workspaces[0].id;
    writeFileSync(join(f.root, 'one/file'), 'changed\n');
    const roster = await f.service.handle('workspace.detail', { workspaceId: id, mode: 'roster' });
    assert.equal(roster.repositories.length, 2); assert.equal(calls.length, 0);
    const task = await finish(f.service, { workspaceId: id, repoPath: 'one', scope: 'working', requestId: 'first', force: true });
    assert.equal(task.result.regions.summary.result.repository.dirty, true);
    assert.equal(task.result.regions.changes.result.files[0].path, 'file');
    assert.equal(task.result.regions.changes.result.summary.complete, false);
    assert.equal(task.result.regions.graph.result.nodes.length, 1);
    assert.ok(calls.every(call => call.path === join(f.root, 'one')));
    assert.ok(calls.every(call => !call.args.some(arg => arg.startsWith('--merged='))));
    const trace = task.result.trace;
    assert.equal(trace.filter((c: any) => c.command === 'status').length, 1);
    // Full statistics are independent, so inspect critical trace only.
    assert.ok(!trace.some((c: any) => c.command === 'numstat'));
    const before = f.service.observation.diffTasks.health().started;
    await finish(f.service, { workspaceId: id, repoPath: 'one', scope: 'working', requestId: 'second', force: true });
    assert.equal(f.service.observation.diffTasks.health().started, before + 1, 'manual refresh must not replay a completed task');
  } finally { await f.service.close(); Git.prototype.run = original; rmSync(f.root, { recursive: true, force: true }); }
});

test('a slow graph does not hold summary/changes and release cancels the owned request', async () => {
  const f = fixture(), original = Git.prototype.run;
  Git.prototype.run = async function(...args) {
    if (args[0][0] === 'log') await new Promise<void>((resolve, reject) => { if (this.signal?.aborted) reject(Error('cancelled')); else this.signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); });
    return original.apply(this, args);
  };
  try {
    const id = (await f.service.handle('workspace.list', {})).workspaces[0].id;
    let task = await f.service.handle('observer.refresh', { workspaceId: id, repoPath: 'one', scope: 'working', requestId: 'slow' });
    for (let i = 0; i < 50 && task.result?.regions?.summary?.state !== 'ready'; i++) { await sleep(20); task = await f.service.handle('observer.refresh', { action: 'status', requestId: 'slow', taskId: task.taskId }); }
    assert.equal(task.result.regions.summary.state, 'ready'); assert.notEqual(task.result.regions.graph.state, 'ready');
    await f.service.handle('observer.refresh', { action: 'release', requestId: 'slow', taskId: task.taskId });
  } finally { await f.service.close(); Git.prototype.run = original; rmSync(f.root, { recursive: true, force: true }); }
});

test('an indefinitely slow non-current repository does not hold the current refresh', async () => {
  const f = fixture(), original = Git.prototype.run;
  let blocked = false;
  Git.prototype.run = async function(...args) {
    if (this.path === join(f.root, 'two') && args[0][0] === 'status') {
      blocked = true;
      await new Promise<void>((resolve, reject) => {
        if (this.signal?.aborted) reject(Error('cancelled'));
        else this.signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      });
    }
    return original.apply(this, args);
  };
  try {
    const workspaceId = (await f.service.handle('workspace.list', {})).workspaces[0].id;
    const background = await f.service.handle('observer.refresh', { workspaceId, repoPath: 'two', scope: 'working', requestId: 'blocked-other', prefetch: true });
    assert.equal(blocked, true);
    const current = await finish(f.service, { workspaceId, repoPath: 'one', scope: 'working', requestId: 'visible-current', force: true });
    for (const region of Object.values(current.result.regions) as any[]) assert.equal(region.state, 'ready');
    const other = await f.service.handle('observer.refresh', { action: 'status', taskId: background.taskId, requestId: 'blocked-other' });
    assert.ok(['queued', 'running'].includes(other.state));
  } finally { await f.service.close(); Git.prototype.run = original; rmSync(f.root, { recursive: true, force: true }); }
});

test('persisted snapshots survive restart and are returned before delayed Git revalidation', async () => {
  const f = fixture(); let next: Service | undefined;
  try {
    const id = (await f.service.handle('workspace.list', {})).workspaces[0].id;
    await finish(f.service, { workspaceId: id, repoPath: 'one', scope: 'working', requestId: 'before' });
    await f.service.close(); next = new Service(loadConfig(f.config));
    const original = Git.prototype.run;
    let release!: () => void;
    const gitGate = new Promise<void>(resolve => { release = resolve; });
    Git.prototype.run = async function(...args) { await gitGate; return original.apply(this, args); };
    try {
      let task = await next.handle('observer.refresh', { workspaceId: id, repoPath: 'one', scope: 'working', requestId: 'after' });
      // Control acceptance can precede metadata hydration, especially after a
      // worker restart. Wait for retained data while Git stays explicitly blocked.
      for (let i = 0; i < 100 && !task.result?.regions?.graph?.result; i++) {
        await sleep(20);
        task = await next.handle('observer.refresh', { action: 'status', requestId: 'after', taskId: task.taskId });
      }
      assert.ok(task.result.regions.graph.result.nodes.length);
      assert.equal(task.result.regions.graph.state, 'queued');
      assert.ok(['queued', 'running'].includes(task.state));
    } finally { release(); await next.close(); next = undefined; Git.prototype.run = original; }
  } finally { await next?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('the shared UI job client returns partial regions and late results stay in their own repository cache', async () => {
  const reader = createRepositoryRefreshClient(), client = new QueryClient();
  const input = { workspaceId: 'w', repoPath: 'one', scope: 'working', historyMode: 'full', maxCommits: 50 };
  const result = await reader.readRefresh('one', input, async params => ({ ok: true, result: { protocol: 1, taskId: 't', requestId: params.requestId, generation: 'g', deadline: Date.now()+30000, state: 'running', result: { regions: { summary: { state: 'ready', result: { repository: { repoPath: 'one', head: 'a' } } } } } } }));
  assert.ok((result.result as any).observation.readTask);
  publishRefresh(client, 'p', input, result.result as any);
  assert.ok(client.getQueryData(repositoryQueryKeys('p', input).summary));
  assert.equal(client.getQueryData(repositoryQueryKeys('p', { ...input, repoPath: 'two' }).summary), undefined);
  client.clear();
});

test('manual refresh does not join a pre-change in-flight observation while the watcher token is unchanged', async () => {
  const f = fixture(), original = Git.prototype.run;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let block = true;
  Git.prototype.run = async function(...args) {
    const result = await original.apply(this, args);
    if (block && args[0][0] === 'log') { block = false; await gate; }
    return result;
  };
  try {
    const id = (await f.service.handle('workspace.list', {})).workspaces[0].id;
    const input = { workspaceId: id, repoPath: 'one', scope: 'working', historyMode: 'full' };
    const old = await f.service.handle('observer.refresh', { ...input, requestId: 'old', prefetch: true });
    writeFileSync(join(f.root, 'one/file'), 'new commit\n'); git(join(f.root, 'one'), 'add', 'file'); git(join(f.root, 'one'), 'commit', '-qm', 'new commit');
    const head = git(join(f.root, 'one'), 'rev-parse', 'HEAD');
    const current = await finish(f.service, { ...input, requestId: 'manual', force: true });
    assert.equal(current.result.regions.graph.result.head, head);
    assert.notEqual(current.taskId, old.taskId);
    release();
  } finally { release(); await f.service.close(); Git.prototype.run = original; rmSync(f.root, { recursive: true, force: true }); }
});

test('prewarmed branch snapshots are reused without another Git command', async () => {
  const f = fixture();
  try {
    const w = await f.service.handle('workspace.create', { name: 'warm', repositories: ['one'] });
    await f.service.observation.scheduler.register(w.id, w.repositories[0].worktreePath);
    const input = { workspaceId: w.id, repoPath: 'one', scope: 'branch', historyMode: 'branch' };
    await finish(f.service, { ...input, requestId: 'prepare', prefetch: true });
    const before = f.service.health().git.commands;
    const reused = await finish(f.service, { ...input, requestId: 'click' });
    assert.equal(reused.result.cacheHit, true);
    assert.equal(f.service.health().git.commands, before);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('successful group version validation reaches displayed leaf caches without changing content observation time', () => {
  const client = new QueryClient(), input = { workspaceId: 'w', repoPath: 'one', scope: 'working', historyMode: 'full', maxCommits: 50 };
  const result = { observation: { observedAt: '2026-09-27T00:00:00Z', validationKey: '/one#working', validationToken: '1' }, nodes: [] };
  publishRefresh(client, 'p', input, { regions: { graph: { state: 'ready', phase: 'cache', result } } });
  publishRefresh(client, 'p', input, { regions: { graph: { state: 'ready', phase: 'cache', result } }, observation: { validatedAt: '2026-09-27T01:00:00Z' } });
  const value = client.getQueryData<any>(repositoryQueryKeys('p', input).graph).result;
  assert.equal(value.observation.validatedAt, '2026-09-27T01:00:00Z'); assert.equal(value.observation.observedAt, result.observation.observedAt);
  client.clear();
});

test('a user joining queued prefetch promotes it into the reserved observation capacity without recomputation', async () => {
  const { gitQueue, gitIntent } = await import('../server/backend/git-scheduler.ts');
  const { DiffReadTasks } = await import('../server/backend/diff-read-tasks.ts');
  const tasks = new DiffReadTasks(); let release!: () => void; let executions = 0;
  const gate = new Promise<void>(r => { release = r; });
  const background = [gitQueue.run(() => gate, 'background'), gitQueue.run(() => gate, 'background')];
  try {
    const work = async (signal: AbortSignal, deadline: number) => { const priority = gitIntent(['status']); return gitQueue.run(async () => { executions++; return { value: 'ready' }; }, priority.intent, deadline, signal, priority.progress); };
    const queued = await tasks.start('refresh:promote', 'prefetch', work, 30000, 'same', 'background');
    assert.equal(queued.state, 'queued');
    const current = await tasks.start('refresh:promote', 'visible', work, 30000, 'same', 'observation');
    assert.equal(current.state, 'ready'); assert.equal(current.taskId, queued.taskId); assert.equal(executions, 1);
    assert.equal(gitQueue.health().byIntent.background, 2);
  } finally { release(); await Promise.all(background); await tasks.close(); }
});

test('basic observation completes without reading a graph or file diff', async () => {
  const f=fixture(), original=Git.prototype.run;
  const calls:string[]=[];
  Git.prototype.run=async function(...args) { calls.push(args[0][0]); if(['log','diff','diff-tree'].includes(args[0][0])) throw Error('heavy read forbidden'); return original.apply(this,args); };
  try {
    const id=(await f.service.handle('workspace.list',{})).workspaces[0].id;
    const task=await finish(f.service,{workspaceId:id,repoPath:'two',summaryOnly:true,requestId:'basic'});
    assert.deepEqual(Object.keys(task.result.regions),['summary']);
    assert.equal(task.result.regions.summary.state,'ready');
    assert.ok(!calls.includes('log'));assert.ok(!calls.includes('diff'));
  } finally {Git.prototype.run=original;await f.service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('cached summary rehydrates a new roster placeholder without another leaf update', () => {
  const client=new QueryClient(), input={workspaceId:'w',repoPath:'one',scope:'working',historyMode:'branch',maxCommits:50};
  const key=['workspace-workbench','p','workspace-detail','w'];
  const result={repository:{repoPath:'one',branch:'main',refState:'attached',observationPending:false},observation:{readStartedAt:10}};
  const refresh={regions:{summary:{state:'ready',phase:'cache',result}}};
  publishRefresh(client,'p',input,refresh);
  client.setQueryData(key,{ok:true,result:{repositories:[{repoPath:'one',branch:'',observationPending:true}]}});
  publishRefresh(client,'p',input,refresh);
  assert.equal((client.getQueryData<any>(key)).result.repositories[0].branch,'main');
  client.setQueryData(key,{ok:true,result:{repositories:[{repoPath:'one',branch:'new',readStartedAt:20}]}});
  publishRefresh(client,'p',input,refresh);
  assert.equal((client.getQueryData<any>(key)).result.repositories[0].branch,'new');client.clear();
});

test('twelve basic subscriptions complete independently of one blocked repository', async () => {
  const f=fixture(); await f.service.close();
  const {readFileSync}=await import('node:fs');
  const raw=JSON.parse(readFileSync(f.config,'utf8'));
  for(let index=2;index<12;index++) {const id=`repo-${index}`;execFileSync('git',['clone','-q','--shared',join(f.root,'one'),join(f.root,id)]);raw.repositories.push({id,path:id});}
  writeFileSync(f.config,JSON.stringify(raw));const service=new Service(loadConfig(f.config)),original=Git.prototype.run;
  Git.prototype.run=async function(...args){
    if(this.path===join(f.root,'one')&&args[0][0]==='status') await new Promise<never>((_,reject)=>{const cancel=()=>reject(Error('cancelled'));if(this.signal?.aborted)cancel();else this.signal?.addEventListener('abort',cancel,{once:true});});
    return original.apply(this,args);
  };
  try {
    const workspace=(await service.handle('workspace.list',{})).workspaces[0];
    const tasks=await Promise.all(raw.repositories.map((repo:any)=>service.handle('observer.refresh',{workspaceId:workspace.id,repoPath:repo.id,summaryOnly:true,prefetch:true,requestId:repo.id})));
    for(let index=1;index<tasks.length;index++) {
      let task=tasks[index];for(let n=0;n<150 && ['queued','running'].includes(task.state);n++){await sleep(20);task=await service.handle('observer.refresh',{action:'status',taskId:task.taskId,requestId:raw.repositories[index].id});}
      assert.equal(task.state,'ready');assert.equal(task.result.regions.summary.state,'ready');
    }
    const slow=await service.handle('observer.refresh',{action:'status',taskId:tasks[0].taskId,requestId:'one'});assert.ok(['queued','running'].includes(slow.state));
  } finally {await service.close();Git.prototype.run=original;rmSync(f.root,{recursive:true,force:true});}
});

test('an older summary repairs placeholders from the newest cached leaf, never its older result', () => {
  const client=new QueryClient(), input={workspaceId:'w',repoPath:'one',scope:'working',historyMode:'branch',maxCommits:50};
  const key=['workspace-workbench','p','workspace-detail','w'];
  client.setQueryData(repositoryQueryKeys('p',input).summary,{ok:true,result:{repository:{repoPath:'one',branch:'new'},observation:{readStartedAt:20}}});
  client.setQueryData(key,{ok:true,result:{repositories:[{repoPath:'one',branch:'',observationPending:true}]}});
  publishRefresh(client,'p',input,{regions:{summary:{state:'ready',phase:'late',result:{repository:{repoPath:'one',branch:'old'},observation:{readStartedAt:10}}}}});
  assert.equal(client.getQueryData<any>(key).result.repositories[0].branch,'new');client.clear();
});

test('a partial follow-up keeps the known dirty state and late rosters hydrate from leaf data', async () => {
  const {hydrateRepositorySummaries}=await import('../client/repository-refresh-client.ts');
  const client=new QueryClient(),input={workspaceId:'w',repoPath:'one',scope:'working',historyMode:'branch',maxCommits:50};
  const key=['workspace-workbench','p','workspace-detail','w'];
  const ready={repoPath:'one',branch:'main',head:'a',status:'clean',dirty:false,observationPending:false,issues:[]};
  client.setQueryData(key,{ok:true,result:{workspace:{id:'w'},repositories:[ready]}});
  publishRefresh(client,'p',input,{regions:{summary:{state:'ready',phase:'complete',result:{repository:ready,observation:{readStartedAt:10}}}}});
  publishRefresh(client,'p',input,{regions:{summary:{state:'running',phase:'status',result:{repository:{...ready,status:'unknown',dirty:null,observationPending:true},observation:{readStartedAt:20}}}}});
  assert.equal(client.getQueryData<any>(key).result.repositories[0].status,'clean');
  const restored=hydrateRepositorySummaries(client,'p',{workspace:{id:'w'},repositories:[{repoPath:'one',branch:'',dirty:null,observationPending:true}]});
  assert.equal(restored.repositories[0].branch,'main');assert.equal(restored.repositories[0].dirty,false);assert.equal(restored.repositories[0].observationPending,true);
  client.clear();
});

test('task-based regions distinguish unread, running, failed, and genuinely empty results', async () => {
  const {refreshRegionFeedback}=await import('../client/repository-refresh-client.ts');
  assert.deepEqual(refreshRegionFeedback(undefined,'graph',false),{loading:true,failed:false});
  const response=(state:string):any=>({ok:true,result:{regions:{graph:{state}}}});
  assert.deepEqual(refreshRegionFeedback(response('running'),'graph',false),{loading:true,failed:false});
  assert.deepEqual(refreshRegionFeedback(response('running'),'graph',true),{loading:false,failed:false});
  assert.deepEqual(refreshRegionFeedback(response('failed'),'graph',false),{loading:false,failed:true});
  assert.deepEqual(refreshRegionFeedback(response('ready'),'graph',true),{loading:false,failed:false});
  assert.deepEqual(refreshRegionFeedback(undefined,'changes',false,true),{loading:false,failed:true});
});

test('partial region failure is recoverable and never revalidates retained failed content', async()=>{
  const reader=createRepositoryRefreshClient(), input={workspaceId:'w',repoPath:'one',historyMode:'branch',maxCommits:50,scope:'working'};
  const calls:any[]=[];
  const rpc=async(params:any):Promise<any>=>{calls.push(params);return {ok:true,result:{protocol:1,generation:'g',taskId:'t',deadline:Date.now()+30000,state:'ready',result:{regions:{summary:{state:'ready',phase:'cache',result:{observation:{state:'ready'}}},graph:{state:'failed',phase:'git',error:{code:'git_timeout',message:'slow'},result:{nodes:['old'],observation:{readStartedAt:1}}}}}}};};
  const failed=await reader.readRefresh('one',input,rpc);
  assert.equal(failed.ok,false);assert.equal((failed.error?.details as any).recovery,'repository');
  const client=new QueryClient(),key=repositoryQueryKeys('p',input).graph;
  const prior={ok:true,result:{nodes:['kept'],observation:{readStartedAt:2}}};client.setQueryData(key,prior);
  publishRefresh(client,'p',input,failed.result as any);assert.deepEqual(client.getQueryData(key),prior);
  await reader.readRefresh('one',input,rpc);assert.notEqual(calls[0].requestId,calls[1].requestId);
  client.clear();
});

test('metadata stalls do not block refresh acceptance, status, or release',async()=>{
  const f=fixture(),records=f.service.workspaces.observationRecords;
  const original=records.request.bind(records);let unblock!:()=>void;
  const held=new Promise<void>(r=>unblock=r);
  records.request=async(...args:Parameters<typeof records.request>)=>{if(args[0]==='context')await held;return original(...args);};
  try{
    const start=Date.now();const task=await f.service.handle('observer.refresh',{workspaceId:'main',repoPath:'one',requestId:'held-context'});
    assert.ok(Date.now()-start<500);assert.ok(['queued','running'].includes(task.state));
    const at=Date.now();const status=await f.service.handle('observer.refresh',{action:'status',taskId:task.taskId,requestId:'held-context'});
    assert.ok(Date.now()-at<100);assert.equal(status.result.regions.graph.phase,'metadata');
    await f.service.handle('observer.refresh',{action:'release',taskId:task.taskId,requestId:'held-context'});
  }finally{unblock();await f.service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('expired client wait reconciles original task before replacing computation',async t=>{
  let now=100000;t.mock.method(Date,'now',()=>now);
  const reader=createRepositoryRefreshClient(),input={workspaceId:'w',repoPath:'one',historyMode:'branch',maxCommits:50,scope:'working'};
  const calls:any[]=[];let complete=false;
  const rpc=async(params:any):Promise<any>=>{calls.push(params);return {ok:true,result:{protocol:1,generation:'g',taskId:'original',deadline:130000,state:complete?'ready':'running',result:{regions:{graph:{state:complete?'ready':'running',phase:'git',result:complete?{nodes:['new']}:undefined}}}}};};
  await reader.readRefresh('one',input,rpc);now+=31000;
  const failed=await reader.readRefresh('one',input,rpc);assert.equal(failed.ok,false);assert.equal(calls.length,1);
  reader.retry('one'); // manual refresh must reconcile the same uncertain task too
  complete=true;const recovered=await reader.readRefresh('one',input,rpc);
  assert.equal(recovered.ok,true);assert.equal(calls[1].action,'status');assert.equal(calls[1].requestId,calls[0].requestId);assert.equal(calls[1].taskId,'original');
});

test('permanent region failure stays terminal until explicit retry',async()=>{
  const reader=createRepositoryRefreshClient(),input={workspaceId:'w',repoPath:'one',historyMode:'branch',maxCommits:50,scope:'working'};let calls=0;
  const rpc=async():Promise<any>=>{calls++;return {ok:true,result:{protocol:1,generation:'g',taskId:'t',deadline:Date.now()+30000,state:'failed',error:{code:'commit_missing',message:'missing'}}};};
  const first=await reader.readRefresh('one',input,rpc);assert.equal((first.error?.details as any).recovery,undefined);
  await reader.readRefresh('one',input,rpc);assert.equal(calls,1);
  reader.retry('one');await reader.readRefresh('one',input,rpc);assert.equal(calls,2);
});

test('failed forced graph check cannot be hidden by same-token cache during recovery',async()=>{
  const f=fixture(),original=Git.prototype.graph;let fail=false,reads=0;
  Git.prototype.graph=async function(...args){reads++;if(fail){throw new WorkbenchError('git_timeout','injected timeout');}return original.apply(this,args);};
  try{
    const input={workspaceId:'main',repoPath:'one',scope:'working',historyMode:'full'};
    // Initial watcher registration advances the source token. Complete it before
    // testing recovery with an unchanged version, independent of machine speed.
    await f.service.observation.scheduler.register(input.workspaceId, join(f.root, input.repoPath));
    await finish(f.service,{...input,requestId:'baseline',force:true});
    fail=true;const failed=await finish(f.service,{...input,requestId:'failure',force:true});
    assert.equal(failed.result.outcome,'partial-failure');assert.equal(failed.result.regions.graph.state,'failed');
    const before=reads;fail=false;
    const recovered=await finish(f.service,{...input,requestId:'recovery'});
    assert.equal(recovered.result.regions.graph.state,'ready');assert.ok(reads>before);
    assert.equal(recovered.result.regions.summary.phase,'cache');
  }finally{Git.prototype.graph=original;await f.service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('task failure during metadata does not leave queued regions loading forever',async()=>{
  const {refreshRegionFeedback}=await import('../client/repository-refresh-client.ts');
  const response:any={ok:false,error:{code:'observer_refresh_timeout',message:'expired'},result:{regions:{graph:{state:'queued',phase:'metadata'},changes:{state:'ready',phase:'cache'}}}};
  assert.deepEqual(refreshRegionFeedback(response,'graph',false),{failed:true,loading:false});
  assert.deepEqual(refreshRegionFeedback(response,'changes',true),{failed:false,loading:false});
});
