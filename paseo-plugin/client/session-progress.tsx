import {useEffect,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
import {Icon,ScrollView} from './native-components';
import {Button,Dialog,Label,Row,Section,useColors} from './extensions/project-communications/ui';
import type {OrganizerInput,OrganizerJob,OrganizerRun} from '../shared/organizer';
import {sessionJobProgress,sessionStageLabels} from '../shared/session-progress';
import {organizerErrorLabel} from './organizer-errors';

type Props={job?:OrganizerJob;foreground:boolean;error?:string;call<T>(request:OrganizerInput['request']):Promise<T>;onRetry():void;onCancel():void};
export function SessionProgress({job,foreground,error,call,onRetry,onCancel}:Props){
  const c=useColors(),[now,setNow]=useState(Date.now()),[open,setOpen]=useState(false),[run,setRun]=useState<OrganizerRun|null>(),[runError,setRunError]=useState('');
  const running=job?.state==='running'||job?.state==='queued';
  useEffect(()=>{if(!foreground||!running)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[foreground,running,job?.id]);
  useEffect(()=>{if(!open)return;let alive=true;setRunError('');if(!job?.model?.runId){setRun(undefined);return;}void call<OrganizerRun|null>({action:'run',runId:job.model.runId}).then(value=>{if(alive)setRun(value);}).catch(e=>{if(alive)setRunError(e.message);});return()=>{alive=false;};},[open,job?.model?.runId,job?.model?.state,call]);
  if(!job&&!error)return null;
  const view=job?sessionJobProgress(job,now):undefined,color=error||job?.state==='failed'||job?.result?.previewStale?c.statusWarning:job?.result?.previewReady?c.statusSuccess:c.foregroundMuted;
  const mapped=error?organizerErrorLabel(error):'',errorLabel=mapped===error&&(!/[\u3400-\u9fff]/.test(mapped)||mapped.startsWith('['))?'处理未完成，请查看过程或重试':mapped;
  const input=job?.input,source=input?.workspaces.reduce((a,w)=>({repositories:a.repositories+w.repositories,commits:a.commits+w.commits,notes:a.notes+w.notes,diffs:a.diffs+w.diffs}),{repositories:0,commits:0,notes:0,diffs:0});
  const modelSeconds=running&&job?.model?.requestedAt&&['requesting','validating'].includes(job.model.state)?Math.max(0,(now-Date.parse(job.model.requestedAt))/1000):run?.elapsedMs!==undefined?run.elapsedMs/1000:undefined;
  return <View testID="session-progress" style={{gap:5,minWidth:0}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:7,minWidth:0}}>{running?<ActivityIndicator size="small" color={c.accent}/>:<Icon name={error||job?.state==='failed'||job?.result?.previewStale?'CircleAlert':job?.result?.previewReady?'CircleCheck':'Info'} size={14} color={color}/>}<Text style={{fontSize:12,color:c.foreground,flex:1,minWidth:0}}>{view?.label||'上次处理未完成'}</Text>{view?<Text style={{fontSize:11,color:c.foregroundMuted,fontVariant:['tabular-nums']}}>{view.seconds} 秒</Text>:null}<Button variant="link" onPress={()=>setOpen(true)}>查看过程</Button></View>
    {view?.detail?<Text numberOfLines={2} style={{fontSize:11,lineHeight:17,color:c.foregroundMuted}}>{view.detail}</Text>:null}
    {error?<Row><Label warning>{errorLabel}</Label><Button variant="link" onPress={onRetry}>重试</Button></Row>:null}
    {open?<Dialog id="session-process" title="本次处理" compact width={460} height={650} onClose={()=>setOpen(false)} footer={<Row end>{running?<Button disabled={!!job?.cancelRequestedAt} onPress={onCancel}>{job?.cancelRequestedAt?'取消中…':'取消本次处理'}</Button>:error?<Button onPress={onRetry}>重试</Button>:null}<Button onPress={()=>setOpen(false)}>关闭</Button></Row>}>
      <ScrollView style={{flexGrow:0,flexShrink:1}} contentContainerStyle={{padding:16,gap:12,minWidth:0}}>
        <Row><Label strong>{view?.label||'上次处理未完成'}</Label><Label muted>{view?.seconds||0} 秒</Label></Row>
        {source?<View style={{gap:5}}><Label strong>输入资料</Label>{input!.workspaces.length?<><Label>{input!.workspaces.length} 个工作区 · {source.repositories} 个仓库</Label><Label muted>{source.commits} 个自身提交 · {source.diffs} 份差异 · {source.notes} 条改动说明</Label></>:<Label muted>{running?'正在读取工作区资料…':'尚未读取工作区资料'}</Label>}{input!.workspaces.map(w=><View key={w.id} style={{gap:2,paddingTop:4}}><Label lines={2}>{w.name}</Label><Label muted>{w.commits} 个提交 · {w.updated?'摘要已更新':w.cached?'沿用已有摘要':!w.commits?'无独立提交，暂不生成':running?'待更新摘要':'摘要未更新'}</Label></View>)}<Label muted>会话记录：{input!.history.pages} 页 · {input!.history.fragments} 个公开片段{input!.history.sentFragments!==undefined?' · 模型采用 '+input!.history.sentFragments+' 个':''}{input!.history.pages?input!.history.complete?' · 本批已覆盖':' · 历史部分覆盖':''}</Label></View>:null}
        <View style={{gap:5,borderTopWidth:1,borderTopColor:c.border,paddingTop:10}}><Label strong>本地模型</Label><Label>{job?.model?.model||'尚未请求'}</Label><Label muted>{job?.model?.calls||0} 次请求 · {job?.model?.completed||0} 次通过校验{modelSeconds!==undefined?' · '+modelSeconds.toFixed(1)+' 秒':''}</Label></View>
        {error?<Label warning>{errorLabel}</Label>:null}
        {run?.contextBudget?<Section title="输入容量" collapsible initiallyOpen={false}><Label muted>单次上限 {run.contextBudget.contextTokens} tokens · 输出预留 {run.contextBudget.outputTokens}</Label><Label muted>提示词 {run.contextBudget.promptBytes} B · 资料 {run.contextBudget.inputBytes} B（按字节保守控制）</Label><Label muted>工作区证据 {run.contextBudget.selectedSources}/{run.contextBudget.totalSources} · 会话片段 {run.contextBudget.selectedFragments}/{run.contextBudget.totalFragments}</Label></Section>:null}
        <Section title="处理记录" collapsible initiallyOpen={false}>{job?.diagnostic?<Label muted>Git {((job.diagnostic.factsMs||0)/1000).toFixed(1)} 秒 · 材料 {((job.diagnostic.materialsMs||0)/1000).toFixed(1)} 秒 · 写入 {((job.diagnostic.writeMs||0)/1000).toFixed(1)} 秒</Label>:null}{run?.timings?<Label muted>排队 {(run.timings.queueMs/1000).toFixed(1)} 秒 · 连接 {(run.timings.connectionMs/1000).toFixed(1)} 秒 · 请求 {(run.timings.requestMs/1000).toFixed(1)} 秒 · 校验 {(run.timings.validationMs/1000).toFixed(1)} 秒</Label>:null}{job?.events?.map((event,i)=><View key={i} style={{gap:2,paddingVertical:3}}><Label>{sessionStageLabels[event.stage]||event.stage}</Label><Label muted>{new Date(event.at).toLocaleTimeString()}{['production','fetching'].includes(event.stage)&&event.current?.repository?' · '+event.current.repository+(event.current.ref?' / '+event.current.ref:''):event.stage==='conversation'&&event.current?.page?' · 第 '+event.current.page+' 页':''}</Label></View>)}</Section>
        {runError?<Label warning>{runError}</Label>:run?<><Section title="模型实际输入" collapsible initiallyOpen={false}><Text selectable style={{color:c.foregroundMuted,fontSize:11,lineHeight:17}}>{run.input}</Text></Section><Section title="模型实际输出" collapsible initiallyOpen={false}><Text selectable style={{color:c.foregroundMuted,fontSize:11,lineHeight:17}}>{run.output||'等待模型返回'}</Text></Section><Section title="来源映射与提示词" collapsible initiallyOpen={false}><Text selectable style={{color:c.foregroundMuted,fontSize:11,lineHeight:17}}>{JSON.stringify(run.references||{},null,2)+'\n'+run.prompt+(run.error?'\n'+run.error:'')}</Text></Section></>:null}
      </ScrollView>
    </Dialog>:null}
  </View>;
}
