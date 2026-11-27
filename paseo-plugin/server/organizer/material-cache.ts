import type {OrganizerPolicy,WorkspaceAnalysis} from '../../shared/organizer.ts';
import {organizerHash} from './storage.ts';

export function materialStamp(versions:Record<string,any>|undefined,workspaceId:string,policy:OrganizerPolicy,handoff:unknown):string|undefined{
 const token=versions?.materialTokens?.[workspaceId];
 const notes=versions?.notesRevision;
 if(typeof token!=='string'||!token||!(typeof notes==='string'&&notes.length||typeof notes==='number'&&Number.isFinite(notes)))return;
 return organizerHash([versions.instanceId,token,versions.notesRevision,policy.productionBranches,handoff]);
}
export function reuseMaterial(workspace:WorkspaceAnalysis,stamp:string|undefined,policy:OrganizerPolicy,now=Date.now()){
 const saved=workspace.materialCache,age=now-Date.parse(saved?.at||'');
 return !!stamp&&saved?.stamp===stamp&&saved.fingerprint===workspace.material.fingerprint&&age>=0&&age<policy.fetchIntervalSeconds*1000;
}
