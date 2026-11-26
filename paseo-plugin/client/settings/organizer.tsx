import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import type { ModelProfile, OrganizerPolicy, OrganizerRun, OrganizerModelTest, ProductionState } from '../../shared/organizer';
import { productionLabels, organizerPolicySchema } from '../../shared/organizer';
import { useOrganizer } from '../use-organizer';
import {ModelRunView} from '../organizer-run';
import { OrganizerJobs } from '../organizer-summary';
import { useSettingsForm } from './drafts';
import { SettingButton, SettingCard, SettingField, SettingSelect, SettingSwitch, SettingText, SettingPill, type SettingsTheme } from './ui';

export function RunDetails({run,theme}:{run:OrganizerRun;theme:SettingsTheme}) {return <ModelRunView run={run} theme={theme}/>;}
export function ModelConnections({projectConfig,active,theme,draftKey}:{projectConfig?:string;active:boolean;theme:SettingsTheme;draftKey:string}) {
  const organizer=useOrganizer(projectConfig,active),settings=organizer.settings.data;
  const [selected,setSelected]=useState<string>(),[status,setStatus]=useState(''),[test,setTest]=useState(''),[testId,setTestId]=useState(''),[starting,setStarting]=useState(false),[historyMode,setHistoryMode]=useState(false);
  const tests=useQuery({queryKey:['workbench-organizer-model-tests'],queryFn:()=>organizer.call<OrganizerModelTest[]>({action:'profile.tests'}),enabled:active,staleTime:5000,retry:false,refetchOnWindowFocus:false});
  const selection=selected||settings?.effective.profileId||settings?.profiles[0]?.id||'new';
  const result=useQuery({queryKey:['workbench-organizer-model-test',testId],queryFn:()=>organizer.call<OrganizerModelTest>({action:'profile.test.result',testId}),enabled:active&&!!testId,retry:false,refetchOnWindowFocus:false,refetchInterval:query=>query.state.data&&['queued','running'].includes(query.state.data.state)?1000:false});
  useEffect(()=>{if(active&&testId)void tests.refetch();},[active,testId,result.data?.state]);
  const testing=starting||!!testId&&!result.error&&(!result.data||['queued','running'].includes(result.data.state)),run=result.data?.run;
  const fresh=useMemo(()=>({id:'local-'+Date.now().toString(36),name:'本地 Sushi',baseUrl:'http://127.0.0.1:12345/v1',model:'',contextTokens:16384,outputTokens:2048,timeoutMs:120000}),[selection]);
  const base=settings?.profiles.find(p=>p.id===selection)||fresh;
  return <SettingCard title="连接配置" theme={theme}>
    {organizer.settings.error?<SettingText theme={theme} error>{organizer.settings.error.message}</SettingText>:null}
    <ConnectionEditor key={selection} base={base} draftKey={draftKey+':profile:'+selection} theme={theme} saved={selection!=='new'} organizer={organizer} onSaved={id=>{setSelected(id);setTestId('');setStatus('');}}>
      {guard=><SettingSelect theme={theme} label="编辑连接" value={selection} options={[{value:'new',label:'新增连接'},...(settings?.profiles||[]).map(p=>({value:p.id,label:p.name}))]} onChange={id=>guard(()=>{setSelected(id);setTestId('');setStatus('');})}/>}
    </ConnectionEditor>
    {selection!=='new'?<><SettingButton theme={theme} onPress={()=>{void organizer.call<{models:Array<{id:string}>;selectedAvailable:boolean}>({action:'profile.check',profileId:selection}).then(value=>setStatus(value.selectedAvailable?'模型已就绪':'模型未就绪')).catch(e=>setStatus(e.message));}}>检测连接</SettingButton>{status?<SettingText theme={theme}>{status}</SettingText>:null}
      <SettingCard title="不写标题的生成测试" theme={theme} collapsed><SettingField theme={theme} label="测试材料" value={test} onChange={setTest} multiline placeholder="粘贴目标、修改说明或提交摘要"/>
        <SettingButton theme={theme} disabled={testing||!test.trim()} onPress={()=>{setHistoryMode(false);setTestId('');setStarting(true);void organizer.call<OrganizerModelTest>({action:'profile.test',profileId:selection,text:test}).then(value=>setTestId(value.id)).catch(e=>setStatus(e.message)).finally(()=>setStarting(false));}}>{testing?'模型生成中…':'运行测试'}</SettingButton>{testing?<SettingButton theme={theme} disabled={!testId||starting} onPress={()=>{void organizer.call({action:'profile.test.cancel',testId}).then(()=>result.refetch()).catch(e=>setStatus(e.message));}}>取消模型测试</SettingButton>:null}{result.data?.error||result.error?<SettingText theme={theme} error>{result.data?.error||result.error?.message}</SettingText>:null}{run&&!historyMode?<RunDetails run={run} theme={theme}/>:null}</SettingCard></>:null}
    <SettingCard title="测试记录" theme={theme} collapsed><View testID="model-test-history" style={{gap:9}}>{tests.data?.map(item=><View key={item.id} style={{gap:9}}><SettingButton theme={theme} quiet compact onPress={()=>{setHistoryMode(true);setTestId(item.id);}}>{new Date(item.createdAt).toLocaleTimeString()} · {({queued:'排队',running:'请求中',complete:'已返回',failed:'失败',cancelled:'已取消',interrupted:'已中断'})[item.state]}</SettingButton>{historyMode&&testId===item.id&&run?<RunDetails run={run} theme={theme}/>:null}</View>)}</View></SettingCard>
  </SettingCard>;
}
function ConnectionEditor({base,draftKey,theme,saved,organizer,onSaved,children}:{base:ModelProfile;draftKey:string;theme:SettingsTheme;saved:boolean;organizer:ReturnType<typeof useOrganizer>;onSaved(id:string):void;children(guard:(fn:()=>void)=>void):React.ReactNode}) {
  const form=useSettingsForm(draftKey,{...base,secret:''},async patch=>{const value={...base,...patch}, {secret,...profile}=value;const saved=await organizer.mutate<import('../use-organizer').OrganizerSettingsResponse>({action:'profile.save',revision:organizer.settings.data!.revision,profile,...(patch.secret!==undefined?{secret}: {})});if(!saved.defaults.profileId&&saved.profiles.length===1)await organizer.mutate({action:'settings.save',revision:saved.revision,scope:'host',patch:{profileId:profile.id},reset:[]});onSaved(profile.id);});
  const {value:v,change}=form;
  return <View style={{gap:10}}>{children(form.guard)}<SettingField theme={theme} label="连接名称" value={v.name} onChange={x=>change('name',x)}/><SettingField theme={theme} label="接口地址" value={v.baseUrl} onChange={x=>change('baseUrl',x)}/><SettingField theme={theme} label="模型 ID" value={v.model} onChange={x=>change('model',x)}/><SettingField theme={theme} label="认证（可选）" secret value={v.secret} onChange={x=>change('secret',x)} placeholder={'hasSecret' in base&&base.hasSecret?'已保存，仅主机可读':'可选 Bearer Token'}/>
    <SettingCard theme={theme} title="上下文、输出与超时" collapsed><SettingField theme={theme} label="输入上下文预算（tokens）" value={String(v.contextTokens)} onChange={x=>change('contextTokens',Number(x))}/><SettingField theme={theme} label="输出上限（tokens）" value={String(v.outputTokens)} onChange={x=>change('outputTokens',Number(x))}/><SettingField theme={theme} label="超时（秒）" value={String(v.timeoutMs/1000)} onChange={x=>change('timeoutMs',Number(x)*1000)}/></SettingCard>
    {form.error?<SettingText theme={theme} error>{form.error}</SettingText>:null}<SettingButton theme={theme} primary disabled={form.saving||!organizer.settings.data||!form.dirty} onPress={()=>{void form.save().catch(()=>{});}}>保存连接</SettingButton>
    {saved?<SettingButton theme={theme} onPress={()=>form.guard(()=>{void organizer.mutate({action:'profile.delete',revision:organizer.settings.data!.revision,profileId:base.id}).then(()=>onSaved('new')).catch(form.report);})}>删除此连接</SettingButton>:null}</View>;
}

