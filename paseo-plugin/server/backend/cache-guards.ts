import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheResource } from '../../shared/cache-management.ts';
import { registeredProjects } from '../projects.ts';
import { loadConfig, type Config } from './config.ts';
import { inside, WorkbenchError } from './storage.ts';

/** Inspect known task owners, never infer execution from the backend worker's state. */
export async function assertCacheIdle(resource: CacheResource, current: Config) {
  const configs = new Map([[current.configPath, current]]);
  for (const route of registeredProjects()) {
    try { const config = loadConfig(route.configPath); if (resource.scope === 'global' || resource.paths.some(path => inside(path, config.cacheRoot, true) || inside(config.cacheRoot, path, true))) configs.set(config.configPath, config); } catch {}
  }
  const read = async (path: string) => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new WorkbenchError('cache_task_status_unavailable', 'Could not verify active cache users'); }
  };
  for (const config of configs.values()) {
    const relevant = (id: string) => resource.scope !== 'workspace' || config.configPath !== current.configPath || !resource.references.length || resource.references.some(ref => ref.projectConfig === config.configPath && ref.workspaceId === id);
    const bindings = (await read(join(config.stateRoot, 'agent-bindings.json')))?.bindings || [];
    if (!Array.isArray(bindings)) throw new WorkbenchError('cache_task_status_unavailable', 'Invalid execution bindings');
    if (bindings.some((value: any) => relevant(value.workspaceId) && !['completed','failed','cancelled','stopped','idle','archived','closed','error'].includes(value.status))) throw new WorkbenchError('cache_in_use', 'An execution may be using this cache');
    for (const [directory, active] of [['prepare-operations', ['queued','running']], ['reviews', null]] as const) {
      const root = join(config.stateRoot, directory);
      const files = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of files.filter(file => file.endsWith('.json'))) {
        const value = await read(join(root, file));
        if (!value || !relevant(value.workspaceId)) continue;
        if (active ? active.includes(value.state) : typeof value.status === 'string' && !['approved','stopped','failed','blocked','limit_reached'].includes(value.status)) throw new WorkbenchError('cache_in_use', 'Preparation or review may be using this cache');
      }
    }
  }
  return [...configs.keys()];
}
