import type {OrganizerPolicy,WorkspaceMaterial} from '../../shared/organizer.ts';
import {aggregateRepositoryCoverage} from '../../shared/organizer.ts';
import {organizerHash} from './storage.ts';
import {referenceRefreshFailed} from './reference-state.ts';

type Read=(method:'repository.compare'|'repository.fetch',params:Record<string,unknown>)=>Promise<Record<string,any>>;
/** Use the existing journaled, bounded Git fetch path; cache identity belongs to the source repo/ref. */
export class SessionProduction {
  private fetches=new Map<string,{at:number;ready:boolean}>();
  applyCached(project:string,material:WorkspaceMaterial){for(const repo of material.repositories){const key=project+':'+(repo.sourcePath||repo.repositoryId)+':'+repo.productionRef;if(this.fetches.get(key)?.ready===false)referenceRefreshFailed(repo);}material.state=aggregateRepositoryCoverage(material.repositories);return material;}
  async refresh(project:string,material:WorkspaceMaterial,policy:OrganizerPolicy,jobId:string,read:Read,reload:()=>Promise<WorkspaceMaterial>,signal:AbortSignal,onFetch:(repository:string,ref:string,fetching:boolean)=>void){
    let fetched=false;const failed=new Set<string>();
    for(const repo of material.repositories){if(signal.aborted)throw Error('organizer_cancelled');if(!repo.productionRef||repo.state==='discussion')continue;
      onFetch(repo.repositoryId,repo.productionRef,false);
      const key=project+':'+(repo.sourcePath||repo.repositoryId)+':'+repo.productionRef,old=this.fetches.get(key);
      if(old?.ready&&Date.now()-old.at<policy.fetchIntervalSeconds*1000){if(repo.refreshError||repo.referenceUnavailable)fetched=true;continue;}
      try{const refs=await read('repository.compare',{workspaceId:material.workspaceId,repoPath:repo.repoPath,action:'refs'});const remote=refs.refs?.find((r:any)=>r.kind==='remote'&&(r.name===repo.productionRef||r.shortName===repo.productionRef));if(!remote)continue;
        if(refs.fetch?.state==='ready'&&refs.fetch.ref===repo.productionRef&&Date.now()-Date.parse(refs.fetch.lastFetchedAt||'')<policy.fetchIntervalSeconds*1000){this.fetches.set(key,{at:Date.parse(refs.fetch.lastFetchedAt),ready:true});if(!old?.ready||repo.refreshError||repo.referenceUnavailable)fetched=true;continue;}
        if(old&&!old.ready&&Date.now()-old.at<60_000){failed.add(repo.repositoryId);continue;}
        onFetch(repo.repositoryId,repo.productionRef,true);const result=await read('repository.fetch',{workspaceId:material.workspaceId,repoPath:repo.repoPath,ref:repo.productionRef,requestId:'session:'+jobId+':'+organizerHash(key)});let state=result.state;const deadline=Date.now()+35000;
        while(state==='running'&&Date.now()<deadline){await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,300);signal.addEventListener('abort',done,{once:true});});if(signal.aborted)throw Error('organizer_cancelled');const value=await read('repository.compare',{workspaceId:material.workspaceId,repoPath:repo.repoPath,action:'refs'});state=value.fetch?.state;}
        const ready=state==='ready';this.fetches.set(key,{at:Date.now(),ready});if(ready)fetched=true;else failed.add(repo.repositoryId);
      }catch(error){if(signal.aborted)throw error;this.fetches.set(key,{at:Date.now(),ready:false});failed.add(repo.repositoryId);}
    }
    const value=fetched?await reload():material;
    for(const repo of value.repositories)if(failed.has(repo.repositoryId))referenceRefreshFailed(repo);
    value.state=aggregateRepositoryCoverage(value.repositories);return value;
  }
}