export function OrganizerPolicySettings({projectConfig,scope,active,theme,draftKey}:{projectConfig?:string;scope:'host'|'project';active:boolean;theme:SettingsTheme;draftKey:string}) {
  const organizer=useOrganizer(projectConfig,active),data=organizer.settings.data;
  const base=data?(scope==='project'?data.effective:organizerPolicySchema.parse(data.defaults)):undefined;
  const form=useSettingsForm<OrganizerPolicy>(draftKey,base,async patch=>{await organizer.mutate({action:'settings.save',revision:data!.revision,scope,patch,reset:[]});});
  const v=form.value,change=form.change;
  return <View style={{gap:14}}>{base?<>
    <SettingCard title="自动整理" theme={theme}>
      <SettingSwitch theme={theme} label="自动维护未来内容" value={v.enabled} onChange={x=>change('enabled',x)}/>
      <SettingSelect theme={theme} label="模型连接" value={v.profileId} onChange={x=>change('profileId',x)} options={[{value:'',label:'请选择模型连接'},...(data?.profiles||[]).map(p=>({value:p.id,label:p.name+' · '+p.model}))]}/>
      <SettingSelect theme={theme} label="自动维护范围" value={v.mode} onChange={x=>change('mode',x as OrganizerPolicy['mode'])} options={[{value:'automatic',label:'全部明确关联的新内容'},{value:'selected',label:'仅指定范围'},{value:'exclude',label:'全部，但应用排除名单'}]}/>
      {v.mode==='selected'?<><SettingField theme={theme} label="指定 ID（每行一个 Workspace 或 PASEO 条目 ID）" value={v.selectedIds.join('\n')} multiline onChange={x=>change('selectedIds',x.split('\n').map(s=>s.trim()).filter(Boolean))}/>
      {projectConfig?<SettingCard title="选择 Workspace 范围" theme={theme} collapsed>{organizer.snapshot.data?.workspaces.map(w=><SettingSwitch key={w.key} theme={theme} label={w.material.name} value={v.selectedIds.includes(w.material.workspaceId)||v.selectedIds.includes(w.key)} onChange={selected=>change('selectedIds',selected?[...v.selectedIds,w.material.workspaceId]:v.selectedIds.filter(id=>id!==w.material.workspaceId&&id!==w.key))}/>)}</SettingCard>:null}</>:null}
      {v.mode==='exclude'||v.excludedIds.length?<SettingField theme={theme} label="排除 ID（每行一个）" value={v.excludedIds.join('\n')} multiline onChange={x=>change('excludedIds',x.split('\n').map(s=>s.trim()).filter(Boolean))}/>:null}
    </SettingCard>
    <SettingCard title="标题格式" theme={theme}>
      <View style={{borderWidth:1,borderStyle:'dashed',borderColor:theme.colors.border,padding:12,borderRadius:7}}><SettingText theme={theme}>{v.markers.pending} 具体需求的稳定短标题</SettingText></View>
      <SettingField theme={theme} label="标题正文长度上限" value={String(v.titleLength)} onChange={x=>change('titleLength',Number(x))}/>
      <SettingCard title="状态符号" theme={theme} collapsed>{(Object.keys(productionLabels) as ProductionState[]).map(state=><SettingField key={state} theme={theme} label={productionLabels[state]} value={v.markers[state]} onChange={x=>change('markers',{...v.markers,[state]:x})}/>)}</SettingCard>
    </SettingCard>
    <SettingCard title="提示词与更新频率" theme={theme} collapsed>
      <SettingField theme={theme} label="整理提示词" value={v.prompt} onChange={x=>change('prompt',x)} multiline/>
      <SettingSwitch theme={theme} label="增量整理会话讨论" value={v.conversationSummary} onChange={x=>change('conversationSummary',x)}/>
      <SettingField theme={theme} label="事件合并等待（秒）" value={String(v.debounceSeconds)} onChange={x=>change('debounceSeconds',Number(x))}/>
      <SettingField theme={theme} label="同一对象最短模型间隔（秒）" value={String(v.analysisIntervalSeconds)} onChange={x=>change('analysisIntervalSeconds',Number(x))}/>
      {scope==='host'?<SettingField theme={theme} label="主机模型并发（1–4）" value={String(v.modelConcurrency)} onChange={x=>change('modelConcurrency',Number(x))}/>:<SettingPill theme={theme}>并发 {v.modelConcurrency}</SettingPill>}
    </SettingCard>
    {form.error?<SettingText theme={theme} error>{form.error}</SettingText>:null}
    <SettingButton theme={theme} primary icon="Check" disabled={form.saving||!form.dirty} onPress={()=>{void form.save().catch(()=>{});}}>保存整理规则</SettingButton>
    {scope==='project'?<SettingButton theme={theme} quiet onPress={()=>form.guard(()=>{void organizer.mutate({action:'settings.save',revision:data!.revision,scope,patch:{},reset:Object.keys(organizerPolicySchema.shape).filter(k=>k!=='productionBranches'&&k!=='modelConcurrency')}).catch(form.report);})}>继承主机默认规则</SettingButton>:null}
    </>:<SettingText theme={theme}>{organizer.settings.error?.message||'读取设置…'}</SettingText>}
  </View>;
}

