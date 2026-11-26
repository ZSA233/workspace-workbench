import { useRpc } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';
import { agentSessionSettingsGet, agentSessionSettingsUpdate, agentSessionProviders, agentSessionSettingsSchema, type AgentSessionSettings } from '../../shared/agent-session';
import { reviewSettingsGet, reviewSettingsUpdate, reviewModels, resolveReviewPreferences, type ReviewPreferences, type ReviewPreferencePatch } from '../../shared/agent-review';
import { useSettingsForm } from './drafts';
import { SettingButton, SettingCard, SettingField, SettingSelect, SettingSwitch, SettingText, type SettingsTheme } from './ui';

type Props={projectConfig:string;scope:'host'|'project';theme:SettingsTheme;draftKey:string;active:boolean};
const relationships=[{value:'independent',label:'独立会话'},{value:'child',label:'子会话'}];
const source=(value:string|undefined)=>value?.startsWith('project')?'项目覆盖':value?.startsWith('global')?'主机默认':'内置默认';
const verified=<T extends {ok:boolean;error?:{message:string}}>(result:T)=>{if(!result.ok)throw Error(result.error?.message||'保存失败');return result;};
function useModels(projectConfig:string,active:boolean) {
  const read=useRpc(reviewModels);return useQuery({queryKey:['workspace-workbench',projectConfig,'settings-models'],queryFn:()=>read({projectConfig}),enabled:active,staleTime:300000,retry:false,refetchOnWindowFocus:false});
}
export function SessionSettings({projectConfig,scope,theme,draftKey,active}:Props) {
  const read=useRpc(agentSessionSettingsGet),write=useRpc(agentSessionSettingsUpdate),providers=useRpc(agentSessionProviders),reviewRead=useRpc(reviewSettingsGet),reviewWrite=useRpc(reviewSettingsUpdate),cache=useQueryClient();
  const query=useQuery({queryKey:['workspace-workbench',projectConfig,'agent-session-settings'],queryFn:()=>read({projectConfig}),refetchOnWindowFocus:false,retry:false});
  const reviews=useQuery({queryKey:['workspace-workbench',projectConfig,'agent-review-settings'],queryFn:()=>reviewRead({projectConfig}),refetchOnWindowFocus:false,retry:false});
  const available=useQuery({queryKey:['workspace-workbench',projectConfig,'agent-session-providers'],queryFn:()=>providers({projectConfig}),enabled:active,staleTime:300000,refetchOnWindowFocus:false,retry:false});
  const models=useModels(projectConfig,active),data=query.data;
  type Fields=AgentSessionSettings & {executionModel:string};
  const base:Fields|undefined=data?{...(scope==='host'?agentSessionSettingsSchema.parse(data.global):data.effective),providerRelationships:(scope==='host'?data.global.providerRelationships:data.project.providerRelationships)||{},executionModel:(scope==='host'?reviews.data?.global.executionModel:reviews.data?.effective.executionModel)||''}:undefined;
  const form=useSettingsForm<Fields>(draftKey,base,async patch=>{
    const {executionModel,...session}=patch;
    if(Object.keys(session).length)verified(await write({projectConfig,scope:scope==='host'?'global':'project',patch:session,resetFields:[]}));
    if(executionModel!==undefined)verified(await reviewWrite({projectConfig,scope:scope==='host'?'global':'project-model',patch:executionModel?{executionModel}:{},resetFields:executionModel?[]:['executionModel']}));
    await cache.invalidateQueries({queryKey:['workspace-workbench',projectConfig]});
  });
  const v=form.value;
  const providerIds=[...new Set([...(available.data?.providers||[]).map(p=>p.provider),...Object.keys(data?.effective.providerRelationships||{}),...Object.keys(v.providerRelationships||{})])];
  return <SettingCard title="会话与执行默认值" theme={theme}><SettingText theme={theme}>适用于新建执行会话。复用中的会话保留宿主当前计划／执行状态。</SettingText>
    {base?<><SettingSelect theme={theme} label={'会话关系 · '+source(data?.sources.defaultRelationship)} value={v.defaultRelationship} options={relationships} onChange={x=>form.change('defaultRelationship',x as Fields['defaultRelationship'])}/>
      <SettingSelect theme={theme} label={'权限预设 · '+source(data?.sources.permissionMode)} value={v.permissionMode} onChange={x=>form.change('permissionMode',x as Fields['permissionMode'])} options={[{value:'inherit',label:'继承宿主默认'},{value:'auto',label:'自动'},{value:'auto-review',label:'自动审阅'},{value:'full-access',label:'完全访问'}]}/>
      <SettingText theme={theme}>权限预设与计划／执行模式独立，运行中状态也不代表执行授权。</SettingText>
      <SettingSelect theme={theme} label={'执行模型 · '+source(reviews.data?.sources.executionModel)} value={v.executionModel} options={[{value:'',label:'跟随执行 Provider 默认'},...(models.data?.models||[]).map(m=>({value:m.id,label:m.label}))]} onChange={x=>form.change('executionModel',x)}/>
      <SettingField theme={theme} label="执行模型 ID（可手动指定）" value={v.executionModel} onChange={x=>form.change('executionModel',x)}/>
      <SettingCard title="Provider 会话关系覆盖" theme={theme} collapsed>{providerIds.map(provider=><SettingSelect theme={theme} key={provider} label={provider+' · '+source(data?.sources.providerRelationships[provider])} value={v.providerRelationships[provider]||''} options={[{value:'',label:'继承默认关系'},...relationships]} onChange={x=>{const next={...v.providerRelationships};if(x)next[provider]=x as Fields['defaultRelationship'];else delete next[provider];form.change('providerRelationships',next);}}/>)}</SettingCard>
      <SettingButton theme={theme} primary disabled={!form.dirty||form.saving} onPress={()=>{void form.save().catch(()=>{});}}>保存会话设置</SettingButton>
      {scope==='project'?<SettingButton theme={theme} onPress={()=>form.guard(()=>{void write({projectConfig,scope:'project',patch:{},resetFields:['defaultRelationship','permissionMode','providerRelationships']}).then(verified).then(()=>cache.invalidateQueries({queryKey:['workspace-workbench',projectConfig]})).catch(form.report);})}>清除项目会话覆盖</SettingButton>:null}
    </>:null}{form.error||query.error||!data?.ok&&data?.error?<SettingText theme={theme} error>{form.error||query.error?.message||data?.error?.message}</SettingText>:null}
  </SettingCard>;
}

