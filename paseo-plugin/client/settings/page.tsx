import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectsQuery } from '../../shared/projects';
import { observerQuery } from '../../shared/observer';
import { observerSettings, observerSettingsRpc } from '../../shared/settings';
import { projectBackendStatus } from '../../shared/setup';
import { ScrollView } from '../native-components';
import { WorkbenchLocaleProvider, localeFromHostProps } from '../i18n';
import { useTopics } from '../use-topics';
import { TopicSettings } from '../extensions/project-communications/topic-settings';
import { CommunicationsTheme } from '../extensions/project-communications/ui';
import { OrganizerJobs } from '../organizer-summary';
import { useOrganizer } from '../use-organizer';
import {publishDisplaySettings} from '../use-display-settings';
import { SettingsDrafts } from './drafts';
import {SettingsHome,ExtensionSettings} from './home';
import {OrganizerHistory} from '../organizer-summary';
import { SessionSettings, ReviewSettings } from './execution';
import { FileSettings, RepositorySettings, RecoverySettings, RuntimeSettings, StorageSettings } from './common';
import { OrganizerPolicySettings, ProductionSettings, ModelConnections } from './organizer';
import { SettingButton, SettingCard, SettingHeading, SettingPill, SettingSelect, SettingText, settingsCategories, type SettingsCategory, type SettingsTheme } from './ui';

