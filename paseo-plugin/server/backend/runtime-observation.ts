import { access, stat, readFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, delimiter, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.ts';
import { canonicalAsync, hash, stable, WorkbenchError, type Json } from './storage.ts';
import { runtimeCacheLayout, runtimeCacheRoot, runtimePath } from './runtime-layout.ts';
import { summarizeRuntime, toolExecutable } from './runtime-summary.ts';

function check(signal: AbortSignal){if(signal.aborted)throw new WorkbenchError('observer_timeout','Environment observation cancelled');}
async function executable(path:string,signal:AbortSignal){
  check(signal);try{await access(path,constants.X_OK);return (await stat(path)).isFile();}catch{return false;}
}
async function managerPath(config:Config,signal:AbortSignal){
  const raw=config.toolchain?.managerPath;
  const paths=(process.env.PATH || '').split(delimiter).map(directory=>join(directory,raw || 'mise'));
  const candidates=raw ? raw.includes('/') ? [runtimePath(config,raw)] : [...paths,runtimePath(config,raw)]
    : [...paths,process.env.WORKSPACE_WORKBENCH_MISE,'/opt/homebrew/bin/mise','/usr/local/bin/mise','/usr/bin/mise',join(homedir(),'.local/bin/mise'),join(homedir(),'.mise/bin/mise'),join(homedir(),'.local/share/mise/bin/mise')];
  for(const path of candidates)if(path && await executable(path,signal))return await canonicalAsync(path);
  return null;
}
export async function observeRuntime(config:Config,workspace:Json,createCaches:boolean,signal:AbortSignal){
  const requirements=config.toolchain?.repositories || {}, mode=config.toolchain?.mode || (config.toolchain?.manager === 'system' ? 'system':'auto');
  const manager=config.toolchain?.manager || (mode === 'system' ? 'system':'mise');
  const managerBinary=mode === 'system' ? null : await managerPath(config,signal);
  check(signal);
  let saved:Json={};
  try {saved=JSON.parse(await readFile(join(config.stateRoot,'toolchains',hash(workspace.id)+'.json'),{encoding:'utf8',signal}));}catch(error){if(signal.aborted)throw error;}
  const ready:Record<string,boolean>={};
  for(const repo of workspace.repositories){
    const required=requirements[repo.id] || {},entry=saved[repo.id] || {};
    ready[repo.id]=stable(entry.requested) === stable(required);
    for(const tool of Object.keys(required)){
      const path=toolExecutable(entry,tool);
      if(!await executable(path,signal) || managerBinary && await canonicalAsync(path) === managerBinary)ready[repo.id]=false;
    }
  }
  const tools=[...new Set<string>(workspace.repositories.flatMap((repo:Json)=>Object.keys(requirements[repo.id] || {})))];
  const variables=runtimeCacheLayout(config,workspace,tools,requirements);
  if(variables.MISE_DATA_DIR){
    const target=await canonicalAsync(variables.MISE_DATA_DIR);
    for(const source of [config.treesRoot,...config.repositories.map(repo=>join(config.sourceRoot,repo.path))]){
      const path=relative(await canonicalAsync(source),target);
      if(path === '' || path !== '..' && !path.startsWith('../') && !isAbsolute(path))throw new WorkbenchError('config_invalid','mise data must be outside source and workspace trees');
    }
    variables.MISE_DATA_DIR=target;
  }
  if(createCaches)for(const path of new Set(Object.values(variables))){check(signal);await mkdir(path,{recursive:true,mode:0o700});await access(path,constants.W_OK);}
  const toolchain=summarizeRuntime(workspace,requirements,saved,ready,{manager,mode,managerPath:managerBinary,variables,
    cache:{scope:config.cacheScope || 'workspace',root:runtimeCacheRoot(config,workspace),enabled:config.cacheEnabled}});
  const bins=new Set<string>(),versions:Json={};
  for(const [tool,requirement] of Object.entries(toolchain.requirements) as [string,Json][]){
    if(new Set(requirement.requested).size > 1)continue;
    for(const repo of workspace.repositories){
      const entry=saved[repo.id],required=requirements[repo.id] || {};
      if(entry?.status !== 'ready' || !ready[repo.id] || !required[tool])continue;
      const path=await canonicalAsync(toolExecutable(entry,tool));bins.add(dirname(path));versions[tool]=entry.resolved[tool];
      if(tool === 'go'){
        const root=entry.goRoot || dirname(dirname(path)),platform=process.platform === 'win32' ? 'windows':process.platform,arch=process.arch === 'x64' ? 'amd64':process.arch === 'ia32' ? '386':process.arch;
        Object.assign(variables,{GOROOT:root,GOTOOLDIR:entry.goToolDir || join(root,'pkg','tool',`${platform}_${arch}`)});
      }
    }
  }
  check(signal);
  return {toolchain,variables,versions,pathEntries:[...bins,...(variables.MISE_DATA_DIR ? [join(variables.MISE_DATA_DIR,'shims')] : [])],
    cache:{scope:config.cacheScope,root:runtimeCacheRoot(config,workspace)}};
}
