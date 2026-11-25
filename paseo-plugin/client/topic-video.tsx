import {createElement,useState} from 'react';
import {Image,Platform,Text,View} from 'react-native';
import {Icon} from './native-components';
import {Label,useColors} from './extensions/project-communications/ui';
import {videoTime,videoFileSize,type TopicVideoPreview} from '../shared/topic-video';

export function TopicVideoFile({name,size,message='可选择并发送原视频'}:{name:string;size?:number;message?:string}) {
  const c=useColors();
  return <View testID="topic-video-file" style={{padding:18,gap:8,alignItems:'center',backgroundColor:c.surface2,borderRadius:5}}>
    <Icon name="Video" size={32} color={c.foregroundMuted}/>
    <Label>{name}</Label>{size!==undefined?<Label muted>{videoFileSize(size)}</Label>:null}
    <Label muted>{message}</Label>
  </View>;
}

export function TopicVideoPlayer({uri,poster}:{uri:string;poster?:string}) {
  const [failed,setFailed]=useState(false);
  if(Platform.OS!=='web')return <Label muted>此客户端可查看下方画面；播放请使用 Web UI</Label>;
  return <View style={{gap:6}}>
    {createElement('video',{src:uri,poster,controls:true,playsInline:true,preload:'metadata','aria-label':'所选原视频','data-testid':'topic-video-player',
      style:{width:'100%',height:300,maxHeight:'45vh',backgroundColor:'#111',borderRadius:6},onError:()=>setFailed(true)})}
    {failed?<Label muted>此浏览器暂时无法播放，可查看画面或发送原视频</Label>:null}
  </View>;
}
export function TopicVideoFrames({video}:{video:TopicVideoPreview}) {
  const c=useColors();
  return <View testID="topic-video-frames" style={{gap:8}}>
    <Label muted>{video.frames.length ? '原视频 + '+video.frames.length+' 帧 · '+videoTime(video.duration)+' · 不含音频转写' : '画面预览暂不可用，可发送原视频'}</Label>
    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {video.frames.map((frame,index)=><View key={index} style={{width:132,gap:3}}>
        <Image source={{uri:'data:'+frame.mimeType+';base64,'+frame.base64}} accessibilityLabel={'视频画面 '+videoTime(frame.time)} resizeMode="contain" style={{width:132,height:88,backgroundColor:c.surface2,borderRadius:4}}/>
        <Text style={{color:c.foregroundMuted,fontSize:11}}>{videoTime(frame.time)}</Text>
      </View>)}
    </View>
  </View>;
}
