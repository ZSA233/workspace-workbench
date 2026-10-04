import { relative, isAbsolute } from 'node:path';
import { observeRuntime } from './runtime-observation.ts';
import { publishEnvironmentSnapshot } from './environment-snapshots.ts';
import { resolveRuntimeDeclarations } from './runtime-declarations.ts';
import { canonicalAsync, hash, stable, WorkbenchError, type Json } from './storage.ts';
import type { Service } from './service.ts';

/** Public environment description; lifecycle records remain private. */
export async function sessionEnvironment(service: Service, params: Json, signal: AbortSignal) {
  let id = String(params.workspaceId || '');
  if (!id && params.cwd) {
    const match = await service.workspaces.observationRecords.request('identify', {directory:String(params.cwd)});
    if (!match.matched) throw new WorkbenchError('workspace_not_found', 'Directory is not a registered workspace');
    id = match.workspaceId;
  }
  const workspace = await service.workspaces.observationRecords.request('get', {workspaceId:id});
  if (workspace.state !== 'active') throw new WorkbenchError('workspace_state_invalid', 'Workspace is not active');
  const cwd = await canonicalAsync(params.cwd || workspace.treePath || workspace.sourceRoot);
  const contains = (path:string,root:string) => {const part=relative(root,path);return !part || part !== '..' && !part.startsWith('../') && !isAbsolute(part);};
  if (workspace.managed && !contains(cwd, await canonicalAsync(workspace.treePath))) throw new WorkbenchError('path_invalid','Session directory is outside workspace');
  const aliases = params.repositories || (params.repositoryId ? [params.repositoryId] : null);
  if (aliases && (!Array.isArray(aliases) || !aliases.length || aliases.length > 256))
    throw new WorkbenchError('request_invalid', 'Expected a bounded repository list');
  const selected = aliases
    ? [...new Set<string>(aliases.map((id: string) => service.workspaces.repository(workspace, id).id))]
      .map(id => workspace.repositories.find((repo: Json) => repo.id === id))
    : workspace.repositories.filter((repo: Json) => contains(cwd, repo.worktreePath || repo.sourcePath));
  const scoped = { ...workspace, repositories: selected.length ? selected : workspace.repositories };
  const resolved = await resolveRuntimeDeclarations(service.config, scoped, signal);
  const observed = await observeRuntime(resolved.config, scoped, params.prepare !== false, signal);
  const { toolchain } = observed;
  let preparation;
  const issues: Json[] = [];
  const missing = scoped.repositories.filter((repo:Json) => Object.keys(resolved.config.toolchain.repositories[repo.id] || {}).length && toolchain.preparedRepositories[repo.id]?.status !== 'ready').map((repo:Json)=>repo.id);
  if(signal.aborted || Date.now() >= (params.environmentDeadline || Infinity))throw new WorkbenchError('observer_timeout','Environment observation expired');
  if (params.prepare !== false && missing.length && workspace.managed) {
    // Durable task identity is tied to declared scope, never to UI retries.
    try { preparation = await service.workspaces.mutations.run(() => { if(signal.aborted || Date.now() >= params.environmentDeadline)throw new WorkbenchError('observer_timeout','Environment preparation admission expired'); return service.preparations.request({action:'start',workspaceId:id,repositories:missing,requestId:`session:${hash(id+resolved.identity+missing.join(','))}`}); }); }
    catch(error) { if(error instanceof WorkbenchError && error.code === 'operation_conflict') { preparation=await service.preparations.request({action:'status',workspaceId:id}); issues.push({code:'preparation_scope_busy',message:'Another preparation scope is active'}); } else throw error; }
  }
  const snapshot = await publishEnvironmentSnapshot(service.config.stateRoot, {
    schemaVersion:'workspace.workbench.environment/v1', projectId:service.config.projectId,workspaceId:id,cwd,
    configIdentity:resolved.identity, preparedIdentity:hash(stable({versions:observed.versions,paths:observed.pathEntries})),
    declarations:resolved.sources,versions:observed.versions,cache:observed.cache,toolchain,
    state:missing.length ? 'preparing':'ready',
    environment:{pathEntries:observed.pathEntries,variables:{...observed.variables,GOTOOLCHAIN:'local'}}
  });
  return {...snapshot,toolchain,state:missing.length ? (['failed','interrupted'].includes(preparation?.state) || toolchain.status === 'prepare_failed') ? 'needs_attention':'preparing':'ready',preparation,issues};
}
