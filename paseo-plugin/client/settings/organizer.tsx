import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import type { ModelProfile, OrganizerPolicy, OrganizerRun, OrganizerModelTest, ProductionState } from '../../shared/organizer';
import { productionLabels, organizerPolicySchema } from '../../shared/organizer';
import { useOrganizer } from '../use-organizer';
import { OrganizerHistory, OrganizerJobs } from '../organizer-summary';
import { useSettingsForm } from './drafts';
import { SettingButton, SettingCard, SettingField, SettingSelect, SettingSwitch, SettingText, type SettingsTheme } from './ui';

export function RunDetails({run,theme}:{run:OrganizerRun;theme:SettingsTheme}) {
  return <View style={{gap:8}}><SettingText theme={theme}>{Math.round((run.elapsedMs||0)/1000)} 秒 · {run.truncated?'输入已截断，覆盖不完整':'输入在预算内'} · 用量 {JSON.stringify(run.usage||{})}</SettingText>
    {run.error?<SettingText theme={theme} error>{run.error}</SettingText>:null}<SettingCard title="实际提示词" theme={theme}><SettingText theme={theme}>{run.prompt}</SettingText></SettingCard>
    <SettingCard title="实际输入与来源" theme={theme}><SettingText theme={theme}>{run.input}</SettingText></SettingCard><SettingCard title="模型输出" theme={theme}><SettingText theme={theme}>{run.output||'未返回内容'}</SettingText></SettingCard></View>;
}
export function ModelConnections({projectConfig,active,theme,draftKey}:{projectConfig?:string;active:boolean;theme:SettingsTheme;draftKey:string}) {
  const organizer=useOrganizer(projectConfig,active),settings=organizer.settings.data;
  const [selected,setSelected]=useState('new'),[status,setStatus]=useState(''),[test,setTest]=useState(''),[testId,setTestId]=useState(''),[starting,setStarting]=useState(false);
  const result=useQuery({queryKey:['workbench-organizer-model-test',testId],queryFn:()=>organizer.call<OrganizerModelTest>({action:'profile.test.result',testId}),enabled:active&&!!testId,retry:false,refetchOnWindowFocus:false,refetchInterval:query=>query.state.data&&['queued','running'].includes(query.state.data.state)?1000:false});
  const testing=starting||!!testId&&!result.error&&(!result.data||['queued','running'].includes(result.data.state)),run=result.data?.run;
  const fresh=useMemo(()=>({id:'local-'+Date.now().toString(36),name:'本地 Sushi',baseUrl:'http://127.0.0.1:12345/v1',model:'',contextTokens:16384,outputTokens:2048,timeoutMs:120000}),[selected]);
  const base=settings?.profiles.find(p=>p.id===selected)||fresh;
  return <SettingCard title="主机模型连接" theme={theme}><SettingText theme={theme}>地址和认证保存在当前主机。直接使用 Chat Completions；只调用指定模型。</SettingText>
    {organizer.settings.error?<SettingText theme={theme} error>{organizer.settings.error.message}</SettingText>:null}
    <ConnectionEditor key={selected} base={base} draftKey={draftKey+':profile:'+selected} theme={theme} saved={selected!=='new'} organizer={organizer} onSaved={id=>setSelected(id)}>
      {guard=><SettingSelect theme={theme} label="编辑连接" value={selected} options={[{value:'new',label:'新增连接'},...(settings?.profiles||[]).map(p=>({value:p.id,label:p.name}))]} onChange={id=>guard(()=>{setSelected(id);setTestId('');setStatus('');})}/>}
    </ConnectionEditor>
    {selected!=='new'?<><SettingButton theme={theme} onPress={()=>{void organizer.call<{models:Array<{id:string}>;selectedAvailable:boolean}>({action:'profile.check',profileId:selected}).then(value=>setStatus((value.selectedAvailable?'指定模型可用':'指定模型未就绪')+'\n'+value.models.map(m=>m.id).join('\n'))).catch(e=>setStatus(e.message));}}>检测连接与可用模型</SettingButton>{status?<SettingText theme={theme}>{status}</SettingText>:null}
      <SettingCard title="不写标题的生成测试" theme={theme} collapsed><SettingField theme={theme} label="测试材料" value={test} onChange={setTest} multiline placeholder="粘贴目标、修改说明或提交摘要"/>
        <SettingButton theme={theme} disabled={testing||!test.trim()} onPress={()=>{setStarting(true);void organizer.call<OrganizerModelTest>({action:'profile.test',profileId:selected,text:test}).then(value=>setTestId(value.id)).catch(e=>setStatus(e.message)).finally(()=>setStarting(false));}}>{testing?'正在调用模型…':'运行测试'}</SettingButton>{testing?<SettingButton theme={theme} onPress={()=>{void organizer.call({action:'profile.test.cancel',testId}).then(()=>result.refetch());}}>取消模型测试</SettingButton>:null}{result.data?.error||result.error?<SettingText theme={theme} error>{result.data?.error||result.error?.message}</SettingText>:null}{run?<RunDetails run={run} theme={theme}/>:null}</SettingCard></>:null}
  </SettingCard>;
}
function ConnectionEditor({base,draftKey,theme,saved,organizer,onSaved,children}:{base:ModelProfile;draftKey:string;theme:SettingsTheme;saved:boolean;organizer:ReturnType<typeof useOrganizer>;onSaved(id:string):void;children(guard:(fn:()=>void)=>void):React.ReactNode}) {
  const form=useSettingsForm(draftKey,{...base,secret:''},async patch=>{const value={...base,...patch}, {secret,...profile}=value;await organizer.mutate({action:'profile.save',revision:organizer.settings.data!.revision,profile,...(patch.secret!==undefined?{secret}: {})});onSaved(profile.id);});
  const {value:v,change}=form;
  return <View style={{gap:10}}>{children(form.guard)}<SettingField theme={theme} label="连接名称" value={v.name} onChange={x=>change('name',x)}/><SettingField theme={theme} label="接口地址（含 /v1）" value={v.baseUrl} onChange={x=>change('baseUrl',x)}/><SettingField theme={theme} label="模型 ID" value={v.model} onChange={x=>change('model',x)}/><SettingField theme={theme} label="认证（留空保留已有值）" secret value={v.secret} onChange={x=>change('secret',x)} placeholder={'hasSecret' in base&&base.hasSecret?'已保存，仅主机可读':'可选 Bearer Token'}/>
    <SettingField theme={theme} label="输入上下文预算（tokens）" value={String(v.contextTokens)} onChange={x=>change('contextTokens',Number(x))}/><SettingField theme={theme} label="输出上限（tokens）" value={String(v.outputTokens)} onChange={x=>change('outputTokens',Number(x))}/><SettingField theme={theme} label="超时（秒）" value={String(v.timeoutMs/1000)} onChange={x=>change('timeoutMs',Number(x)*1000)}/>
    {form.error?<SettingText theme={theme} error>{form.error}</SettingText>:null}<SettingButton theme={theme} disabled={form.saving||!organizer.settings.data} onPress={()=>{void form.save().catch(()=>{});}}>保存连接</SettingButton>
    {saved?<SettingButton theme={theme} onPress={()=>form.guard(()=>{void organizer.mutate({action:'profile.delete',revision:organizer.settings.data!.revision,profileId:base.id}).then(()=>onSaved('new')).catch(form.report);})}>删除此连接</SettingButton>:null}</View>;
}

