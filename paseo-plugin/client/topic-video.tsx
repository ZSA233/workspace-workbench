import {createElement,useState} from 'react';
import {Image,Platform,Text,View} from 'react-native';
import {Label,useColors} from './extensions/project-communications/ui';
import {videoTime,type TopicVideoPreview} from '../shared/topic-video';

export function TopicVideoPlayer({uri,poster}:{uri:string;poster?:string}) {
  const [failed,setFailed]=useState(false);
  if(Platform.OS!=='web')return <Label muted>此客户端可查看下方画面；播放请使用 Web UI</Label>;
  return <View style={{gap:6}}>
    {createElement('video',{src:uri,poster,controls:true,playsInline:true,preload:'metadata','aria-label':'所选原视频','data-testid':'topic-video-player',
      style:{width:'100%',height:300,maxHeight:'45vh',backgroundColor:'#111',borderRadius:6},onError:()=>setFailed(true)})}
    {failed?<Label warning>视频编码无法播放，可查看下方画面</Label>:null}
  </View>;
}
export function TopicVideoFrames({video}:{video:TopicVideoPreview}) {
  const c=useColors();
  return <View testID="topic-video-frames" style={{gap:8}}>
    <Label muted>{'原视频 + '+video.frames.length+' 帧 · '+videoTime(video.duration)+' · 不含音频转写'}</Label>
    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {video.frames.map((frame,index)=><View key={index} style={{width:132,gap:3}}>
        <Image source={{uri:'data:'+frame.mimeType+';base64,'+frame.base64}} accessibilityLabel={'视频画面 '+videoTime(frame.time)} resizeMode="contain" style={{width:132,height:88,backgroundColor:c.surface2,borderRadius:4}}/>
        <Text style={{color:c.foregroundMuted,fontSize:11}}>{videoTime(frame.time)}</Text>
      </View>)}
    </View>
  </View>;
}
