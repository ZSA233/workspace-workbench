import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.ts';
import { hash, type Json } from './storage.ts';
import { runtimeTools } from './runtime-tools.ts';

export function runtimePath(config: Config, value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(dirname(config.configPath), value);
}
export function runtimeCacheRoot(config: Config, workspace: Json): string {
  return config.cacheScope === 'project' ? join(config.cacheRoot, 'shared')
    : join(config.cacheRoot, 'workspaces', workspace.id === 'main' ? 'main' : hash(workspace.id).slice(0, 16));
}
export function runtimeCacheLayout(config: Config, workspace: Json, tools: string[], requirements: Json): Record<string, string> {
  const mode = config.toolchain?.mode || (config.toolchain?.manager === 'system' ? 'system' : 'auto');
  const manager = config.toolchain?.manager || (mode === 'system' ? 'system' : 'mise');
  const variables: Record<string, string> = {};
  if (manager === 'mise' && mode !== 'system') variables.MISE_DATA_DIR = config.toolchain?.miseDataRoot
    ? runtimePath(config, config.toolchain.miseDataRoot) : join(config.stateRoot, 'toolchains', 'mise');
  if (!config.cacheEnabled) return variables;
  const root = runtimeCacheRoot(config, workspace);
  const paths = Object.assign({UV_CACHE_DIR:'uv'}, variables.MISE_DATA_DIR ? {MISE_CACHE_DIR:'mise'} : {}, ...tools.map(tool => runtimeTools[tool]?.cache || {}));
  for (const [name, part] of Object.entries(paths)) variables[name] = join(root, String(part));
  if (config.cacheScope === 'project' && tools.includes('go')) {
    variables.WORKBENCH_GO_BUILD_CACHE_ROOT = join(root, 'go-build');
    variables.WORKBENCH_GO_MOD_CACHE_ROOT = join(root, 'go-mod');
    const versions = [...new Set(workspace.repositories.map((repo: Json) => requirements[repo.id]?.go).filter(Boolean))];
    variables.GOCACHE = join(root, 'go-build', `go${versions.length === 1 ? versions[0] : 'mixed'}`, `${process.platform}-${process.arch}`);
    variables.GOMODCACHE = variables.WORKBENCH_GO_MOD_CACHE_ROOT;
  }
  return variables;
}
