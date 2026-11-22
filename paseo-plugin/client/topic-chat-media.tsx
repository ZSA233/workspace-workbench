import {useEffect,useState} from 'react';
import {ActivityIndicator,Image,Pressable,View,useWindowDimensions} from 'react-native';
import {useRpc,type PluginTimelineItemProps} from '@getpaseo/plugin/client';
import {type TopicChatMedia,type TopicChatImage} from '../shared/topic-chat-media';
import {topicChatMediaRpc} from '../shared/topic-chat-media-rpc';
import {CommunicationsTheme,Dialog,Button} from './extensions/project-communications/ui';

/** The host's user-message transcript is text-only; this row preserves the
 * same images visibly without adding URLs or archive instructions to the prompt. */
export function TopicChatImages({agentId,item,theme}:PluginTimelineItemProps<TopicChatMedia>) {
  const rpc=useRpc(topicChatMediaRpc),window=useWindowDimensions();
  const [images,setImages]=useState<TopicChatImage[]>([]),[uris,setUris]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState(false),[revision,setRevision]=useState(0),[open,setOpen]=useState('');
  const {projectConfig,materialId}=item.data;
  useEffect(()=>{
    let active=true;
    setFailed(false);
    void (async()=>{
      const result=await rpc({projectConfig,materialId,agentId}) as {images:TopicChatImage[]};
      if(!active)return;setImages(result.images);
      for(let offset=0;offset<result.images.length;offset+=2){
        await Promise.all(result.images.slice(offset,offset+2).map(async image=>{
          const data=await rpc({projectConfig,materialId,agentId,assetId:image.assetId}) as {mimeType:string;base64:string};
          if(active)setUris(current=>({...current,[image.assetId]:'data:'+data.mimeType+';base64,'+data.base64}));
        }));
        if(!active)return;
      }
    })().catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[rpc,projectConfig,materialId,agentId,revision]);
  const width=Math.max(100,Math.min(260,window.width-80));
  return <CommunicationsTheme theme={theme}><View testID="topic-chat-images" style={{alignSelf:'flex-end',maxWidth:'100%',gap:8,paddingVertical:4}}>
    <View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'flex-end',gap:8}}>
      {images.map((image,index)=><Pressable key={image.assetId} accessibilityRole="button" accessibilityLabel={'查看所选图片 '+(index+1)}
        disabled={!uris[image.assetId]} onPress={()=>setOpen(image.assetId)} style={{width,height:180,borderRadius:8,overflow:'hidden',backgroundColor:theme.colors.surface1}}>
        {uris[image.assetId]?<Image source={{uri:uris[image.assetId]}} accessibilityLabel={'所选图片 '+(index+1)} resizeMode="contain" style={{width:'100%',height:'100%'}}/>
          :<ActivityIndicator style={{flex:1}} color={theme.colors.foregroundMuted}/>}
      </Pressable>)}
      {!images.length&&!failed?<ActivityIndicator color={theme.colors.foregroundMuted}/>:null}
    </View>
    {failed?<Button icon="RefreshCw" onPress={()=>setRevision(value=>value+1)}>重新加载图片</Button>:null}
    {open?<Dialog title="图片" onClose={()=>setOpen('')} width={900} height={760}>
      <Image source={{uri:uris[open]}} accessibilityLabel="所选原图" resizeMode="contain" style={{flex:1,width:'100%'}}/>
    </Dialog>:null}
  </View></CommunicationsTheme>;
}
