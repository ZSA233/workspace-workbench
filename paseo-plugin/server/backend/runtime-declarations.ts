import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { Config } from './config.ts';
import { hash, stable, WorkbenchError, type Json } from './storage.ts';

/** Project declarations override legacy settings without executing TOML directives. */
export async function resolveRuntimeDeclarations(config: Config, workspace: Json, signal?:AbortSignal) {
  const repositories: Json = Object.create(null), sources: Json = Object.create(null);
  for (const repo of workspace.repositories) {
    if(signal?.aborted)throw new WorkbenchError('observer_timeout','Environment declaration read cancelled');
    const legacy = config.toolchain?.repositories?.[repo.id] || {};
    repositories[repo.id] = { ...legacy };
    for (const name of ['mise.toml', '.mise.toml']) {
      const path = join(repo.worktreePath || repo.sourcePath, name);
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (!info.isFile() || info.size > 64 * 1024) throw new WorkbenchError('runtime_declaration_invalid', 'Tool declaration must be a bounded regular file');
      const text = await readFile(path, {encoding:'utf8',signal});
      let parsed: Json;
      try { parsed = parse(text) as Json; } catch { throw new WorkbenchError('runtime_declaration_invalid', 'Invalid tool declaration'); }
      const tools: Json = {}, unmanaged: string[] = [];
      for (const [tool, value] of Object.entries(parsed.tools || {})) {
        if (!['go', 'node', 'python'].includes(tool)) { unmanaged.push(tool); continue; }
        if (typeof value !== 'string' || !/^\d+(\.\d+){0,2}$/.test(value)) throw new WorkbenchError('runtime_declaration_invalid', 'Supported tools require a numeric version');
        tools[tool] = value;
      }
      repositories[repo.id] = tools;
      sources[repo.id] = { file: name, identity: hash(text), unmanaged, overrides: Object.keys(legacy).filter(tool => legacy[tool] !== tools[tool]) };
      break;
    }
  }
  return { config: { ...config, toolchain: { ...(config.toolchain || {}), repositories } }, sources,
    identity: hash(stable({ repositories, sources, policy:config.toolchain, cacheScope:config.cacheScope })) };
}
