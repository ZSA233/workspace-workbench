import {useContext,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
import {useQuery} from '@tanstack/react-query';
import {organizerPolicySchema} from '../../shared/organizer';
import type {OrganizerSettingsResponse} from '../use-organizer';
import {useOrganizer} from '../use-organizer';
import {useTopics} from '../use-topics';
import {SettingsDrafts} from './drafts';
import {SettingsSurface,SettingButton,SettingHeading,SettingLink,SettingPill,SettingSwitch,SettingText,settingsCategories,type SettingsCategory,type SettingsTheme} from './ui';

export function SettingsHome({projectConfig,active,scope,theme,onNavigate}:{projectConfig?:string;active:boolean;scope:'host'|'project';theme:SettingsTheme;onNavigate(category:SettingsCategory):void}) {
  const organizer=useOrganizer(projectConfig,active),settings=organizer.settings.data,policy=scope==='host'?organizerPolicySchema.parse(settings?.defaults||{}):settings?.effective,profile=settings?.profiles.find(p=>p.id===policy?.profileId)||settings?.profiles[0];
  const context=useContext(SettingsDrafts),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const available=useQuery({queryKey:['workbench-organizer-model-availability',profile?.id,profile?.baseUrl,profile?.model],queryFn:()=>organizer.call<{selectedAvailable:boolean}>({action:'profile.check',profileId:profile!.id}),enabled:active&&!!profile,staleTime:300000,retry:false,refetchOnWindowFocus:false});
  const toggle=(enabled:boolean)=>{if(enabled&&!profile){onNavigate('models');return;}context.guard(()=>{setSaving(true);setError('');void organizer.call<OrganizerSettingsResponse>({action:'settings.get'}).then(fresh=>organizer.mutate({action:'settings.save',scope:projectConfig?scope:'host',revision:fresh.revision,patch:{enabled,...(enabled&&!policy?.profileId&&profile?{profileId:profile.id}:{})},reset:[]})).catch(e=>setError(e.message)).finally(()=>setSaving(false));});};
  const enabled=(scope==='host'?settings?.defaults.enabled:settings?.effective.enabled)||false;
  return <View style={{gap:16,minWidth:0}}>
    <SettingsSurface theme={theme} testID="settings-model-entry"><View style={{flexDirection:'row',gap:8,alignItems:'center',justifyContent:'space-between'}}><SettingHeading small theme={theme}>模型连接</SettingHeading>{available.isFetching?<ActivityIndicator size="small" color="#669878"/>:<SettingPill theme={theme} tone={available.data?.selectedAvailable?'green':available.error?'amber':'muted'}>{available.data?.selectedAvailable?'已就绪':available.error?'连接异常':profile?'已配置':'未配置'}</SettingPill>}</View>
      {profile?<><Text selectable style={{color:theme.colors.foreground,fontSize:13,fontFamily:'monospace'}}>{profile.baseUrl}</Text><Text selectable style={{color:theme.colors.foregroundMuted,fontSize:11,fontFamily:'monospace'}}>{profile.model}</Text></>:null}
      <SettingButton theme={theme} quiet compact icon="Bot" onPress={()=>onNavigate('models')}>配置地址与模型</SettingButton>
    </SettingsSurface>
    <SettingsSurface theme={theme} testID="settings-organizer-entry"><SettingSwitch theme={theme} label="自动整理" value={enabled} onChange={toggle} disabled={!settings||saving}/><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}><SettingPill theme={theme} tone={enabled?'green':'muted'}>{enabled?'未来新内容': '未开启'}</SettingPill>{saving?<ActivityIndicator size="small" color="#669878"/>:null}<SettingButton theme={theme} quiet compact onPress={()=>onNavigate('organizer')}>范围与命名规则</SettingButton></View></SettingsSurface>
    {error||organizer.settings.error?<SettingText theme={theme} error>{error||organizer.settings.error?.message}</SettingText>:null}
    <SettingsSurface theme={theme}>{settingsCategories.filter(c=>c.id!=='models'&&c.id!=='organizer').map((category,index)=><View key={category.id} style={index?{borderTopWidth:1,borderTopColor:theme.colors.border}:{}}><SettingLink theme={theme} title={category.label} description={category.description} icon={category.icon} onPress={()=>onNavigate(category.id)}/></View>)}</SettingsSurface>
  </View>;
}
export function ExtensionSettings({projectConfig,active,theme,onConfigure}:{projectConfig:string;active:boolean;theme:SettingsTheme;onConfigure():void}) {
  const client=useTopics(projectConfig,active,false),[error,setError]=useState('');
  return <SettingsSurface theme={theme}><SettingSwitch theme={theme} label={client.state?.manifest.name||'档案话题'} value={client.enabled} disabled={client.changing} onChange={enabled=>{setError('');void client.setEnabled(enabled).catch(e=>setError(e.message));}}/>
    <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><SettingText theme={theme}>v{client.state?.manifest.version||'—'}</SettingText><SettingPill theme={theme} tone={client.state?.state==='ready'?'green':client.state?.state==='failed'?'amber':'muted'}>{client.state?.state==='ready'?'已启用':client.state?.state==='failed'?'连接异常':client.state?.state==='starting'?'连接中':'未启用'}</SettingPill></View>
    <SettingButton theme={theme} icon="Settings" onPress={onConfigure}>连接与投递配置</SettingButton>{error||client.state?.error?<SettingText theme={theme} error>{error||client.state?.error}</SettingText>:null}
  </SettingsSurface>;
}
