import {useEffect,useState} from 'react';
import {ActivityIndicator,Image,Pressable,View,useWindowDimensions} from 'react-native';
import {useRpc,type PluginTimelineItemProps} from '@getpaseo/plugin/client';
import {type TopicChatMedia,type TopicChatImage,type TopicChatVideo} from '../shared/topic-chat-media';
import {topicChatMediaRpc} from '../shared/topic-chat-media-rpc';
import {Icon,ScrollView} from './native-components';
import {TopicVideoPlayer,TopicVideoFrames} from './topic-video';
import {videoTime} from '../shared/topic-video';
import {CommunicationsTheme,Dialog,Button,Label} from './extensions/project-communications/ui';

/** The host's user-message transcript is text-only; this row preserves the
 * same images visibly without adding URLs or archive instructions to the prompt. */
export function TopicChatImages({agentId,item,theme}:PluginTimelineItemProps<TopicChatMedia>) {
  const rpc=useRpc(topicChatMediaRpc),window=useWindowDimensions();
  const [videos,setVideos]=useState<TopicChatVideo[]>([]),[images,setImages]=useState<TopicChatImage[]>([]),[uris,setUris]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState(false),[revision,setRevision]=useState(0),[open,setOpen]=useState('');
  const {projectConfig,materialId}=item.data;
  useEffect(()=>{
    let active=true;
    setFailed(false);
    void (async()=>{
      const result=await rpc({projectConfig,materialId,agentId}) as {images:TopicChatImage[];videos?:TopicChatVideo[]};
      if(!active)return;setImages(result.images);setVideos(result.videos||[]);
      const thumbnails=[...result.images,...(result.videos||[]).flatMap(video=>video.frames.slice(0,1))];
      for(let offset=0;offset<thumbnails.length;offset+=2){
        await Promise.all(thumbnails.slice(offset,offset+2).map(async image=>{
          const data=await rpc({projectConfig,materialId,agentId,assetId:image.assetId}) as {mimeType:string;base64:string};
          if(active)setUris(current=>({...current,[image.assetId]:'data:'+data.mimeType+';base64,'+data.base64}));
        }));
        if(!active)return;
      }
    })().catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[rpc,projectConfig,materialId,agentId,revision]);
  const video=videos.find(video=>video.assetId===open);
  useEffect(()=>{
    if(!video)return;
    let active=true;
    void (async()=>{
      for(const assetId of [video.assetId,...video.frames.map(frame=>frame.assetId)]) {
        if(uris[assetId])continue;
        const data=await rpc({projectConfig,materialId,agentId,assetId}) as {mimeType:string;base64:string};
        if(!active)return;setUris(current=>({...current,[assetId]:'data:'+data.mimeType+';base64,'+data.base64}));
      }
    })().catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[video,rpc,projectConfig,materialId,agentId,revision]);
  const width=Math.max(100,Math.min(260,window.width-80));
  return <CommunicationsTheme theme={theme}><View testID="topic-chat-images" style={{alignSelf:'flex-end',maxWidth:'100%',gap:8,paddingVertical:4}}>
    <View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'flex-end',gap:8}}>
      {images.map((image,index)=><Pressable key={image.assetId} accessibilityRole="button" accessibilityLabel={'查看所选图片 '+(index+1)}
        disabled={!uris[image.assetId]} onPress={()=>setOpen(image.assetId)} style={{width,height:180,borderRadius:8,overflow:'hidden',backgroundColor:theme.colors.surface1}}>
        {uris[image.assetId]?<Image source={{uri:uris[image.assetId]}} accessibilityLabel={'所选图片 '+(index+1)} resizeMode="contain" style={{width:'100%',height:'100%'}}/>
          :<ActivityIndicator style={{flex:1}} color={theme.colors.foregroundMuted}/>}
      </Pressable>)}
      {videos.map((video,index)=><Pressable key={video.assetId} testID="topic-chat-video" accessibilityRole="button" accessibilityLabel={'查看所选视频 '+(index+1)}
        onPress={()=>setOpen(video.assetId)} style={{width,height:180,borderRadius:8,overflow:'hidden',backgroundColor:theme.colors.surface1,alignItems:'center',justifyContent:'center'}}>
        {uris[video.frames[0]?.assetId]?<Image source={{uri:uris[video.frames[0].assetId]}} accessibilityLabel={'所选视频 '+(index+1)} resizeMode="contain" style={{width:'100%',height:'100%'}}/>:null}
        <View style={{position:'absolute',padding:8,borderRadius:24,backgroundColor:'#0009'}}><Icon name="Play" size={28} color="#fff"/></View>
        <View style={{position:'absolute',bottom:6,right:6}}><Label>{videoTime(video.duration)}</Label></View>
      </Pressable>)}
      {!images.length&&!videos.length&&!failed?<ActivityIndicator color={theme.colors.foregroundMuted}/>:null}
    </View>
    {failed?<Button icon="RefreshCw" onPress={()=>setRevision(value=>value+1)}>重新加载附件</Button>:null}
    {open?<Dialog title={video?'视频':'图片'} onClose={()=>setOpen('')} width={900} height={760}>
      {video?<ScrollView contentContainerStyle={{padding:16,gap:14}}>
        {uris[open]?<TopicVideoPlayer uri={uris[open]} poster={uris[video.frames[0]?.assetId]}/>:<ActivityIndicator/>}
        <TopicVideoFrames video={{duration:video.duration,frames:video.frames.filter(frame=>uris[frame.assetId]).map(frame=>({time:frame.time,mimeType:'image/jpeg',base64:uris[frame.assetId].split(',')[1]}))}}/>
      </ScrollView>:<Image source={{uri:uris[open]}} accessibilityLabel="所选原图" resizeMode="contain" style={{flex:1,width:'100%'}}/>}
    </Dialog>:null}
  </View></CommunicationsTheme>;
}
