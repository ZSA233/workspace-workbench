import type {PaseoAgent} from '@getpaseo/client';
import type {OrganizerTarget,SessionAssociations} from '../../shared/organizer.ts';
import type {AgentBinding} from '../agent-store.ts';
import {organizerHash,type OrganizerLedger} from './storage.ts';

export type AssociationWorkspace = {id:string;instanceKey:string;managed?:boolean;state?:string;displayName?:string;createdAt?:string;latestCommitAt?:string|null;taskBrief?:string;creator?:{agentId?:string}};
export function eligibleAssociationWorkspaces(rows:AssociationWorkspace[]) {
  return rows.filter(row=>row.managed&&row.id!=='main'&&typeof row.instanceKey==='string'&&!['record_invalid','removed','deletion_pending'].includes(row.state||''));
}

/** A verified association belongs to a native session and a Workspace instance,
 * not to the changing activity, cwd or archive state of an execution Agent. */
export function syncSessionAssociations(ledger:OrganizerLedger,target:OrganizerTarget,rows:AssociationWorkspace[],agents:Map<string,PaseoAgent>,bindings:AgentBinding[]) {
  const eligible=eligibleAssociationWorkspaces(rows),links=target.workspaceLinks||{};
  // Older ledgers already contain verified explicit associations. Freeze those
  // identities once; never recover links by matching a directory or a name.
  if(!target.workspaceLinks)for(const key of target.workspaceKeys){
    const row=eligible.find(row=>row.instanceKey===key),saved=ledger.workspaces[key];
    if(row&&saved?.material.workspaceId===row.id)links[key]={workspaceId:row.id,source:'automatic',included:true,at:new Date().toISOString()};
  }
  for(const row of eligible){
    if(links[row.instanceKey])continue;
    const ids=new Set([row.creator?.agentId,...bindings.filter(binding=>binding.workspaceId===row.id).map(binding=>binding.agentId)].filter(Boolean));
    const verified=[...ids].some(id=>{
      const agent=agents.get(id!),binding=bindings.find(binding=>binding.workspaceId===row.id&&binding.agentId===id);
      return agent?.workspaceId===target.id&&(!binding||binding.cwd===agent.cwd&&binding.paseoWorkspaceId===target.id);
    });
    if(verified)links[row.instanceKey]={workspaceId:row.id,source:'automatic',included:true,at:new Date().toISOString()};
  }
  target.workspaceLinks=links;
  const linked=eligible.filter(row=>links[row.instanceKey]?.included&&links[row.instanceKey].workspaceId===row.id);
  target.workspaceKeys=linked.map(row=>row.instanceKey);
  // Manually linked Workspaces need the current native session's conversation,
  // even when their original creator belonged to a different session.
  target.agentIds=[...agents.values()].filter(agent=>agent.workspaceId===target.id).map(agent=>agent.id);
  for(const row of linked)if(!ledger.workspaces[row.instanceKey])ledger.workspaces[row.instanceKey]={key:row.instanceKey,title:row.displayName||row.id,brief:'',items:[],material:{workspaceId:row.id,instance:row.instanceKey,name:row.displayName||row.id,createdAt:row.createdAt||'',activityAt:row.createdAt||'',latestCommitAt:row.latestCommitAt||null,taskBrief:row.taskBrief||'',fingerprint:'',evidence:[],repositories:[],state:'unknown',complete:false}};
  return linked;
}

export function sessionAssociations(ledger:OrganizerLedger,target:OrganizerTarget,rows:AssociationWorkspace[]):SessionAssociations {
  const workspaces=eligibleAssociationWorkspaces(rows).map(row=>({key:row.instanceKey,id:row.id,name:row.displayName||row.id,title:ledger.workspaces[row.instanceKey]?.digest?.title,linked:target.workspaceKeys.includes(row.instanceKey),source:target.workspaceLinks?.[row.instanceKey]?.source}));
  // Model progress and title edits do not invalidate a selection dialog. A scope
  // edit or a replaced Workspace instance does.
  return {targetId:target.id,title:target.currentTitle,revision:organizerHash([target.id,target.workspaceLinks,workspaces.map(row=>[row.key,row.id]).sort((a,b)=>a[0].localeCompare(b[0]))]),workspaces};
}
