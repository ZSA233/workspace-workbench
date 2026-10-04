import { dirname, join } from 'node:path';
import { stable, type Json } from './storage.ts';
export function toolExecutable(entry: Json, tool: string): string {
  return entry.executables?.[tool] || join(entry.paths?.[tool] || '', 'bin', tool);
}
/** One interpretation of preparation records, shared by installation and observation. */
export function summarizeRuntime(workspace: Json, requestedByRepo: Json, saved: Json, readyByRepo: Record<string, boolean>, policy: Json): Json {
  if (!workspace.managed) return {manager:policy.manager,mode:policy.mode,status:'not_applicable',requirements:{},preparedRepositories:{},issues:[]};
  const repositories: Json = Object.create(null), requirements: Json = Object.create(null), bins = new Set<string>();
  for (const repo of workspace.repositories) {
    const requested = requestedByRepo[repo.id] || {}, previous = Object.hasOwn(saved,repo.id) ? saved[repo.id] : {};
    const matches = stable(previous.requested) === stable(requested), ready = readyByRepo[repo.id];
    let status = matches ? previous.status || 'needs_prepare' : 'needs_prepare';
    if (status === 'ready' && !ready) status = 'needs_prepare';
    if (!Object.keys(requested).length) status = 'not_applicable';
    const paths = status === 'ready' && ready ? [...new Set(Object.keys(requested).map(tool => dirname(toolExecutable(previous,tool))))] : [];
    paths.forEach(path => bins.add(path));
    repositories[repo.id] = {status,tools:Object.keys(requested),issues:matches ? previous.issues || [] : [],sources:matches ? previous.sources || {} : {},binPaths:paths};
    for (const [tool, version] of Object.entries(requested)) {
      const entry = requirements[tool] ||= {requested:[],resolved:[]}; entry.requested.push(version);
      if (matches && previous.resolved?.[tool]) entry.resolved.push(previous.resolved[tool]);
    }
  }
  const entries = Object.values(repositories) as Json[], states = entries.map(entry => entry.status);
  const status = states.every(state => ['ready','not_applicable'].includes(state)) ? 'ready' : states.includes('ready') ? 'partial' : states.includes('prepare_failed') ? 'prepare_failed' : 'needs_prepare';
  return {manager:policy.manager,mode:policy.mode,managerAvailable:!!policy.managerPath,managerPath:policy.managerPath,cache:policy.cache,
    requirements,preparedRepositories:repositories,issues:entries.flatMap(entry => entry.issues),status,
    environment:{pathEntries:status === 'ready' ? [...bins] : [],variables:{...policy.variables,...(status === 'ready' ? {GOTOOLCHAIN:'local'} : {})}}};
}