export function ReviewSettings({projectConfig,scope,theme,draftKey,active}:Props) {
  const read=useRpc(reviewSettingsGet),write=useRpc(reviewSettingsUpdate),cache=useQueryClient(),models=useModels(projectConfig,active);
  const query=useQuery({queryKey:['workspace-workbench',projectConfig,'agent-review-settings'],queryFn:()=>read({projectConfig}),retry:false,refetchOnWindowFocus:false});
  const data=query.data,base=data?(scope==='host'?resolveReviewPreferences(data.global):data.effective):undefined;
  const form=useSettingsForm<ReviewPreferences>(draftKey,base,async patch=>{
    const {executionModel:ignoredExecution,reviewerModel,locale:ignoredLocale,...shared}=patch;
    if(Object.keys(shared).length)verified(await write({projectConfig,scope:scope==='host'?'global':'project',patch:shared,resetFields:[]}));
    if(reviewerModel!==undefined)verified(await write({projectConfig,scope:scope==='host'?'global':'project-model',patch:reviewerModel?{reviewerModel}:{},resetFields:reviewerModel?[]:['reviewerModel']}));
    await cache.invalidateQueries({queryKey:['workspace-workbench',projectConfig]});
  });
  const v=form.value,label=(name:string,key:string)=>name+' · '+source(data?.sources[key]);
  return <SettingCard title="代码评审" theme={theme}>{base?<>
    <SettingSelect theme={theme} label={label('模式','mode')} value={v.mode} onChange={x=>form.change('mode',x as ReviewPreferences['mode'])} options={[{value:'off',label:'关闭'},{value:'manual',label:'手动'},{value:'automatic',label:'自动'}]}/>
    <SettingSwitch theme={theme} label={label('自动修复','autoFix')} value={v.autoFix} onChange={x=>form.change('autoFix',x)}/>
    <SettingSelect theme={theme} label={label('审核目标','reviewerTarget')} value={v.reviewerTarget} onChange={x=>form.change('reviewerTarget',x as ReviewPreferences['reviewerTarget'])} options={[{value:'independent',label:'独立 Reviewer'},{value:'coordinator',label:'协调者'}]}/>
    <SettingSelect theme={theme} label={label('Reviewer 模型','reviewerModel')} value={v.reviewerModel||''} onChange={x=>form.change('reviewerModel',x||null)} options={[{value:'',label:'跟随执行模型'},...(models.data?.models||[]).map(m=>({value:m.id,label:m.label}))]}/>
    <SettingField theme={theme} label="Reviewer 模型 ID" value={v.reviewerModel||''} onChange={x=>form.change('reviewerModel',x||null)}/>
    <SettingField theme={theme} label={label('角色','reviewerRole')} value={v.reviewerRole} onChange={x=>form.change('reviewerRole',x)}/>
    <SettingField theme={theme} label={label('审核指令','instructions')} value={v.instructions} onChange={x=>form.change('instructions',x)} multiline/>
    <SettingCard title="轮数、超时与会话复用" theme={theme} collapsed><SettingField theme={theme} label={label('最多轮数（1–10）','maxRounds')} value={String(v.maxRounds)} onChange={x=>form.change('maxRounds',Number(x))}/>
      <SettingField theme={theme} label={label('审核超时（分钟）','reviewerTimeoutMs')} value={String(v.reviewerTimeoutMs/60000)} onChange={x=>form.change('reviewerTimeoutMs',Number(x)*60000)}/><SettingField theme={theme} label={label('修复超时（分钟）','repairTimeoutMs')} value={String(v.repairTimeoutMs/60000)} onChange={x=>form.change('repairTimeoutMs',Number(x)*60000)}/>
      <SettingSelect theme={theme} label={label('审核会话','reviewerSession')} value={v.reviewerSession} onChange={x=>form.change('reviewerSession',x as ReviewPreferences['reviewerSession'])} options={[{value:'reuse',label:'复用'},{value:'new_per_round',label:'每轮新建'}]}/>
    </SettingCard><SettingButton theme={theme} primary disabled={!form.dirty||form.saving} onPress={()=>{void form.save().catch(()=>{});}}>保存评审设置</SettingButton>
    {scope==='project'?<SettingButton theme={theme} onPress={()=>form.guard(()=>{void (async()=>{verified(await write({projectConfig,scope:'project',patch:{},resetFields:['mode','autoFix','maxRounds','reviewerRole','instructions','reviewerSession','reviewerTarget','reviewerTimeoutMs','repairTimeoutMs']}));verified(await write({projectConfig,scope:'project-model',patch:{},resetFields:['reviewerModel']}));await cache.invalidateQueries({queryKey:['workspace-workbench',projectConfig]});})().catch(form.report);})}>清除项目评审覆盖</SettingButton>:null}
  </>:null}{form.error||query.error||data?.error?<SettingText theme={theme} error>{form.error||query.error?.message||data?.error?.message}</SettingText>:null}</SettingCard>;
}
