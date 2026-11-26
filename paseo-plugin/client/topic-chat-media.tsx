import {useCallback,useEffect,useState} from 'react';
import {ActivityIndicator,Image,Platform,Pressable,Text,View,useWindowDimensions} from 'react-native';
import {useRpc,type PluginTimelineItemProps} from '@getpaseo/plugin/client';
import {type TopicChatMedia,type TopicChatImage,type TopicChatVideo} from '../shared/topic-chat-media';
import {topicChatMediaRpc} from '../shared/topic-chat-media-rpc';
import {chatMediaRpc,type ChatMedia,type ChatMediaFile} from '../shared/chat-media';
import {saveChatMediaFile} from './save-chat-media';
import type {ChatMediaChunk,ChatMediaDownload} from '../shared/chat-media-limits';
import {Icon,ScrollView} from './native-components';
import {TopicVideoPlayer,TopicVideoFrames,TopicVideoFile} from './topic-video';
import {videoTime,videoFileSize,MAX_INLINE_VIDEO_BYTES} from '../shared/topic-video';
import {CommunicationsTheme,Dialog,Button,Label} from './extensions/project-communications/ui';

/** The host's user-message transcript is text-only; this row preserves the
 * same images visibly without adding URLs or archive instructions to the prompt. */
export function TopicChatImages({agentId,item,theme}:PluginTimelineItemProps<TopicChatMedia>) {
  const rpc=useRpc(topicChatMediaRpc),{projectConfig,materialId}=item.data;
  const load=useCallback((assetId?:string)=>rpc({projectConfig,materialId,agentId,...(assetId?{assetId}:{})}),[rpc,projectConfig,materialId,agentId]);
  const save=useCallback((file:ChatMediaFile)=>saveChatMediaFile(file,
    async()=>await rpc({projectConfig,materialId,agentId,assetId:file.assetId,action:'download'}) as ChatMediaDownload,
    async(offset,revision)=>await rpc({projectConfig,materialId,agentId,assetId:file.assetId,action:'chunk',offset,revision}) as ChatMediaChunk),[rpc,projectConfig,materialId,agentId]);
  return item.data.hidden?null:<ChatMediaGallery theme={theme} load={load} save={save}/>;
}
export function SessionChatMedia({agentId,item,theme}:PluginTimelineItemProps<ChatMedia>) {
  const rpc=useRpc(chatMediaRpc),{receiptId,messageId}=item.data;
  const load=useCallback((assetId?:string)=>rpc({receiptId,messageId,agentId,action:'read',...(assetId?{assetId}:{})}),[rpc,receiptId,messageId,agentId]);
  const save=useCallback((file:ChatMediaFile)=>saveChatMediaFile(file,
    async()=>await rpc({receiptId,messageId,agentId,assetId:file.assetId,action:'download'}) as ChatMediaDownload,
    async(offset,revision)=>await rpc({receiptId,messageId,agentId,assetId:file.assetId,action:'chunk',offset,revision}) as ChatMediaChunk),[rpc,receiptId,messageId,agentId]);
  return <ChatMediaGallery theme={theme} load={load} save={save}/>;
}
function ChatMediaGallery({theme,load,save}:{theme:PluginTimelineItemProps['theme'];load(assetId?:string):Promise<unknown>;save?(file:ChatMediaFile):Promise<void>}) {
  const window=useWindowDimensions();
  const [videos,setVideos]=useState<TopicChatVideo[]>([]),[images,setImages]=useState<TopicChatImage[]>([]),[uris,setUris]=useState<Record<string,string>>({});
  const [files,setFiles]=useState<ChatMediaFile[]>([]),[saving,setSaving]=useState(''),[fileError,setFileError]=useState(false);
  const [unavailable,setUnavailable]=useState<Set<string>>(()=>new Set());
  const [failed,setFailed]=useState(false),[revision,setRevision]=useState(0),[open,setOpen]=useState('');
  useEffect(()=>{
    let active=true;
    setFailed(false);setImages([]);setVideos([]);setFiles([]);setUris({});setUnavailable(new Set());
    void (async()=>{
      const result=await load() as {images:TopicChatImage[];videos?:TopicChatVideo[];files?:ChatMediaFile[]};
      if(!active)return;setImages(result.images);setVideos(result.videos||[]);setFiles(result.files||[]);
      const thumbnails=[...result.images,...(result.videos||[]).flatMap(video=>video.frames.slice(0,1))];
      for(let offset=0;offset<thumbnails.length;offset+=2){
        await Promise.all(thumbnails.slice(offset,offset+2).map(async image=>{
          try {
            const data=await load(image.assetId) as {mimeType:string;base64:string};
            if(active)setUris(current=>({...current,[image.assetId]:'data:'+data.mimeType+';base64,'+data.base64}));
          } catch {if(active){setFailed(true);setUnavailable(current=>new Set(current).add(image.assetId));}}
        }));
        if(!active)return;
      }
    })().catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[load,revision]);
  const video=videos.find(video=>video.assetId===open);
  useEffect(()=>{
    if(!video)return;
    let active=true;
    void (async()=>{
      const original = (video.size ?? 0) <= MAX_INLINE_VIDEO_BYTES ? [video.assetId] : [];
      for(const assetId of [...original,...video.frames.map(frame=>frame.assetId)]) {
        if(uris[assetId])continue;
        const data=await load(assetId) as {mimeType:string;base64:string};
        if(!active)return;setUris(current=>({...current,[assetId]:'data:'+data.mimeType+';base64,'+data.base64}));
      }
    })().catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[video,load,revision]);
  const width=Math.max(100,Math.min(260,window.width-80));
  return <CommunicationsTheme theme={theme}><View testID="topic-chat-images" style={{alignSelf:'flex-end',maxWidth:'100%',gap:8,paddingVertical:4}}>
    {images.length||videos.length||files.length?<Text testID="chat-media-receipt-status" style={{fontSize:11,color:theme.colors.foregroundMuted,textAlign:'right'}}>
      {'已发送 · '+[images.length?images.length+' 张图片':'',videos.length?videos.length+' 个视频':'',files.length?files.length+' 个附件':''].filter(Boolean).join(' · ')}
    </Text>:null}
    <View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'flex-end',gap:8}}>
      {images.map((image,index)=><Pressable key={image.assetId} accessibilityRole="button" accessibilityLabel={'查看所选图片 '+(index+1)}
        disabled={!uris[image.assetId]} onPress={()=>setOpen(image.assetId)} style={{width,height:180,borderRadius:8,overflow:'hidden',backgroundColor:theme.colors.surface1}}>
        {uris[image.assetId]?<Image source={{uri:uris[image.assetId]}} accessibilityLabel={'所选图片 '+(index+1)} resizeMode="contain" style={{width:'100%',height:'100%'}} onError={()=>{
          setFailed(true);setUnavailable(current=>new Set(current).add(image.assetId));setUris(current=>{const next={...current};delete next[image.assetId];return next;});
        }}/>
          :unavailable.has(image.assetId)?<View style={{flex:1,padding:12,justifyContent:'center',alignItems:'center',gap:6}}>
            <Icon name="Image" size={24} color={theme.colors.foregroundMuted}/><Label>{image.name}</Label><Label muted>预览暂不可用</Label>
          </View>:<ActivityIndicator style={{flex:1}} color={theme.colors.foregroundMuted}/>}
      </Pressable>)}
      {videos.map((video,index)=><Pressable key={video.assetId} testID="topic-chat-video" accessibilityRole="button" accessibilityLabel={'查看所选视频 '+(index+1)}
        onPress={()=>setOpen(video.assetId)} style={{width,height:180,borderRadius:8,overflow:'hidden',backgroundColor:theme.colors.surface1,alignItems:'center',justifyContent:'center'}}>
        {uris[video.frames[0]?.assetId]?<Image source={{uri:uris[video.frames[0].assetId]}} accessibilityLabel={'所选视频 '+(index+1)} resizeMode="contain" style={{width:'100%',height:'100%'}}/>:null}
        <View style={{position:'absolute',padding:8,borderRadius:24,backgroundColor:'#0009'}}><Icon name={video.frames.length ? 'Play' : 'Video'} size={28} color="#fff"/></View>
        <View style={{position:'absolute',bottom:6,left:6,right:6,gap:2}}>
          <Text numberOfLines={2} style={{fontSize:11,color:theme.colors.foreground}}>{video.name}</Text>
          <Label muted>{[videoFileSize(video.size),video.duration>0 ? videoTime(video.duration) : '原视频'].filter(Boolean).join(' · ')}</Label>
        </View>
      </Pressable>)}
      {files.map(file=><View key={file.assetId} testID="chat-media-file" style={{maxWidth:320,padding:12,borderRadius:6,borderWidth:1,borderColor:theme.colors.border,gap:6}}>
        <View style={{flexDirection:'row',alignItems:'center',gap:8}}><Icon name="FileText" size={20} color={theme.colors.foregroundMuted}/><Label>{file.name}</Label></View>
        <Label muted>{videoFileSize(file.size)}</Label>
        {save&&file.available&&Platform.OS==='web'?<Button icon="Download" disabled={Boolean(saving)} onPress={()=>{
          setSaving(file.assetId);setFileError(false);void save(file).catch(()=>setFileError(true)).finally(()=>setSaving(''));
        }}>{saving===file.assetId?'正在准备':'保存附件'}</Button>:null}
      </View>)}
      {!images.length&&!videos.length&&!files.length&&!failed?<ActivityIndicator color={theme.colors.foregroundMuted}/>:null}
    </View>
    {failed?<Label muted>附件已发送，预览暂不可用</Label>:null}
    {fileError?<Label muted>暂时无法保存附件，请重试</Label>:null}
    {failed?<Button icon="RefreshCw" onPress={()=>setRevision(value=>value+1)}>重新加载附件</Button>:null}
    {open?<Dialog title={video?'视频':'图片'} onClose={()=>setOpen('')} width={900} height={760}>
      {video?<ScrollView contentContainerStyle={{padding:16,gap:14}}>
        {uris[open]?<TopicVideoPlayer uri={uris[open]} poster={uris[video.frames[0]?.assetId]}/>
          : video.size && video.size>MAX_INLINE_VIDEO_BYTES || !video.frames.length ? <TopicVideoFile name={video.name} size={video.size} message="原视频已随材料发送"/> : <ActivityIndicator/>}
        <TopicVideoFrames video={{duration:video.duration,error:video.error,frames:video.frames.filter(frame=>uris[frame.assetId]).map(frame=>({time:frame.time,mimeType:'image/jpeg',base64:uris[frame.assetId].split(',')[1]}))}}/>
      </ScrollView>:<Image source={{uri:uris[open]}} accessibilityLabel="所选原图" resizeMode="contain" style={{flex:1,width:'100%'}}/>}
    </Dialog>:null}
  </View></CommunicationsTheme>;
}
