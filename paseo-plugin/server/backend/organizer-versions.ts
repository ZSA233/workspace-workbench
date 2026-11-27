import type {Observation} from './observation.ts';
import {canonicalAsync,hash,stable,type Json} from './storage.ts';
import {workspaceInstanceKey} from '../../shared/workspace-lineage.ts';

/** Register only the explicitly requested Workspace roots. Hot reads use the
 * existing source watches; they never enumerate commits or compare production. */
export async function organizerVersions(observation:Observation,params:Json){
 const ids=[...new Set((Array.isArray(params.workspaceIds)?params.workspaceIds:[]).filter((id:unknown)=>typeof id==='string'))].slice(0,100) as string[];
 const rows=await Promise.all(ids.map(workspaceId=>observation.workspaces.observationRecords.request('get',{workspaceId})));
 const roots=new Map<string,string[]>();await Promise.all(rows.map(async w=>{roots.set(w.id,await Promise.all(w.repositories.map((r:Json)=>canonicalAsync(r.worktreePath||r.sourcePath))));}));
 await Promise.all(rows.flatMap(w=>roots.get(w.id)!.map(path=>observation.scheduler.register(w.id,path))));
 const versions=observation.scheduler.versions(ids),materialTokens:Record<string,string>={};
 for(const w of rows){
  const paths=roots.get(w.id)!,ready=paths.length&&paths.every(path=>versions.repositories.some(r=>r.path===path&&r.sourceReady&&!r.sourcePending&&!r.issue));
  materialTokens[w.id]=ready?hash(stable([workspaceInstanceKey(w),w.taskBrief,w.description,w.taskKind,w.displayName,w.repositories.map((r:Json)=>[r.id,r.repoPath,r.worktreePath,r.sourcePath,r.baseSha]),paths.map(path=>[path,versions.tokens[path+'#source']])])):'';
 }
 return{...versions,materialTokens};
}
