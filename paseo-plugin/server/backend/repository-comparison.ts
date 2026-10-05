import { join } from 'node:path';
import { atomicJson, optionalJson, hash } from './storage.ts';
import { Git } from './git.ts';
import { WorkbenchError, stable, type Json } from './storage.ts';
import { count, fileJson, type Observation } from './observation.ts';
import { comparisonKey, type Comparison } from '../../shared/comparison.ts';

export async function resolveComparison(git: Git, input: Json): Promise<Comparison> {
  const fromRef = String(input.fromRef || ''), toRef = String(input.toRef || 'HEAD');
  if (!fromRef || fromRef.includes('\0') || toRef.includes('\0')) throw new WorkbenchError('comparison_invalid', 'Select both comparison endpoints');
  const mode = input.mode || 'endpoints';
  if (!['endpoints', 'contribution'].includes(mode)) throw new WorkbenchError('comparison_invalid', 'Unknown comparison mode');
  const [fromSha, toSha] = await Promise.all([git.commit(fromRef), git.commit(toRef)]);
  let mergeBase: string | null = null;
  if (mode === 'contribution') {
    const result = await git.run(['merge-base', '--all', fromSha, toSha], false);
    if (result.code > 1) throw new WorkbenchError('git_command_failed', result.stderr);
    const bases = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (bases.length !== 1) throw new WorkbenchError(bases.length ? 'comparison_multiple_bases' : 'comparison_unrelated', bases.length ? 'Multiple common ancestors; use endpoint comparison' : 'No common ancestor; use endpoint comparison');
    mergeBase = bases[0];
  }
  return { fromRef, toRef, fromSha, toSha, mode, mergeBase, leftSha: mergeBase || fromSha };
}

/** Stateless producers use the same bounded Git queue and observation cache. */
export async function compareRepository(observation: Observation, params: Json, signal?: AbortSignal): Promise<Json> {
  const {workspace, repo, path} = await observation.workspaces.observationRecords.request('context', {workspaceId: String(params.workspaceId || ''), repository: params.repoPath || params.repositoryId || ''});
  const git = new Git(path, observation.workspaces.config.gitTimeout, Date.now() + Math.min(30_000, observation.workspaces.config.observationTimeout), signal, true);
  if (await git.root() !== path) throw new WorkbenchError('repository_root_mismatch', 'Expected recorded repository root');
  const token = observation.scheduler.token(path, 'refs');
  const meta = {state: 'ready', observedAt: new Date().toISOString(), validationKey: `${path}#refs`, validationToken: token};
  if (params.action === 'refs') return {workspaceId: workspace.id, refs: await git.refs(), fetch:remoteFetchState(observation,path), observation: {...meta,...(remoteFetchState(observation,path).state==='running'?{readTask:{state:'running',nextPollMs:1000,deadline:remoteFetchState(observation,path).deadline}}:{})}};
  const comparison = await resolveComparison(git, params.comparison || {});
  const action = params.action || 'files';
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const key = `comparison:${stable([workspace.id, path, comparisonKey(comparison), action, params.side, offset])}`;
  const result = await observation.cache.read(key, key, async () => {
    const common = {workspaceId: workspace.id, repoPath: repo.repoPath, comparison};
    if (action === 'counts') {
      const values = (await git.text(['rev-list', '--left-right', '--count', `${comparison.fromSha}...${comparison.toSha}`])).split(/\s+/).map(Number);
      return {...common, fromOnly: values[0], toOnly: values[1]};
    }
    if (action === 'commits') {
      const range = params.side === 'from' ? `${comparison.toSha}..${comparison.fromSha}` : `${comparison.fromSha}..${comparison.toSha}`;
      const raw = await git.text(['log', '--topo-order', '--format=%H%x00%s', '--max-count=51', `--skip=${offset}`, range, '--']);
      const rows = raw.split('\n').filter(Boolean).map(line => {const [sha, subject] = line.split('\0'); return {sha, subject};});
      return {...common, commits: rows.slice(0,50), hasMore: rows.length > 50, offset};
    }
    if (!['files', 'statistics'].includes(action)) throw new WorkbenchError('comparison_invalid', 'Unknown comparison action');
    const files = (await git.files('compare', comparison.leftSha, comparison.toSha, false, action === 'files')).map(fileJson);
    return {...common, files, summary: count(files)};
  }, true, true, {workspaceId: workspace.id, repoPath: path});
  const immutable=[params.comparison?.fromRef,params.comparison?.toRef].every(value=>typeof value==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value));
  return {...result, comparison, observation: immutable?{state:'ready',observedAt:meta.observedAt,immutableIdentity:key}:meta};
}