export function OrganizerPolicySettings({projectConfig,scope,active,theme,draftKey}:{projectConfig?:string;scope:'host'|'project';active:boolean;theme:SettingsTheme;draftKey:string}) {
  const organizer=useOrganizer(projectConfig,active),data=organizer.settings.data;
  const base=data?(scope==='project'?data.effective:organizerPolicySchema.parse(data.defaults)):undefined;
  const form=useSettingsForm<OrganizerPolicy>(draftKey,base,async patch=>{await organizer.mutate({action:'settings.save',revision:data!.revision,scope,patch,reset:[]});});
  const v=form.value,change=form.change;
  return <View style={{gap:12}}>{base?<SettingCard title="自动整理规则" theme={theme}>
    <SettingText theme={theme}>编辑：{scope==='host'?'主机默认':'当前项目'}。{scope==='project'?'未覆盖项继承主机默认；保存仅写入修改项。':''}同一代表 Workspace 的正式标题会保持稳定。</SettingText>
    <SettingSwitch theme={theme} label="自动维护未来关联内容" value={v.enabled} onChange={x=>change('enabled',x)} hint="启用时记录时间边界，历史标题需要在下方预览后应用。"/>
    <SettingSelect theme={theme} label="整理使用的连接" value={v.profileId} onChange={x=>change('profileId',x)} options={[{value:'',label:'尚未选择'},...(data?.profiles||[]).map(p=>({value:p.id,label:p.name+' · '+p.model}))]}/>
    <SettingSelect theme={theme} label="自动维护范围" value={v.mode} onChange={x=>change('mode',x as OrganizerPolicy['mode'])} options={[{value:'automatic',label:'全部明确关联的新内容'},{value:'selected',label:'仅指定范围'},{value:'exclude',label:'全部，但应用排除名单'}]}/>
    {v.mode==='selected'?<SettingField theme={theme} label="指定 ID（每行一个 Workspace 或 PASEO 条目 ID）" value={v.selectedIds.join('\n')} multiline onChange={x=>change('selectedIds',x.split('\n').map(s=>s.trim()).filter(Boolean))}/>:null}
    {v.mode==='selected'&&projectConfig?<SettingCard title="选择 Workspace 范围" theme={theme} collapsed>{organizer.snapshot.data?.workspaces.map(w=><SettingSwitch key={w.key} theme={theme} label={w.material.name} hint={w.material.workspaceId} value={v.selectedIds.includes(w.material.workspaceId)||v.selectedIds.includes(w.key)} onChange={selected=>change('selectedIds',selected?[...v.selectedIds,w.material.workspaceId]:v.selectedIds.filter(id=>id!==w.material.workspaceId&&id!==w.key))}/>)}<SettingText theme={theme}>历史条目仍需预览并应用一次。可以在下方历史试点查看 PASEO ID 和关联 Workspace。</SettingText></SettingCard>:null}
    <SettingField theme={theme} label="排除 ID（每行一个）" value={v.excludedIds.join('\n')} multiline onChange={x=>change('excludedIds',x.split('\n').map(s=>s.trim()).filter(Boolean))}/>
    <SettingField theme={theme} label="整理提示词" value={v.prompt} onChange={x=>change('prompt',x)} multiline/>
    <SettingField theme={theme} label="标题正文长度上限" value={String(v.titleLength)} onChange={x=>change('titleLength',Number(x))}/>
    <SettingSwitch theme={theme} label="增量整理会话讨论" value={v.conversationSummary} onChange={x=>change('conversationSummary',x)}/>
    {scope==='host'?<SettingField theme={theme} label="主机模型并发（1–4）" value={String(v.modelConcurrency)} onChange={x=>change('modelConcurrency',Number(x))}/>:<SettingText theme={theme}>模型并发采用主机默认：{v.modelConcurrency}。</SettingText>}
    <SettingCard theme={theme} title="状态符号与触发" collapsed>{(Object.keys(productionLabels) as ProductionState[]).map(state=><SettingField key={state} theme={theme} label={productionLabels[state]} value={v.markers[state]} onChange={x=>change('markers',{...v.markers,[state]:x})}/>)}
      <SettingText theme={theme}>可以用 emoji 或短文字。原生列表展示标题字符，插件内显示状态颜色。</SettingText>
      <SettingField theme={theme} label="事件合并等待（秒）" value={String(v.debounceSeconds)} onChange={x=>change('debounceSeconds',Number(x))}/><SettingField theme={theme} label="同一对象最短模型间隔（秒）" value={String(v.analysisIntervalSeconds)} onChange={x=>change('analysisIntervalSeconds',Number(x))}/>
    </SettingCard>{form.error?<SettingText theme={theme} error>{form.error}</SettingText>:null}<SettingButton theme={theme} primary disabled={form.saving||!form.dirty} onPress={()=>{void form.save().catch(()=>{});}}>保存整理规则</SettingButton>
    {scope==='project'?<SettingButton theme={theme} onPress={()=>form.guard(()=>{void organizer.mutate({action:'settings.save',revision:data!.revision,scope,patch:{},reset:Object.keys(organizerPolicySchema.shape).filter(k=>k!=='productionBranches'&&k!=='modelConcurrency')}).catch(form.report);})}>恢复继承主机默认规则</SettingButton>:null}
  </SettingCard>:<SettingText theme={theme}>{organizer.settings.error?.message||'读取整理设置…'}</SettingText>}
    <ModelConnections projectConfig={projectConfig} active={active} theme={theme} draftKey={draftKey}/>
    {projectConfig?<SettingCard title="历史预览与人工维护名单" theme={theme} collapsed><OrganizerHistory projectConfig={projectConfig} active={active} theme={theme}/></SettingCard>:null}
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
    <SettingButton theme={theme} onPress={()=>{setError('');void organizer.mutate({action:'refresh',forceFetch:true,productionBranches:legacy}).catch(e=>setError(e.message));}}>强制获取并核验生产引用</SettingButton><OrganizerJobs theme={theme} snapshot={organizer.snapshot.data} call={organizer.mutate} onChanged={()=>{void organizer.invalidate();}}/>
  </SettingCard>;
}