const editingTarget = new Map<string,string>();
type PageProps={host:PluginSurfaceProps['host'];theme:SettingsTheme;projectConfig?:string;hostWorkspaceId?:string;active?:boolean;initialCategory?:SettingsCategory};
export function WorkbenchSettingsScreen(props:PluginSurfaceProps & {initialCategory?:SettingsCategory}) {return <WorkbenchLocaleProvider locale={localeFromHostProps(props)}><WorkbenchSettingsPage {...props}/></WorkbenchLocaleProvider>;}
export function WorkbenchSettingsPage({host,theme,projectConfig,hostWorkspaceId='',active=true,initialCategory='home'}:PageProps) {
  const [project,setProject]=useState(()=>editingTarget.has(host.id)?editingTarget.get(host.id)!:projectConfig||'');
  const [scope,setScope]=useState<'host'|'project'>(project?'project':'host'),[category,setCategory]=useState<SettingsCategory>(initialCategory==='display'?'home':initialCategory),[visited,setVisited]=useState<SettingsCategory[]>([initialCategory==='display'?'home':initialCategory]),[contextOpen,setContextOpen]=useState(false);
  const drafts=useRef(new Map<string,{save():Promise<void>;discard():void}>()),[dirtyCount,setDirtyCount]=useState(0),[pending,setPending]=useState<()=>void>(),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const getProjects=useRpc(projectsQuery),projects=useQuery({queryKey:['workbench-settings-projects',host.id],queryFn:()=>getProjects({}),retry:false,refetchOnWindowFocus:false});
  const context=useMemo(()=>({register(id:string,value:{save():Promise<void>;discard():void}|null){if(value)drafts.current.set(id,value);else drafts.current.delete(id);setDirtyCount(drafts.current.size);},guard(action:()=>void){if(drafts.current.size)setPending(()=>action);else action();}}),[]);
  const navigate=(value:SettingsCategory)=>{const next=value==='display'?'home':value;setCategory(next);if(next==='home')setContextOpen(false);setVisited(values=>values.includes(next)?values:[...values,next]);};
  useEffect(()=>{navigate(initialCategory);},[initialCategory]);
  useEffect(()=>{editingTarget.set(host.id,project);},[host.id,project]);
  const switchProject=(value:string)=>context.guard(()=>{setProject(value);if(!value)setScope('host');setError('');});
  const saveAll=async()=>{setSaving(true);setError('');try{for(const draft of [...drafts.current.values()])await draft.save();const action=pending;setPending(undefined);action?.();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
  const discardAll=()=>{for(const draft of [...drafts.current.values()])draft.discard();const action=pending;setPending(undefined);action?.();setError('');};
  const selected=projects.data?.find(p=>p.configPath===project),key=host.id+':'+project+':'+scope;
  const projectOptions=[{value:'',label:'主机默认（无需 Workspace）'},...(projects.data||[]).map(p=>({value:p.configPath,label:p.displayName}))];
  if(project&&!projectOptions.some(p=>p.value===project))projectOptions.push({value:project,label:project});
  const scopeEnabled=['home','session','review','organizer'].includes(category);
  return <SettingsDrafts.Provider value={context}><View testID="workbench-settings-tab" style={{flex:1,minWidth:0,minHeight:0}}>
    <ScrollView contentContainerStyle={{padding:12,gap:12}} keyboardShouldPersistTaps="handled">
      {category!=='home'?<View style={{alignSelf:'flex-start'}}><SettingButton theme={theme} quiet compact icon="ChevronLeft" onPress={()=>navigate('home')}>全部设置</SettingButton></View>:null}
      <SettingHeading theme={theme}>{category==='home'?'设置':settingsCategories.find(c=>c.id===category)?.label||'设置'}</SettingHeading>
      <View style={{flexDirection:'row',alignItems:'center',gap:9,borderWidth:1,borderColor:theme.colors.border,borderRadius:7,padding:10}}><Text numberOfLines={1} style={{color:theme.colors.foreground,fontSize:12,flex:1}}>{selected?.displayName||(!project?'主机默认':project.split('/').slice(-3,-2).join(''))}</Text><SettingPill theme={theme}>{category==='models'?'主机连接':scopeEnabled&&scope==='host'?'主机默认':'项目设置'}</SettingPill><SettingButton theme={theme} quiet compact onPress={()=>setContextOpen(v=>!v)}>切换</SettingButton></View>
      {contextOpen?<View style={{gap:12}}><SettingSelect theme={theme} label="编辑项目（固定，不跟随会话焦点）" value={project} options={projectOptions} onChange={switchProject}/>
      {project&&scopeEnabled?<SettingSelect theme={theme} label="编辑作用范围" value={scope} options={[{value:'project',label:'当前项目覆盖'},{value:'host',label:'主机默认'}]} onChange={value=>context.guard(()=>setScope(value as typeof scope))}/>:null}
      <SettingText theme={theme}>{project}</SettingText></View>:null}
      {category!=='home'?<SettingSelect theme={theme} label="设置分类" value={category} options={settingsCategories.map(c=>({value:c.id,label:c.label}))} onChange={value=>navigate(value as SettingsCategory)}/>:null}
      {dirtyCount?<View style={{gap:8,borderWidth:1,borderColor:theme.colors.statusWarning,padding:10,borderRadius:5}}><SettingText theme={theme}>{pending?'切换目标前，请处理未保存设置。':`${dirtyCount} 组未保存设置，分类切换会保留草稿。`}</SettingText><SettingButton theme={theme} primary disabled={saving} onPress={()=>{void saveAll();}}>{saving?'正在保存…':'保存全部草稿'+(pending?'并切换':'')}</SettingButton><SettingButton theme={theme} disabled={saving} onPress={discardAll}>放弃草稿{pending?'并切换':''}</SettingButton>{pending?<SettingButton theme={theme} onPress={()=>setPending(undefined)}>继续编辑</SettingButton>:null}</View>:null}
      {error?<SettingText theme={theme} error>{error}</SettingText>:null}
      <View key={key} style={{gap:12}}>{visited.map(id=><View key={id} style={id===category?{gap:12,minWidth:0}:{display:'none'}}>
        <SettingsCategoryContent category={id} projectConfig={project||undefined} hostWorkspaceId={hostWorkspaceId} scope={scope} theme={theme} draftKey={key+':'+id} active={active&&category===id} onNavigate={navigate}/>
      </View>)}</View>
    </ScrollView>
  </View></SettingsDrafts.Provider>;
}
function TopicsSettings({projectConfig,active,theme,draftKey}:{projectConfig:string;active:boolean;theme:SettingsTheme;draftKey:string}) {
  const client=useTopics(projectConfig,active,active);
  return <CommunicationsTheme theme={theme}><TopicSettings client={client} embedded open onClose={()=>{}} draftKey={draftKey}/></CommunicationsTheme>;
}
function SettingsCategoryContent({category,projectConfig,hostWorkspaceId,scope,theme,draftKey,active,onNavigate}:{category:SettingsCategory;projectConfig?:string;hostWorkspaceId:string;scope:'host'|'project';theme:SettingsTheme;draftKey:string;active:boolean;onNavigate(category:SettingsCategory):void}) {
  if(category==='home'||category==='display')return <SettingsHome projectConfig={projectConfig} active={active} scope={scope} theme={theme} onNavigate={onNavigate}/>;
  if(category==='models')return <ModelConnections projectConfig={projectConfig} active={active} theme={theme} draftKey={draftKey}/>;
  if(category==='recovery')return <RecoverySettings theme={theme} draftKey={draftKey} active={active}/>;
  if(category==='organizer')return <OrganizerPolicySettings projectConfig={projectConfig} scope={projectConfig?scope:'host'} theme={theme} draftKey={draftKey} active={active}/>;
  if(category==='diagnostics')return <Diagnostics projectConfig={projectConfig} active={active} theme={theme}/>;
  if(!projectConfig)return <SettingText theme={theme}>请先选择要编辑的已注册项目。模型连接可在“标题与自动整理”中配置。</SettingText>;
  const props={projectConfig,active,theme,draftKey};
  if(category==='session')return <SessionSettings {...props} scope={scope}/>;
  if(category==='review')return <ReviewSettings {...props} scope={scope}/>;
  if(category==='files')return <FileSettings {...props}/>;
  if(category==='extensions')return <ExtensionSettings projectConfig={projectConfig} active={active} theme={theme} onConfigure={()=>onNavigate('topics')}/>;
  if(category==='history')return <OrganizerHistory projectConfig={projectConfig} active={active} theme={theme}/>;
  if(category==='topics')return <TopicsSettings {...props}/>;
  if(category==='project')return <><SettingCard title="项目配置" theme={theme}><SettingText theme={theme}>{projectConfig}</SettingText></SettingCard><RepositorySettings {...props}/><RepositorySettings {...props} draftKey={draftKey+':linked'} linked/></>;
  if(category==='runtime')return <RuntimeSettings {...props}/>;
  if(category==='storage')return <><StorageSettings {...props}/><RuntimeSettings {...props} storage/></>;
  return <ProductionCategory {...props}/>;
}
function ProductionCategory({projectConfig,active,theme,draftKey}:{projectConfig:string;active:boolean;theme:SettingsTheme;draftKey:string}) {
  const rpc=useRpc(observerQuery),read=useRpc(observerSettingsRpc.read),write=useRpc(observerSettingsRpc.write),cache=useQueryClient();
  const legacy=useQuery({queryKey:['workbench-settings-display-values'],queryFn:async()=>{const result=await read({});if(result.status!=='ready')throw Error('显示设置不可用');return observerSettings.schema.parse(result.values);},enabled:active,retry:false,refetchOnWindowFocus:false});
  const repos=useQuery({queryKey:['workbench-settings-repositories',projectConfig],queryFn:async()=>{const result=await rpc({projectConfig,method:'workspace.detail',params:{workspaceId:'main',summary:true}});if(!result.ok)throw Error(result.error?.message||'仓库列表不可用');return (result.result as {repositories:Array<{repoPath:string;name:string}>}).repositories;},enabled:active,retry:false,refetchOnWindowFocus:false});
  return <ProductionSettings projectConfig={projectConfig} active={active} theme={theme} draftKey={draftKey} repositories={repos.data||[]} legacy={legacy.data?.productionBranches||{}} onLegacySave={async branches=>{const current=await read({});if(current.status!=='ready')throw Error('旧版生产配置不可用');const values=observerSettings.schema.parse(current.values),productionBranches={...values.productionBranches};for(const [path,ref]of Object.entries(branches))productionBranches[JSON.stringify([projectConfig,path])]=ref;const result=await write({revision:current.revision,values:{...values,productionBranches}});if(result.status!=='saved')throw Error('生产配置同步冲突，请重试保存');publishDisplaySettings({production:productionBranches});await cache.invalidateQueries({queryKey:['workbench-settings-display-values']});}}/>;
}
function Diagnostics({projectConfig,active,theme}:{projectConfig?:string;active:boolean;theme:SettingsTheme}) {
  const read=useRpc(projectBackendStatus),organizer=useOrganizer(projectConfig,active),backend=useQuery({queryKey:['workbench-settings-backend',projectConfig],queryFn:()=>read({projectConfig:projectConfig!}),enabled:active&&!!projectConfig,retry:false,refetchOnWindowFocus:false});
  return <View style={{gap:12}}><SettingCard theme={theme} title="后端与模型连接"><SettingText theme={theme}>{projectConfig?'后端：'+(backend.data?.state||backend.error?.message||'正在读取'):'尚未选择项目'}{backend.data?.message?'\n'+backend.data.message:''}</SettingText><SettingText theme={theme}>{organizer.settings.data?.profiles.map(p=>`${p.name} · ${p.model} · ${p.baseUrl}`).join('\n')||'尚未配置模型连接'}</SettingText><SettingButton theme={theme} onPress={()=>{if(projectConfig)void backend.refetch();void organizer.invalidate();}}>刷新诊断</SettingButton></SettingCard>
    <SettingCard theme={theme} title="整理队列与失败原因"><OrganizerJobs snapshot={organizer.snapshot.data} call={organizer.mutate} history theme={theme} onChanged={()=>{void organizer.invalidate();}}/>{organizer.snapshot.data?.targets.filter(t=>t.reason).map(t=><SettingText key={t.id} theme={theme} error>{t.currentTitle||t.id}：{t.reason}</SettingText>)}{organizer.snapshot.data?.workspaces.filter(w=>w.error).map(w=><SettingText theme={theme} key={w.key} error>{w.material.name}：{w.error}</SettingText>)}</SettingCard>
  </View>;
}