const fetches = new WeakMap<Observation, Map<string, {promise:Promise<Json>; state:Json}>>();
export function remoteFetchState(observation: Observation, path: string) { const live=fetches.get(observation)?.get(path)?.state;if(live)return live;const saved=optionalJson(join(observation.workspaces.config.stateRoot,'comparison-fetch',`${hash(path)}.json`));return saved?.requestId ? saved.state==='running'?{...saved,state:'uncertain',error:'Previous fetch interrupted; reference needs verification'}:saved : {state:'idle',lastFetchedAt:null}; }
/** Explicit network operation; never automatically replayed by the bridge. */
export async function fetchComparisonRef(observation: Observation, params: Json): Promise<Json> {
  const {workspace, path} = await observation.workspaces.observationRecords.request('context', {workspaceId:String(params.workspaceId||''),repository:params.repoPath||''});
  let entries=fetches.get(observation); if(!entries){entries=new Map();fetches.set(observation,entries);}
  const previous=entries.get(path);
  if(previous?.state.state==='running') return previous.state;
  if(previous && previous.state.requestId===params.requestId) return previous.state;
  if(typeof params.requestId!=='string'||!params.requestId) throw new WorkbenchError('request_invalid','Request identity required');
  const ref=String(params.ref||'');
  const journal=join(observation.workspaces.config.stateRoot,'comparison-fetch',`${hash(path)}.json`);
  const requestJournal=join(observation.workspaces.config.stateRoot,'comparison-fetch',hash(path),`${hash(params.requestId)}.json`);
  const saved=optionalJson(journal), existing=optionalJson(requestJournal);
  if(existing?.requestId===params.requestId) return existing.state==='running'?{...existing,state:'uncertain',error:'Previous fetch was interrupted; verify the reference before retrying'}:existing;
  const state:Json={state:'running',deadline:Date.now()+30_000,requestId:params.requestId,ref,lastFetchedAt:previous?.state.lastFetchedAt||saved?.lastFetchedAt||null};
  atomicJson(requestJournal,state);atomicJson(journal,state);
  const promise=observation.workspaces.mutations.run(async()=>{
    const git=new Git(path,observation.workspaces.config.gitTimeout,state.deadline,undefined,true);
    if(await git.root()!==path) throw new WorkbenchError('repository_root_mismatch','Expected repository root');
    const refs=await git.refs();
    const selected=refs.find(item=>item.kind==='remote'&&(item.name===ref||item.shortName===ref));
    if(!selected) throw new WorkbenchError('remote_ref_required','Select an existing remote branch');
    const remotes=(await git.text(['remote'])).split('\n').filter(Boolean).sort((a,b)=>b.length-a.length);
    const remote=remotes.find(name=>selected.name.startsWith(`refs/remotes/${name}/`));
    if(!remote) throw new WorkbenchError('remote_ref_required','Remote not found');
    const branch=selected.name.slice(`refs/remotes/${remote}/`.length);
    if(branch==='HEAD'||(await git.run(['check-ref-format',`refs/heads/${branch}`],false)).code) throw new WorkbenchError('remote_ref_required','Select a branch, not remote HEAD');
    await git.run(['-c','credential.interactive=false','-c','core.askPass=','fetch','--no-tags','--no-prune','--no-recurse-submodules','--no-write-fetch-head','--',remote,`refs/heads/${branch}:${selected.name}`]);
    state.state='ready';state.lastFetchedAt=new Date().toISOString();atomicJson(requestJournal,state);atomicJson(journal,state);observation.scheduler.force(workspace.id);
    return state;
  }).catch(error=>{state.state=/timeout/.test(error?.code||'')?'uncertain':'failed';state.error=error instanceof Error?error.message:String(error);try{atomicJson(requestJournal,state);atomicJson(journal,state);}catch{}return state;});
  entries.set(path,{promise,state});return state;
}
