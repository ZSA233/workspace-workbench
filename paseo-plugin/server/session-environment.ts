import { delimiter, isAbsolute, relative, join } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { queryObserver } from './observer.ts';
import { withProject, type ProjectRoute } from './projects.ts';

const allowed = new Set(['GOCACHE', 'GOMODCACHE', 'NPM_CONFIG_CACHE', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'MISE_DATA_DIR',
  'MISE_CACHE_DIR', 'GOROOT', 'GOTOOLDIR', 'GOTOOLCHAIN', 'WORKBENCH_ENVIRONMENT_FILE', 'WORKBENCH_GO_BUILD_CACHE_ROOT',
  'WORKBENCH_GO_MOD_CACHE_ROOT']);

export function runtimeEnvironment(value: any, explicit: Record<string, string> = {}): Record<string, string> {
  const environment = value?.environment || value?.toolchain?.environment;
  const variables: Record<string, string> = {};
  for (const [key, item] of Object.entries(environment?.variables || {})) {
    if (allowed.has(key) && typeof item === 'string' && (key === 'GOTOOLCHAIN' || isAbsolute(item))) variables[key] = item;
  }
  const legacyConflict = !value?.environment && Object.values(value?.toolchain?.requirements || {}).some((requirement: any) => requirement.requested?.length > 1);
  const paths = legacyConflict
    ? variables.MISE_DATA_DIR ? [join(variables.MISE_DATA_DIR, 'shims')] : []
    : (environment?.pathEntries || []).filter((path: unknown) => typeof path === 'string' && isAbsolute(path));
  if (paths.length) variables.PATH = [...paths, process.env.PATH || ''].filter(Boolean).join(delimiter);
  return { ...variables, ...explicit };
}

/** Cache access is independent of permission presets and source write scope. */
export async function cacheExecutionConfig<T extends {provider: string; cwd?: string; providerOptions?: any}>(config: T, value: any, sessionCwd?: string): Promise<T> {
  if (config.provider !== 'codex' || !value?.cache?.root || !value?.environment?.variables?.UV_CACHE_DIR) return config;
  const options = config.providerOptions || {};
  if (options.sandbox_mode === 'read-only' || options.sandbox_mode === 'danger-full-access') return config;
  try {
    const root = await realpath(value.cache.root), cwd = await realpath(config.cwd || sessionCwd || '');
    const location = relative(root, cwd);
    // Never grant an ancestor of the session's source directory. The root
    // comes from the trusted backend result, not from caller env overrides.
    if (!location.startsWith('..') && !isAbsolute(location)) return config;
    const cache = options.sandbox_workspace_write || {};
    const roots = Array.isArray(cache.writable_roots) ? cache.writable_roots : [];
    return {...config,providerOptions:{...options,sandbox_workspace_write:{...cache,writable_roots:[...new Set([...roots,root])]}}};
  } catch { return config; }
}

/** Retain user overrides, refresh only values still equal to the previous injection. */
export function sessionOverrides(explicit: Record<string, string>, previous: any, current: any) {
  if (previous?.schemaVersion !== 'workspace.workbench.environment/v1' || previous.projectId !== current?.projectId) return explicit;
  const result = { ...explicit };
  for (const [key, value] of Object.entries(previous.environment?.variables || {})) {
    if (allowed.has(key) && result[key] === value) delete result[key];
  }
  const prefix = (previous.environment?.pathEntries || []).join(delimiter) + delimiter;
  if (prefix !== delimiter && result.PATH?.startsWith(prefix)) {
    const rest = result.PATH.slice(prefix.length);
    if (rest === (process.env.PATH || '')) delete result.PATH;
  }
  return result;
}

async function previousEnvironment(explicit: Record<string, string>) {
  const path = explicit.WORKBENCH_ENVIRONMENT_FILE;
  if (!path || !isAbsolute(path)) return null;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 128 * 1024) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { return null; }
}

/** Optional startup defaults, independent of MCP readiness and execution permissions. */
export async function bindSessionRuntime<T extends {provider:string;cwd:string;providerOptions?:any}>(project: ProjectRoute, config:T, explicit: Record<string, string> = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = {config,env:explicit};
  const binding = (async () => {
  try {
    const location = relative(await realpath(project.treesRoot), await realpath(config.cwd));
    if (location.startsWith('..') || isAbsolute(location)) return fallback;
    const previous = await previousEnvironment(explicit);
    const response = await withProject({ projectConfig: project.configPath }, () => queryObserver({ method: 'workspace.environment', params: { cwd:config.cwd } }));
    return response.ok ? {config:await cacheExecutionConfig(config,response.result),env:runtimeEnvironment(response.result, sessionOverrides(explicit, previous, response.result))} : fallback;
  } catch { return fallback; }
  })();
  return Promise.race([binding,new Promise<typeof fallback>(resolve => {timer=setTimeout(()=>resolve(fallback),2_000);})]).finally(()=>clearTimeout(timer));
}

export async function bindSessionEnvironment(project: ProjectRoute, cwd: string, explicit: Record<string, string> = {}) {
  return (await bindSessionRuntime(project,{provider:'',cwd},explicit)).env;
}
