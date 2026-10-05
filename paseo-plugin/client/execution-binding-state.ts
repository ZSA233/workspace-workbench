import type {WorkspaceBindingResponse} from '../shared/handoff.ts';
export type RetainedBindingResponse=WorkspaceBindingResponse&{retainedBinding?:WorkspaceBindingResponse};
export function successfulBinding(value:unknown):WorkspaceBindingResponse|undefined {
 const response=value as RetainedBindingResponse|undefined;
 return response?.ok?response:response?.retainedBinding;
}
/** Retention stays inside the same React Query entry; successful absence clears it. */
export function retainBindingResponse(previous:unknown,incoming:unknown,workspaceId:string):RetainedBindingResponse {
 const next=incoming as RetainedBindingResponse;
 const prior=successfulBinding(previous);
 if(next?.ok&&(!next.binding||next.binding.workspaceId===workspaceId)){
   const {retainedBinding:_,...fresh}=next;return fresh;
 }
 const failed=next?.ok?{ok:false,error:{code:'binding_workspace_mismatch',message:'Execution binding belongs to another workspace'}}:next;
 return {...failed,...(prior&&(!prior.binding||prior.binding.workspaceId===workspaceId)?{retainedBinding:prior}:{})};
}
export function executionBindingState(workspaceId:string,value:unknown,loading=false,transportError?:string|null){
 const response=value as RetainedBindingResponse|undefined,successful=successfulBinding(value);
 const binding=successful?.binding?.workspaceId===workspaceId?successful.binding:null;
 const agent=binding?.agentId&&successful?.agent?.id===binding.agentId?successful.agent:null;
 const mismatched=!!successful?.agent&&!!binding?.agentId&&successful.agent.id!==binding.agentId;
 const error=transportError||response?.error?.message||(mismatched?'Execution session identity does not match the binding':null);
 const hostClosed=agent&&['closed','archived'].includes(agent.status||'')?agent.status:null;
 const status=hostClosed||(binding&&['completed','blocked','permission','error','closed','archived'].includes(binding.status)?binding.status:agent?.status||binding?.status||null);
 const state=binding?'bound':error?'failed':loading||!response?'loading':'none';
 return {state,binding,agent,status,error,stale:!!binding&&!!error,hasAgent:!!binding?.agentId,canOpen:!!agent&&!['closed','archived'].includes(status||''),attention:['error','blocked','permission'].includes(status||''),handoff:successful?.handoff||null} as const;
}