export function ProductionSettings({projectConfig,active,theme,draftKey,repositories,legacy,onLegacySave}:{projectConfig:string;active:boolean;theme:SettingsTheme;draftKey:string;repositories:Array<{repoPath:string;name:string}>;legacy:Record<string,string>;onLegacySave(branches:Record<string,string>):Promise<void>}) {
  const organizer=useOrganizer(projectConfig,active),data=organizer.settings.data;
  const [error,setError]=useState('');
  const base=data?{productionBranches:{...Object.fromEntries(repositories.map(r=>[r.repoPath,legacy[JSON.stringify([projectConfig,r.repoPath])]||''])),...data.effective.productionBranches},fetchIntervalSeconds:data.effective.fetchIntervalSeconds}:undefined;
  const form=useSettingsForm<Pick<OrganizerPolicy,'productionBranches'|'fetchIntervalSeconds'>>(draftKey,base,async patch=>{await organizer.mutate({action:'settings.save',scope:'project',revision:data!.revision,patch,reset:[]});if(patch.productionBranches)await onLegacySave(patch.productionBranches);});
  return <SettingCard title="各仓库生产分支" theme={theme}><SettingText theme={theme}>优先沿用已有配置。留空自动选择存在的 origin/main，其次 origin/master；没有匹配分支时显示待核实。</SettingText>
    {base?repositories.map(r=><SettingField key={r.repoPath} theme={theme} label={r.name+' · '+r.repoPath} value={form.value.productionBranches[r.repoPath]||''} placeholder="自动选择 origin/main 或 origin/master" onChange={x=>form.change('productionBranches',{...form.value.productionBranches,[r.repoPath]:x})}/>):null}
    {!repositories.length?<SettingText theme={theme}>项目仓库尚未就绪。主机模型连接仍可配置。</SettingText>:null}
    {base?<SettingField theme={theme} label="焦点或刷新时获取生产引用的间隔（秒）" value={String(form.value.fetchIntervalSeconds)} onChange={x=>form.change('fetchIntervalSeconds',Number(x))}/>:null}
    <SettingText theme={theme}>逐仓库核对冻结基线和当前生产内容。回滚、对象缺失或模糊补丁不会标为已上线；有未提交改动则仍有未上线内容。</SettingText>
    {form.error||error?<SettingText theme={theme} error>{form.error||error}</SettingText>:null}<SettingButton theme={theme} primary disabled={!form.dirty||form.saving} onPress={()=>{void form.save().catch(()=>{});}}>保存生产配置</SettingButton>
    <SettingButton theme={theme} onPress={()=>{setError('');void organizer.mutate({action:'refresh',forceFetch:true,productionOnly:true,productionBranches:legacy}).catch(e=>setError(e.message));}}>强制获取并核验生产引用</SettingButton><OrganizerJobs theme={theme} snapshot={organizer.snapshot.data} call={organizer.mutate} onChanged={()=>{void organizer.invalidate();}}/>
  </SettingCard>;
}
