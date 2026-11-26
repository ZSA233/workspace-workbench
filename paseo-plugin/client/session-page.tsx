import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,Text,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {ScrollView,Icon} from './native-components';
import {Button,CommunicationsTheme,Dialog,Label,Row,Toggle,useColors} from './extensions/project-communications/ui';
import {useOrganizer} from './use-organizer';
import {productionLabels,type OrganizerJob,type OrganizerRun} from '../shared/organizer';
import {sortWorkspacesByLatestCommit,type WorkspaceSummary} from './model';
import {organizerErrorLabel} from './organizer-errors';
function jobLabel(job:OrganizerJob|undefined){if(!job)return '读取资料…';const stage=job.stage;return stage==='materials'&&job.total?'读取 '+job.completed+'/'+job.total:({queued:'等待处理',discovering:'读取关联',fetching:'核对上线','model-queued':'等待模型',checking:'连接模型',requesting:'模型处理中',validating:'核对结果',titles:'更新标题'} as Record<string,string>)[stage||'']||'同步资料';}
function readableError(value:string){const label=organizerErrorLabel(value);return label===value?'更新未完成，请重试或检查模型设置':label;}

type Props={projectConfig:string;hostWorkspaceId:string;selectedWorkspaceId:string;foreground:boolean;theme:PluginWorkspacePanelProps['theme'];workspaces:WorkspaceSummary[];refreshNonce:number;onSelect(id:string):void;onModelSettings():void};
export function SessionPage(props:Props){return <CommunicationsTheme theme={props.theme}><SessionContent key={props.projectConfig+':'+props.hostWorkspaceId} {...props}/></CommunicationsTheme>;}
function SessionContent({projectConfig,hostWorkspaceId,selectedWorkspaceId,foreground,workspaces,refreshNonce,onSelect,onModelSettings}:Props){
  const c=useColors(),organizer=useOrganizer(projectConfig,foreground&&!!hostWorkspaceId,hostWorkspaceId),data=organizer.snapshot.data;
  const target=data?.targets.find(t=>t.id===hostWorkspaceId),session=target?.session,profile=organizer.settings.data?.effective.profileId;
  const [error,setError]=useState(''),[modal,setModal]=useState(false),[previewJob,setPreviewJob]=useState(''),[busy,setBusy]=useState(false),[evidence,setEvidence]=useState(false),[run,setRun]=useState<OrganizerRun|null>(),[runError,setRunError]=useState('');
  const generation=useRef(0),pendingJob=useRef('');
  const start=async(preview=false,force=false)=>{setError('');try{const job=await organizer.mutate<OrganizerJob>({action:'session.refresh',targetId:hostWorkspaceId,preview,force});return job.id;}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{if(foreground&&hostWorkspaceId)void start(false,refreshNonce>0);},[projectConfig,hostWorkspaceId,foreground,refreshNonce,profile]);
  useEffect(()=>()=>{generation.current++;if(pendingJob.current)void organizer.call({action:'cancel',jobId:pendingJob.current}).catch(()=>{});},[]);
  const jobs=data?.jobs.filter(j=>j.kind==='session'&&j.hostWorkspaceId===hostWorkspaceId)||[],active=jobs.find(j=>j.state==='running'||j.state==='queued'),job=jobs.find(j=>j.id===previewJob),ready=modal&&!!session?.preview&&!!job&&job.state==='complete'&&!busy;
  const close=()=>{if(busy)return;generation.current++;setModal(false);setEvidence(false);if(pendingJob.current)void organizer.mutate({action:'cancel',jobId:pendingJob.current}).catch(()=>{});pendingJob.current='';};
  const preview=async()=>{if(!profile){onModelSettings();return;}const token=++generation.current;setModal(true);setPreviewJob('');setEvidence(false);setRun(undefined);setRunError('');const id=await start(true);if(token!==generation.current){if(id)void organizer.mutate({action:'cancel',jobId:id}).catch(()=>{});return;}if(id){pendingJob.current=id;setPreviewJob(id);}};
  const toggle=(value:boolean)=>{if(value){void preview();return;}setBusy(true);setError('');void organizer.mutate({action:'session.automatic',targetId:hostWorkspaceId,enabled:false}).catch(e=>setError(e.message)).finally(()=>setBusy(false));};
  const linked=new Map((data?.workspaces||[]).map(w=>[w.material.workspaceId,w]));
  const rows=sortWorkspacesByLatestCommit((target?.workspaceKeys||[]).flatMap(key=>{const w=data?.workspaces.find(w=>w.key===key);if(!w)return [];const roster=workspaces.find(r=>r.id===w.material.workspaceId);return [{...roster,id:w.material.workspaceId,displayName:w.material.name,latestCommitAt:roster?.latestCommitAt||w.material.latestCommitAt||null} as WorkspaceSummary];}));
  const failure=error||(!active?session?.error||jobs[0]?.error:'')||organizer.snapshot.error?.message;
  const readRun=()=>{setEvidence(v=>!v);const runId=session?.preview?.runId||jobs[0]?.model?.runId;if(runId){setRunError('');void organizer.call<OrganizerRun|null>({action:'run',runId}).then(setRun).catch(e=>setRunError(e.message));}};
  const divider={borderBottomWidth:1,borderBottomColor:c.border} as const;
  if(!hostWorkspaceId)return <View style={{padding:12}}><Label muted>打开一个会话以查看关联工作区</Label></View>;
  return <View testID="workbench-session-tab" style={{flex:1,minWidth:0,minHeight:0}}>
    <ScrollView contentContainerStyle={{paddingBottom:16}}>
      <View style={{paddingHorizontal:12,paddingVertical:10,gap:7,...divider}}>
        <View style={{flexDirection:'row',alignItems:'flex-start',gap:8}}><Text numberOfLines={2} style={{flex:1,minWidth:0,color:c.foreground,fontSize:13,lineHeight:21}}>{target?.currentTitle||'当前会话'}</Text><Button variant="link" disabled={!target?.workspaceKeys.length||busy} onPress={()=>{void preview();}}>预览标题</Button></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}}><Label>自动更新标题</Label><Toggle label="自动更新标题" hideLabel checked={session?.enabled===true} disabled={!target?.workspaceKeys.length||busy} onChange={toggle}/></View>
        {session?.paused?<Row><Icon name="CircleAlert" size={13} color={c.statusWarning}/><Label warning>{session.paused}</Label></Row>:null}
      </View>
      <View style={{paddingHorizontal:12,paddingVertical:9,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:7,...divider}}><Label muted>关联工作区 {rows.length}</Label>{active?<Row><ActivityIndicator size="small" color={c.accent}/><Label muted>{jobLabel(active)}</Label></Row>:null}</View>
      {rows.map(row=>{const w=linked.get(row.id)!,own=w.material.evidence.some(e=>e.kind==='commit'),digest=own?w.digest:undefined,title=w.manual?w.title:digest?.title||w.material.name,brief=w.manual?w.brief:digest?.brief,selected=row.id===selectedWorkspaceId,state=w.material.state,color=state==='deployed'?c.statusSuccess:state==='unknown'||state==='partial'?c.statusWarning:state==='pending'?c.accent:c.foregroundMuted;
        return <Pressable key={w.key} testID={'session-workspace-'+row.id} accessibilityRole="button" accessibilityLabel={'打开工作区：'+w.material.name} onPress={()=>onSelect(row.id)} style={({hovered,pressed}:any)=>({paddingVertical:11,paddingLeft:9,paddingRight:12,borderLeftWidth:3,borderLeftColor:selected?c.accent:'transparent',backgroundColor:selected||hovered||pressed?c.surface2:c.surface0,...divider})}>
          <View style={{flexDirection:'row',alignItems:'center',gap:9}}><View style={{flex:1,minWidth:0,gap:4}}><View style={{flexDirection:'row',gap:8,alignItems:'center',flexWrap:'wrap'}}><Text numberOfLines={1} style={{color:c.foreground,fontSize:13,fontWeight:'600',flexShrink:1}}>{title}</Text><Text style={{fontSize:11,color}}>{state==='deployed'?'✓ ':''}{productionLabels[state]}</Text></View>
            <View style={{flexDirection:'row',gap:7,alignItems:'center'}}>{digest||w.manual?<Text numberOfLines={1} ellipsizeMode="middle" style={{color:c.foregroundMuted,fontSize:11,flex:1,minWidth:0}}>{w.material.name}</Text>:null}<Text style={{color:c.foregroundMuted,fontSize:11}}>{row.latestCommitAt?new Date(row.latestCommitAt).toLocaleDateString(undefined,{month:'numeric',day:'numeric'}):'—'}{!own?' · 0 个提交':''}</Text></View>
            {brief?<Text numberOfLines={2} style={{color:c.foregroundMuted,fontSize:12,lineHeight:19}}>{brief}</Text>:null}
          </View><Icon name="ChevronRight" size={16} color={c.foregroundMuted}/></View>
        </Pressable>;})}
      {!rows.length&&!active?<View style={{padding:12}}><Label muted>{organizer.snapshot.isPending?'读取关联工作区…':'此会话暂无明确关联的工作区'}</Label></View>:null}
      {failure?<View style={{padding:12,gap:7}}><Label warning>{readableError(failure)}</Label><Row><Button onPress={()=>{void start(false,true);}}>重试</Button><Button variant="link" onPress={onModelSettings}>模型设置</Button></Row></View>:null}
    </ScrollView>
    {modal?<Dialog id="session-title-preview" title="自动更新会话标题" compact width={360} height={620} onClose={close} footer={<Row end><Button disabled={busy} onPress={close}>取消</Button><Button id="session-confirm-title" variant="primary" disabled={!ready||busy} onPress={()=>{if(!session?.preview)return;setBusy(true);setError('');void organizer.mutate({action:'session.apply',targetId:hostWorkspaceId,previewId:session.preview.id}).then(()=>{pendingJob.current='';setModal(false);}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{busy?'应用中…':'应用并开启'}</Button></Row>}>
      <ScrollView style={{flexGrow:0,flexShrink:1}} contentContainerStyle={{padding:16,gap:13,minWidth:0}}><Label muted>当前标题</Label><Label lines={2}>{target?.currentTitle||'未命名'}</Label><View style={{height:1,backgroundColor:c.border}}/>
        <Label muted>建议标题</Label>{ready?<Text selectable style={{color:c.foreground,fontSize:17,fontWeight:'600',lineHeight:26}}>{session?.preview?.title}</Text>:job?.state==='failed'||job?.state==='cancelled'?<><Label warning>{job.state==='cancelled'?'生成已取消':readableError(job.error||'')}</Label><Button onPress={()=>{void preview();}}>重试</Button></>:<Row><ActivityIndicator color={c.accent}/><Label>{jobLabel(job||active)}</Label></Row>}
        {target?.state==='unknown'?<Label warning>上线状态待核实</Label>:null}<Row><Label muted>{rows.length} 个关联工作区</Label><Button variant="link" icon={evidence?'ChevronDown':'ChevronRight'} onPress={readRun}>查看依据</Button></Row>
        {error?<Label warning>{readableError(error)}</Label>:null}
        {evidence?<View style={{gap:10,borderTopWidth:1,borderTopColor:c.border,paddingTop:10}}>{rows.map(row=>{const w=linked.get(row.id)!;return <View key={w.key} style={{gap:3}}><Label strong>{w.digest?.title||w.material.name}</Label><Label muted>{w.material.evidence.filter(e=>e.kind==='commit').length} 个自身提交 · {w.digest?.partial?'材料部分覆盖':'材料已读取'}</Label>{w.digest?.brief?<Label>{w.digest.brief}</Label>:null}</View>;})}<Label muted>{session?.preview?.conversationComplete?'会话历史已覆盖':'会话历史增量整理中'}</Label>{runError?<Label warning>{runError}</Label>:run?<><Label muted>{run.model} · {((run.elapsedMs||0)/1000).toFixed(1)} 秒</Label><Label strong>实际输入</Label><Text selectable style={{fontSize:11,lineHeight:17,color:c.foregroundMuted}}>{run.input}</Text><Label strong>来源映射</Label><Text selectable style={{fontSize:11,lineHeight:17,color:c.foregroundMuted}}>{JSON.stringify(run.references||{},null,2)}</Text><Label strong>模型输出</Label><Text selectable style={{fontSize:11,lineHeight:17,color:c.foregroundMuted}}>{run.output}</Text><Label strong>提示词</Label><Text selectable style={{fontSize:11,lineHeight:17,color:c.foregroundMuted}}>{run.prompt}</Text></>:null}</View>:null}
      </ScrollView>
    </Dialog>:null}
  </View>;
}
