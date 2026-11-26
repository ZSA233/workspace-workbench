import type { ModelProfile, OrganizerJob, OrganizerModelPhase, OrganizerRun, OrganizerStage } from '../../shared/organizer.ts';
import type { OrganizerStore } from './storage.ts';

export function organizerProgress(store:OrganizerStore,id:string) {
  const update=(edit:(job:OrganizerJob)=>void)=>store.update(ledger=>{const job=ledger.jobs.find(j=>j.id===id);if(!job)throw Error('organizer_job_missing');edit(job);job.updatedAt=new Date().toISOString();});
  const stage=(value:OrganizerStage,current?:OrganizerJob['current'])=>update(job=>{
    job.stage=value;job.stageAt=new Date().toISOString();if(current)job.current=current;
    job.events=[...(job.events||[]),{at:job.stageAt,stage:value,workspaceId:job.current?.workspaceId,message:job.current?.repository||job.current?.name||''}].slice(-32);
  });
  return {
    update,stage,
    count(key:keyof NonNullable<OrganizerJob['result']>,amount=1){update(job=>{job.result||={analyzed:0,cached:0,skipped:0,failed:0,titleWrites:0,conversations:0};job.result[key]+=amount;});},
    skip(reason:NonNullable<OrganizerJob['model']>['reason']){update(job=>{if(job.model)job.model.reason=reason;});},
    queued(profile:ModelProfile){stage('model-queued');update(job=>{job.model={...job.model,calls:job.model?.calls||0,completed:job.model?.completed||0,state:'queued',profileId:profile.id,name:profile.name,model:profile.model,timeoutMs:profile.timeoutMs,reason:undefined,runId:undefined,requestedAt:undefined};});},
    model(phase:OrganizerModelPhase,run:OrganizerRun){
      store.addRun(run);stage(phase);update(job=>{const old=job.model;job.model={...old,state:phase,calls:(old?.calls||0)+(phase==='requesting'?1:0),completed:(old?.completed||0)+(phase==='complete'?1:0),runId:run.id,requestedAt:run.requestedAt};});
    },
  };
}
export type OrganizerProgress=ReturnType<typeof organizerProgress>;
