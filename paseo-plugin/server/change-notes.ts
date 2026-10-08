import {liveAgentIdentity} from './agent-identity';
import {currentProject,resolveProject} from './projects';
import {handleObserver} from './observer';
import type {AgentContext} from './agent-provider';
import {changeNotesRpc} from '../shared/change-notes-rpc';
import type {z} from 'zod';
export async function handleChangeNotes(input:z.output<typeof changeNotesRpc.input>,context:AgentContext){
 let author:string|undefined;
 if(input.token){const identity=await liveAgentIdentity(input.token,context.paseo);if(!identity||resolveProject({directory:identity.cwd}).configPath!==currentProject()?.configPath)throw new Error('notes_access_denied');if(identity.workspaceId&&identity.workspaceId!==input.workspaceId)throw new Error('notes_workspace_denied');if(input.action==='feedback')throw new Error('notes_user_action_only');author=identity.agentId;}
 if(input.action==='write'&&!author)throw new Error('notes_author_required');
 return handleObserver({projectConfig:input.projectConfig,method:input.action==='write'?'notes.write':input.action==='feedback'?'notes.feedback':'notes.read',params:{...input,token:undefined,author}},context);
}
