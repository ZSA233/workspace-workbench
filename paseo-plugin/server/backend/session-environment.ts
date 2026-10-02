import { join, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Runtime } from './runtime.ts';
import { resolveRuntimeDeclarations } from './runtime-declarations.ts';
import { writeOperation } from './operation-storage.ts';
import { inside, canonical, hash, WorkbenchError, type Json } from './storage.ts';
import type { Service } from './service.ts';

/** Public environment description; lifecycle records remain private. */
export async function sessionEnvironment(service: Service, params: Json) {
  let id = String(params.workspaceId || '');
  if (!id && params.cwd) {
    const match = await service.workspaces.observationRecords.request('identify', {directory:String(params.cwd)});
    if (!match.matched) throw new WorkbenchError('workspace_not_found', 'Directory is not a registered workspace');
    id = match.workspaceId;
  }
  const workspace = await service.workspaces.observationRecords.request('get', {workspaceId:id});
  if (workspace.state !== 'active') throw new WorkbenchError('workspace_state_invalid', 'Workspace is not active');
  const cwd = canonical(params.cwd || workspace.treePath || workspace.sourceRoot);
  if (workspace.managed && !inside(cwd, workspace.treePath, true)) throw new WorkbenchError('path_invalid','Session directory is outside workspace');
  const aliases = params.repositories || (params.repositoryId ? [params.repositoryId] : null);
  if (aliases && (!Array.isArray(aliases) || !aliases.length || aliases.length > 256))
    throw new WorkbenchError('request_invalid', 'Expected a bounded repository list');
  const selected = aliases
    ? [...new Set<string>(aliases.map((id: string) => service.workspaces.repository(workspace, id).id))]
      .map(id => workspace.repositories.find((repo: Json) => repo.id === id))
    : workspace.repositories.filter((repo: Json) => inside(cwd, repo.worktreePath || repo.sourcePath, true));
  const scoped = { ...workspace, repositories: selected.length ? selected : workspace.repositories };
  const resolved = await resolveRuntimeDeclarations(service.config, scoped);
  const runtime = new Runtime(resolved.config);
  const toolchain = runtime.summary(scoped);
  const variables = runtime.cache(scoped, Object.keys(toolchain.requirements), true);
  const bins = new Set<string>();
  const versions: Json = {};
  const prepared = runtime.load(workspace);
  for (const [tool, requirement] of Object.entries(toolchain.requirements) as [string,Json][]) {
    if (new Set(requirement.requested).size > 1) continue;
    for (const repo of scoped.repositories) {
      const entry = prepared[repo.id];
      const required = runtime.requirements[repo.id] || {};
      if (entry?.status === 'ready' && runtime.ready(entry,required) && required[tool]) {
        bins.add(dirname(runtime.entryExecutable(entry,tool))); versions[tool]=entry.resolved[tool];
        if (tool === 'go') Object.assign(variables, runtime.executionVariables(entry, required));
      }
    }
  }
  let preparation;
  const issues: Json[] = [];
  const missing = scoped.repositories.filter((repo:Json) => Object.keys(runtime.requirements[repo.id] || {}).length && toolchain.preparedRepositories[repo.id]?.status !== 'ready').map((repo:Json)=>repo.id);
  if (params.prepare !== false && missing.length && workspace.managed) {
    // Durable task identity is tied to declared scope, never to UI retries.
    try { preparation = await service.preparations.request({action:'start',workspaceId:id,repositories:missing,requestId:`session:${hash(id+resolved.identity+missing.join(','))}`}); }
    catch(error) { if(error instanceof WorkbenchError && error.code === 'operation_conflict') { preparation=await service.preparations.request({action:'status',workspaceId:id}); issues.push({code:'preparation_scope_busy',message:'Another preparation scope is active'}); } else throw error; }
  }
  const file = join(service.config.stateRoot,'environments',`${hash(id+cwd+scoped.repositories.map((repo:Json) => repo.id).sort().join(','))}.json`);
  const result = {schemaVersion:'workspace.workbench.environment/v1',projectId:service.config.projectId,workspaceId:id,cwd,
    configIdentity:resolved.identity,declarations:resolved.sources,toolchain,versions,cache:{scope:service.config.cacheScope,root:runtime.cacheRoot(workspace)},
    state:missing.length ? (['failed','interrupted'].includes(preparation?.state) || toolchain.status === 'prepare_failed') ? 'needs_attention' : 'preparing' : 'ready',preparation,issues,
    environment:{pathEntries:[...bins, ...(variables.MISE_DATA_DIR ? [join(variables.MISE_DATA_DIR,'shims')] : [])],variables:{...variables,GOTOOLCHAIN:'local',WORKBENCH_ENVIRONMENT_FILE:file}}};
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  await writeOperation(file,result);
  return result;
}
