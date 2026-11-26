import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentContext} from './agent-provider.ts';
import type {ProjectRoute} from './projects.ts';
import type {ReviewArtifactReference} from '../shared/review-packet.ts';
import {topicChatMediaKind, type TopicChatMedia, type TopicChatImage, type TopicChatVideo} from '../shared/topic-chat-media.ts';
import type {TopicStoredVideo} from '../shared/topic-video.ts';
import {MAX_INLINE_VIDEO_BYTES} from '../shared/topic-video.ts';
import {readStoredArtifact,storedArtifactFileDescriptor} from './artifacts.ts';
import {withProject} from './projects.ts';

/** These are display-only host timeline items, never part of the model prompt. */
export async function appendTopicImages(route:ProjectRoute,context:AgentContext,agentId:string,value:{id:string;messageId?:string;references:ReviewArtifactReference[]}) {
  if (!value.references.some(item=>item.assetId)) return;
  const id='topic-images:'+value.id;
  const current=await context.paseo.agents.ref(agentId).timeline.refetch({limit:100});
  if(current.error)throw Error('topic_media_history_unavailable');
  const api=context.pluginPaseo||context.paseo;
  const original = current.entries.findIndex(entry => entry.item.type === 'plugin' && entry.item.id === id);
  const message = value.messageId ? current.entries.findIndex(entry => entry.item.type === 'user_message'
    && (entry.item.messageId === value.messageId || entry.item.clientMessageId === value.messageId)) : -1;
  const replacement = current.entries.some(entry => entry.item.type === 'plugin' && entry.item.id === id + ':after');
  const earlier = original >= 0 && message > original;
  // Preserve old timeline identities. A display-only replacement repairs an
  // earlier media row without dispatching the already accepted prompt again.
  if (original < 0 || earlier && !replacement) await api.agents.ref(agentId).timeline.append({
    type:'plugin',id:earlier ? id + ':after' : id,kind:topicChatMediaKind,version:1,
    data:{projectConfig:route.configPath,materialId:value.id,...(value.messageId?{messageId:value.messageId}:{})},
  });
  if (earlier) {
    const item = current.entries[original].item;
    if (item.type === 'plugin' && item.data && typeof item.data === 'object' && !Array.isArray(item.data) && !item.data.hidden) {
      await api.agents.ref(agentId).timeline.append({type:'plugin',id:item.id,kind:item.kind,version:item.version,data:{...item.data,hidden:true}});
    }
  }
}

/** Frozen originals remain readable after the archive connection is changed or disabled. */
function selectedReferences(route:ProjectRoute,input:TopicChatMedia&{agentId:string}) {
  const name=createHash('sha256').update(input.materialId).digest('hex')+'.json';
  const stored=JSON.parse(readFileSync(join(route.stateRoot,'extensions','topic-materials',name),'utf8'));
  if(stored.id!==input.materialId || (stored.targetAgentId||stored.agentId)!==input.agentId || !['sending','uncertain','accepted'].includes(stored.state)) throw Error('topic_media_outside_session');
  return (stored.references||[]) as ReviewArtifactReference[];
}
export function readTopicChatMedia(route:ProjectRoute,input:TopicChatMedia&{agentId:string;assetId?:string}) {
  const references=selectedReferences(route,input);
  if(input.assetId){
    if(!references.some(item=>item.assetId===input.assetId&&(item.mimeType?.startsWith('image/')||item.mimeType?.startsWith('video/'))))throw Error('topic_media_outside_selection');
    return withProject({projectConfig:route.configPath},()=>{
      const asset=readStoredArtifact(input.assetId!);
      if(!asset.metadata.mimeType.startsWith('image/')&&!asset.metadata.mimeType.startsWith('video/'))throw Error('topic_media_not_media');
      if(asset.metadata.mimeType.startsWith('video/')&&asset.metadata.size>MAX_INLINE_VIDEO_BYTES)throw Error('topic_video_inline_unavailable');
      return {mimeType:asset.metadata.mimeType,base64:asset.bytes.toString('base64')};
    });
  }
  const videos:TopicChatVideo[]=[];
  const frames=new Set<string>();
  const name=createHash('sha256').update(input.materialId).digest('hex')+'.json';
  const stored=JSON.parse(readFileSync(join(route.stateRoot,'extensions','topic-materials',name),'utf8'));
  for(const video of (stored.videoMaterials||[]) as TopicStoredVideo[]) {
    const reference=references.find(item=>item.assetId===video.assetId&&item.mimeType?.startsWith('video/'));
    if(!reference||video.frames.some(frame=>!references.some(item=>item.assetId===frame.assetId&&item.mimeType?.startsWith('image/'))))throw Error('topic_media_outside_selection');
    videos.push({...video,mimeType:reference.mimeType!});for(const frame of video.frames)frames.add(frame.assetId);
  }
  const images:TopicChatImage[]=[],seen=new Set<string>();
  for(const item of references.filter(item=>item.assetId&&!frames.has(item.assetId)&&item.mimeType?.startsWith('image/'))){
    const stored=withProject({projectConfig:route.configPath},()=>readStoredArtifact(item.assetId!));
    const hash=createHash('sha256').update(stored.bytes).digest('hex');
    if(seen.has(hash))continue;seen.add(hash);
    images.push({assetId:item.assetId!,name:item.title||'图片',mimeType:stored.metadata.mimeType});
  }
  const files = references.filter(item=>item.assetId&&!item.mimeType?.startsWith('image/')&&!item.mimeType?.startsWith('video/')).map(item=>{
    const asset=withProject({projectConfig:route.configPath},()=>storedArtifactFileDescriptor(item.assetId!));
    return {assetId:item.assetId!,name:asset.fileName,mimeType:asset.mimeType,size:asset.size,available:true};
  });
  return {images,videos,files};
}

export function readTopicChatFile(route:ProjectRoute,input:TopicChatMedia&{agentId:string;assetId:string}) {
  const references=selectedReferences(route,input);
  if(!references.some(item=>item.assetId===input.assetId&&!item.mimeType?.startsWith('image/')&&!item.mimeType?.startsWith('video/')))throw Error('topic_media_outside_selection');
  return withProject({projectConfig:route.configPath},()=>storedArtifactFileDescriptor(input.assetId));
}
