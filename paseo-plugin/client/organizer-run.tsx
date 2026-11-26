import {useState} from 'react';
import {View} from 'react-native';
import {useQuery} from '@tanstack/react-query';
import type {OrganizerRun} from '../shared/organizer';
import {SettingButton,SettingCard,SettingPill,SettingText,type SettingsTheme} from './settings/ui';
export function ModelRunView({run,theme}:{run:OrganizerRun;theme:SettingsTheme}) {
  return <View style={{gap:10,minWidth:0}}><View style={{flexDirection:'row',flexWrap:'wrap',gap:6}}><SettingPill theme={theme} tone={run.error?'amber':run.state==='complete'?'green':'muted'}>{run.error?'未采纳':run.state==='complete'?'已返回':run.state==='requesting'?'请求中':'模型记录'}</SettingPill><SettingPill theme={theme}>{((run.elapsedMs||0)/1000).toFixed(1)} 秒</SettingPill>{run.usage?.total_tokens?<SettingPill theme={theme}>{String(run.usage.total_tokens)} tokens</SettingPill>:null}<SettingPill theme={theme} tone={run.truncated?'amber':'muted'}>{run.truncated?'输入有截断':'选中材料已输入'}</SettingPill></View>
    {run.model?<SettingText theme={theme}>{run.model}</SettingText>:null}{run.error?<SettingText theme={theme} error>{run.error}</SettingText>:null}
    <SettingCard title="实际输入与来源" theme={theme}><SettingText theme={theme}>{run.input}</SettingText></SettingCard>
    <SettingCard title="模型输出" theme={theme} collapsed><SettingText theme={theme}>{run.output||'—'}</SettingText></SettingCard>
    <SettingCard title="实际提示词" theme={theme} collapsed><SettingText theme={theme}>{run.prompt}</SettingText></SettingCard>
  </View>;
}
export function ModelRunInspector({runId,call,theme,live=false,initiallyOpen=false}:{runId?:string;call(request:any):Promise<unknown>;theme:SettingsTheme;live?:boolean;initiallyOpen?:boolean}) {
  const [open,setOpen]=useState(initiallyOpen);
  const query=useQuery({queryKey:['workbench-organizer-run',runId],queryFn:()=>call({action:'run',runId}) as Promise<OrganizerRun|null>,enabled:open&&!!runId,retry:false,refetchOnWindowFocus:false,refetchInterval:open&&live?1000:false});
  if(!runId)return null;
  return <View style={{gap:10}}><SettingButton theme={theme} quiet compact icon="Activity" onPress={()=>setOpen(v=>!v)}>{open?'收起实际输入与输出':'实际输入与输出'}</SettingButton>{open?(query.error?<SettingText theme={theme} error>{query.error.message}</SettingText>:query.data?<ModelRunView run={query.data} theme={theme}/>:<SettingText theme={theme}>{query.isPending?'读取记录…':'记录不可用'}</SettingText>):null}</View>;
}
