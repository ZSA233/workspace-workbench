import {useEffect,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
import type {OrganizerJob,OrganizerSnapshot,OrganizerStage} from '../shared/organizer';
import {SettingButton,SettingCard,SettingHeading,SettingPill,SettingText,SettingsSurface,type SettingsTheme} from './settings/ui';
import {ModelRunInspector} from './organizer-run';
import {organizerErrorLabel} from './organizer-errors';
const stages:Record<OrganizerStage,string>={queued:'排队',discovering:'关联检查',materials:'读取材料',fetching:'获取生产引用','model-queued':'等待模型',checking:'检查模型',requesting:'模型生成',validating:'结果校验',complete:'模型已返回',failed:'模型失败',conversation:'读取会话',titles:'更新标题',finished:'已结束'};
const purposes={refresh:'关联与生产检查',production:'生产核验',analysis:'生成预览',regenerate:'重新生成预览'};
const reasons={'automatic-off':'自动维护关闭','production-only':'Git 核验',cached:'命中缓存','no-material':'缺少材料','no-profile':'未配置模型',interval:'间隔未到',scope:'范围外'};
const active=(job:OrganizerJob)=>job.state==='running'||job.state==='queued';
export function OrganizerJobs({snapshot,call,theme,onChanged,preferredJobId,history=false,workspaceId,hideCompleted=false}:{snapshot?:OrganizerSnapshot;call(request:any):Promise<unknown>;theme:SettingsTheme;onChanged():void;preferredJobId?:string;history?:boolean;workspaceId?:string;hideCompleted?:boolean}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[,tick]=useState(0);
  const jobs=(snapshot?.jobs||[]).filter(j=>!workspaceId||j.id===preferredJobId||j.workspaceIds.includes(workspaceId)),job=jobs.find(j=>j.id===preferredJobId)||jobs.find(active)||jobs.find(j=>j.kind&&j.kind!=='refresh');
  const running=job&&active(job),queued=jobs.filter(j=>j.state==='queued').length;
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>tick(t=>t+1),1000);return()=>clearInterval(timer);},[running]);
  const run=(request:any)=>{setError('');setBusy(true);void call(request).then(onChanged).catch(e=>setError(e.message)).finally(()=>setBusy(false));};
  if(!job)return null;
  const failed=job.state==='failed'||!!job.result?.failed,cancelled=job.state==='cancelled'||job.state==='interrupted',model=job.model;
  const empty=(job.kind==='analysis'||job.kind==='regenerate')&&job.state==='complete'&&!(job.result?.analyzed||job.result?.cached||job.result?.conversations);
  const outcome=cancelled?'已停止':failed?'有失败项':empty?job.total?'未生成':'范围为空':job.kind==='production'?'核验结束':'已完成';
  if(hideCompleted&&!running&&!failed&&!cancelled&&!empty)return null;
  const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(model?.requestedAt&&model.state==='requesting'?model.requestedAt:job.stageAt||job.startedAt||job.createdAt))/1000));
  const time=elapsed<60?`00:${String(elapsed).padStart(2,'0')}`:`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
  return <View style={{gap:10}}><SettingsSurface theme={theme} testID="organizer-task">
    <View style={{flexDirection:'row',alignItems:'center',gap:9}}>{running?<ActivityIndicator size="small" color={job.kind==='production'?theme.colors.foregroundMuted:'#669878'}/>:null}<View style={{flex:1,minWidth:0}}><SettingHeading small theme={theme}>{job.cancelRequestedAt&&running?'正在取消':job.state==='queued'?'等待前序任务':job.kind?purposes[job.kind]:'历史任务'}</SettingHeading></View><SettingPill theme={theme} tone={failed||empty?'amber':cancelled?'muted':running?'blue':'green'}>{running?job.stage?stages[job.stage]:'进行中':outcome}</SettingPill></View>
    {job.current?.name?<Text numberOfLines={1} style={{color:theme.colors.foreground,fontSize:12}}>{job.current.name}{job.current.repository?' / '+job.current.repository:''}</Text>:null}
    <View accessibilityRole="progressbar" accessibilityValue={job.total?{min:0,max:job.total,now:job.completed}:undefined} style={{height:4,borderRadius:5,backgroundColor:theme.colors.surface2,overflow:'hidden'}}><View style={{height:4,width:`${job.total?Math.min(100,job.completed/job.total*100):0}%`,backgroundColor:failed?'#c09a54':job.kind==='production'?theme.colors.foregroundMuted:'#82b58d'}}/></View>
    <View style={{flexDirection:'row',gap:12,alignItems:'center',flexWrap:'wrap'}}>{job.total?<SettingPill theme={theme}>{job.completed} / {job.total} 工作区</SettingPill>:null}{model?<SettingPill theme={theme} tone={model.state==='requesting'?'green':'muted'}>{model.calls?`模型 ${model.completed} / ${model.calls}`:model.reason?reasons[model.reason]:'模型未请求'}</SettingPill>:null}{queued?<SettingPill theme={theme}>排队 {queued}</SettingPill>:null}{running?<Text style={{color:theme.colors.foregroundMuted,fontSize:11,fontFamily:'monospace'}}>{time}{model?.state==='requesting'&&model.timeoutMs?' / '+Math.floor(model.timeoutMs/1000)+'s':''}</Text>:null}</View>
    {model?.state==='requesting'||model?.state==='checking'||model?.state==='queued'?<Text numberOfLines={2} style={{color:theme.colors.foregroundMuted,fontSize:11}}>{model.name} · {model.model}</Text>:null}
    {!running&&job.result?<View style={{flexDirection:'row',gap:6,flexWrap:'wrap'}}>{job.result.analyzed?<SettingPill theme={theme} tone="green">新预览 {job.result.analyzed}</SettingPill>:null}{job.result.cached?<SettingPill theme={theme}>缓存 {job.result.cached}</SettingPill>:null}{job.result.skipped?<SettingPill theme={theme}>跳过 {job.result.skipped}</SettingPill>:null}{job.result.failed?<SettingPill theme={theme} tone="amber">失败 {job.result.failed}</SettingPill>:null}<SettingPill theme={theme}>标题写入 {job.result.titleWrites}</SettingPill></View>:null}
    {running?<View style={{alignSelf:'flex-end'}}><SettingButton theme={theme} compact quiet disabled={busy||!!job.cancelRequestedAt} onPress={()=>run({action:'cancel',jobId:job.id})}>{job.kind==='production'?'停止核验':'取消生成'}</SettingButton></View>:null}
    {error||job.error?<SettingText theme={theme} error>{organizerErrorLabel(error||job.error||'')}</SettingText>:null}
    <ModelRunInspector runId={model?.runId} call={call} theme={theme} live={running}/>
    {cancelled&&job.options?<SettingButton theme={theme} compact disabled={busy} onPress={()=>run({action:'resume',jobId:job.id})}>重新核验并继续</SettingButton>:null}
  </SettingsSurface>
  {history?<SettingCard title="任务与阶段记录" theme={theme} collapsed>{jobs.slice(0,12).map(j=><View key={j.id} style={{gap:5,borderBottomWidth:1,borderBottomColor:theme.colors.border,paddingVertical:7}}><SettingText theme={theme}>{new Date(j.createdAt).toLocaleString()} · {j.kind?purposes[j.kind]:'旧任务'} · {j.state}</SettingText>{j.events?.map((event,i)=><SettingText theme={theme} key={i}>{new Date(event.at).toLocaleTimeString()} · {stages[event.stage]}{event.message?' · '+event.message:''}</SettingText>)}</View>)}</SettingCard>:null}
  </View>;
}
