import {randomUUID} from 'node:crypto';
import type {Observation} from './observation.ts';
import {inspectRepository} from './production-coverage.ts';
import {withBackgroundGit} from './git.ts';
import {hash,stable,WorkbenchError,type Json} from './storage.ts';
import {workspaceInstanceKey} from '../../shared/workspace-lineage.ts';
import type {RawStatus} from './repository-status.ts';

/** Production coverage is derived Git data in the existing shared observation
 * cache. Producers own cancellation; a departing panel cannot cancel a peer. */
export class ProductionReads{
 private closed=false;private producers=new Set<AbortController>();
 private observation:Observation;
 constructor(observation:Observation){this.observation=observation;}
 async read(context:{workspace:Json;repo:Json;path:string},productionRef:string|undefined,signal?:AbortSignal){
  if(this.closed||signal?.aborted)throw new WorkbenchError('observer_cancelled','Production observation cancelled');
  const {workspace,repo,path}=context,o=this.observation,instance=workspaceInstanceKey(workspace as Json&{id:string}),state=o.scheduler.versions([workspace.id]).repositories.find(r=>r.path===path);
  const version=state?.sourceReady&&!state.sourcePending?o.scheduler.statusToken(path)+':'+Math.floor(Date.now()/900_000):randomUUID();
  const key='production:v4:'+hash(stable([instance,path,repo.id,repo.baseSha,productionRef,version,o.cache.workspaceEpoch(workspace.id)]));
  const read=o.cache.read(key,version,async()=>{
   if(this.closed)throw new WorkbenchError('observer_closed','Production reader closed');
   const abort=new AbortController();this.producers.add(abort);const timer=setTimeout(()=>abort.abort(),30_000);timer.unref();
   try{
    const git=o.refresh.sourceGit({workspace,path},Date.now()+25_000,abort.signal);
    if(await git.root()!==path)throw new WorkbenchError('repository_root_mismatch','Expected recorded repository root');
    let status:RawStatus|undefined;
    try{status=await o.status.read(workspace.id,path,repo.role==='gitlink-root',instance);}catch{if(abort.signal.aborted)throw new WorkbenchError('observer_cancelled','Production observation cancelled');}
    const result=await withBackgroundGit(()=>inspectRepository(git,{repositoryId:repo.id,repoPath:repo.repoPath||repo.id,baseSha:repo.baseSha,productionRef},status?.rows));
    return{...result,observation:{state:'ready',observedAt:new Date().toISOString()},sourceVersion:version};
   }finally{clearTimeout(timer);this.producers.delete(abort);}
  },true,true,{workspaceId:workspace.id,repoPath:path});
  let cancel=()=>{};
  try{return structuredClone(await Promise.race([read,new Promise<never>((_,reject)=>{cancel=()=>reject(new WorkbenchError('observer_cancelled','Production subscriber cancelled'));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();})]));}
  finally{signal?.removeEventListener('abort',cancel);}
 }
 close(){this.closed=true;for(const abort of this.producers)abort.abort();}
}
