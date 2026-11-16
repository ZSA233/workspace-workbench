import type { ExtensionHost } from './backend/extensions/contracts.ts';
import type { AgentContext } from './agent-provider.ts';
import { withProject, type ProjectRoute } from './projects.ts';
import { readStoredArtifact, storeArtifactBytes } from './artifacts.ts';
import { handleSessionOperation } from './session-tools.ts';

export function createExtensionHost(project:ProjectRoute,context:AgentContext):ExtensionHost {
  const projectConfig=project.configPath;
  return {
    projectId:projectConfig,dataRoot:project.stateRoot,
    registerMaterials:items=>withProject({projectConfig},async()=>items.map(item=>{
      const assetId='communication-'+item.id;let stored;
      try{stored=readStoredArtifact(assetId).metadata;}catch{stored=storeArtifactBytes({...item,id:assetId,kind:item.mimeType.startsWith('image/')?'image':item.mimeType==='application/pdf'?'pdf':'document'});}
      return {id:assetId,assetId,title:stored.title,mimeType:stored.mimeType,kind:stored.kind,required:false};
    })),
    deliver:input=>withProject({projectConfig},async()=>await handleSessionOperation({projectConfig,...input,action:'message',behavior:'steer',limit:20,timeoutMs:0},context) as {delivery:string;messageId?:string;readConfirmed:false}),
  };
}
