import {readActivityHead,readActivityReference} from './activity-head.ts';
import {Git,withBackgroundGit} from './git.ts';
import {hash,stable,type Json} from './storage.ts';
import type {Observation} from './observation.ts';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {workspaceInstanceKey} from '../../shared/workspace-lineage.ts';

/** Facts for the organizer reuse the existing Git status/queue. This consumer
 * does not change project warming, watch leases, reconciliation or priorities. */
export async function organizerFacts(o:Observation,rows:Json[],branches:Record<string,string>={}){
 const refs=new Map<string,Promise<string|undefined>>(),facts:Record<string,Json>={};let next=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(next<rows.length){const w=rows[next++],repositories:Json[]=[];
  for(const repo of w.repositories){try{const context=await o.workspaces.observationRecords.request('context',{workspaceId:w.id,repository:repo.repoPath||repo.id}),path=context.path;
   const head=await readActivityHead(path),configured=o.workspaces.config.repositories.find(r=>r.id===repo.id||r.path===repo.sourcePath),selected=branches[repo.sourcePath]||branches[configured?.path||'']||branches[repo.id]||branches[repo.repoPath];
   const resolveRef=(ref:string)=>{const key=head.commonDir+':'+ref;let p=refs.get(key);if(!p){p=(async()=>{try{return await readActivityReference(head.commonDir,ref)||await withBackgroundGit(()=>new Git(path,o.workspaces.config.gitTimeout,Date.now()+5000).commit(ref));}catch{return undefined;}})();refs.set(key,p);}return p;};
   let productionRef=selected||'origin/main',productionSha=await resolveRef(productionRef);if(!selected&&!productionSha){productionRef='origin/master';productionSha=await resolveRef(productionRef);}
   const status=await o.status.read(w.id,path,repo.role==='gitlink-root',workspaceInstanceKey(w as Json&{id:string}));
   // Reftable/packed refs retain the same bounded Git fallback as the Git view.
   const current=head.head||await withBackgroundGit(()=>new Git(path,o.workspaces.config.gitTimeout,Date.now()+5000).head());
   repositories.push({repositoryId:repo.id,repoPath:repo.repoPath||repo.id,sourcePath:repo.sourcePath,baseSha:repo.baseSha,head:current,productionRef,productionSha,dirty:status.rows.length>0,working:await Promise.all(status.rows.slice(0,80).map(async([code,name])=>{try{const stat=await lstat(join(path,name.split('\0')[0]));return[code,name,stat.size,stat.mtimeMs,stat.ctimeMs];}catch{return[code,name,'missing'];}})),statusVersion:status.version});
  }catch(error){repositories.push({repositoryId:repo.id,repoPath:repo.repoPath||repo.id,error:error instanceof Error?error.message:'git_facts_unavailable'});}}
  const ready=repositories.length>0&&repositories.every(r=>r.head&&r.baseSha&&!r.error);
  facts[w.id]={ready,repositories,workingKey:hash(stable(repositories.map(r=>[r.repositoryId,r.working]))),commitKey:ready?hash(stable(repositories.map(r=>[r.repositoryId,r.baseSha,r.head]))):undefined,productionKey:hash(stable(repositories.map(r=>[r.repositoryId,r.productionRef,r.productionSha]))),observedAt:new Date().toISOString()};
 }}));return facts;
}
