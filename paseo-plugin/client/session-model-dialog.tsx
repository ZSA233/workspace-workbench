import {useEffect,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {ScrollView} from './native-components';
import {Button,Choice,CommunicationsTheme,Dialog,Field,Label,Row,Section} from './extensions/project-communications/ui';
import {useOrganizer,type OrganizerSettingsResponse} from './use-organizer';
import {defaultMarkers,defaultOrganizerPrompt,modelProfileSchema,organizerPatchSchema,type ModelProfile,type OrganizerPolicy} from '../shared/organizer';
import {SessionTitleStyle} from './session-title-style';

const modes=[{id:'latest',label:'最新工作优先'},{id:'overall',label:'整体需求概括'},{id:'custom',label:'自定义'}] as const;
export function SessionModelDialog({projectConfig,theme,onClose}:{projectConfig:string;theme:PluginWorkspacePanelProps['theme'];onClose():void}){return <CommunicationsTheme theme={theme}><ModelEditor key={projectConfig} projectConfig={projectConfig} onClose={onClose}/></CommunicationsTheme>;}
function ModelEditor({projectConfig,onClose}:{projectConfig:string;onClose():void}){
  const organizer=useOrganizer(projectConfig,true),settings=organizer.settings.data;
  const [profile,setProfile]=useState<ModelProfile>({id:'sushi-local',name:'本机模型',baseUrl:'http://127.0.0.1:12345/v1',model:'',contextTokens:16384,outputTokens:2048,timeoutMs:120000}),[secret,setSecret]=useState(''),[mode,setMode]=useState<OrganizerPolicy['namingMode']>('latest'),[prompt,setPrompt]=useState(defaultOrganizerPrompt),[length,setLength]=useState('16');
  const [markers,setMarkers]=useState<OrganizerPolicy['markers']>({...defaultMarkers});
  const [initialized,setInitialized]=useState(false),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[testing,setTesting]=useState(false),[available,setAvailable]=useState<boolean>(),[error,setError]=useState(''),[picker,setPicker]=useState<'connection'|'mode'|''>(''),[discard,setDiscard]=useState(false);
  useEffect(()=>{if(!settings||initialized)return;const saved=settings.profiles.find(p=>p.id===settings.effective.profileId)||settings.profiles[0];if(saved)setProfile(saved);setMode(settings.effective.namingMode);setPrompt(settings.effective.prompt);setLength(String(settings.effective.titleLength));setMarkers({...settings.effective.markers});setInitialized(true);},[settings,initialized]);
  const change=(patch:Partial<ModelProfile>)=>{setProfile(p=>({...p,...patch}));setDirty(true);setAvailable(undefined);};
  const close=()=>{if(saving)return;if(dirty)setDiscard(true);else onClose();};
  const save=async()=>{setSaving(true);setError('');try{const checked=modelProfileSchema.safeParse(profile),patch=organizerPatchSchema.safeParse({profileId:profile.id,namingMode:mode,prompt,titleLength:Number(length),markers});if(!checked.success||!patch.success)throw Error('请检查地址、模型、符号（最多16字）和高级参数的格式');const url=new URL(profile.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('接口地址应为不含认证和查询参数的 HTTP 或 HTTPS 地址');let current=await organizer.call<OrganizerSettingsResponse>({action:'settings.get'});current=await organizer.mutate<OrganizerSettingsResponse>({action:'profile.save',revision:current.revision,profile:checked.data,...(secret?{secret}:{})});await organizer.mutate({action:'settings.save',scope:'project',revision:current.revision,patch:patch.data,reset:[]});setDirty(false);onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
  const existing=settings?.profiles.find(p=>p.id===profile.id);
  return <Dialog id="session-model-settings" title="模型设置" width={440} height={720} onClose={close} footer={discard?<Row end><Button onPress={()=>setDiscard(false)}>继续编辑</Button><Button onPress={onClose}>放弃更改</Button></Row>:<Row end><Button disabled={saving} onPress={close}>取消</Button><Button id="session-save-model" variant="primary" disabled={!initialized||saving||testing||!profile.model.trim()} onPress={()=>{void save();}}>{saving?'保存中…':'保存'}</Button></Row>}>
    <ScrollView contentContainerStyle={{padding:16,gap:14}}><Label muted>{projectConfig.split('/').slice(-3,-2).join('')||projectConfig}</Label>
      {(settings?.profiles.length||0)>1?<><Choice id="session-model-connection" icon="Bot" label={profile.name} disabled={saving} onPress={()=>setPicker(p=>p==='connection'?'':'connection')}/>{picker==='connection'?<View style={{gap:5}}>{settings?.profiles.map(p=><Button key={p.id} active={p.id===profile.id} align="start" onPress={()=>{setProfile(p);setSecret('');setPicker('');setDirty(true);setAvailable(undefined);}}>{p.name}</Button>)}</View>:null}</>:null}
      <Field id="session-model-url" label="接口地址" value={profile.baseUrl} onChange={baseUrl=>change({baseUrl})}/>
      <Field id="session-model-id" label="模型 ID" value={profile.model} onChange={model=>change({model})}/>
      <Field label="认证（可选）" value={secret} secret placeholder={existing?.hasSecret?'已保存，留空保留':'可留空'} onChange={value=>{setSecret(value);setDirty(true);}}/>
      <Row><Button disabled={testing||saving||!profile.model.trim()} onPress={()=>{setTesting(true);setError('');void organizer.call<{selectedAvailable:boolean}>({action:'profile.probe',profile,...(secret?{secret}:{})}).then(result=>setAvailable(result.selectedAvailable)).catch(e=>{setError(e.message);setAvailable(false);}).finally(()=>setTesting(false));}}>检测连接</Button>{testing?<ActivityIndicator size="small"/>:available!==undefined?<Label warning={!available}>{available?'模型已就绪':'指定模型未就绪'}</Label>:null}</Row>
      <View style={{gap:7}}><Label>命名偏好</Label><Choice id="session-naming-mode" icon="Pencil" label={modes.find(m=>m.id===mode)!.label} disabled={saving} onPress={()=>setPicker(p=>p==='mode'?'':'mode')}/>{picker==='mode'?<View style={{gap:4}}>{modes.map(m=><Button key={m.id} active={mode===m.id} align="start" onPress={()=>{setMode(m.id);setDirty(true);setPicker('');}}>{m.label}</Button>)}</View>:null}</View>
      <SessionTitleStyle markers={markers} onChange={value=>{setMarkers(value);setDirty(true);}}/>
      <Field label="命名提示词" value={prompt} multiline minHeight={100} onChange={value=>{setPrompt(value);setDirty(true);}}/>
      <Field label="标题长度" value={length} onChange={value=>{setLength(value);setDirty(true);}}/>
      <Label muted>正文按提示词生成，状态按 Git 上线依据添加。保存后在会话页预览确认。</Label>
      <Section title="高级设置" collapsible initiallyOpen={false}>
        <Field label="连接名称" value={profile.name} onChange={name=>change({name})}/>
        <Field label="单次上下文上限（tokens）" value={String(profile.contextTokens)} onChange={value=>change({contextTokens:Number(value)})}/>
        <Field label="输出上限（tokens）" value={String(profile.outputTokens)} onChange={value=>change({outputTokens:Number(value)})}/>
        <Field label="请求超时（秒）" value={String(profile.timeoutMs/1000)} onChange={value=>change({timeoutMs:Number(value)*1000})}/>
      </Section>
      {discard?<Label warning>有未保存的更改</Label>:null}{error||organizer.settings.error?<Label warning>{error||organizer.settings.error?.message}</Label>:null}
    </ScrollView>
  </Dialog>;
}
